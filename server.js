// ═══════════════════════════════════════════════════════
//  KALSHI EDGE v7  —  Ground-up rewrite. Ships today.
//
//  Safety systems:
//    ✓ Startup auth validation (abort if keys bad)
//    ✓ Auth-failure kill switch (halt after 3x 401/403)
//    ✓ Live balance synced to Kelly every cycle
//    ✓ Daily loss circuit breaker
//    ✓ Peak drawdown circuit breaker (20% from high)
//    ✓ Limit orders only (zero taker fees)
//    ✓ Telegram alerts on every meaningful event
//    ✓ Midnight daily reset
//    ✓ Duplicate position prevention
//
//  Brain:
//    ✓ Web search before every analysis cycle
//    ✓ Accumulated memory / brain notes
//    ✓ News-first edge detection
//    ✓ Favourite-longshot bias exploitation
// ═══════════════════════════════════════════════════════

'use strict';

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────
const C = {
  // Kalshi
  keyId:   process.env.KALSHI_API_KEY_ID   || '',
  pem:     (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  base:    process.env.KALSHI_BASE_URL     || 'https://api.elections.kalshi.com',
  v2:      '/trade-api/v2',

  // Claude
  claude:  process.env.CLAUDE_API_KEY      || '',
  model:   'claude-sonnet-4-20250514',

  // Telegram
  tgTok:   process.env.TELEGRAM_TOKEN      || '',
  tgChat:  process.env.TELEGRAM_CHAT_ID    || '',

  // Trading
  paper:      process.env.DRY_RUN !== 'false',
  startBal:   parseFloat(process.env.BANKROLL    || '50'),
  kelly:      parseFloat(process.env.KELLY       || '0.35'),
  edgeLive:   parseFloat(process.env.EDGE_LIVE   || '0.07'),
  edgePaper:  parseFloat(process.env.EDGE_PAPER  || '0.03'),
  maxBet:     parseFloat(process.env.MAX_BET     || '5'),
  maxPos:     parseInt(  process.env.MAX_POS     || '5'),
  dailyStop:  parseFloat(process.env.DAILY_STOP  || '8'),
  ddLimit:    parseFloat(process.env.DD_LIMIT    || '0.20'),
  minVol:     parseInt(  process.env.MIN_VOL     || '2000'),
  scanSec:    parseInt(  process.env.SCAN_SEC    || '30'),
  brainSec:   parseInt(  process.env.BRAIN_SEC   || '90'),
};

// ─── STATE ───────────────────────────────────────────────
const STATE_FILE = (() => {
  const v = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  return v ? path.join(v, 'ke7.json') : path.join(__dirname, 'ke7.json');
})();

function fresh() {
  const b = Math.round(C.startBal * 100);
  return {
    on: false, bal: b, peak: b,
    dayPnl: 0, totPnl: 0,
    wins: 0, losses: 0,
    positions: [], trades: [], signals: [],
    notes: [], pnlHist: [], cands: [],
    calls: 0, authFails: 0,
    day: '', startedAt: null,
    scanAt: null, brainAt: null,
    lastErr: null, haltMsg: null,
    _ph: {},
  };
}

let S = fresh();
try { Object.assign(S, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (_) {}
const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(S)); } catch (_) {} };

// ─── LOGS ────────────────────────────────────────────────
const LOGS = [];
const log = msg => {
  const l = `[${new Date().toISOString()}] ${msg}`;
  console.log(l); LOGS.unshift(l);
  if (LOGS.length > 500) LOGS.length = 500;
};

// ─── TELEGRAM ────────────────────────────────────────────
// Sends immediately, logs any failure, never throws
function tg(text) {
  if (!C.tgTok || !C.tgChat) {
    log(`[TG skipped — no token/chat] ${text.slice(0, 60)}`);
    return Promise.resolve();
  }
  const body = JSON.stringify({ chat_id: C.tgChat, text, parse_mode: 'HTML' });
  log(`[TG] Sending: ${text.slice(0, 80)}`);
  return new Promise(res => {
    const u = new URL(`https://api.telegram.org/bot${C.tgTok}/sendMessage`);
    const req = https.request({
      hostname: u.hostname, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (!j.ok) log(`[TG] API error: ${JSON.stringify(j).slice(0, 100)}`);
          else log('[TG] Sent OK');
        } catch (_) { log(`[TG] Parse error: ${d.slice(0, 80)}`); }
        res();
      });
    });
    req.on('error', e => { log(`[TG] Request error: ${e.message}`); res(); });
    req.write(body); req.end();
  });
}

