// ─────────────────────────────────────────────────────────────
//  KALSHI EDGE v2 — AI-Powered Prediction Market Trading Bot
// ─────────────────────────────────────────────────────────────

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ─── CONFIG ─────────────────────────────────────────────────

const CFG = {
  apiKeyId:    process.env.KALSHI_API_KEY_ID || '',
  privateKey:  (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  baseUrl:     process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com',
  basePath:    '/trade-api/v2',
  claudeKey:   process.env.CLAUDE_API_KEY || '',
  claudeModel: 'claude-sonnet-4-20250514',
  dryRun:        process.env.DRY_RUN !== 'false',
  bankroll:      parseFloat(process.env.BANKROLL || '50'),
  kellyFraction: parseFloat(process.env.KELLY_FRACTION || '0.35'),
  claudeEdge:    parseFloat(process.env.CLAUDE_EDGE || '0.07'),
  maxPosition:   parseFloat(process.env.MAX_POSITION || '5'),
  maxDailyLoss:  parseFloat(process.env.MAX_DAILY_LOSS || '8'),
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '5'),
  pollInterval:  parseInt(process.env.POLL_INTERVAL || '45'),
  minVolume:     parseInt(process.env.MIN_VOLUME || '3000'),
  telegramToken: process.env.TELEGRAM_TOKEN || '',
  telegramChat:  process.env.TELEGRAM_CHAT_ID || '',
};

// ─── STATE ──────────────────────────────────────────────────

const STATE_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'state.json')
  : path.join('/tmp', 'kalshi-state.json');

let state = {
  trades: [], positions: [], signals: [], newsHeadlines: [], settledTrades: [],
  balance: CFG.bankroll * 100, dailyPnL: 0, dailyDate: new Date().toISOString().slice(0, 10),
  totalPnL: 0, wins: 0, losses: 0, botStarted: null,
  lastPoll: null, lastError: null, isRunning: false, cycleCount: 0,
};

function loadState() { try { if (fs.existsSync(STATE_FILE)) { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); state = { ...state, ...s }; } } catch (e) {} }
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {} }
loadState();

// ─── LOGGING ────────────────────────────────────────────────

const logs = [];
function log(msg) { const e = `[${new Date().toISOString().slice(11, 19)}] ${msg}`; console.log(e); logs.unshift(e); if (logs.length > 500) logs.length = 500; }

// ─── HTTPS HELPER ───────────────────────────────────────────

function httpsReq(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const o = { hostname: u.hostname, port: 443, path: u.pathname + u.search, ...opts };
    const req = https.request(o, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }); } catch (e) { resolve({ status: res.statusCode, data: { raw: d } }); } });
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── KALSHI API ─────────────────────────────────────────────

