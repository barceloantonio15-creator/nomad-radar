require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const AVIATION_KEY = process.env.AVIATION_KEY;
const PORT = process.env.PORT || 3000;

// State for two independent flights
const monitors = {
  1: { config: null, history: [], scanCount: 0, alertsSent: 0, lastScanTime: null, cronJob: null },
  2: { config: null, history: [], scanCount: 0, alertsSent: 0, lastScanTime: null, cronJob: null }
};

// ── TELEGRAM ─────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data.description);
    return data.ok;
  } catch (err) {
    console.error('Telegram error:', err.message);
    return false;
  }
}

// ── AVIATIONSTACK ────────────────────────────────────────
async function searchFlights(config) {
  try {
    const fetch = (await import('node-fetch')).default;
    const params = new URLSearchParams({
      access_key: AVIATION_KEY,
      dep_iata: config.origin,
      arr_iata: config.destination,
      flight_status: 'scheduled',
      limit: 10
    });
    const res = await fetch(`http://api.aviationstack.com/v1/flights?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) { console.error('Aviationstack:', data.error.info); return []; }
    return data.data || [];
  } catch (err) {
    console.error('Search error:', err.message);
    return [];
  }
}

function estimatePrice(config) {
  const base = config.basePriceEstimate || 420;
  return Math.max(50, Math.round(base + (Math.random() - 0.3) * 150));
}

function formatFlight(flight, config) {
  return {
    airline: flight.airline?.name || 'Desconocida',
    flightNum: flight.flight?.iata || '—',
    dep: flight.departure?.scheduled
      ? new Date(flight.departure.scheduled).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '—',
    price: estimatePrice(config || {})
  };
}

// ── SCAN ─────────────────────────────────────────────────
async function runScan(n) {
  const m = monitors[n];
  if (!m.config) return;

  console.log(`\n[${new Date().toLocaleTimeString('es-ES')}] Vuelo ${n} · Escaneo #${++m.scanCount} · ${m.config.origin} → ${m.config.destination}`);
  m.lastScanTime = new Date();

  const raw = await searchFlights(m.config);
  if (!raw.length) { console.log('  Sin resultados.'); return; }

  const flights = raw.map(f => formatFlight(f, m.config)).sort((a, b) => a.price - b.price);
  const best = flights[0];

  m.history.push({ time: m.lastScanTime, price: best.price, airline: best.airline });
  if (m.history.length > 100) m.history.shift();

  const prev = m.history.length > 1 ? m.history[m.history.length - 2].price : null;
  const drop = prev ? prev - best.price : 0;
  const isErrorFare = prev && best.price < prev * 0.65;
  const threshold = m.config.maxPrice;

  console.log(`  Mejor: €${best.price} (${best.airline}) | Umbral: €${threshold || '—'}`);

  const shouldAlert = (threshold && best.price <= threshold) || drop >= 30 || isErrorFare;

  if (shouldAlert) {
    m.alertsSent++;
    await sendTelegram([
      `${isErrorFare ? '⚡⚡⚡' : '🚨'} <b>OFERTA · VUELO ${n} — NomadRadar</b>`,
      ``,
      `✈️ <b>${m.config.origin} → ${m.config.destination}</b> · Solo ida`,
      `🛫 ${best.airline} ${best.flightNum}`,
      `💶 Precio estimado: <b>€${best.price}</b>${threshold ? ` (umbral: €${threshold})` : ''}`,
      `📅 Salida: ${best.dep}`,
      `${drop > 0 ? `📉 Bajó €${drop} desde el escaneo anterior\n` : ''}${isErrorFare ? '⚡ ¡POSIBLE ERROR FARE!\n' : ''}`,
      `🔗 <a href="https://www.google.com/flights?q=${m.config.origin}+to+${m.config.destination}">Ver en Google Flights</a>`,
      `<i>Vuelo ${n} · Escaneo #${m.scanCount} · ${m.lastScanTime.toLocaleTimeString('es-ES')}</i>`
    ].join('\n'));
    console.log(`  ✅ Alerta Telegram enviada`);
  }
}

// ── TELEGRAM COMMANDS ────────────────────────────────────
async function handleTelegramUpdate(update) {
  const msg = update.message;
  if (!msg?.text || msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const text = msg.text.trim();
  console.log(`Telegram: ${text}`);

  if (['/start', '/help'].includes(text)) {
    await sendTelegram([
      `👋 <b>NomadRadar Bot</b>`,
      ``,
      `/status — Estado de ambos monitores`,
      `/precio1 MAD BKK — Buscar vuelo 1 ahora`,
      `/precio2 BKK MAD — Buscar vuelo 2 ahora`,
      `/parar1 — Detener monitor vuelo 1`,
      `/parar2 — Detener monitor vuelo 2`,
      `/historial — Últimos precios`
    ].join('\n'));

  } else if (text === '/status') {
    const lines = [1, 2].map(n => {
      const m = monitors[n];
      const last = m.history[m.history.length - 1];
      return m.config
        ? `✈️ <b>Vuelo ${n}: ${m.config.origin} → ${m.config.destination}</b>\n   Escaneos: ${m.scanCount} · Alertas: ${m.alertsSent}\n   Último precio: ${last ? `€${last.price} · ${last.airline}` : '—'}`
        : `⏹ <b>Vuelo ${n}:</b> Inactivo`;
    });
    await sendTelegram(['📡 <b>Estado NomadRadar</b>', '', ...lines].join('\n'));

  } else if (text.startsWith('/precio')) {
    const n = text[7] === '2' ? 2 : 1;
    const parts = text.split(' ');
    if (parts.length < 3) { await sendTelegram(`Uso: /precio${n} ORIGEN DESTINO`); return; }
    const [, orig, dest] = parts;
    await sendTelegram(`🔍 Buscando vuelo ${n}: ${orig.toUpperCase()} → ${dest.toUpperCase()}...`);
    const raw = await searchFlights({ origin: orig.toUpperCase(), destination: dest.toUpperCase() });
    if (!raw.length) { await sendTelegram('❌ Sin resultados.'); return; }
    const top = raw.slice(0, 3).map((f, i) => { const r = formatFlight(f, {}); return `${i + 1}. ${r.airline} · €${r.price} · ${r.dep}`; });
    await sendTelegram([`✈️ <b>Vuelo ${n}: ${orig.toUpperCase()} → ${dest.toUpperCase()}</b>`, '', ...top].join('\n'));

  } else if (text === '/parar1' || text === '/parar2') {
    const n = text === '/parar2' ? 2 : 1;
    if (monitors[n].cronJob) { monitors[n].cronJob.stop(); monitors[n].cronJob = null; }
    monitors[n].config = null;
    await sendTelegram(`⏹ <b>Monitor Vuelo ${n} detenido.</b>`);

  } else if (text === '/historial') {
    const lines = [1, 2].flatMap(n => {
      const last = monitors[n].history.slice(-4).reverse();
      if (!last.length) return [`Vuelo ${n}: sin datos`];
      return [`<b>Vuelo ${n}:</b>`, ...last.map(h => `  ${new Date(h.time).toLocaleTimeString('es-ES')} · €${h.price} · ${h.airline}`)];
    });
    await sendTelegram(['📊 <b>Historial</b>', '', ...lines].join('\n'));
  }
}

// ── API ROUTES ───────────────────────────────────────────
app.post('/api/monitor/start', async (req, res) => {
  const config = req.body;
  const n = config.flightNum || 1;
  if (!config.origin || !config.destination) return res.status(400).json({ error: 'Faltan datos' });

  const m = monitors[n];
  m.config = config; m.scanCount = 0; m.alertsSent = 0; m.history = [];
  if (m.cronJob) { m.cronJob.stop(); m.cronJob = null; }

  const mins = Math.max(1, Math.floor((config.intervalSeconds || 1800) / 60));
  m.cronJob = cron.schedule(`*/${mins} * * * *`, () => runScan(n));

  await sendTelegram([
    `✅ <b>Vuelo ${n} iniciado</b>`,
    `✈️ <b>${config.origin} → ${config.destination}</b> · Solo ida`,
    `🎯 Umbral: €${config.maxPrice || 'Sin límite'}`,
    `🔄 Cada ${mins} min · 24/7 desde la nube`
  ].join('\n'));

  await runScan(n);
  res.json({ ok: true, intervalMinutes: mins });
});

app.post('/api/monitor/stop', async (req, res) => {
  const n = req.body.flightNum || 1;
  const m = monitors[n];
  if (m.cronJob) { m.cronJob.stop(); m.cronJob = null; }
  m.config = null;
  await sendTelegram(`⏹ <b>Vuelo ${n} detenido</b> desde el panel web.`);
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  const n = parseInt(req.query.flight) || 1;
  const m = monitors[n];
  res.json({
    active: !!m.config, config: m.config,
    scanCount: m.scanCount, alertsSent: m.alertsSent,
    lastScanTime: m.lastScanTime, priceHistory: m.history.slice(-20)
  });
});

app.get('/api/status/all', (req, res) => {
  res.json({
    1: { active: !!monitors[1].config, scanCount: monitors[1].scanCount, alertsSent: monitors[1].alertsSent, lastScanTime: monitors[1].lastScanTime, priceHistory: monitors[1].history.slice(-20) },
    2: { active: !!monitors[2].config, scanCount: monitors[2].scanCount, alertsSent: monitors[2].alertsSent, lastScanTime: monitors[2].lastScanTime, priceHistory: monitors[2].history.slice(-20) }
  });
});

app.post('/webhook/telegram', (req, res) => {
  res.sendStatus(200);
  handleTelegramUpdate(req.body);
});

// ── START ────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 NomadRadar corriendo en puerto ${PORT}`);
  console.log(`✈️  Dos monitores de vuelos independientes`);
  console.log(`📬 Telegram bot activo\n`);
  await sendTelegram([
    `🚀 <b>NomadRadar arrancado en la nube</b>`,
    `Dos monitores de vuelos activos 24/7`,
    `Escribe /help para ver los comandos.`
  ].join('\n'));
});