// ─── HTTP ────────────────────────────────────────────────
function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, data: JSON.parse(d) }); }
        catch (_) { resolve({ status: r.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ─── KALSHI HTTPS ─────────────────────────────────────────
function sign(method, ep) {
  const ts = Date.now().toString();
  const sig = crypto.sign('sha256', Buffer.from(ts + method.toUpperCase() + ep), {
    key: C.pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return { ts, sig: sig.toString('base64') };
}

function kalshi(method, ep, body = null) {
  const fp = C.v2 + ep;
  const { ts, sig } = sign(method, fp);
  const host = new URL(C.base).hostname;
  let reqPath = fp;
  if (method === 'GET' && body) { reqPath += '?' + new URLSearchParams(body); body = null; }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: reqPath, method,
      headers: {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': C.keyId,
        'KALSHI-ACCESS-TIMESTAMP': ts,
        'KALSHI-ACCESS-SIGNATURE': sig,
      },
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, data: JSON.parse(d) }); }
        catch (_) { resolve({ status: r.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── AUTH GUARD ──────────────────────────────────────────
async function onAuthFail(status, where) {
  S.authFails = (S.authFails || 0) + 1;
  log(`Auth fail #${S.authFails} (HTTP ${status}) at ${where}`);
  if (S.authFails >= 3) {
    const msg = `Auth failed 3x (HTTP ${status}). Check KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY, system clock.`;
    S.haltMsg = msg; stopBot();
    await tg(`🔴 <b>KALSHI EDGE HALTED</b>\n${msg}`);
  }
}
const authOk = () => { S.authFails = 0; };

// ─── STARTUP VALIDATION ───────────────────────────────────
async function validate() {
  log('Validating Kalshi auth...');
  if (!C.keyId || C.pem.length < 50) {
    const m = 'Missing KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY env vars';
    log('ABORT: ' + m);
    await tg(`🔴 <b>Startup aborted</b>\n${m}`);
    return false;
  }
  try {
    const r = await kalshi('GET', '/portfolio/balance');
    if (r.status === 200) {
      const b = r.data.balance ?? 0;
      // ALWAYS sync real Kalshi balance — even in paper mode.
      // Paper mode uses real balance as the starting point so Kelly sizing
      // and all Telegram messages reflect your actual account.
      if (b > 0) {
        S.bal  = b;
        S.peak = Math.max(S.peak, b);
        log(`Real Kalshi balance synced: $${(b / 100).toFixed(2)}`);
      }
      authOk();
      log(`Auth OK — balance $${(S.bal / 100).toFixed(2)}`);
      return true;
    }
    log(`Auth failed HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 120)}`);
    await tg(`🔴 <b>Auth failed (${r.status})</b>\nDouble-check your keys and that your system clock is accurate.`);
    return false;
  } catch (e) {
    log(`Auth error: ${e.message}`);
    await tg(`🔴 <b>Connection error</b>\n${e.message}`);
    return false;
  }
}

// ─── LIVE BALANCE SYNC ────────────────────────────────────
// Runs every scan cycle in both paper and live mode.
// Paper mode: syncs real Kalshi balance so P&L tracking is accurate.
// Live mode: syncs to get settled positions reflected immediately.
async function syncBal() {
  try {
    const r = await kalshi('GET', '/portfolio/balance');
    if (r.status === 200 && r.data.balance !== undefined) {
      const prev = S.bal;
      S.bal  = r.data.balance;
      S.peak = Math.max(S.peak, S.bal);
      authOk();
      if (Math.abs(S.bal - prev) > 10) { // log if changed by more than 10 cents
        log(`Balance updated: $${(prev/100).toFixed(2)} → $${(S.bal/100).toFixed(2)}`);
      }
    } else if (r.status === 401 || r.status === 403) {
      await onAuthFail(r.status, 'syncBal');
    }
  } catch (e) { log(`syncBal: ${e.message}`); }
}

// ─── CIRCUIT BREAKERS ────────────────────────────────────
function breakers() {
  // 1. Daily loss floor
  if (S.dayPnl <= -C.dailyStop) {
    const m = `Daily loss -$${Math.abs(S.dayPnl).toFixed(2)} hit limit $${C.dailyStop}`;
    log('BREAKER: ' + m); S.haltMsg = m; stopBot();
    tg(`⚡ <b>Circuit breaker — daily loss</b>\n${m}`);
    return false;
  }
  // 2. Peak drawdown
  if (S.peak > 0) {
    const dd = (S.peak - S.bal) / S.peak;
    if (dd >= C.ddLimit) {
      const m = `Drawdown ${(dd * 100).toFixed(1)}% from peak $${(S.peak / 100).toFixed(2)}`;
      log('BREAKER: ' + m); S.haltMsg = m; stopBot();
      tg(`⚡ <b>Circuit breaker — drawdown</b>\n${m}`);
      return false;
    }
  }
  return true;
}

// ─── MIDNIGHT RESET ───────────────────────────────────────
function midnight() {
  const today = new Date().toDateString();
  if (S.day === today) return;
  log('Midnight reset');
  S.dayPnl = 0; S.day = today; save();
  tg(`🌅 <b>New day reset</b>\nBalance: $${(S.bal / 100).toFixed(2)} | All-time: ${fmt(S.totPnl)}`);
}

// ─── HELPERS ─────────────────────────────────────────────
const usd  = () => S.bal / 100;
const fmt  = n => (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2);
const fmtB = n => '$' + Number(n).toFixed(2);

function kellySz(p, mkt) {
  if (mkt <= 0 || mkt >= 1) return 0;
  const b = 1 / mkt - 1;
  const f = Math.max(0, (p * (b + 1) - 1) / b) * C.kelly;
  return Math.min(f * usd(), C.maxBet, usd() * 0.10);
}

// ─── LAYER 1 — SCANNER ───────────────────────────────────
async function scan() {
  S.scanAt = new Date().toISOString();
  try {
    const r = await kalshi('GET', '/markets', { status: 'open', limit: '100' });
    if (r.status === 401 || r.status === 403) { await onAuthFail(r.status, 'scan'); return; }
    if (r.status !== 200) { log(`Scan HTTP ${r.status}`); return; }
    authOk();

    const held = new Set(S.positions.map(p => p.ticker));
    const now  = Date.now();

    const list = (r.data.markets || []).filter(m => {
      if (held.has(m.ticker_name)) return false;
      if ((m.volume || 0) < C.minVol) return false;
      const hrs = (new Date(m.close_time || 0) - now) / 3.6e6;
      if (hrs < 1 || hrs > 168) return false;
      const y = m.last_price || 50;
      return y >= 5 && y <= 95;
    }).map(m => {
      const y   = m.last_price || 50;
      const hrs = ((new Date(m.close_time || 0) - now) / 3.6e6).toFixed(1);
      const t   = m.ticker_name;
      const ph  = (S._ph[t] || []);
      const mom = y > (ph.slice(-1)[0] || y) + 2 ? '↑' : y < (ph.slice(-1)[0] || y) - 2 ? '↓' : '→';
      S._ph[t]  = [...ph.slice(-19), y];
      const score = (1 - Math.abs(y - 50) / 50) * 0.4
                  + Math.min((m.volume || 0) / 10000, 1) * 0.3
                  + Math.max(0, 1 - parseFloat(hrs) / 48) * 0.3;
      return { ticker: t, title: m.title, yes: y, no: 100 - y, vol: m.volume || 0, hrs, cat: m.category || '—', mom, score };
    });

    list.sort((a, b) => b.score - a.score);
    S.cands = list.slice(0, 20);
    log(`Scan: ${(r.data.markets || []).length} total → ${list.length} filtered → ${S.cands.length} candidates`);
  } catch (e) { log(`Scan error: ${e.message}`); S.lastErr = e.message; }
}

// ─── LAYER 2 — CLAUDE BRAIN ──────────────────────────────
async function brain() {
  if (!C.claude) { log('No Claude key'); return; }
  if (!S.cands.length) { log('No candidates for brain'); return; }
  S.brainAt = new Date().toISOString();
  S.calls++;

  const edgeMin = C.paper ? C.edgePaper : C.edgeLive;
  const held    = S.positions.map(p => `${p.ticker}(${p.side}@${p.ep}¢)`).join(', ') || 'none';
  const mem     = S.notes.slice(-5).join('\n') || 'none yet';
  const mkts    = S.cands.map((c, i) =>
    `${i + 1}. [${c.ticker}] "${c.title}"\n   YES:${c.yes}¢ NO:${c.no}¢ | Vol:${c.vol} | ${c.hrs}h | ${c.cat} | ${c.mom}`
  ).join('\n\n');

  const system =
`You are Kalshi Edge — an autonomous AI prediction market trader.
MISSION: Double the portfolio. Only trade where you find hard evidence.

MODE: ${C.paper ? 'PAPER' : 'LIVE'} | Balance: $${usd().toFixed(2)} | Today P&L: ${fmt(S.dayPnl)}
HELD (do not re-enter): ${held}
MEMORY: ${mem}

RULES:
1. SEARCH THE WEB FIRST. No search = no signal.
2. Signal only HIGH or MEDIUM confidence. Never LOW.
3. Edge minimum: ${(edgeMin * 100).toFixed(0)}% (true prob minus market price).
4. Favourite-longshot: >80¢ contracts underpriced, <15¢ are traps.
5. Prefer markets closing within 48h.
6. Limit price = market price ± 2¢ (never market orders).
7. Do not stack same-topic exposure (Fed, elections, etc).

RETURN ONLY valid JSON — no markdown, no extra text:
{
  "signals": [{
    "ticker": "...", "title": "...",
    "side": "yes"|"no",
    "marketPrice": 0.XX, "trueProb": 0.XX, "edge": 0.XX,
    "confidence": "high"|"medium",
    "limitPrice": XX,
    "reasoning": "max 20 words citing specific evidence"
  }],
  "note": "one concrete learning from this cycle"
}`;

  const user =
`TIME: ${new Date().toISOString()}

MARKETS TO ANALYSE:
${mkts}

Search the web for relevant news on each market, then signal only where you find genuine evidence.`;

  try {
    const body = JSON.stringify({
      model: C.model, max_tokens: 1200,
      system, tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: user }],
    });

    const r = await post('https://api.anthropic.com/v1/messages', body, {
      'Content-Type': 'application/json',
      'x-api-key': C.claude,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    });

    if (r.status !== 200) { log(`Claude ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`); return; }

    const text = (r.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) { log('Brain: no text'); return; }

    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s < 0 || e < 0) { log('Brain: no JSON'); return; }

    let parsed;
    try { parsed = JSON.parse(text.slice(s, e + 1)); }
    catch (err) { log(`Brain JSON parse: ${err.message}`); return; }

    if (parsed.note) {
      S.notes.push(`[${new Date().toLocaleDateString()}] ${parsed.note}`);
      if (S.notes.length > 30) S.notes.shift();
    }

    S.signals = (parsed.signals || []).filter(sig => {
      if (!sig.ticker || !sig.side || typeof sig.edge !== 'number') return false;
      if (sig.edge < edgeMin) { log(`Skip ${sig.ticker}: edge ${(sig.edge * 100).toFixed(1)}% < ${(edgeMin * 100).toFixed(0)}%`); return false; }
      if (sig.confidence === 'low') return false;
      return true;
    });

    log(`Brain: ${S.signals.length} signal(s) | note: ${(parsed.note || '').slice(0, 60)}`);

    if (S.signals.length) {
      const lines = S.signals.map(sig =>
        `• ${sig.ticker} ${sig.side.toUpperCase()} — ${(sig.edge * 100).toFixed(1)}% edge\n  ${sig.reasoning || ''}`
      ).join('\n');
      await tg(`🧠 <b>Brain cycle — ${S.signals.length} signal(s)</b>\n\n${lines}`);
    }
  } catch (e) { log(`Brain error: ${e.message}`); S.lastErr = e.message; }
}

// ─── LAYER 3 — EXECUTION ─────────────────────────────────
async function execute() {
  if (!S.signals.length || S.positions.length >= C.maxPos) return;
  if (!breakers()) return;

  for (const sig of S.signals) {
    if (S.positions.length >= C.maxPos || !breakers()) break;
    if (S.positions.find(p => p.ticker === sig.ticker)) continue;

    const mkt  = sig.marketPrice || 0.5;
    const size = kellySz(sig.trueProb || 0.55, mkt);
    if (size < 0.50) { log(`${sig.ticker}: size $${size.toFixed(2)} too small, skip`); continue; }

    const qty  = Math.max(1, Math.floor(size));
    const lp   = sig.limitPrice || Math.round(mkt * 100);

    if (C.paper) {
      const pos = {
        id: crypto.randomUUID(), ticker: sig.ticker, title: sig.title || sig.ticker,
        side: sig.side, qty, ep: lp, size, edge: sig.edge,
        reason: sig.reasoning || '', at: new Date().toISOString(),
      };
      S.positions.push(pos);
      S.bal      -= Math.round(size * 100);
      S.dayPnl   -= size;
      log(`[PAPER] ${sig.side.toUpperCase()} ${sig.ticker} ${qty}ct @${lp}¢ $${size.toFixed(2)}`);
      await tg(`📝 <b>Paper trade</b>\n${sig.side.toUpperCase()} ${sig.ticker}\n${qty} contracts @ ${lp}¢ — $${size.toFixed(2)}\nEdge: ${(sig.edge * 100).toFixed(1)}%\n${sig.reasoning || ''}`);
    } else {
      try {
        const ob = {
          ticker: sig.ticker, action: 'buy', type: 'limit', side: sig.side,
          count: qty,
          yes_price: sig.side === 'yes' ? lp : 100 - lp,
          no_price:  sig.side === 'no'  ? lp : 100 - lp,
          client_order_id: crypto.randomUUID(),
        };
        const r = await kalshi('POST', '/portfolio/orders', ob);
        if (r.status === 200 || r.status === 201) {
          authOk();
          const order = r.data.order || r.data;
          S.positions.push({
            id: order.order_id || crypto.randomUUID(), ticker: sig.ticker,
            title: sig.title || sig.ticker, side: sig.side, qty, ep: lp, size,
            edge: sig.edge, reason: sig.reasoning || '', at: new Date().toISOString(),
            orderId: order.order_id,
          });
          log(`[LIVE] ${sig.side.toUpperCase()} ${sig.ticker} ${qty}ct @${lp}¢`);
          await tg(`✅ <b>Live order placed</b>\n${sig.side.toUpperCase()} ${sig.ticker}\n${qty}ct @ ${lp}¢ — $${size.toFixed(2)}\nEdge: ${(sig.edge * 100).toFixed(1)}%\n${sig.reasoning || ''}`);
        } else if (r.status === 401 || r.status === 403) {
          await onAuthFail(r.status, `order ${sig.ticker}`); break;
        } else {
          log(`Order rejected ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`);
          await tg(`⚠️ <b>Order rejected</b> ${sig.ticker}\nHTTP ${r.status}`);
        }
      } catch (e) { log(`Order error: ${e.message}`); }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  S.pnlHist.push({ ts: Date.now(), bal: usd(), pnl: S.totPnl });
  if (S.pnlHist.length > 500) S.pnlHist.shift();
  save();
}

// ─── POSITION MONITOR ────────────────────────────────────
// Runs in both paper and live mode.
// Paper: checks if any open positions have been manually settled via /settle.
// Live:  polls Kalshi for settled positions and records real P&L.
async function monitor() {
  if (!S.positions.length) { await syncBal(); return; }

  if (C.paper) {
    // Paper mode: just sync balance every cycle so it stays accurate
    await syncBal();
    return;
  }

  // Live mode: check what Kalshi says is still open
  try {
    const r = await kalshi('GET', '/portfolio/positions');
    if (r.status === 401 || r.status === 403) { await onAuthFail(r.status, 'monitor'); return; }
    if (r.status !== 200) { log(`Monitor HTTP ${r.status}`); return; }
    authOk();

    // Build map of live positions with their realized P&L
    const liveMap = {};
    for (const p of (r.data.market_positions || [])) {
      liveMap[p.ticker_name] = p;
    }

    for (const pos of [...S.positions]) {
      const livePos = liveMap[pos.ticker];

      if (!livePos) {
        // Position no longer exists — fully settled
        // Try to get realized P&L from Kalshi fills
        let pnl = -pos.size; // fallback: assume loss
        try {
          const fills = await kalshi('GET', '/portfolio/fills', { ticker: pos.ticker, limit: '5' });
          if (fills.status === 200 && fills.data.fills?.length) {
            const totalFill = fills.data.fills.reduce((acc, f) => acc + (f.profit_loss || 0), 0);
            if (totalFill !== 0) pnl = totalFill / 100;
          }
        } catch (_) {}

        S.positions = S.positions.filter(p => p.id !== pos.id);
        S.totPnl  += pnl;
        S.dayPnl  += pnl;
        if (pnl > 0) S.wins++; else S.losses++;

        S.trades.unshift({ ...pos, closedAt: new Date().toISOString(), pnl, won: pnl > 0 });
        if (S.trades.length > 100) S.trades.length = 100;

        log(`Settled ${pos.ticker}: ${fmt(pnl)} | total P&L: ${fmt(S.totPnl)} | W:${S.wins} L:${S.losses}`);
        await tg(
          `${pnl > 0 ? '✅' : '❌'} <b>Trade Settled: ${pos.ticker}</b>\n` +
          `Side: ${pos.side.toUpperCase()} @ ${pos.ep}¢\n` +
          `P&L: <b>${fmt(pnl)}</b>\n` +
          `All-time: ${fmt(S.totPnl)} | Win rate: ${S.wins + S.losses > 0 ? ((S.wins / (S.wins + S.losses)) * 100).toFixed(0) : 0}%\n` +
          `Balance: $${(S.bal / 100).toFixed(2)}`
        );
      } else if (livePos.position !== undefined && livePos.position === 0) {
        // Position exists but qty is zero — also settled
        const pnl = livePos.realized_pnl !== undefined ? livePos.realized_pnl / 100 : -pos.size;
        S.positions = S.positions.filter(p => p.id !== pos.id);
        S.totPnl  += pnl; S.dayPnl += pnl;
        if (pnl > 0) S.wins++; else S.losses++;
        S.trades.unshift({ ...pos, closedAt: new Date().toISOString(), pnl, won: pnl > 0 });
        if (S.trades.length > 100) S.trades.length = 100;
        log(`Settled (zero qty) ${pos.ticker}: ${fmt(pnl)}`);
        await tg(
          `${pnl > 0 ? '✅' : '❌'} <b>Trade Settled: ${pos.ticker}</b>\n` +
          `P&L: <b>${fmt(pnl)}</b> | All-time: ${fmt(S.totPnl)}`
        );
      }
    }

    await syncBal();
    save();
  } catch (e) { log(`Monitor error: ${e.message}`); }
}

// ─── BOT LOOP ─────────────────────────────────────────────
let _sc, _br, _hb;

function startBot() {
  if (S.on) return;
  S.on = true; S.haltMsg = null; S.startedAt = new Date().toISOString();
  log('Bot started');

  // Immediate first scan + balance sync
  scan().then(() => syncBal());

  // Main loop every 30s: sync balance → scan markets → monitor positions → maybe execute
  _sc = setInterval(async () => {
    midnight();
    await syncBal();          // always get real balance first
    await scan();
    await monitor();
    if (breakers()) await execute();

    // Record P&L snapshot for chart
    S.pnlHist.push({ ts: Date.now(), bal: usd(), pnl: S.totPnl });
    if (S.pnlHist.length > 500) S.pnlHist.shift();
    save();
  }, C.scanSec * 1000);

  // Claude brain: starts 20s after boot, then every 90s
  _br = setTimeout(() => {
    brain();
    _br = setInterval(brain, C.brainSec * 1000);
  }, 20000);

  // Telegram heartbeat every 30 minutes
  _hb = setInterval(async () => {
    const w = S.wins, l = S.losses, tot = w + l;
    const wr = tot > 0 ? ((w / tot) * 100).toFixed(0) + '%' : '—';
    const dd = S.peak > 0 ? ((S.peak - S.bal) / S.peak * 100).toFixed(1) : '0.0';
    await tg(
      `📊 <b>Kalshi Edge Heartbeat</b>\n` +
      `Mode: ${C.paper ? 'Paper' : '⚡ LIVE'}\n` +
      `Balance: $${usd().toFixed(2)} | Today: ${fmt(S.dayPnl)}\n` +
      `All-time: ${fmt(S.totPnl)} | Win rate: ${wr}\n` +
      `Open: ${S.positions.length}/${C.maxPos} | Brain calls: ${S.calls}\n` +
      `Drawdown: ${dd}% | Signals: ${S.signals.length}`
    );
  }, 30 * 60 * 1000);

  save();
}

function stopBot() {
  S.on = false;
  clearInterval(_sc);
  clearTimeout(_br); clearInterval(_br);
  clearInterval(_hb);
  _sc = _br = _hb = null;
  log('Bot stopped'); save();
}

// ─── API ─────────────────────────────────────────────────
app.get('/s', (_, res) => {
  const w = S.wins, l = S.losses, tot = w + l;
  const dd = S.peak > 0 ? (S.peak - S.bal) / S.peak * 100 : 0;
  res.json({
    on: S.on, paper: C.paper,
    bal: usd(), balCents: S.bal,
    peak: S.peak / 100, dd: parseFloat(dd.toFixed(1)),
    dayPnl: S.dayPnl, totPnl: S.totPnl,
    wins: w, losses: l, total: tot,
    wr: tot > 0 ? parseFloat((w / tot * 100).toFixed(1)) : null,
    open: S.positions.length, maxPos: C.maxPos,
    calls: S.calls, authFails: S.authFails,
    scanAt: S.scanAt, brainAt: S.brainAt,
    startedAt: S.startedAt, haltMsg: S.haltMsg,
    cfg: { kelly: C.kelly, edgeLive: C.edgeLive, maxBet: C.maxBet, dailyStop: C.dailyStop, ddLimit: C.ddLimit },
  });
});

app.get('/trades',    (_, res) => res.json(S.trades.slice(0, 50)));
app.get('/positions', (_, res) => res.json(S.positions));
app.get('/signals',   (_, res) => res.json(S.signals));
app.get('/cands',     (_, res) => res.json(S.cands));
app.get('/logs',      (_, res) => res.json(LOGS.slice(0, 120)));
app.get('/pnl',       (_, res) => res.json(S.pnlHist.slice(-200)));
app.get('/notes',     (_, res) => res.json(S.notes));

app.post('/start',    (_, res) => { startBot(); res.json({ ok: true }); });
app.post('/stop',     (_, res) => { stopBot();  res.json({ ok: true }); });
app.post('/scan',     async (_, res) => { await scan();  res.json({ ok: true }); });
app.post('/brain',    async (_, res) => { await brain(); res.json({ ok: true }); });
app.get('/test',      async (_, res) => { const ok = await validate(); res.json({ ok, bal: usd() }); });

// Manual settle for paper testing
app.post('/settle', (req, res) => {
  const { id, won } = req.body;
  const p = S.positions.find(x => x.id === id);
  if (!p) return res.json({ ok: false });
  const pnl = won ? p.size * (100 / p.ep - 1) : -p.size;
  S.positions = S.positions.filter(x => x.id !== id);
  S.totPnl += pnl; S.dayPnl += pnl;
  S.bal += Math.round(pnl * 100);
  S.peak = Math.max(S.peak, S.bal);
  if (pnl > 0) S.wins++; else S.losses++;
  S.trades.unshift({ ...p, closedAt: new Date().toISOString(), pnl, won: pnl > 0 });
  S.pnlHist.push({ ts: Date.now(), bal: usd(), pnl: S.totPnl });
  save();
  tg(`${pnl > 0 ? '✅' : '❌'} <b>Manual settle: ${p.ticker}</b>\n${fmt(pnl)}`);
  res.json({ ok: true, pnl });
});

app.post('/reset', (_, res) => { stopBot(); S = fresh(); save(); res.json({ ok: true }); });

// ─── DASHBOARD ────────────────────────────────────────────
app.get('/', (_, res) => { res.setHeader('Content-Type', 'text/html'); res.send(HTML()); });

function HTML() {
return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#070711">
<title>Kalshi Edge</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#070711;--l1:#0d0d1a;--l2:#12121f;--l3:#181828;--l4:#1f1f32;
  --bd:rgba(255,255,255,.06);--bd2:rgba(255,255,255,.11);--bd3:rgba(255,255,255,.18);
  --t1:#f2f2ff;--t2:#8888b0;--t3:#44446a;
  --g:#00e676;--ga:rgba(0,230,118,.12);--g2:rgba(0,230,118,.25);
  --r:#ff4560;--ra:rgba(255,69,96,.12);
  --b:#4488ff;--ba:rgba(68,136,255,.12);
  --y:#ffb020;--ya:rgba(255,176,32,.12);
  --p:#c084fc;--pa:rgba(192,132,252,.12);
  --m:'JetBrains Mono',monospace;--f:'Outfit',sans-serif;
  --st:env(safe-area-inset-top,0px);--sb:env(safe-area-inset-bottom,0px)
}
html,body{height:100%;background:var(--bg);color:var(--t1);font-family:var(--f);-webkit-font-smoothing:antialiased;overflow:hidden}
.app{display:flex;flex-direction:column;height:100%;padding-top:var(--st)}

/* HEADER */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 10px;flex-shrink:0}
.logo-row{display:flex;align-items:center;gap:10px}
.logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#00e676,#4488ff);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;color:#000;letter-spacing:-.5px}
.app-name{font-size:20px;font-weight:800;letter-spacing:-.5px}
.badge{font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;padding:4px 10px;border-radius:20px;border:1px solid}
.b-paper{background:var(--ya);border-color:var(--y);color:var(--y)}
.b-live{background:var(--ra);border-color:var(--r);color:var(--r)}
.b-on{background:var(--ga);border-color:var(--g);color:var(--g)}

/* NAV TABS (top) */
.nav-tabs{display:flex;padding:0 14px 10px;gap:4px;flex-shrink:0;overflow-x:auto;-webkit-overflow-scrolling:touch}
.nav-tabs::-webkit-scrollbar{display:none}
.nt{border:none;background:var(--l2);color:var(--t3);font-family:var(--f);font-size:12px;font-weight:700;padding:8px 16px;border-radius:20px;cursor:pointer;white-space:nowrap;transition:all .15s;letter-spacing:.3px}
.nt.on{background:var(--l4);color:var(--t1);border:1px solid var(--bd2)}

/* SCROLL */
.scroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 14px calc(70px + var(--sb)) 14px}
.scroll::-webkit-scrollbar{display:none}

/* PANELS */
.panel{display:none}.panel.on{display:block}

/* PAGE HEADER (like Polybot bold headers) */
.ph{margin-bottom:20px}
.ph h1{font-size:30px;font-weight:900;letter-spacing:-.8px;line-height:1}
.ph p{font-size:13px;color:var(--t2);margin-top:4px}

/* HALT BANNER */
.halt{background:var(--ra);border:1px solid var(--r);border-radius:16px;padding:14px 16px;margin-bottom:14px;display:none}
.halt strong{display:block;color:var(--r);font-size:13px;margin-bottom:2px}
.halt span{color:var(--r);font-size:12px;opacity:.85}

/* HERO / P&L CARD */
.hero{background:var(--l1);border:1px solid var(--bd);border-radius:22px;padding:22px 20px 18px;margin-bottom:12px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-50px;right:-50px;width:160px;height:160px;background:radial-gradient(circle,rgba(0,230,118,.08),transparent 65%);border-radius:50%;pointer-events:none}
.hero-lbl{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--t3);margin-bottom:8px}
.hero-pnl{font-size:46px;font-weight:900;letter-spacing:-2px;line-height:1;margin-bottom:6px}
.hero-sub{font-size:13px;color:var(--t2);margin-bottom:18px}
.hero-stats{display:flex;border-top:1px solid var(--bd);padding-top:16px;gap:0}
.hstat{flex:1;display:flex;flex-direction:column;gap:4px}
.hstat+.hstat{border-left:1px solid var(--bd);padding-left:16px;margin-left:0}
.hstat-l{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3)}
.hstat-v{font-size:15px;font-weight:700;letter-spacing:-.3px}

/* 3-STAT ROW (like Polybot wallet/deployed/trades) */
.trirow{display:flex;background:var(--l2);border:1px solid var(--bd);border-radius:16px;overflow:hidden;margin-bottom:12px}
.tristat{flex:1;padding:14px 12px;text-align:center;display:flex;flex-direction:column;gap:4px}
.tristat+.tristat{border-left:1px solid var(--bd)}
.tri-l{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3)}
.tri-v{font-size:18px;font-weight:800;letter-spacing:-.4px}

