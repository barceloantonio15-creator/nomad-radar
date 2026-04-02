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

let monitorConfig = null;
let priceHistory = [];
let scanCount = 0;
let alertsSent = 0;
let lastScanTime = null;
let cronJob = null;

// ─── TELEGRAM ─────────────────────────────────────────────
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

// ─── AVIATIONSTACK ────────────────────────────────────────
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
    dep: flight.departure?.scheduled ? new Date(flight.departure.scheduled).toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—',
    arr: flight.arrival?.scheduled ? new Date(flight.arrival.scheduled).toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—',
    price: estimatePrice(config || {}),
    status: flight.flight_status || 'scheduled'
  };
}

// ─── SCAN ─────────────────────────────────────────────────
async function runScan() {
  if (!monitorConfig) return;
  console.log(`\n[${new Date().toLocaleTimeString('es-ES')}] Escaneo #${++scanCount} — ${monitorConfig.origin} → ${monitorConfig.destination}`);
  lastScanTime = new Date();

  const raw = await searchFlights(monitorConfig);
  if (!raw.length) { console.log('  Sin resultados.'); return; }

  const flights = raw.map(f => formatFlight(f, monitorConfig)).sort((a,b) => a.price - b.price);
  const best = flights[0];

  priceHistory.push({ time: lastScanTime, price: best.price, airline: best.airline });
  if (priceHistory.length > 100) priceHistory.shift();

  const prev = priceHistory.length > 1 ? priceHistory[priceHistory.length - 2].price : null;
  const drop = prev ? prev - best.price : 0;
  const isErrorFare = prev && best.price < prev * 0.65;
  const threshold = monitorConfig.maxPrice;

  console.log(`  Mejor: €${best.price} (${best.airline} ${best.flightNum}) | Umbral: €${threshold || '—'}`);

  if ((threshold && best.price <= threshold) || drop >= 30 || isErrorFare) {
    alertsSent++;
    await sendTelegram([
      `${isErrorFare ? '⚡⚡⚡' : '🚨'} <b>OFERTA DETECTADA — NomadRadar</b>`,
      ``,
      `✈️ <b>${monitorConfig.origin} → ${monitorConfig.destination}</b>`,
      `🛫 ${best.airline} ${best.flightNum}`,
      `💶 Precio estimado: <b>€${best.price}</b>${threshold ? ` (umbral: €${threshold})` : ''}`,
      `📅 Salida: ${best.dep} · Llegada: ${best.arr}`,
      `${drop > 0 ? `📉 Bajó €${drop} desde el escaneo anterior\n` : ''}${isErrorFare ? '⚡ ¡POSIBLE ERROR FARE!\n' : ''}`,
      `🔗 <a href="https://www.google.com/flights?q=${monitorConfig.origin}+to+${monitorConfig.destination}">Ver en Google Flights</a>`,
      `<i>Escaneo #${scanCount} · ${lastScanTime.toLocaleTimeString('es-ES')}</i>`
    ].join('\n'));
    console.log(`  ✅ Alerta #${alertsSent} enviada`);
  }

  return { flights, scanCount, lastScanTime, alertsSent };
}