function signReq(ts, method, p) {
  try {
    const msg = `${ts}${method}${p}`;
    const pk = crypto.createPrivateKey({ key: CFG.privateKey, format: 'pem' });
    return crypto.sign('sha256', Buffer.from(msg), {
      key: pk, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
  } catch (e) { log('RSA sign error: ' + e.message); return ''; }
}

function kalshi(method, apiPath, body) {
  const ts = Date.now().toString();
  const sp = `${CFG.basePath}${apiPath.split('?')[0]}`;
  const sig = signReq(ts, method, sp);
  const url = `${CFG.baseUrl}${CFG.basePath}${apiPath}`;
  return httpsReq(url, {
    method,
    headers: { 'KALSHI-ACCESS-KEY': CFG.apiKeyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, body ? JSON.stringify(body) : null);
}

// ─── DATA FETCHERS ──────────────────────────────────────────

async function getBalance() {
  try { const r = await kalshi('GET', '/portfolio/balance'); if (r.status === 200 && r.data.balance !== undefined) { state.balance = r.data.balance; return r.data.balance; } log('Balance: HTTP ' + r.status); } catch (e) { log('Balance err: ' + e.message); }
  return state.balance;
}

async function getMarkets() {
  try { const r = await kalshi('GET', '/markets?status=open&limit=200'); if (r.status === 200 && r.data.markets) return r.data.markets; log('Markets: HTTP ' + r.status); } catch (e) { log('Markets err: ' + e.message); }
  return [];
}

async function getPositions() {
  try { const r = await kalshi('GET', '/portfolio/positions'); if (r.status === 200) { state.positions = r.data.market_positions || []; return state.positions; } } catch (e) {}
  return state.positions;
}

async function getSettlements() {
  try { const r = await kalshi('GET', '/portfolio/settlements?limit=20'); if (r.status === 200 && r.data.settlements) return r.data.settlements; } catch (e) {}
  return [];
}

// ─── NEWS ───────────────────────────────────────────────────

async function fetchNews() {
  const now = new Date();
  return [
    `Date: ${now.toISOString().slice(0, 10)} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()]})`,
    'Assess all markets using your training knowledge of current events, economics, politics, weather, and sports.',
    'For time-sensitive markets (weather, sports scores), note if insufficient info exists to estimate.',
  ];
}

// ─── CLAUDE SIGNAL ENGINE ───────────────────────────────────

async function claudeAnalyze(markets) {
  if (!CFG.claudeKey || !markets.length) return [];

  const liquid = markets
    .filter(m => (m.volume || m.volume_fp || 0) >= CFG.minVolume)
    .sort((a, b) => (b.volume || b.volume_fp || 0) - (a.volume || a.volume_fp || 0))
    .slice(0, 15);

  if (!liquid.length) { log('No liquid markets above threshold'); return []; }

  const news = await fetchNews();
  state.newsHeadlines = news;

  const mBlock = liquid.map((m, i) => {
    const yp = m.yes_bid || m.last_price || m.yes_ask || 50;
    const v = m.volume || m.volume_fp || 0;
    return `${i+1}. "${m.title}" [${m.ticker}] YES:${yp}c Vol:$${(v/100).toFixed(0)} Close:${m.close_time||m.expected_expiration_time||'TBD'}`;
  }).join('\n');

  const body = JSON.stringify({
    model: CFG.claudeModel, max_tokens: 2500,
    system: `You are a quantitative Kalshi prediction market analyst. Binary contracts: YES=$1, NO=$0. Prices in cents 1-99.
ONLY flag markets with ${(CFG.claudeEdge*100).toFixed(0)}%+ edge (your estimated true probability vs market price).
Prefer: high-volume, near-expiry, economy/politics markets. Avoid: markets you're uncertain about.
RESPOND WITH VALID JSON ARRAY ONLY. No markdown. Each: {"ticker":"X","title":"short","side":"yes"|"no","marketPrice":0.XX,"trueProb":0.XX,"edge":0.XX,"confidence":"low"|"medium"|"high","reasoning":"1 sentence"}
If no edge found: []`,
    messages: [{ role: 'user', content: `${news.join('\n')}\n\nMARKETS:\n${mBlock}\n\nAnalyze. Flag ${(CFG.claudeEdge*100).toFixed(0)}%+ edge only.` }],
  });

  try {
    const r = await httpsReq('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': CFG.claudeKey, 'anthropic-version': '2023-06-01' },
    }, body);
    if (r.data.error) { log('Claude err: ' + (r.data.error.message || JSON.stringify(r.data.error))); return []; }
    const txt = (r.data.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    const sigs = JSON.parse(txt);
    return Array.isArray(sigs) ? sigs : [];
  } catch (e) { log('Claude err: ' + e.message); return []; }
}

// ─── KELLY SIZING ───────────────────────────────────────────

function kellySize(edge, mktPrice, side) {
  const cost = side === 'yes' ? mktPrice : (1 - mktPrice);
  if (cost <= 0 || cost >= 1 || edge <= 0) return 0;
  const odds = (1 - cost) / cost;
  const wp = cost + edge;
  const k = (wp * odds - (1 - wp)) / odds;
  if (k <= 0) return 0;
  const frac = k * CFG.kellyFraction;
  const bankDollars = Math.max(state.balance / 100, CFG.bankroll);
  const dollars = Math.min(CFG.maxPosition, Math.max(1, frac * bankDollars));
  return Math.max(1, Math.min(Math.floor(dollars / cost), 100));
}

// ─── ORDER EXECUTION ────────────────────────────────────────

async function placeOrder(sig) {
  const { ticker, side, marketPrice, edge, confidence, reasoning } = sig;
  const contracts = kellySize(edge, marketPrice, side);
  if (contracts <= 0) { log('Kelly skip: ' + ticker); return null; }

  const pc = side === 'yes' ? Math.round(marketPrice * 100) : Math.round((1 - marketPrice) * 100);
  const cost = ((contracts * pc) / 100).toFixed(2);

  const rec = {
    id: uuidv4(), ticker, title: sig.title || ticker, side, contracts, priceCents: pc,
    costDollars: cost, edge: (edge * 100).toFixed(1) + '%', confidence, reasoning,
    timestamp: new Date().toISOString(), status: 'pending', dryRun: CFG.dryRun,
  };

  if (CFG.dryRun) {
    rec.status = 'simulated';
    state.trades.unshift(rec);
    if (state.trades.length > 200) state.trades.length = 200;
    saveState();
    log(`📋 PAPER: ${side.toUpperCase()} ${contracts}x ${ticker} @${pc}c ($${cost}) Edge:${rec.edge}`);
    await tg(`🧪 <b>PAPER TRADE</b>\n${side.toUpperCase()} ${contracts}x <code>${ticker}</code>\n@${pc}¢ ($${cost}) | Edge: ${rec.edge}\n${confidence} | ${reasoning}`);
    return rec;
  }

  const order = { ticker, action: 'buy', side, count: contracts, type: 'limit', client_order_id: uuidv4() };
  if (side === 'yes') order.yes_price = pc; else order.no_price = pc;

  try {
    const r = await kalshi('POST', '/portfolio/orders', order);
    if (r.status === 201 || r.status === 200) {
      rec.status = 'placed'; rec.orderId = r.data.order?.order_id;
      log(`✅ LIVE: ${side.toUpperCase()} ${contracts}x ${ticker} @${pc}c`);
      await tg(`✅ <b>LIVE ORDER</b>\n${side.toUpperCase()} ${contracts}x <code>${ticker}</code>\n@${pc}¢ ($${cost}) | Edge: ${rec.edge}\n${reasoning}`);
    } else {
      rec.status = 'error'; rec.error = JSON.stringify(r.data).slice(0, 300);
      log('❌ Order err ' + r.status + ': ' + rec.error);
      await tg(`❌ <b>ORDER FAILED</b>\n${ticker}\n${rec.error.slice(0, 200)}`);
    }
  } catch (e) { rec.status = 'error'; rec.error = e.message; }

  state.trades.unshift(rec);
  if (state.trades.length > 200) state.trades.length = 200;
  saveState();
  return rec;
}

// ─── SETTLEMENTS ────────────────────────────────────────────

async function checkSettlements() {
  try {
    const setts = await getSettlements();
    const known = new Set((state.settledTrades || []).map(s => s.market_id || s.ticker));
    for (const s of setts) {
      const id = s.market_id || s.ticker;
      if (!known.has(id)) {
        state.settledTrades = state.settledTrades || [];
        state.settledTrades.unshift(s);
        const rev = (s.revenue || 0) / 100;
        const win = rev > 0;
        if (win) state.wins++; else state.losses++;
        state.totalPnL += (s.revenue || 0);
        state.dailyPnL += (s.revenue || 0);
        log(`📊 SETTLED: ${s.ticker || id} → ${win ? 'WIN' : 'LOSS'} $${rev.toFixed(2)}`);
        await tg(`${win ? '🏆' : '💸'} <b>${win ? 'WIN' : 'LOSS'}</b>\n<code>${s.ticker || id}</code>\nP&L: ${win ? '+' : ''}$${rev.toFixed(2)}\nTotal: $${(state.totalPnL / 100).toFixed(2)}`);
      }
    }
  } catch (e) {}
}

// ─── MAIN LOOP ──────────────────────────────────────────────

let pollTimer = null;

async function cycle() {
  try {
    state.cycleCount++;
    const today = new Date().toISOString().slice(0, 10);
    if (state.dailyDate !== today) { state.dailyPnL = 0; state.dailyDate = today; log('📅 New day reset'); }

    if (state.dailyPnL <= -(CFG.maxDailyLoss * 100)) { log('🛑 Daily loss limit hit'); return; }

    const [bal, mkts, pos] = await Promise.all([getBalance(), getMarkets(), getPositions()]);
    await checkSettlements();
    state.lastPoll = new Date().toISOString();
    log(`🔄 #${state.cycleCount}: ${mkts.length} mkts | $${(bal / 100).toFixed(2)} | ${pos.length} pos`);

    if (pos.length >= CFG.maxConcurrent) { log('⏸ Max positions'); saveState(); return; }

    const sigs = await claudeAnalyze(mkts);
    state.signals = sigs.slice(0, 20);

    if (sigs.length > 0) {
      log(`🧠 ${sigs.length} signal(s)`);
      const held = new Set(pos.map(p => p.ticker));
      const recent = new Set(state.trades.slice(0, 30).map(t => t.ticker));
      const fresh = sigs.filter(s => !held.has(s.ticker) && !recent.has(s.ticker)).sort((a, b) => (b.edge || 0) - (a.edge || 0));
      const slots = CFG.maxConcurrent - pos.length;
      for (const s of fresh.slice(0, Math.min(slots, 2))) {
        await placeOrder(s);
        await new Promise(r => setTimeout(r, 1500));
      }
    } else { log('😴 No signals'); }

    state.lastError = null; saveState();
  } catch (e) { state.lastError = e.message; log('💥 Cycle err: ' + e.message); saveState(); }
}

function startBot() {
  if (state.isRunning) return;
  state.isRunning = true; state.botStarted = new Date().toISOString();
  log('🚀 Started | ' + (CFG.dryRun ? 'PAPER' : 'LIVE'));
  tg(`🚀 <b>Kalshi Edge Started</b>\nMode: ${CFG.dryRun ? '📋 Paper' : '⚡ LIVE'}\nBankroll: $${CFG.bankroll}\nEdge: ${CFG.claudeEdge * 100}% | Kelly: ${CFG.kellyFraction}\nMax/trade: $${CFG.maxPosition} | Poll: ${CFG.pollInterval}s`);
  cycle();
  pollTimer = setInterval(cycle, CFG.pollInterval * 1000);
  saveState();
}

function stopBot() {
  state.isRunning = false; if (pollTimer) clearInterval(pollTimer); pollTimer = null;
  log('⏹ Stopped'); tg('⏹ <b>Kalshi Edge Stopped</b>'); saveState();
}

// ─── TELEGRAM ───────────────────────────────────────────────

async function tg(text) {
  if (!CFG.telegramToken || !CFG.telegramChat) return;
  try { await httpsReq(`https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ chat_id: CFG.telegramChat, text, parse_mode: 'HTML' })); } catch (e) {}
}

// ─── API ROUTES ─────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const t = state.wins + state.losses;
  res.json({ isRunning: state.isRunning, dryRun: CFG.dryRun, balance: state.balance, bankroll: CFG.bankroll,
    totalPnL: state.totalPnL, dailyPnL: state.dailyPnL, wins: state.wins, losses: state.losses,
    winRate: t > 0 ? ((state.wins / t) * 100).toFixed(1) : '0.0', openPositions: state.positions.length,
    maxConcurrent: CFG.maxConcurrent, lastPoll: state.lastPoll, lastError: state.lastError,
    botStarted: state.botStarted, cycleCount: state.cycleCount,
    config: { kellyFraction: CFG.kellyFraction, claudeEdge: CFG.claudeEdge, maxPosition: CFG.maxPosition, maxDailyLoss: CFG.maxDailyLoss, pollInterval: CFG.pollInterval, minVolume: CFG.minVolume },
  });
});

app.get('/api/trades', (req, res) => res.json(state.trades.slice(0, 50)));
app.get('/api/positions', (req, res) => res.json(state.positions));
app.get('/api/signals', (req, res) => res.json(state.signals));
app.get('/api/logs', (req, res) => res.json(logs.slice(0, 100)));
app.post('/api/bot/start', (req, res) => { startBot(); res.json({ ok: true }); });
app.post('/api/bot/stop', (req, res) => { stopBot(); res.json({ ok: true }); });
app.post('/api/bot/cycle', async (req, res) => { try { await cycle(); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); } });

app.get('/api/test-connection', async (req, res) => {
  try {
    const [b, m] = await Promise.all([kalshi('GET', '/portfolio/balance'), kalshi('GET', '/markets?status=open&limit=3')]);
    res.json({ auth: b.status === 200 ? 'ok' : 'failed', authStatus: b.status, authError: b.status !== 200 ? JSON.stringify(b.data).slice(0, 200) : null,
      balance: b.status === 200 ? b.data : null, markets: m.status === 200 ? `${(m.data.markets || []).length} markets` : 'failed',
      sampleMarket: m.data.markets?.[0] ? { ticker: m.data.markets[0].ticker, title: m.data.markets[0].title, yes_bid: m.data.markets[0].yes_bid } : null });
  } catch (e) { res.json({ auth: 'error', error: e.message }); }
});

// ─── DASHBOARD (INLINE — no file dependency) ────────────────

app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html'); res.send(getDashboard()); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Kalshi Edge v2 on :${PORT}`);
  log(`Mode: ${CFG.dryRun ? 'PAPER' : 'LIVE'} | Bank: $${CFG.bankroll} | Kelly: ${CFG.kellyFraction} | Edge: ${CFG.claudeEdge * 100}%`);
  log(`Telegram: ${CFG.telegramToken ? '✓' : '✗'} | Poll: ${CFG.pollInterval}s`);
  if (CFG.apiKeyId && CFG.privateKey) { log('Credentials found — starting in 2s...'); setTimeout(startBot, 2000); }
  else { log('⚠️ Set KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY to enable.'); }
});

// ─── DASHBOARD HTML ─────────────────────────────────────────

function getDashboard() {
return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#050505"><title>Kalshi Edge</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&display=swap');
:root{--bg:#050505;--s1:#111113;--s2:#1a1a1e;--s3:#232328;--bd:rgba(255,255,255,.06);--bd2:rgba(255,255,255,.12);--t1:#f5f5f7;--t2:#a1a1a6;--t3:#636366;--g:#30d158;--gd:rgba(48,209,88,.12);--r:#ff453a;--rd:rgba(255,69,58,.12);--b:#0a84ff;--bld:rgba(10,132,255,.12);--o:#ff9f0a;--od:rgba(255,159,10,.12);--rad:16px;--st:env(safe-area-inset-top,20px);--sb:env(safe-area-inset-bottom,0px)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',-apple-system,sans-serif;background:var(--bg);color:var(--t1);-webkit-font-smoothing:antialiased;min-height:100dvh;padding-top:var(--st);padding-bottom:calc(72px + var(--sb));overflow-x:hidden}
.hd{padding:12px 20px 8px;display:flex;align-items:center;justify-content:space-between}
.hdb{display:flex;align-items:center;gap:10px}
.hdl{width:32px;height:32px;background:linear-gradient(135deg,var(--g),var(--b));border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#000}
.hdt{font-size:20px;font-weight:700;letter-spacing:-.3px}
.tg{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;padding:4px 10px;border-radius:20px}
.tgd{background:var(--od);color:var(--o)}.tgl{background:var(--gd);color:var(--g)}.tgo{background:var(--rd);color:var(--r)}
.hero{margin:8px 16px 0;padding:24px 20px;background:var(--s1);border-radius:20px;border:1px solid var(--bd);position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-60%;right:-30%;width:200px;height:200px;background:radial-gradient(circle,rgba(48,209,88,.06) 0%,transparent 70%);pointer-events:none}
.bl{font-size:12px;color:var(--t3);font-weight:500;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:4px}
.bv{font-size:42px;font-weight:700;letter-spacing:-2px;line-height:1;margin-bottom:12px;font-variant-numeric:tabular-nums}
.pr{display:flex;gap:16px;flex-wrap:wrap}.pi{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:500}
.pb{font-size:12px;font-weight:600;padding:3px 8px;border-radius:6px;font-variant-numeric:tabular-nums}
.pu{background:var(--gd);color:var(--g)}.pdn{background:var(--rd);color:var(--r)}.pn{background:var(--s3);color:var(--t3)}
.sr{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 16px 0}
.sc{background:var(--s1);border:1px solid var(--bd);border-radius:var(--rad);padding:14px;text-align:center}
.sv{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.sla{font-size:11px;color:var(--t3);font-weight:500;text-transform:uppercase;letter-spacing:.8px;margin-top:2px}
.ct{display:flex;gap:8px;margin:12px 16px 0}
.bn{flex:1;padding:14px;border:none;border-radius:var(--rad);font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:transform .15s}
.bn:active{transform:scale(.97)}
.bgo{background:var(--g);color:#000}.bsp{background:var(--r);color:#fff}
.bcy{background:var(--s2);color:var(--t1);border:1px solid var(--bd2);flex:.6}
.bte{background:var(--bld);color:var(--b);border:1px solid rgba(10,132,255,.2);flex:.6}
.sec{margin:20px 16px 0}.sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.stt{font-size:16px;font-weight:700}.snm{font-size:12px;color:var(--t3);background:var(--s2);padding:2px 8px;border-radius:10px}
.clist{display:flex;flex-direction:column;gap:6px}
.tc{background:var(--s1);border:1px solid var(--bd);border-radius:var(--rad);padding:14px 16px}
.tto{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:6px}
.ttk{font-size:14px;font-weight:600;line-height:1.3;flex:1}
.tsd{font-size:11px;font-weight:700;text-transform:uppercase;padding:3px 8px;border-radius:6px;flex-shrink:0}
.sy{background:var(--gd);color:var(--g)}.sno{background:var(--rd);color:var(--r)}
.tm{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--t3)}.tm span{display:flex;align-items:center;gap:3px}
.tre{font-size:12px;color:var(--t2);margin-top:6px;line-height:1.4;font-style:italic}
.tss{font-size:11px;font-weight:600;padding:2px 7px;border-radius:5px;text-transform:uppercase}
.ssim{background:var(--od);color:var(--o)}.spl{background:var(--gd);color:var(--g)}.ser{background:var(--rd);color:var(--r)}
.pc{background:var(--s1);border:1px solid var(--bd);border-radius:var(--rad);padding:14px 16px;display:flex;justify-content:space-between;align-items:center}
.lp{background:var(--s1);border:1px solid var(--bd);border-radius:var(--rad);padding:12px;max-height:300px;overflow-y:auto;font-family:'SF Mono',Menlo,monospace;font-size:11px;line-height:1.6;color:var(--t3);-webkit-overflow-scrolling:touch}
.em{text-align:center;padding:24px 16px;color:var(--t3);font-size:13px}.eic{font-size:28px;margin-bottom:8px;opacity:.4}
.mod{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:100;display:none;align-items:flex-end;justify-content:center}
.mod.open{display:flex}.ms{background:var(--s1);border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:20px;padding-bottom:calc(20px + var(--sb));animation:su .3s ease}
@keyframes su{from{transform:translateY(100%)}to{transform:translateY(0)}}
.mhd{width:36px;height:5px;background:var(--s3);border-radius:3px;margin:0 auto 16px}
.mti{font-size:18px;font-weight:700;margin-bottom:12px}
.tres{padding:12px;background:var(--s2);border-radius:10px;margin-bottom:8px;font-size:13px}
.tres .lb{color:var(--t3);font-size:11px;text-transform:uppercase;letter-spacing:.5px}.tres .vl{font-weight:600;margin-top:2px}
.tok{border-left:3px solid var(--g)}.tfl{border-left:3px solid var(--r)}
.tb{position:fixed;bottom:0;left:0;right:0;background:rgba(17,17,19,.85);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-top:1px solid var(--bd);display:flex;justify-content:space-around;padding:8px 0 calc(8px + var(--sb));z-index:50}
.tab{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:10px;font-weight:500;color:var(--t3);cursor:pointer;padding:4px 12px;border:none;background:none;-webkit-tap-highlight-color:transparent}
.tab.active{color:var(--g)}.tab svg{width:22px;height:22px}
.vw{display:none}.vw.active{display:block}
.spn{width:18px;height:18px;border:2px solid var(--s3);border-top-color:var(--t1);border-radius:50%;animation:sp .6s linear infinite;display:inline-block}
@keyframes sp{to{transform:rotate(360deg)}}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--s3);border-radius:2px}
</style></head><body>
<div class="hd"><div class="hdb"><div class="hdl">KE</div><div class="hdt">Kalshi Edge</div></div><div id="mT" class="tg tgo">OFFLINE</div></div>

<div id="vD" class="vw active">
<div class="hero"><div class="bl">Portfolio Balance</div><div class="bv" id="bal">$0.00</div>
<div class="pr"><div class="pi"><span style="color:var(--t3)">Total</span><span id="tP" class="pb pn">$0.00</span></div>
<div class="pi"><span style="color:var(--t3)">Today</span><span id="dP" class="pb pn">$0.00</span></div></div></div>
<div class="sr"><div class="sc"><div class="sv" id="wr" style="color:var(--g)">0%</div><div class="sla">Win Rate</div></div>
<div class="sc"><div class="sv" id="nt">0</div><div class="sla">Trades</div></div>
<div class="sc"><div class="sv" id="op" style="color:var(--b)">0</div><div class="sla">Open</div></div></div>
<div class="ct"><button class="bn bgo" id="bG" onclick="sB()">&#9654; Start</button>
<button class="bn bsp" id="bS" onclick="xB()" style="display:none">&#9632; Stop</button>
<button class="bn bcy" id="bC" onclick="cy()">&#8635; Cycle</button>
<button class="bn bte" onclick="tt()">&#10003; Test</button></div>
<div class="sec"><div class="sh"><div class="stt">Recent Trades</div><div class="snm" id="tC">0</div></div>
<div class="clist" id="tL"><div class="em"><div class="eic">&#128202;</div>No trades yet</div></div></div></div>

<div id="vP" class="vw"><div class="sec" style="margin-top:8px"><div class="sh"><div class="stt">Open Positions</div><div class="snm" id="pC">0</div></div>
<div class="clist" id="pL"><div class="em"><div class="eic">&#128200;</div>No positions</div></div></div></div>

<div id="vS" class="vw"><div class="sec" style="margin-top:8px"><div class="sh"><div class="stt">Signals</div><div class="snm" id="sC">0</div></div>
<div class="clist" id="sL"><div class="em"><div class="eic">&#129504;</div>Run a cycle to scan</div></div></div></div>

<div id="vL" class="vw"><div class="sec" style="margin-top:8px"><div class="sh"><div class="stt">Logs</div><div class="snm" id="cC">#0</div></div>
<div class="lp" id="lP"><div class="em">Waiting...</div></div></div></div>

<div class="mod" id="md" onclick="if(event.target===this)this.classList.remove('open')">
<div class="ms"><div class="mhd"></div><div class="mti">Connection Test</div>
<div id="tR"><div style="text-align:center;padding:24px"><div class="spn"></div></div></div>
<button class="bn" style="background:var(--s2);color:var(--t1);margin-top:12px;width:100%" onclick="document.getElementById('md').classList.remove('open')">Done</button></div></div>

<div class="tb">
<button class="tab active" onclick="sw('D',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Dashboard</button>
<button class="tab" onclick="sw('P',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Positions</button>
<button class="tab" onclick="sw('S',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>Signals</button>
<button class="tab" onclick="sw('L',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Logs</button></div>

<script>
var e=s=>s?(s+'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'';
function sw(n,t){document.querySelectorAll('.vw').forEach(v=>v.classList.remove('active'));document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));document.getElementById('v'+n).classList.add('active');t.classList.add('active')}

async function sB(){await fetch('/api/bot/start',{method:'POST'});gA()}
async function xB(){await fetch('/api/bot/stop',{method:'POST'});gA()}
async function cy(){var b=document.getElementById('bC');b.innerHTML='<div class="spn"></div>';b.disabled=true;try{await fetch('/api/bot/cycle',{method:'POST'});await gA()}finally{b.innerHTML='&#8635; Cycle';b.disabled=false}}
async function tt(){var m=document.getElementById('md'),r=document.getElementById('tR');m.classList.add('open');r.innerHTML='<div style="text-align:center;padding:24px"><div class="spn"></div><div style="margin-top:8px;color:var(--t3);font-size:13px">Testing Kalshi API...</div></div>';try{var d=await(await fetch('/api/test-connection')).json();r.innerHTML='<div class="tres '+(d.auth==='ok'?'tok':'tfl')+'"><div class="lb">Auth</div><div class="vl">'+(d.auth==='ok'?'&#10004; Connected':'&#10006; '+e(d.authError||d.authStatus))+'</div></div>'+(d.auth==='ok'?'<div class="tres tok"><div class="lb">Balance</div><div class="vl">$'+((d.balance?.balance||0)/100).toFixed(2)+'</div></div>':'')+'<div class="tres '+(d.markets&&!d.markets.includes('fail')?'tok':'tfl')+'"><div class="lb">Markets</div><div class="vl">'+e(d.markets)+'</div></div>'+(d.sampleMarket?'<div class="tres tok"><div class="lb">Sample</div><div class="vl">'+e(d.sampleMarket.title)+'</div></div>':'')}catch(x){r.innerHTML='<div class="tres tfl"><div class="lb">Error</div><div class="vl">'+e(x.message)+'</div></div>'}}

function uD(d){
document.getElementById('bal').textContent='$'+(d.balance/100).toFixed(2);
var te=document.getElementById('tP'),de=document.getElementById('dP'),tv=d.totalPnL/100,dv=d.dailyPnL/100;
te.textContent=(tv>=0?'+':'')+tv.toFixed(2);te.className='pb '+(tv>0?'pu':tv<0?'pdn':'pn');
de.textContent=(dv>=0?'+':'')+dv.toFixed(2);de.className='pb '+(dv>0?'pu':dv<0?'pdn':'pn');
document.getElementById('wr').textContent=d.winRate+'%';
document.getElementById('nt').textContent=d.wins+d.losses;
document.getElementById('op').textContent=d.openPositions;
var tg=document.getElementById('mT');
if(!d.isRunning){tg.textContent='OFFLINE';tg.className='tg tgo'}
else if(d.dryRun){tg.textContent='PAPER';tg.className='tg tgd'}
else{tg.textContent='LIVE';tg.className='tg tgl'}
document.getElementById('bG').style.display=d.isRunning?'none':'flex';
document.getElementById('bS').style.display=d.isRunning?'flex':'none';
document.getElementById('cC').textContent='#'+d.cycleCount}

function rT(t){var el=document.getElementById('tL');document.getElementById('tC').textContent=t.length;
if(!t.length){el.innerHTML='<div class="em"><div class="eic">&#128202;</div>No trades yet</div>';return}
el.innerHTML=t.slice(0,20).map(function(x){return'<div class="tc"><div class="tto"><div class="ttk">'+e(x.title||x.ticker)+'</div><span class="tsd '+(x.side==='yes'?'sy':'sno')+'">'+x.side+'</span></div><div class="tm"><span>'+x.contracts+'x @'+x.priceCents+'c ($'+x.costDollars+')</span><span style="color:var(--g)">'+x.edge+'</span><span class="tss '+(x.status==='simulated'?'ssim':x.status==='placed'?'spl':'ser')+'">'+x.status+'</span></div>'+(x.reasoning?'<div class="tre">'+e(x.reasoning)+'</div>':'')+'</div>'}).join('')}

function rP(p){var el=document.getElementById('pL');document.getElementById('pC').textContent=p.length;
if(!p.length){el.innerHTML='<div class="em"><div class="eic">&#128200;</div>No positions</div>';return}
el.innerHTML=p.map(function(x){return'<div class="pc"><div><div style="font-size:13px;font-weight:600">'+e(x.ticker||x.market_ticker)+'</div><div style="font-size:12px;color:var(--t3)">'+(x.market_outcome||'')+' &middot; '+(x.total_traded||0)+'</div></div><div style="font-size:18px;font-weight:700">'+(x.position||0)+'</div></div>'}).join('')}

function rS(s){var el=document.getElementById('sL');document.getElementById('sC').textContent=s.length;
if(!s.length){el.innerHTML='<div class="em"><div class="eic">&#129504;</div>Run a cycle to scan</div>';return}
el.innerHTML=s.map(function(x){return'<div class="tc"><div class="tto"><div class="ttk">'+e(x.title||x.ticker)+'</div><span class="tsd '+(x.side==='yes'?'sy':'sno')+'">'+x.side+'</span></div><div class="tm"><span>Mkt:'+(x.marketPrice*100).toFixed(0)+'c</span><span>True:'+(x.trueProb*100).toFixed(0)+'c</span><span style="color:var(--g)">Edge:'+(x.edge*100).toFixed(1)+'%</span><span style="color:var(--o)">'+x.confidence+'</span></div>'+(x.reasoning?'<div class="tre">'+e(x.reasoning)+'</div>':'')+'</div>'}).join('')}

function rL(l){var el=document.getElementById('lP');if(!l.length){el.innerHTML='<div class="em">Waiting...</div>';return}
el.innerHTML=l.map(function(x){return'<div style="white-space:pre-wrap;word-break:break-all">'+e(x)+'</div>'}).join('')}

async function gA(){try{var[s,t,p,si,l]=await Promise.all([fetch('/api/status').then(r=>r.json()),fetch('/api/trades').then(r=>r.json()),fetch('/api/positions').then(r=>r.json()),fetch('/api/signals').then(r=>r.json()),fetch('/api/logs').then(r=>r.json())]);uD(s);rT(t);rP(p);rS(si);rL(l)}catch(x){}}
gA();setInterval(gA,8000);
</script></body></html>`;
}