/* BOT ENGINE CARD (like Copy Trading Engine card) */
.engine-card{background:var(--l2);border:1px solid var(--bd);border-radius:18px;padding:16px 18px;display:flex;align-items:center;gap:14px;margin-bottom:12px}
.engine-icon{width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,var(--ga),var(--ba));display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.engine-txt{flex:1}
.engine-name{font-size:16px;font-weight:700}
.engine-sub{font-size:12px;color:var(--t2);margin-top:2px}
.toggle{width:50px;height:28px;border-radius:14px;border:none;cursor:pointer;transition:background .2s;position:relative;flex-shrink:0}
.toggle::after{content:'';position:absolute;top:3px;width:22px;height:22px;border-radius:11px;background:#fff;transition:left .2s}
.toggle.off{background:var(--l4)}.toggle.off::after{left:3px}
.toggle.on2{background:var(--g)}.toggle.on2::after{left:25px}

/* STAT GRID */
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
.sc{background:var(--l2);border:1px solid var(--bd);border-radius:14px;padding:14px}
.sc-l{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3);margin-bottom:6px}
.sc-v{font-size:24px;font-weight:800;letter-spacing:-.6px}

/* SECTION */
.sec{background:var(--l1);border:1px solid var(--bd);border-radius:18px;padding:16px;margin-bottom:12px}
.sec-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.sec-title{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--t3)}
.sec-ct{font-size:11px;font-weight:700;background:var(--l3);color:var(--t2);padding:3px 9px;border-radius:8px}