// ─── TELEGRAM COMMANDS ────────────────────────────────────
async function handleTelegramUpdate(update) {
  const msg = update.message;
  if (!msg?.text || msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const text = msg.text.trim();
  console.log(`Telegram cmd: ${text}`);

  if (['/start','/help'].includes(text)) {
    await sendTelegram(['👋 <b>NomadRadar Bot</b>','','/status — Estado del monitor','/precio MAD BKK — Buscar ahora','/escanear — Forzar escaneo','/historial — Últimos precios','/parar — Detener monitor'].join('\n'));

  } else if (text === '/status') {
    const last = priceHistory[priceHistory.length - 1];
    await sendTelegram(!monitorConfig
      ? '📡 Monitor <b>inactivo</b>. Configúralo desde el panel web.'
      : [`📡 <b>Monitor activo</b>`,'',`✈️ ${monitorConfig.origin} → ${monitorConfig.destination}`,`🎯 Umbral: €${monitorConfig.maxPrice || 'Sin límite'}`,`🔄 Escaneos: ${scanCount}`,`📬 Alertas: ${alertsSent}`,`💶 Último precio: ${last ? `€${last.price} · ${last.airline}` : '—'}`,`🕐 Último escaneo: ${lastScanTime ? lastScanTime.toLocaleTimeString('es-ES') : '—'}`].join('\n'));

  } else if (text.startsWith('/precio')) {
    const [, orig, dest] = text.split(' ');
    if (!orig || !dest) { await sendTelegram('Uso: /precio ORIGEN DESTINO · Ej: /precio MAD BKK'); return; }
    await sendTelegram(`🔍 Buscando ${orig.toUpperCase()} → ${dest.toUpperCase()}...`);
    const raw = await searchFlights({ origin: orig.toUpperCase(), destination: dest.toUpperCase() });
    if (!raw.length) { await sendTelegram('❌ Sin resultados para esa ruta.'); return; }
    const top = raw.slice(0,3).map((f,i) => { const r = formatFlight(f,{}); return `${i+1}. ${r.airline} ${r.flightNum} · €${r.price} · ${r.dep}`; });
    await sendTelegram([`✈️ <b>${orig.toUpperCase()} → ${dest.toUpperCase()}</b>`,'', ...top].join('\n'));

  } else if (text === '/escanear') {
    if (!monitorConfig) { await sendTelegram('❌ Monitor no activo.'); return; }
    await sendTelegram('🔄 Ejecutando escaneo manual...');
    await runScan();

  } else if (text === '/parar') {
    if (cronJob) { cronJob.stop(); cronJob = null; }
    monitorConfig = null;
    await sendTelegram('⏹ <b>Monitor detenido.</b>');

  } else if (text === '/historial') {
    if (!priceHistory.length) { await sendTelegram('📊 Sin historial todavía.'); return; }
    const lines = priceHistory.slice(-8).reverse().map(h => `${new Date(h.time).toLocaleTimeString('es-ES')} · €${h.price} · ${h.airline}`);
    await sendTelegram(['📊 <b>Historial de precios</b>','', ...lines].join('\n'));
  }
}

// ─── ROUTES ───────────────────────────────────────────────
app.post('/api/monitor/start', async (req, res) => {
  const config = req.body;
  if (!config.origin || !config.destination) return res.status(400).json({ error: 'Faltan origen o destino' });
  monitorConfig = config; scanCount = 0; alertsSent = 0; priceHistory = [];
  if (cronJob) { cronJob.stop(); cronJob = null; }
  const mins = Math.max(1, Math.floor((config.intervalSeconds || 1800) / 60));
  cronJob = cron.schedule(`*/${mins} * * * *`, runScan);
  await sendTelegram([`✅ <b>Monitor iniciado</b>`,'',`✈️ <b>${config.origin} → ${config.destination}</b>`,`🎯 Umbral: €${config.maxPrice || 'Sin límite'}`,`🔄 Cada ${mins} min`,'',`Escribe /status para consultar.`].join('\n'));
  await runScan();
  res.json({ ok: true, intervalMinutes: mins });
});

app.post('/api/monitor/stop', async (req, res) => {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  monitorConfig = null;
  await sendTelegram('⏹ <b>Monitor detenido</b> desde el panel web.');
  res.json({ ok: true });
});

app.post('/api/scan', async (req, res) => {
  if (!monitorConfig) return res.status(400).json({ error: 'Monitor no activo' });
  res.json(await runScan() || { ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ active: !!monitorConfig, config: monitorConfig, scanCount, alertsSent, lastScanTime, priceHistory: priceHistory.slice(-20) });
});

app.post('/webhook/telegram', (req, res) => {
  res.sendStatus(200);
  handleTelegramUpdate(req.body);
});

// ─── START ────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 NomadRadar en http://localhost:${PORT}`);
  console.log(`📬 Telegram activo — escribe /help en tu bot\n`);
  await sendTelegram([`🚀 <b>NomadRadar arrancado</b>`,`Puerto ${PORT} · Aviationstack conectado`,`Escribe /help para ver los comandos.`].join('\n'));
});