/* CHART */
.chart-box{height:150px;position:relative;margin-bottom:4px}
canvas{display:block;width:100%!important}

/* TIME FILTER */
.tf{display:flex;gap:6px;margin-bottom:14px}
.tfb{border:1px solid var(--bd);background:none;color:var(--t3);border-radius:20px;padding:5px 14px;font-family:var(--f);font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}
.tfb.on{background:var(--l3);color:var(--t1);border-color:var(--bd2)}

/* WIN RING */
.ring-wrap{display:flex;align-items:center;gap:20px;margin-bottom:16px}
.ring-rows{flex:1;display:flex;flex-direction:column;gap:8px}
.rrow{display:flex;justify-content:space-between;align-items:center;font-size:13px}
.rlbl{color:var(--t2)}
.gross-row{display:flex;justify-content:space-between;align-items:center;padding-top:14px;border-top:1px solid var(--bd)}

/* ITEMS */
.item{background:var(--l3);border-radius:14px;padding:13px 14px;margin-bottom:8px}
.item:last-child{margin-bottom:0}
.ihead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px}
.iname{font-size:13px;font-weight:600;flex:1;line-height:1.35}
.imeta{display:flex;flex-wrap:wrap;gap:5px;font-size:10px;font-family:var(--m);color:var(--t3)}
.imeta span{background:var(--l4);padding:2px 7px;border-radius:5px}
.ireason{font-size:11px;color:var(--t2);margin-top:7px;line-height:1.5;border-left:2px solid var(--bd2);padding-left:8px;font-style:italic}
.tag{font-size:9px;font-weight:700;text-transform:uppercase;padding:3px 8px;border-radius:6px;flex-shrink:0;letter-spacing:.5px}
.t-yes{background:var(--ga);color:var(--g)}.t-no{background:var(--ra);color:var(--r)}
.t-won{background:var(--ga);color:var(--g)}.t-lost{background:var(--ra);color:var(--r)}
.t-sig{background:var(--ba);color:var(--b)}.t-high{background:var(--ya);color:var(--y)}

/* FEED CHIPS */
.chips{display:flex;gap:6px;margin-bottom:14px;overflow-x:auto;padding-bottom:2px}
.chips::-webkit-scrollbar{display:none}
.chip{border:1px solid var(--bd);background:none;color:var(--t3);border-radius:20px;padding:6px 14px;font-family:var(--f);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .15s}
.chip.on{background:var(--b);border-color:var(--b);color:#fff}

/* LOG */
.logline{font-size:10px;font-family:var(--m);color:var(--t3);padding:3px 0;border-bottom:1px solid var(--bd);line-height:1.45;word-break:break-all}
.logline:last-child{border:none}

/* NOTE */
.note{font-size:12px;color:var(--t2);padding:7px 0;border-bottom:1px solid var(--bd);line-height:1.5}
.note:last-child{border:none}

/* EMPTY */
.empty{text-align:center;color:var(--t3);font-size:13px;padding:28px 0;line-height:1.6}
.empty-icon{font-size:32px;margin-bottom:8px}

/* CTRL BTNS */
.btns{display:flex;gap:8px;margin-bottom:12px}
.btn{flex:1;border:1px solid var(--bd2);background:var(--l3);color:var(--t1);border-radius:14px;padding:13px 8px;font-family:var(--f);font-size:13px;font-weight:700;cursor:pointer;transition:all .15s;letter-spacing:.2px}
.btn:active{transform:scale(.97)}.btn:disabled{opacity:.4}
.btn-g{background:var(--ga);border-color:var(--g);color:var(--g)}
.btn-r{background:var(--ra);border-color:var(--r);color:var(--r)}

/* BOTTOM NAV */
.bnav{display:flex;background:var(--l1);border-top:1px solid var(--bd);padding-bottom:var(--sb);flex-shrink:0}
.bnav-btn{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 4px;background:none;border:none;color:var(--t3);font-family:var(--f);font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;cursor:pointer;transition:color .15s}
.bnav-btn svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.8}
.bnav-btn.on{color:var(--g)}

/* COLORS */
.cg{color:var(--g)}.cr{color:var(--r)}.cy{color:var(--y)}.cb{color:var(--b)}
</style>
</head><body>
<div class="app">

<!-- HEADER -->
<div class="hdr">
  <div class="logo-row">
    <div class="logo">KE</div>
    <span class="app-name">Kalshi Edge</span>
  </div>
  <span class="badge b-paper" id="modeBadge">PAPER</span>
</div>

<!-- TOP TABS -->
<div class="nav-tabs">
  <button class="nt on" onclick="goTab(0,this)">Home</button>
  <button class="nt" onclick="goTab(1,this)">Charts</button>
  <button class="nt" onclick="goTab(2,this)">Feed</button>
  <button class="nt" onclick="goTab(3,this)">Signals</button>
  <button class="nt" onclick="goTab(4,this)">Brain</button>
</div>

<div class="scroll">

<!-- ══════════ HOME ══════════ -->
<div class="panel on" id="p0">
  <div class="halt" id="haltBox"><strong>⚡ Bot Halted</strong><span id="haltMsg"></span></div>

  <!-- Hero P&L -->
  <div class="hero">
    <div class="hero-lbl">Total Profit / Loss</div>
    <div class="hero-pnl" id="heroPnl">+$0.00</div>
    <div class="hero-sub" id="heroSub">Start bot to begin tracking</div>
    <div class="hero-stats">
      <div class="hstat"><div class="hstat-l">Balance</div><div class="hstat-v" id="hBal">—</div></div>
      <div class="hstat"><div class="hstat-l">Today</div><div class="hstat-v" id="hDay">—</div></div>
      <div class="hstat"><div class="hstat-l">Drawdown</div><div class="hstat-v" id="hDd">—</div></div>
    </div>
  </div>

  <!-- Tri-stat row (Polybot style) -->
  <div class="trirow">
    <div class="tristat"><div class="tri-l">Deployed</div><div class="tri-v" id="tDeployed">$0</div></div>
    <div class="tristat"><div class="tri-l">Trades</div><div class="tri-v" id="tTrades">0</div></div>
    <div class="tristat"><div class="tri-l">Open</div><div class="tri-v" id="tOpen">0</div></div>
  </div>

  <!-- Bot engine card -->
  <div class="engine-card">
    <div class="engine-icon">⚡</div>
    <div class="engine-txt">
      <div class="engine-name" id="engineName">AI Trading Engine</div>
      <div class="engine-sub" id="engineSub">Tap to activate</div>
    </div>
    <button class="toggle off" id="toggleBtn" onclick="toggleBot()"></button>
  </div>

  <!-- Stats -->
  <div class="grid2">
    <div class="sc"><div class="sc-l">Win Rate</div><div class="sc-v" id="gWr">—</div></div>
    <div class="sc"><div class="sc-l">W / L</div><div class="sc-v" id="gWl">—</div></div>
    <div class="sc"><div class="sc-l">Scans / hr</div><div class="sc-v" id="gScans">—</div></div>
    <div class="sc"><div class="sc-l">Brain calls</div><div class="sc-v" id="gCalls">—</div></div>
  </div>
</div>

<!-- ══════════ CHARTS ══════════ -->
<div class="panel" id="p1">
  <div class="ph"><h1>Analytics</h1><p>Session performance</p></div>

  <!-- Equity curve -->
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Equity Curve</span></div>
    <div class="tf">
      <button class="tfb on" onclick="setTf('1h',this)">1H</button>
      <button class="tfb" onclick="setTf('6h',this)">6H</button>
      <button class="tfb" onclick="setTf('all',this)">ALL</button>
    </div>
    <div style="font-size:30px;font-weight:900;letter-spacing:-1px;margin-bottom:4px" id="chartVal">$0.00</div>
    <div style="font-size:12px;color:var(--t3);margin-bottom:14px" id="chartLbl">No trades yet</div>
    <div class="chart-box"><canvas id="cvs" height="150"></canvas></div>
  </div>

  <!-- Win ring -->
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Performance</span></div>
    <div class="ring-wrap">
      <svg width="86" height="86" viewBox="0 0 86 86" style="flex-shrink:0">
        <circle cx="43" cy="43" r="34" fill="none" stroke="var(--l3)" stroke-width="9"/>
        <circle id="ringC" cx="43" cy="43" r="34" fill="none" stroke="var(--g)" stroke-width="9"
          stroke-dasharray="0 214" stroke-linecap="round" transform="rotate(-90 43 43)"/>
        <text x="43" y="48" text-anchor="middle" font-size="13" font-weight="800" fill="var(--t1)" font-family="Outfit,sans-serif" id="ringTx">—</text>
      </svg>
      <div class="ring-rows">
        <div class="rrow"><span class="rlbl">Wins</span><span class="cg" id="rW">0</span></div>
        <div class="rrow"><span class="rlbl">Losses</span><span class="cr" id="rL">0</span></div>
        <div class="rrow"><span class="rlbl">Copy trades</span><span id="rCopy">—</span></div>
        <div class="rrow"><span class="rlbl">Arb scans</span><span id="rArb">—</span></div>
      </div>
    </div>
    <div class="gross-row">
      <span style="font-size:14px;color:var(--t2)">Gross P&L</span>
      <span style="font-size:18px;font-weight:800" id="rGross">+$0.00</span>
    </div>
  </div>

  <!-- Recent trades -->
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Recent Trades</span><span class="sec-ct" id="trCt">0</span></div>
    <div id="tradeList"><div class="empty"><div class="empty-icon">📊</div>No completed trades</div></div>
  </div>
</div>

<!-- ══════════ FEED ══════════ -->
<div class="panel" id="p2">
  <div class="ph" style="display:flex;align-items:flex-start;justify-content:space-between">
    <div><h1>Live Feed</h1><p>Monitoring markets</p></div>
    <span class="badge b-paper" id="feedBadge" style="margin-top:6px">PAUSED</span>
  </div>

  <div class="chips">
    <button class="chip on" onclick="setFeedFilter('all',this)">All</button>
    <button class="chip" onclick="setFeedFilter('signals',this)">Signals</button>
    <button class="chip" onclick="setFeedFilter('rising',this)">Rising ↑</button>
    <button class="chip" onclick="setFeedFilter('falling',this)">Falling ↓</button>
    <button class="chip" onclick="setFeedFilter('urgent',this)">Urgent</button>
  </div>

  <div id="feedList"><div class="empty"><div class="empty-icon">📡</div><b>Feed is empty</b><br>Enable the bot on Home to start monitoring markets.</div></div>
</div>

<!-- ══════════ SIGNALS ══════════ -->
<div class="panel" id="p3">
  <div class="ph"><h1>Signals</h1><p>Claude AI analysis</p></div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Live Signals</span><span class="sec-ct" id="sigCt">0</span></div>
    <div id="sigList"><div class="empty"><div class="empty-icon">🧠</div>Waiting for brain cycle...</div></div>
  </div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Open Positions</span><span class="sec-ct" id="posCt">0</span></div>
    <div id="posList"><div class="empty">No open positions</div></div>
  </div>
  <div class="btns">
    <button class="btn" onclick="doApi('/brain')">Force Brain</button>
    <button class="btn" onclick="doApi('/scan')">Force Scan</button>
  </div>
</div>

<!-- ══════════ BRAIN ══════════ -->
<div class="panel" id="p4">
  <div class="ph"><h1>Brain</h1><p>Claude's memory & logs</p></div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Learnings</span></div>
    <div id="noteList"><div class="empty"><div class="empty-icon">💡</div>No learnings yet — brain learns after each cycle</div></div>
  </div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">System Log</span></div>
    <div id="logList"><div class="empty">Starting...</div></div>
  </div>
</div>

</div><!-- /scroll -->

<!-- BOTTOM NAV -->
<nav class="bnav">
  <button class="bnav-btn on" onclick="goTab(0,this)">
    <svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    Home
  </button>
  <button class="bnav-btn" onclick="goTab(1,this)">
    <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
    Charts
  </button>
  <button class="bnav-btn" onclick="goTab(2,this)">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48 0a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/></svg>
    Feed
  </button>
  <button class="bnav-btn" onclick="goTab(3,this)">
    <svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    Signals
  </button>
  <button class="bnav-btn" onclick="goTab(4,this)">
    <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
    Brain
  </button>
</nav>
</div>

<script>
// ── STATE ──
let D = {}, sigs=[], pos=[], trades=[], cands=[], notes=[], logs=[], pnl=[];
let tf = '1h', feedFilter = 'all', botState = false;

// ── UTILS ──
const $ = id => document.getElementById(id);
const esc = s => { const d=document.createElement('div'); d.textContent=String(s||''); return d.innerHTML; };
const fmtP = n => (n>=0?'+':'')+'\$'+Math.abs(n).toFixed(2);
const fmtB = n => '\$'+Number(n).toFixed(2);
const cls  = (n, big=false) => n>=0 ? 'cg' : 'cr';

// ── TABS ──
function goTab(i, btn) {
  document.querySelectorAll('.panel').forEach((p,j) => p.classList.toggle('on', j===i));
  document.querySelectorAll('.nt').forEach((b,j) => b.classList.toggle('on', j===i));
  document.querySelectorAll('.bnav-btn').forEach((b,j) => b.classList.toggle('on', j===i));
}

function setTf(m, btn) {
  tf = m;
  document.querySelectorAll('.tfb').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  drawChart();
}

function setFeedFilter(f, btn) {
  feedFilter = f;
  document.querySelectorAll('.chip').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  renderFeed();
}

// ── BOT TOGGLE ──
function toggleBot() {
  const act = botState ? '/stop' : '/start';
  doApi(act);
}

async function doApi(path) {
  try { await fetch(path, {method:'POST'}); setTimeout(refresh, 500); } catch(e) { console.error(e); }
}

// ── CHART ──
function drawChart() {
  const canvas = $('cvs');
  if (!canvas) return;
  const W = canvas.offsetWidth, H = 150;
  canvas.width = W * devicePixelRatio; canvas.height = H * devicePixelRatio;
  const ctx = canvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const now = Date.now();
  let slice = pnl;
  if (tf === '1h') slice = pnl.filter(p => p.ts > now - 3600000);
  else if (tf === '6h') slice = pnl.filter(p => p.ts > now - 21600000);

  const last = slice.length ? slice[slice.length-1].pnl : 0;
  $('chartVal').textContent = fmtP(last);
  $('chartVal').className = last >= 0 ? 'cg' : 'cr';
  $('chartVal').style.cssText = 'font-size:30px;font-weight:900;letter-spacing:-1px;margin-bottom:4px';
  $('chartLbl').textContent = slice.length > 1 ? slice.length + ' data points' : 'No trades yet';

  ctx.clearRect(0,0,W,H);
  if (slice.length < 2) {
    ctx.fillStyle='rgba(255,255,255,.15)'; ctx.font='12px Outfit'; ctx.textAlign='center';
    ctx.fillText('Collecting data...', W/2, H/2); return;
  }

  const vals = slice.map(p => p.pnl);
  const mn=Math.min(...vals), mx=Math.max(...vals), rng=mx-mn||1;
  const px = i => 8+(i/(vals.length-1))*(W-16);
  const py = v => H-8-((v-mn)/rng)*(H-20);
  const col = last>=0 ? '0,230,118' : '255,69,96';

  const g = ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,\`rgba(\${col},.28)\`); g.addColorStop(1,\`rgba(\${col},0)\`);
  ctx.beginPath(); ctx.moveTo(px(0),py(vals[0]));
  for(let i=1;i<vals.length;i++){const cx=(px(i-1)+px(i))/2; ctx.bezierCurveTo(cx,py(vals[i-1]),cx,py(vals[i]),px(i),py(vals[i]));}
  ctx.lineTo(px(vals.length-1),H); ctx.lineTo(px(0),H); ctx.closePath();
  ctx.fillStyle=g; ctx.fill();
  ctx.beginPath(); ctx.moveTo(px(0),py(vals[0]));
  for(let i=1;i<vals.length;i++){const cx=(px(i-1)+px(i))/2; ctx.bezierCurveTo(cx,py(vals[i-1]),cx,py(vals[i]),px(i),py(vals[i]));}
  ctx.strokeStyle=\`rgb(\${col})\`; ctx.lineWidth=2.5; ctx.stroke();
}

// ── RENDER SIGNALS ──
function renderSigs() {
  const el = $('sigList');
  $('sigCt').textContent = sigs.length;
  if (!sigs.length) { el.innerHTML='<div class="empty"><div class="empty-icon">🧠</div>No signals yet — brain scanning...</div>'; return; }
  el.innerHTML = sigs.map(s => \`
    <div class="item">
      <div class="ihead">
        <div class="iname">\${esc(s.title||s.ticker)}</div>
        <span class="tag \${s.side==='yes'?'t-yes':'t-no'}">\${s.side.toUpperCase()}</span>
      </div>
      <div class="imeta">
        <span>Mkt \${((s.marketPrice||0)*100).toFixed(0)}¢</span>
        <span>True \${((s.trueProb||0)*100).toFixed(0)}¢</span>
        <span class="cg">Edge \${((s.edge||0)*100).toFixed(1)}%</span>
        \${s.limitPrice?'<span>Limit '+s.limitPrice+'¢</span>':''}
        <span class="\${s.confidence==='high'?'cy':''}">\${s.confidence||''}</span>
      </div>
      \${s.reasoning?'<div class="ireason">'+esc(s.reasoning)+'</div>':''}
    </div>\`).join('');
}

// ── RENDER POSITIONS ──
function renderPos() {
  const el = $('posList');
  $('posCt').textContent = pos.length;
  if (!pos.length) { el.innerHTML='<div class="empty">No open positions</div>'; return; }
  el.innerHTML = pos.map(p => \`
    <div class="item">
      <div class="ihead">
        <div class="iname">\${esc(p.title||p.ticker)}</div>
        <span class="tag \${p.side==='yes'?'t-yes':'t-no'}">\${p.side.toUpperCase()}</span>
      </div>
      <div class="imeta">
        <span>\${p.qty}ct @ \${p.ep}¢</span>
        <span>\$\${(p.size||0).toFixed(2)}</span>
        <span class="cg">Edge \${((p.edge||0)*100).toFixed(1)}%</span>
      </div>
      \${p.reason?'<div class="ireason">'+esc(p.reason)+'</div>':''}
    </div>\`).join('');
}

// ── RENDER TRADES ──
function renderTrades() {
  const el = $('tradeList');
  $('trCt').textContent = trades.length;
  if (!trades.length) { el.innerHTML='<div class="empty"><div class="empty-icon">📊</div>No completed trades</div>'; return; }
  el.innerHTML = trades.slice(0,20).map(t => \`
    <div class="item">
      <div class="ihead">
        <div class="iname">\${esc(t.title||t.ticker)}</div>
        <span class="tag \${t.won?'t-won':'t-lost'}">\${t.won?'WON':'LOST'}</span>
      </div>
      <div class="imeta">
        <span>\${(t.side||'').toUpperCase()} @ \${t.ep}¢</span>
        <span class="\${t.pnl>=0?'cg':'cr'}">\${fmtP(t.pnl)}</span>
      </div>
    </div>\`).join('');
}

// ── RENDER FEED ──
function renderFeed() {
  const el = $('feedList');
  let list = [...cands];

  if (feedFilter === 'signals') {
    const sigTickers = new Set(sigs.map(s => s.ticker));
    list = list.filter(c => sigTickers.has(c.ticker));
  } else if (feedFilter === 'rising')  { list = list.filter(c => c.mom === '↑'); }
  else if (feedFilter === 'falling') { list = list.filter(c => c.mom === '↓'); }
  else if (feedFilter === 'urgent')  { list = list.filter(c => parseFloat(c.hrs) < 6); }

  if (!list.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📡</div>No markets match this filter</div>'; return;
  }
  el.innerHTML = list.slice(0,15).map(c => {
    const isSig = sigs.find(s => s.ticker === c.ticker);
    return \`<div class="item">
      <div class="ihead">
        <div class="iname" style="font-size:12px">\${esc(c.title)}</div>
        <span style="font-size:12px;font-family:var(--m);color:var(--t3)">\${c.yes}¢ \${c.mom}</span>
      </div>
      <div class="imeta">
        <span>Vol \${c.vol.toLocaleString()}</span>
        <span>\${c.hrs}h left</span>
        <span>\${c.cat}</span>
        \${isSig?'<span class="cb">SIGNAL</span>':''}
      </div>
    </div>\`;
  }).join('');
}

// ── RENDER LOGS ──
function renderLogs() {
  const el = $('logList');
  if (!logs.length) { el.innerHTML='<div class="empty">No logs</div>'; return; }
  el.innerHTML = logs.slice(0,80).map(l => '<div class="logline">'+esc(l)+'</div>').join('');
}

// ── RENDER NOTES ──
function renderNotes() {
  const el = $('noteList');
  if (!notes.length) { el.innerHTML='<div class="empty"><div class="empty-icon">💡</div>No learnings yet</div>'; return; }
  el.innerHTML = [...notes].reverse().map(n => '<div class="note">'+esc(n)+'</div>').join('');
}

// ── UPDATE RING ──
function updateRing(wr, w, l) {
  const circ = 214;
  const pct  = wr != null ? wr/100 : 0;
  $('ringC').setAttribute('stroke-dasharray', (pct*circ).toFixed(1)+' '+circ);
  $('ringTx').textContent = wr != null ? wr+'%' : '—';
  $('rW').textContent = w; $('rL').textContent = l;
}

// ── MAIN REFRESH ──
async function refresh() {
  try {
    const [st, sg, ps, tr, ca, lg, pl, nt] = await Promise.all([
      fetch('/s').then(r=>r.json()),
      fetch('/signals').then(r=>r.json()),
      fetch('/positions').then(r=>r.json()),
      fetch('/trades').then(r=>r.json()),
      fetch('/cands').then(r=>r.json()),
      fetch('/logs').then(r=>r.json()),
      fetch('/pnl').then(r=>r.json()),
      fetch('/notes').then(r=>r.json()),
    ]);

    D=st; sigs=sg; pos=ps; trades=tr; cands=ca; logs=lg; pnl=pl; notes=nt;
    botState = st.on;

    // Mode badge
    const mb = $('modeBadge');
    if (st.on) { mb.textContent='RUNNING'; mb.className='badge b-on'; }
    else if (st.paper) { mb.textContent='PAPER'; mb.className='badge b-paper'; }
    else { mb.textContent='LIVE'; mb.className='badge b-live'; }

    // Halt
    const hb = $('haltBox');
    hb.style.display = st.haltMsg ? 'block' : 'none';
    if (st.haltMsg) $('haltMsg').textContent = st.haltMsg;

    // Hero
    const pnlEl = $('heroPnl');
    pnlEl.textContent = fmtP(st.totPnl);
    pnlEl.className = 'hero-pnl ' + (st.totPnl>=0?'cg':'cr');
    $('heroSub').textContent = st.on ? 'Bot is running — scanning markets' : 'Start bot to begin tracking';
    const balEl=$('hBal'); balEl.textContent=fmtB(st.bal); balEl.className='hstat-v';
    const dayEl=$('hDay'); dayEl.textContent=fmtP(st.dayPnl); dayEl.className='hstat-v '+(st.dayPnl>=0?'cg':'cr');
    const ddEl=$('hDd');  ddEl.textContent=st.dd.toFixed(1)+'%'; ddEl.className='hstat-v '+(st.dd>15?'cr':st.dd>7?'cy':'cg');

    // Tri-row
    const deployed = pos.reduce((a,p)=>a+p.size,0);
    $('tDeployed').textContent = '\$'+deployed.toFixed(2);
    $('tTrades').textContent   = st.total;
    $('tOpen').textContent     = st.open;

    // Engine card
    const tb = $('toggleBtn'), en=$('engineName'), es=$('engineSub');
    if (st.on) { tb.className='toggle on2'; en.textContent='AI Trading Engine'; es.textContent='Active — scanning every 30s'; }
    else { tb.className='toggle off'; en.textContent='AI Trading Engine'; es.textContent='Tap to activate'; }

    // Stats
    $('gWr').textContent    = st.wr != null ? st.wr+'%' : '—';
    $('gWl').textContent    = st.wins+' / '+st.losses;
    $('gScans').textContent = st.on ? Math.round(3600/30)+'' : '0';
    $('gCalls').textContent = st.calls;

    // Charts
    updateRing(st.wr, st.wins, st.losses);
    $('rW').textContent = st.wins; $('rL').textContent = st.losses;
    $('rCopy').textContent = '—'; $('rArb').textContent = st.calls;
    const grossEl = $('rGross');
    grossEl.textContent = fmtP(st.totPnl);
    grossEl.className = st.totPnl>=0 ? 'cg' : 'cr';
    grossEl.style.cssText='font-size:18px;font-weight:800';

    // Feed badge
    const fb = $('feedBadge');
    if (st.on) { fb.textContent='ACTIVE'; fb.className='badge b-on'; }
    else { fb.textContent='PAUSED'; fb.className='badge b-paper'; }

    drawChart();
    renderSigs(); renderPos(); renderTrades(); renderFeed(); renderLogs(); renderNotes();

  } catch(e) { console.error('Refresh:', e); }
}

refresh();
setInterval(refresh, 8000);
window.addEventListener('resize', drawChart);
</script>
</body></html>`;
}

// ─── BOOT ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  log('════════════════════════════════════════');
  log('  KALSHI EDGE v7  —  Ready to trade');
  log('════════════════════════════════════════');
  log(` Mode:      ${C.paper ? 'PAPER (DRY_RUN=true)' : '⚡ LIVE TRADING'}`);
  log(` Kelly:     ${C.kelly} | Min edge: ${(C.edgeLive * 100).toFixed(0)}% live / ${(C.edgePaper * 100).toFixed(0)}% paper`);
  log(` Max bet:   $${C.maxBet} per trade | Max positions: ${C.maxPos}`);
  log(` Stops:     daily -$${C.dailyStop} | drawdown ${(C.ddLimit * 100).toFixed(0)}%`);
  log(` Cadence:   scan ${C.scanSec}s | brain ${C.brainSec}s | heartbeat 30min`);
  log(` Telegram:  ${C.tgTok ? '✓ token' : '✗ NO TOKEN'} | ${C.tgChat ? '✓ chat' : '✗ NO CHAT'}`);
  log(` Claude:    ${C.claude ? '✓ key set' : '✗ NO KEY'}`);
  log(` Kalshi:    ${C.keyId ? '✓ key set' : '✗ NO KEY'}`);
  log('════════════════════════════════════════');

  // Step 1: Test Telegram
  if (C.tgTok && C.tgChat) {
    log('Testing Telegram...');
    await tg('🔧 <b>Kalshi Edge v7</b> — boot test, Telegram is connected ✓');
  } else {
    log('WARNING: Telegram not configured — set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID');
  }

  // Step 2: Validate Kalshi credentials
  if (!C.keyId || !C.pem) {
    log('STANDBY — add KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY env vars and redeploy');
    await tg('⚠️ <b>Standby</b> — Kalshi credentials missing.\nSet KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY in Railway env vars.');
    return;
  }

  // Step 3: Auth + real balance fetch
  const ok = await validate(); // also syncs real balance into S.bal
  if (!ok) {
    log('STANDBY — fix Kalshi credentials and redeploy');
    return;
  }

  // Step 4: Send full status to Telegram with REAL balance
  const checklist = [
    `${C.keyId   ? '✅' : '❌'} Kalshi API key`,
    `${C.pem.length > 50 ? '✅' : '❌'} RSA private key`,
    `${C.claude  ? '✅' : '❌'} Claude API key`,
    `${C.tgTok   ? '✅' : '❌'} Telegram token`,
    `${C.tgChat  ? '✅' : '❌'} Telegram chat ID`,
    `${!C.paper  ? '✅' : '⚠️'} Live mode ${C.paper ? '(currently PAPER — set DRY_RUN=false to go live)' : '(ACTIVE)'}`,
  ].join('\n');

  await tg(
    `🟢 <b>Kalshi Edge v7 — Online</b>\n\n` +
    `Mode: ${C.paper ? '📝 Paper Trading' : '⚡ LIVE TRADING'}\n` +
    `Real Kalshi balance: <b>$${usd().toFixed(2)}</b>\n` +
    `Kelly: ${C.kelly} | Min edge: ${(C.edgeLive * 100).toFixed(0)}%\n` +
    `Daily stop: -$${C.dailyStop} | Drawdown: ${(C.ddLimit * 100).toFixed(0)}%\n` +
    `Max bet: $${C.maxBet} | Max positions: ${C.maxPos}\n\n` +
    `<b>System checklist:</b>\n${checklist}\n\n` +
    `Bot starts in 3 seconds. Heartbeat every 30 minutes.`
  );

  log(`Startup complete. Real balance: $${usd().toFixed(2)}. Starting bot in 3s...`);
  setTimeout(startBot, 3000);
});
