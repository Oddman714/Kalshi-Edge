// ═══════════════════════════════════════════════════════════════════
//  KALSHI EDGE v8  —  Definitive Production Build
//
//  MISSION: Double the portfolio as fast as safely possible.
//
//  What's fixed vs v7:
//    ✓ Balance: paper mode uses separate paperBal — real Kalshi balance
//              always shown correctly in Telegram AND dashboard
//    ✓ Contract sizing: correct Kalshi math (qty = dollars / price per contract)
//    ✓ Signal staleness guard: won't execute signals older than 3 minutes
//    ✓ Brain: elite trading prompt with 3-edge framework + web search strategy
//    ✓ Brain memory: 50 notes retained (long-term learning)
//    ✓ Monitor: rich settlement messages with real P&L from Kalshi fills API
//    ✓ Heartbeat: full status every 30min including signal age
//    ✓ Dashboard: signal freshness indicator, real vs paper balance display
//    ✓ All Telegram messages rich and consistent
//    ✓ Zero syntax errors — written clean
// ═══════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────
const C = {
  keyId:    process.env.KALSHI_API_KEY_ID   || '',
  pem:      (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  base:     process.env.KALSHI_BASE_URL     || 'https://api.elections.kalshi.com',
  v2:       '/trade-api/v2',
  claude:   process.env.CLAUDE_API_KEY      || '',
  model:    'claude-sonnet-4-20250514',
  tgTok:    process.env.TELEGRAM_TOKEN      || '',
  tgChat:   process.env.TELEGRAM_CHAT_ID    || '',
  paper:    process.env.DRY_RUN !== 'false',
  startBal: parseFloat(process.env.BANKROLL   || '50'),
  kelly:    parseFloat(process.env.KELLY      || '0.35'),
  edgeLive: parseFloat(process.env.EDGE_LIVE  || '0.07'),
  edgePaper:parseFloat(process.env.EDGE_PAPER || '0.03'),
  maxBet:   parseFloat(process.env.MAX_BET    || '5'),
  maxPos:   parseInt(  process.env.MAX_POS    || '5'),
  dailyStop:parseFloat(process.env.DAILY_STOP || '8'),
  ddLimit:  parseFloat(process.env.DD_LIMIT   || '0.20'),
  minVol:   parseInt(  process.env.MIN_VOL    || '2000'),
  scanSec:  parseInt(  process.env.SCAN_SEC   || '30'),
  brainSec: parseInt(  process.env.BRAIN_SEC  || '90'),
};

// ─── STATE ───────────────────────────────────────────────────────
const STATE_FILE = (() => {
  const v = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  return v ? path.join(v, 'ke8.json') : path.join(__dirname, 'ke8.json');
})();

function fresh() {
  const b = Math.round(C.startBal * 100);
  return {
    on: false,
    bal: b,         // real Kalshi balance in cents (synced from API every cycle)
    paperBal: b,    // simulated paper balance in cents (tracked independently)
    peak: b,        // high-water mark for drawdown calc
    dayPnl: 0,      // today P&L in dollars
    totPnl: 0,      // all-time P&L in dollars
    wins: 0, losses: 0,
    positions: [],  // open trades
    trades: [],     // closed trades history
    signals: [],    // latest brain signals
    signalTs: 0,    // unix ms when signals were last generated
    notes: [],      // brain learnings — long-term memory
    pnlHist: [],    // [{ts, bal, pnl}] for equity chart
    cands: [],      // market candidates from last scan
    calls: 0,       // total Claude brain calls
    authFails: 0,   // consecutive Kalshi auth failures
    day: '',        // date string for midnight reset
    startedAt: null,
    scanAt: null,
    brainAt: null,
    lastErr: null,
    haltMsg: null,
    _ph: {},        // price history for momentum calc
  };
}

let S = fresh();
try { Object.assign(S, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (_) {}
// Ensure new fields exist on loaded state
if (!S.paperBal) S.paperBal = S.bal;
if (!S.signalTs) S.signalTs = 0;

const save = () => {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(S)); } catch (_) {}
};

// ─── LOGGING ─────────────────────────────────────────────────────
const LOGS = [];
const log = msg => {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  LOGS.unshift(line);
  if (LOGS.length > 500) LOGS.length = 500;
};

// ─── TELEGRAM ────────────────────────────────────────────────────
function tg(text) {
  if (!C.tgTok || !C.tgChat) {
    log('[TG skipped] ' + text.slice(0, 60));
    return Promise.resolve();
  }
  const body = JSON.stringify({ chat_id: C.tgChat, text, parse_mode: 'HTML' });
  log('[TG] ' + text.slice(0, 80).replace(/\n/g, ' '));
  return new Promise(resolve => {
    const url = new URL('https://api.telegram.org/bot' + C.tgTok + '/sendMessage');
    const req = https.request({
      hostname: url.hostname, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (!j.ok) log('[TG] Error: ' + JSON.stringify(j).slice(0, 100));
          else log('[TG] Sent OK');
        } catch (_) { log('[TG] Parse error'); }
        resolve();
      });
    });
    req.on('error', e => { log('[TG] Req error: ' + e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// ─── HTTP ────────────────────────────────────────────────────────
function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers),
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch (_) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── KALSHI AUTH (RSA-PSS) ───────────────────────────────────────
function kalshiSign(method, fullPath) {
  const ts = Date.now().toString();
  const sig = crypto.sign('sha256', Buffer.from(ts + method.toUpperCase() + fullPath), {
    key: C.pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return { ts, sig: sig.toString('base64') };
}

function kalshi(method, ep, body) {
  const fullPath = C.v2 + ep;
  const { ts, sig } = kalshiSign(method, fullPath);
  const host = new URL(C.base).hostname;
  let reqPath = fullPath;
  if (method === 'GET' && body) {
    reqPath += '?' + new URLSearchParams(body).toString();
    body = null;
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: reqPath, method,
      headers: {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': C.keyId,
        'KALSHI-ACCESS-TIMESTAMP': ts,
        'KALSHI-ACCESS-SIGNATURE': sig,
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch (_) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── AUTH GUARD ──────────────────────────────────────────────────
async function onAuthFail(status, where) {
  S.authFails = (S.authFails || 0) + 1;
  log('Auth fail #' + S.authFails + ' (HTTP ' + status + ') at ' + where);
  if (S.authFails >= 3) {
    const msg = 'Auth failed 3x consecutively (HTTP ' + status + '). Check KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY, system clock.';
    S.haltMsg = msg;
    stopBot();
    await tg('🔴 <b>KALSHI EDGE HALTED</b>\n' + msg);
  }
}
const authOk = () => { S.authFails = 0; };

// ─── STARTUP VALIDATION ──────────────────────────────────────────
async function validate() {
  log('Validating Kalshi connection...');
  if (!C.keyId || C.pem.length < 50) {
    const m = 'Missing KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY';
    log('ABORT: ' + m);
    await tg('🔴 <b>Startup aborted</b>\n' + m);
    return false;
  }
  try {
    const r = await kalshi('GET', '/portfolio/balance');
    if (r.status === 200) {
      const b = r.data.balance || 0;
      if (b > 0) {
        S.bal  = b;
        S.peak = Math.max(S.peak, b);
        // Seed paperBal from real balance on first boot
        if (!S.paperBal || S.paperBal === Math.round(C.startBal * 100)) {
          S.paperBal = b;
        }
        log('Real Kalshi balance synced: $' + (b / 100).toFixed(2));
      }
      authOk();
      log('Auth OK');
      return true;
    }
    const errMsg = JSON.stringify(r.data).slice(0, 120);
    log('Auth rejected HTTP ' + r.status + ': ' + errMsg);
    await tg('🔴 <b>Auth failed (' + r.status + ')</b>\nCheck keys and system clock.\n' + errMsg);
    return false;
  } catch (e) {
    log('Auth error: ' + e.message);
    await tg('🔴 <b>Connection error</b>\n' + e.message);
    return false;
  }
}

// ─── BALANCE SYNC ────────────────────────────────────────────────
// Always syncs real Kalshi balance regardless of paper/live mode.
async function syncBal() {
  try {
    const r = await kalshi('GET', '/portfolio/balance');
    if (r.status === 200 && r.data.balance !== undefined) {
      const prev = S.bal;
      S.bal  = r.data.balance;
      S.peak = Math.max(S.peak, S.bal);
      authOk();
      if (Math.abs(S.bal - prev) > 10) {
        log('Balance: $' + (prev / 100).toFixed(2) + ' → $' + (S.bal / 100).toFixed(2));
      }
    } else if (r.status === 401 || r.status === 403) {
      await onAuthFail(r.status, 'syncBal');
    }
  } catch (e) { log('syncBal: ' + e.message); }
}

// ─── CIRCUIT BREAKERS ────────────────────────────────────────────
function breakers() {
  // 1. Daily loss limit
  if (S.dayPnl <= -C.dailyStop) {
    const m = 'Daily loss $' + Math.abs(S.dayPnl).toFixed(2) + ' reached limit -$' + C.dailyStop;
    log('BREAKER: ' + m);
    S.haltMsg = m;
    stopBot();
    tg('⚡ <b>Circuit breaker — Daily loss</b>\n' + m + '\nBot paused until midnight UTC.');
    return false;
  }
  // 2. Peak drawdown
  if (S.peak > 0) {
    const dd = (S.peak - S.bal) / S.peak;
    if (dd >= C.ddLimit) {
      const m = 'Drawdown ' + (dd * 100).toFixed(1) + '% from peak $' + (S.peak / 100).toFixed(2);
      log('BREAKER: ' + m);
      S.haltMsg = m;
      stopBot();
      tg('⚡ <b>Circuit breaker — Drawdown</b>\n' + m + '\nBot halted. Review before restarting.');
      return false;
    }
  }
  return true;
}

// ─── MIDNIGHT RESET ──────────────────────────────────────────────
function midnight() {
  const today = new Date().toDateString();
  if (S.day === today) return;
  log('Midnight reset — daily P&L cleared');
  S.dayPnl = 0;
  S.day = today;
  save();
  tg(
    '🌅 <b>New Day — Kalshi Edge</b>\n' +
    'Real balance: $' + (S.bal / 100).toFixed(2) + '\n' +
    'All-time P&L: ' + fmt(S.totPnl) + '\n' +
    'Win rate: ' + wrStr() + '\n' +
    'Brain calls total: ' + S.calls
  );
}

// ─── HELPERS ─────────────────────────────────────────────────────
// Display balance: paper uses simulated paperBal, live uses real bal
const dispUsd = () => (C.paper ? S.paperBal : S.bal) / 100;
const realUsd = () => S.bal / 100;
const fmt = n => (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2);
const wrStr = () => {
  const tot = S.wins + S.losses;
  return tot > 0 ? ((S.wins / tot) * 100).toFixed(0) + '% (' + S.wins + 'W/' + S.losses + 'L)' : '—';
};
const sigAgeSec = () => S.signalTs ? Math.round((Date.now() - S.signalTs) / 1000) : null;

// Kelly sizing — returns dollar amount to bet
function kellySz(trueP, mktPrice) {
  if (mktPrice <= 0 || mktPrice >= 1) return 0;
  const b = 1 / mktPrice - 1;
  const f = Math.max(0, (trueP * (b + 1) - 1) / b) * C.kelly;
  // Use paper or real balance depending on mode
  const bankroll = dispUsd();
  return Math.min(f * bankroll, C.maxBet, bankroll * 0.10);
}

// ─── LAYER 1: MARKET SCANNER ─────────────────────────────────────
async function scan() {
  S.scanAt = new Date().toISOString();
  try {
    const r = await kalshi('GET', '/markets', { status: 'open', limit: '100' });
    if (r.status === 401 || r.status === 403) { await onAuthFail(r.status, 'scan'); return; }
    if (r.status !== 200) { log('Scan HTTP ' + r.status); return; }
    authOk();

    const held = new Set(S.positions.map(p => p.ticker));
    const now  = Date.now();
    const mkts = r.data.markets || [];

    const scored = mkts
      .filter(m => {
        if (held.has(m.ticker_name)) return false;
        if ((m.volume || 0) < C.minVol) return false;
        const hrs = (new Date(m.close_time || 0) - now) / 3.6e6;
        if (hrs < 1 || hrs > 168) return false;
        const y = m.last_price || 50;
        return y >= 5 && y <= 95;
      })
      .map(m => {
        const y   = m.last_price || 50;
        const hrs = ((new Date(m.close_time || 0) - now) / 3.6e6).toFixed(1);
        const t   = m.ticker_name;
        const ph  = S._ph[t] || [];
        const prv = ph.length ? ph[ph.length - 1] : y;
        const mom = y > prv + 2 ? '↑' : y < prv - 2 ? '↓' : '→';
        S._ph[t]  = ph.slice(-19).concat([y]);
        // Score: mid-range price (most edge potential) + volume + urgency
        const score =
          (1 - Math.abs(y - 50) / 50) * 0.4 +
          Math.min((m.volume || 0) / 10000, 1) * 0.3 +
          Math.max(0, 1 - parseFloat(hrs) / 48) * 0.3;
        return {
          ticker: t,
          title:  m.title,
          yes:    y,
          no:     100 - y,
          vol:    m.volume || 0,
          hrs,
          cat:    m.category || '—',
          mom,
          score,
        };
      });

    scored.sort((a, b) => b.score - a.score);
    S.cands = scored.slice(0, 20);
    log('Scan: ' + mkts.length + ' markets → ' + scored.length + ' filtered → ' + S.cands.length + ' top candidates');
  } catch (e) {
    log('Scan error: ' + e.message);
    S.lastErr = e.message;
  }
}

// ─── LAYER 2: CLAUDE BRAIN ───────────────────────────────────────
async function brain() {
  if (!C.claude)       { log('No Claude key — skipping brain'); return; }
  if (!S.cands.length) { log('No candidates — skipping brain'); return; }

  S.brainAt = new Date().toISOString();
  S.calls++;

  const edgeMin  = C.paper ? C.edgePaper : C.edgeLive;
  const tot      = S.wins + S.losses;
  const wrPct    = tot > 0 ? ((S.wins / tot) * 100).toFixed(0) + '%' : 'no trades yet';
  const held     = S.positions.map(p => p.ticker + '(' + p.side + '@' + p.ep + '¢)').join(', ') || 'none';
  const mem      = S.notes.slice(-8).join('\n') || 'none yet — first session';
  const mktsText = S.cands
    .map((c, i) =>
      (i + 1) + '. [' + c.ticker + '] "' + c.title + '"\n' +
      '   YES:' + c.yes + '¢ NO:' + c.no + '¢ | Vol:' + c.vol +
      ' | ' + c.hrs + 'h left | ' + c.cat + ' | ' + c.mom
    )
    .join('\n\n');

  const systemPrompt =
    'You are Kalshi Edge — an elite autonomous AI prediction market trader.\n' +
    'MISSION: Double the portfolio as fast as safely possible through disciplined, high-conviction trades.\n\n' +
    'CURRENT STATE:\n' +
    '  Mode: ' + (C.paper ? 'PAPER (simulate aggressively to find real edges)' : '⚡ LIVE — real money') + '\n' +
    '  Real Kalshi balance: $' + realUsd().toFixed(2) + '\n' +
    '  Simulated balance: $' + dispUsd().toFixed(2) + '\n' +
    '  Today P&L: ' + fmt(S.dayPnl) + ' | All-time: ' + fmt(S.totPnl) + '\n' +
    '  Win rate: ' + wrPct + ' | Brain cycles: ' + S.calls + '\n' +
    '  Currently holding: ' + held + '\n\n' +
    'YOUR MEMORY (learnings from past cycles):\n' +
    mem + '\n\n' +
    'THE THREE EDGES — HOW TO DOUBLE THIS PORTFOLIO:\n\n' +
    '  EDGE 1 — NEWS LAG (highest alpha)\n' +
    '  Markets update prices slowly after breaking news. A 5-minute lag = free edge.\n' +
    '  Search: "[topic] news today", "[event] latest", look for anything <60 minutes old.\n' +
    '  Example: CPI just came in hot → find Fed rate markets trading at old prices.\n\n' +
    '  EDGE 2 — FAVOURITE-LONGSHOT BIAS (systematic, always present)\n' +
    '  YES at 82-96¢ is underpriced — true probability is 88-98%. Buy it.\n' +
    '  YES at 4-15¢ is overpriced — dumb money buying lottery tickets. Signal NO.\n' +
    '  The market chronically underestimates certainties and overestimates longshots.\n\n' +
    '  EDGE 3 — RESOLUTION CERTAINTY (low-risk, high-conviction)\n' +
    '  Markets closing in <6h where the outcome is effectively already decided.\n' +
    '  A market at 65¢ that is 90% certain to resolve YES = 25¢ of pure edge.\n' +
    '  Search official sources: Fed.gov, BLS.gov, official vote counts, live scores.\n\n' +
    'SIGNAL REQUIREMENTS:\n' +
    '  • Edge minimum: ' + (edgeMin * 100).toFixed(0) + '% (your trueProb minus marketPrice)\n' +
    '  • HIGH confidence: you found specific, timestamped evidence published today\n' +
    '  • MEDIUM confidence: strong logical reasoning, indirect but solid evidence\n' +
    '  • Never signal LOW confidence — skip that market entirely\n' +
    '  • Limit price: bid 1-3¢ INSIDE market (gets priority fill, zero taker fees)\n' +
    '  • No stacking: already holding a Fed market? Skip other Fed markets\n' +
    '  • Prefer <48h to close — your edge is most actionable near resolution\n\n' +
    'WEB SEARCH WORKFLOW (do this for every candidate):\n' +
    '  1. Search "[market topic] latest news today"\n' +
    '  2. Search official data sources relevant to the market\n' +
    '  3. Check if the search result changes your probability estimate\n' +
    '  4. If no relevant results found → skip the market, say why in note\n\n' +
    'RETURN ONLY valid JSON — no markdown, no code fences, no extra text:\n' +
    '{\n' +
    '  "signals": [{\n' +
    '    "ticker": "TICKER-123",\n' +
    '    "title": "Market title",\n' +
    '    "side": "yes",\n' +
    '    "marketPrice": 0.72,\n' +
    '    "trueProb": 0.88,\n' +
    '    "edge": 0.16,\n' +
    '    "confidence": "high",\n' +
    '    "limitPrice": 70,\n' +
    '    "reasoning": "Specific evidence: [source] reported [fact] at [time today]"\n' +
    '  }],\n' +
    '  "note": "One specific, actionable learning to improve future cycles"\n' +
    '}';

  const userMsg =
    'TIME: ' + new Date().toISOString() + '\n' +
    'SESSION STATS: ' + S.calls + ' brain calls | Win rate: ' + wrPct + '\n\n' +
    'MARKET CANDIDATES (top ' + S.cands.length + ', scored by opportunity):\n\n' +
    mktsText + '\n\n' +
    'WORKFLOW:\n' +
    '1. Search the web for current news on each market above\n' +
    '2. Estimate the true resolution probability based on what you find\n' +
    '3. Compare to market price — signal where edge >= ' + (edgeMin * 100).toFixed(0) + '%\n' +
    '4. Be specific in reasoning — name the source and fact\n\n' +
    'Go. Signal every genuine edge you find.';

  try {
    const reqBody = JSON.stringify({
      model:      C.model,
      max_tokens: 1500,
      system:     systemPrompt,
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
      messages:   [{ role: 'user', content: userMsg }],
    });

    log('Brain: calling Claude...');
    const r = await httpPost('https://api.anthropic.com/v1/messages', reqBody, {
      'Content-Type':      'application/json',
      'x-api-key':         C.claude,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'web-search-2025-03-05',
    });

    if (r.status !== 200) {
      log('Claude error ' + r.status + ': ' + JSON.stringify(r.data).slice(0, 200));
      return;
    }

    // Extract text blocks (response may contain web_search tool blocks too)
    const text = (r.data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    if (!text) { log('Brain: no text in response'); return; }

    // Parse JSON from response
    const jStart = text.indexOf('{');
    const jEnd   = text.lastIndexOf('}');
    if (jStart < 0 || jEnd < 0) { log('Brain: no JSON block found'); return; }

    let parsed;
    try {
      parsed = JSON.parse(text.slice(jStart, jEnd + 1));
    } catch (e) {
      log('Brain JSON parse error: ' + e.message);
      return;
    }

    // Store brain note with timestamp
    if (parsed.note) {
      const ts = '[' + new Date().toISOString().slice(0, 16) + '] ';
      S.notes.push(ts + parsed.note);
      if (S.notes.length > 50) S.notes.shift(); // keep 50 = long-term memory
    }

    // Filter and validate signals
    S.signals = (parsed.signals || []).filter(sig => {
      if (!sig.ticker || !sig.side || typeof sig.edge !== 'number') return false;
      if (!['yes', 'no'].includes(sig.side)) return false;
      if (sig.confidence === 'low') return false;
      if (sig.edge < edgeMin) {
        log('Skip ' + sig.ticker + ': edge ' + (sig.edge * 100).toFixed(1) + '% < min ' + (edgeMin * 100).toFixed(0) + '%');
        return false;
      }
      return true;
    });

    // Stamp freshness
    S.signalTs = Date.now();

    log('Brain: ' + S.signals.length + ' signal(s) | note: ' + (parsed.note || '').slice(0, 70));

    if (S.signals.length > 0) {
      const lines = S.signals.map(s =>
        '• ' + s.ticker + ' ' + s.side.toUpperCase() +
        ' — ' + (s.edge * 100).toFixed(1) + '% edge (' + s.confidence + ')' +
        '\n  ' + (s.reasoning || '')
      ).join('\n');
      await tg(
        '🧠 <b>Brain Cycle — ' + S.signals.length + ' signal(s)</b>\n\n' +
        lines + '\n\n' +
        'Balance: $' + dispUsd().toFixed(2) + ' | Calls: ' + S.calls
      );
    } else {
      log('Brain: no signals this cycle (note: ' + (parsed.note || 'none') + ')');
    }

  } catch (e) {
    log('Brain error: ' + e.message);
    S.lastErr = e.message;
  }
}

// ─── LAYER 3: EXECUTION ──────────────────────────────────────────
async function execute() {
  if (!S.signals.length)              return;
  if (S.positions.length >= C.maxPos) return;
  if (!breakers())                    return;

  // Staleness guard — don't fire on signals older than 3 minutes
  const ageSec = sigAgeSec();
  if (ageSec !== null && ageSec > 180) {
    log('Signals stale (' + ageSec + 's old) — waiting for brain refresh');
    return;
  }

  for (const sig of S.signals) {
    if (S.positions.length >= C.maxPos) break;
    if (!breakers()) break;
    if (S.positions.find(p => p.ticker === sig.ticker)) continue;

    const mkt  = sig.marketPrice || 0.5;
    const size = kellySz(sig.trueProb || 0.6, mkt);
    if (size < 0.50) {
      log(sig.ticker + ': size $' + size.toFixed(2) + ' too small, skip');
      continue;
    }

    // Correct Kalshi contract math:
    // limit price is in cents (e.g. 68 means 68¢ per contract)
    // 1 contract costs lp cents = lp/100 dollars
    // qty = how many contracts can we buy with `size` dollars
    const lp  = sig.limitPrice || Math.round(mkt * 100);
    const qty = Math.max(1, Math.round((size * 100) / lp));
    const actualCost = (qty * lp) / 100; // real dollar outlay

    log('Sizing: $' + size.toFixed(2) + ' target → ' + qty + ' contracts @ ' + lp + '¢ = $' + actualCost.toFixed(2));

    if (C.paper) {
      // Paper trade — deduct from paperBal ONLY, never touch S.bal
      const pos = {
        id:     crypto.randomUUID(),
        ticker: sig.ticker,
        title:  sig.title || sig.ticker,
        side:   sig.side,
        qty,
        ep:     lp,
        size:   actualCost,
        edge:   sig.edge,
        reason: sig.reasoning || '',
        at:     new Date().toISOString(),
      };
      S.positions.push(pos);
      S.paperBal -= Math.round(actualCost * 100);
      S.dayPnl   -= actualCost;

      log('[PAPER] ' + sig.side.toUpperCase() + ' ' + sig.ticker + ' ' + qty + 'ct @' + lp + '¢ $' + actualCost.toFixed(2));
      await tg(
        '📝 <b>Paper Trade Opened</b>\n' +
        sig.side.toUpperCase() + ' ' + sig.ticker + '\n' +
        qty + ' contracts @ ' + lp + '¢ = $' + actualCost.toFixed(2) + '\n' +
        'Edge: ' + (sig.edge * 100).toFixed(1) + '% | ' + sig.confidence + ' confidence\n' +
        'Real balance: $' + realUsd().toFixed(2) + ' | Paper sim: $' + (S.paperBal / 100).toFixed(2) + '\n' +
        'Reason: ' + (sig.reasoning || 'no reason')
      );

    } else {
      // Live order — limit order only, never market order
      try {
        const orderBody = {
          ticker:          sig.ticker,
          action:          'buy',
          type:            'limit',
          side:            sig.side,
          count:           qty,
          yes_price:       sig.side === 'yes' ? lp : 100 - lp,
          no_price:        sig.side === 'no'  ? lp : 100 - lp,
          client_order_id: crypto.randomUUID(),
        };

        const r = await kalshi('POST', '/portfolio/orders', orderBody);

        if (r.status === 200 || r.status === 201) {
          authOk();
          const order = r.data.order || r.data;
          S.positions.push({
            id:      order.order_id || crypto.randomUUID(),
            ticker:  sig.ticker,
            title:   sig.title || sig.ticker,
            side:    sig.side,
            qty,
            ep:      lp,
            size:    actualCost,
            edge:    sig.edge,
            reason:  sig.reasoning || '',
            at:      new Date().toISOString(),
            orderId: order.order_id,
          });

          log('[LIVE] ' + sig.side.toUpperCase() + ' ' + sig.ticker + ' ' + qty + 'ct @' + lp + '¢ $' + actualCost.toFixed(2));
          await tg(
            '⚡ <b>LIVE Order Placed</b>\n' +
            sig.side.toUpperCase() + ' ' + sig.ticker + '\n' +
            qty + ' contracts @ ' + lp + '¢ = $' + actualCost.toFixed(2) + '\n' +
            'Edge: ' + (sig.edge * 100).toFixed(1) + '% | ' + sig.confidence + ' confidence\n' +
            'Real balance: $' + realUsd().toFixed(2) + '\n' +
            'Open positions: ' + S.positions.length + '/' + C.maxPos + '\n' +
            'Reason: ' + (sig.reasoning || 'no reason')
          );

        } else if (r.status === 401 || r.status === 403) {
          await onAuthFail(r.status, 'order ' + sig.ticker);
          break;
        } else {
          log('Order rejected ' + r.status + ': ' + JSON.stringify(r.data).slice(0, 150));
          await tg('⚠️ <b>Order Rejected</b> ' + sig.ticker + '\nHTTP ' + r.status + ': ' + JSON.stringify(r.data).slice(0, 80));
        }
      } catch (e) {
        log('Order error ' + sig.ticker + ': ' + e.message);
      }
    }

    // Brief pause between orders to respect rate limits
    await new Promise(res => setTimeout(res, 400));
  }

  // Record P&L snapshot for equity chart
  S.pnlHist.push({ ts: Date.now(), bal: dispUsd(), pnl: S.totPnl });
  if (S.pnlHist.length > 500) S.pnlHist.shift();
  save();
}

// ─── POSITION MONITOR ────────────────────────────────────────────
async function monitor() {
  // Always sync real balance
  await syncBal();

  // Paper mode: positions settle manually via /settle endpoint
  if (C.paper) {
    if (S.positions.length > 0) {
      log('Monitor: ' + S.positions.length + ' paper position(s) open');
    }
    return;
  }

  // Live mode: check Kalshi for settled positions
  if (!S.positions.length) return;

  try {
    const r = await kalshi('GET', '/portfolio/positions');
    if (r.status === 401 || r.status === 403) { await onAuthFail(r.status, 'monitor'); return; }
    if (r.status !== 200) { log('Monitor HTTP ' + r.status); return; }
    authOk();

    const liveMap = {};
    for (const p of (r.data.market_positions || [])) {
      liveMap[p.ticker_name] = p;
    }

    for (const pos of [...S.positions]) {
      const live = liveMap[pos.ticker];

      // Not in live map OR qty is zero = settled
      if (!live || live.position === 0) {
        let pnl = -pos.size; // conservative fallback

        // Try to get real P&L from Kalshi fills API
        try {
          const fills = await kalshi('GET', '/portfolio/fills', { ticker: pos.ticker, limit: '10' });
          if (fills.status === 200 && fills.data.fills && fills.data.fills.length > 0) {
            const fillPnl = fills.data.fills.reduce((acc, f) => acc + (f.profit_loss || 0), 0);
            if (fillPnl !== 0) pnl = fillPnl / 100;
          }
        } catch (_) { /* use fallback */ }

        // Use realized_pnl from position data if available
        if (live && live.realized_pnl !== undefined && live.realized_pnl !== 0) {
          pnl = live.realized_pnl / 100;
        }

        // Record settlement
        S.positions = S.positions.filter(p => p.id !== pos.id);
        S.totPnl   += pnl;
        S.dayPnl   += pnl;
        if (pnl > 0) S.wins++; else S.losses++;

        S.trades.unshift({
          ...pos,
          closedAt: new Date().toISOString(),
          pnl,
          won: pnl > 0,
        });
        if (S.trades.length > 100) S.trades.length = 100;

        log('Settled ' + pos.ticker + ': ' + fmt(pnl) + ' | total: ' + fmt(S.totPnl) + ' | ' + wrStr());
        await tg(
          (pnl > 0 ? '✅' : '❌') + ' <b>Trade Settled: ' + pos.ticker + '</b>\n' +
          pos.side.toUpperCase() + ' @ ' + pos.ep + '¢ | ' + pos.qty + ' contracts\n' +
          'P&L: <b>' + fmt(pnl) + '</b>\n' +
          'All-time: ' + fmt(S.totPnl) + ' | Win rate: ' + wrStr() + '\n' +
          'Balance: $' + (S.bal / 100).toFixed(2)
        );
      }
    }

    save();
  } catch (e) {
    log('Monitor error: ' + e.message);
  }
}

// ─── BOT LOOP ────────────────────────────────────────────────────
let _scanTimer, _brainTimer, _heartbeatTimer;

function startBot() {
  if (S.on) return;
  S.on       = true;
  S.haltMsg  = null;
  S.startedAt = new Date().toISOString();
  log('Bot started — ' + (C.paper ? 'PAPER' : 'LIVE') + ' mode');

  // Immediate first actions
  scan().then(() => syncBal());

  // Main loop: every 30s
  // Order: syncBal → scan → monitor → execute → record
  _scanTimer = setInterval(async () => {
    midnight();
    await syncBal();
    await scan();
    await monitor();
    if (breakers()) await execute();
    S.pnlHist.push({ ts: Date.now(), bal: dispUsd(), pnl: S.totPnl });
    if (S.pnlHist.length > 500) S.pnlHist.shift();
    save();
  }, C.scanSec * 1000);

  // Brain: first run at 20s, then every 90s
  _brainTimer = setTimeout(() => {
    brain();
    _brainTimer = setInterval(brain, C.brainSec * 1000);
  }, 20000);

  // Heartbeat: every 30 minutes
  _heartbeatTimer = setInterval(async () => {
    const age   = sigAgeSec();
    const ageStr = age === null ? 'none yet' : age < 60 ? age + 's' : Math.round(age / 60) + 'min';
    const dd    = S.peak > 0 ? ((S.peak - S.bal) / S.peak * 100).toFixed(1) : '0.0';
    await tg(
      '📊 <b>Heartbeat — Kalshi Edge</b>\n' +
      'Mode: ' + (C.paper ? '📝 Paper' : '⚡ LIVE') + '\n' +
      'Real Kalshi: $' + realUsd().toFixed(2) +
        (C.paper ? ' | Paper sim: $' + (S.paperBal / 100).toFixed(2) : '') + '\n' +
      'Today P&L: ' + fmt(S.dayPnl) + ' | All-time: ' + fmt(S.totPnl) + '\n' +
      'Win rate: ' + wrStr() + '\n' +
      'Positions: ' + S.positions.length + '/' + C.maxPos + ' | Brain calls: ' + S.calls + '\n' +
      'Drawdown: ' + dd + '% | Signal age: ' + ageStr
    );
  }, 30 * 60 * 1000);

  save();
}

function stopBot() {
  S.on = false;
  clearInterval(_scanTimer);
  clearTimeout(_brainTimer);
  clearInterval(_brainTimer);
  clearInterval(_heartbeatTimer);
  _scanTimer = _brainTimer = _heartbeatTimer = null;
  log('Bot stopped');
  save();
}

// ─── API ROUTES ──────────────────────────────────────────────────
app.get('/s', (_, res) => {
  const tot = S.wins + S.losses;
  const dd  = S.peak > 0 ? (S.peak - S.bal) / S.peak * 100 : 0;
  const age = sigAgeSec();
  res.json({
    on:       S.on,
    paper:    C.paper,
    bal:      dispUsd(),         // display balance (paper sim or real)
    realBal:  realUsd(),         // always real Kalshi
    paperBal: S.paperBal / 100,  // paper simulation balance
    peak:     S.peak / 100,
    dd:       parseFloat(dd.toFixed(1)),
    dayPnl:   S.dayPnl,
    totPnl:   S.totPnl,
    wins:     S.wins,
    losses:   S.losses,
    total:    tot,
    wr:       tot > 0 ? parseFloat((S.wins / tot * 100).toFixed(1)) : null,
    open:     S.positions.length,
    maxPos:   C.maxPos,
    calls:    S.calls,
    authFails:S.authFails,
    signalAge:age,
    scanAt:   S.scanAt,
    brainAt:  S.brainAt,
    startedAt:S.startedAt,
    haltMsg:  S.haltMsg,
    lastErr:  S.lastErr,
    cfg: {
      kelly:     C.kelly,
      edgeLive:  C.edgeLive,
      edgePaper: C.edgePaper,
      maxBet:    C.maxBet,
      maxPos:    C.maxPos,
      dailyStop: C.dailyStop,
      ddLimit:   C.ddLimit,
    },
  });
});

app.get('/trades',    (_, res) => res.json(S.trades.slice(0, 50)));
app.get('/positions', (_, res) => res.json(S.positions));
app.get('/signals',   (_, res) => res.json(S.signals));
app.get('/cands',     (_, res) => res.json(S.cands));
app.get('/logs',      (_, res) => res.json(LOGS.slice(0, 150)));
app.get('/pnl',       (_, res) => res.json(S.pnlHist.slice(-200)));
app.get('/notes',     (_, res) => res.json(S.notes));

app.post('/start',  (_, res) => { startBot(); res.json({ ok: true }); });
app.post('/stop',   (_, res) => { stopBot();  res.json({ ok: true }); });
app.post('/scan',   async (_, res) => { await scan();  res.json({ ok: true, count: S.cands.length }); });
app.post('/brain',  async (_, res) => { await brain(); res.json({ ok: true, signals: S.signals.length }); });
app.get('/test',    async (_, res) => {
  const ok = await validate();
  res.json({ ok, realBal: realUsd() });
});

// Paper: manually settle a position for testing win/loss tracking
app.post('/settle', (req, res) => {
  const { id, won } = req.body;
  const p = S.positions.find(x => x.id === id);
  if (!p) return res.json({ ok: false, error: 'position not found' });

  // P&L: if won, collect (100-ep)/ep profit per dollar invested; if lost, lose stake
  const pnl = won
    ? p.size * ((100 - p.ep) / p.ep)   // profit on YES bet
    : -p.size;

  S.positions = S.positions.filter(x => x.id !== id);
  S.totPnl   += pnl;
  S.dayPnl   += pnl;
  S.paperBal += Math.round(pnl * 100);
  S.peak      = Math.max(S.peak, S.paperBal);

  if (pnl > 0) S.wins++; else S.losses++;

  S.trades.unshift({
    ...p,
    closedAt: new Date().toISOString(),
    pnl,
    won: pnl > 0,
  });
  if (S.trades.length > 100) S.trades.length = 100;

  S.pnlHist.push({ ts: Date.now(), bal: dispUsd(), pnl: S.totPnl });
  save();

  tg(
    (pnl > 0 ? '✅' : '❌') + ' <b>Paper Settled: ' + p.ticker + '</b>\n' +
    'P&L: ' + fmt(pnl) + '\n' +
    'All-time: ' + fmt(S.totPnl) + ' | Win rate: ' + wrStr() + '\n' +
    'Paper balance: $' + (S.paperBal / 100).toFixed(2)
  );
  res.json({ ok: true, pnl, newBalance: S.paperBal / 100 });
});

app.post('/reset', (_, res) => {
  stopBot();
  S = fresh();
  save();
  res.json({ ok: true });
});

// ─── DASHBOARD ───────────────────────────────────────────────────
app.get('/', (_, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(DASHBOARD());
});

function DASHBOARD() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#07070f">
<title>Kalshi Edge</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#07070f;--l1:#0d0d1c;--l2:#121222;--l3:#181830;--l4:#1e1e3a;
  --bd:rgba(255,255,255,.06);--bd2:rgba(255,255,255,.12);--bd3:rgba(255,255,255,.2);
  --t1:#f0f0ff;--t2:#8888bb;--t3:#44446a;
  --g:#00e676;--ga:rgba(0,230,118,.12);--g2:rgba(0,230,118,.22);
  --r:#ff4560;--ra:rgba(255,69,96,.12);
  --b:#4488ff;--ba:rgba(68,136,255,.12);
  --y:#ffb020;--ya:rgba(255,176,32,.12);
  --m:'JetBrains Mono',monospace;
  --f:'Outfit',sans-serif;
  --st:env(safe-area-inset-top,0px);
  --sb:env(safe-area-inset-bottom,0px)
}
html,body{height:100%;background:var(--bg);color:var(--t1);font-family:var(--f);-webkit-font-smoothing:antialiased;overflow:hidden}
.app{display:flex;flex-direction:column;height:100%;padding-top:var(--st)}

/* HEADER */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 10px;flex-shrink:0}
.logo-row{display:flex;align-items:center;gap:10px}
.logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#00e676,#4488ff);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;color:#000;letter-spacing:-.5px}
.app-name{font-size:20px;font-weight:800;letter-spacing:-.4px}
.badge{font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;padding:4px 10px;border-radius:20px;border:1px solid}
.b-paper{background:var(--ya);border-color:var(--y);color:var(--y)}
.b-live{background:var(--ra);border-color:var(--r);color:var(--r)}
.b-running{background:var(--ga);border-color:var(--g);color:var(--g)}

/* TAB BAR */
.tab-bar{display:flex;padding:0 14px 10px;gap:4px;flex-shrink:0;overflow-x:auto}
.tab-bar::-webkit-scrollbar{display:none}
.tb{border:none;background:var(--l2);color:var(--t3);font-family:var(--f);font-size:12px;font-weight:700;padding:8px 16px;border-radius:20px;cursor:pointer;white-space:nowrap;letter-spacing:.3px;transition:all .15s}
.tb.on{background:var(--l4);color:var(--t1);border:1px solid var(--bd2)}

/* SCROLL */
.scroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 14px calc(70px + var(--sb)) 14px}
.scroll::-webkit-scrollbar{display:none}

/* PANELS */
.panel{display:none}.panel.on{display:block}

/* PAGE HEADER */
.ph{margin-bottom:18px}
.ph h1{font-size:30px;font-weight:900;letter-spacing:-.8px;line-height:1}
.ph p{font-size:13px;color:var(--t2);margin-top:4px}
.ph-row{display:flex;align-items:flex-start;justify-content:space-between}

/* HALT BANNER */
.halt{background:var(--ra);border:1px solid var(--r);border-radius:16px;padding:14px 16px;margin-bottom:14px;display:none}
.halt strong{display:block;color:var(--r);font-size:13px;margin-bottom:3px}
.halt span{color:var(--r);font-size:12px;opacity:.85}

/* HERO CARD */
.hero{background:var(--l1);border:1px solid var(--bd);border-radius:22px;padding:22px 20px 18px;margin-bottom:12px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-50px;right:-50px;width:160px;height:160px;background:radial-gradient(circle,rgba(0,230,118,.07),transparent 65%);border-radius:50%;pointer-events:none}
.hero-lbl{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--t3);margin-bottom:8px}
.hero-pnl{font-size:46px;font-weight:900;letter-spacing:-2px;line-height:1;margin-bottom:5px}
.hero-sub{font-size:13px;color:var(--t2);margin-bottom:18px}
.hero-stats{display:flex;border-top:1px solid var(--bd);padding-top:16px}
.hstat{flex:1;display:flex;flex-direction:column;gap:4px}
.hstat+.hstat{border-left:1px solid var(--bd);padding-left:16px}
.hstat-l{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3)}
.hstat-v{font-size:15px;font-weight:700;letter-spacing:-.3px}

/* TRI ROW */
.trirow{display:flex;background:var(--l2);border:1px solid var(--bd);border-radius:16px;overflow:hidden;margin-bottom:12px}
.tristat{flex:1;padding:14px 12px;text-align:center}
.tristat+.tristat{border-left:1px solid var(--bd)}
.tri-l{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3);margin-bottom:5px}
.tri-v{font-size:18px;font-weight:800;letter-spacing:-.4px}

/* ENGINE CARD */
.engine{background:var(--l2);border:1px solid var(--bd);border-radius:18px;padding:16px 18px;display:flex;align-items:center;gap:14px;margin-bottom:12px}
.engine-icon{width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,rgba(0,230,118,.2),rgba(68,136,255,.2));border:1px solid var(--bd2);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.engine-info{flex:1}
.engine-name{font-size:16px;font-weight:700}
.engine-sub{font-size:12px;color:var(--t2);margin-top:2px}
.toggle{width:50px;height:28px;border-radius:14px;border:none;cursor:pointer;position:relative;transition:background .2s;flex-shrink:0}
.toggle::after{content:'';position:absolute;top:3px;width:22px;height:22px;border-radius:11px;background:#fff;transition:left .2s}
.toggle.off{background:var(--l4)}.toggle.off::after{left:3px}
.toggle.on2{background:var(--g)}.toggle.on2::after{left:25px}

/* STAT GRID */
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
.sc{background:var(--l2);border:1px solid var(--bd);border-radius:14px;padding:14px}
.sc-l{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3);margin-bottom:6px}
.sc-v{font-size:22px;font-weight:800;letter-spacing:-.5px}
.sc-full{grid-column:span 2}

/* SECTION */
.sec{background:var(--l1);border:1px solid var(--bd);border-radius:18px;padding:16px;margin-bottom:12px}
.sec-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.sec-title{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--t3)}
.sec-ct{font-size:11px;font-weight:700;background:var(--l3);color:var(--t2);padding:3px 9px;border-radius:8px}

/* CHART */
.chart-box{height:140px;position:relative}

/* TIME FILTER */
.tf{display:flex;gap:6px;margin-bottom:14px}
.tfb{border:1px solid var(--bd);background:none;color:var(--t3);border-radius:20px;padding:5px 14px;font-family:var(--f);font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}
.tfb.on{background:var(--l3);color:var(--t1);border-color:var(--bd2)}

/* WIN RING */
.ring-wrap{display:flex;align-items:center;gap:20px;margin-bottom:14px}
.ring-rows{flex:1;display:flex;flex-direction:column;gap:8px}
.rrow{display:flex;justify-content:space-between;font-size:13px}
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

/* CHIPS */
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

/* BTNS */
.btns{display:flex;gap:8px;margin-bottom:12px}
.btn{flex:1;border:1px solid var(--bd2);background:var(--l3);color:var(--t1);border-radius:14px;padding:13px 8px;font-family:var(--f);font-size:13px;font-weight:700;cursor:pointer;transition:all .15s}
.btn:active{transform:scale(.97)}.btn:disabled{opacity:.35;cursor:default}
.btn-g{background:var(--ga);border-color:var(--g);color:var(--g)}
.btn-r{background:var(--ra);border-color:var(--r);color:var(--r)}

/* EMPTY */
.empty{text-align:center;color:var(--t3);font-size:13px;padding:28px 0;line-height:1.6}
.ei{font-size:30px;margin-bottom:8px}

/* COLORS */
.cg{color:var(--g)}.cr{color:var(--r)}.cy{color:var(--y)}.cb{color:var(--b)}

/* BOTTOM NAV */
.bnav{display:flex;background:var(--l1);border-top:1px solid var(--bd);padding-bottom:var(--sb);flex-shrink:0}
.bnav-btn{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 4px;background:none;border:none;color:var(--t3);font-family:var(--f);font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;cursor:pointer;transition:color .15s}
.bnav-btn svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.8}
.bnav-btn.on{color:var(--g)}
</style>
</head><body>
<div class="app">

<div class="hdr">
  <div class="logo-row">
    <div class="logo">KE</div>
    <span class="app-name">Kalshi Edge</span>
  </div>
  <span id="modeBadge" class="badge b-paper">PAPER</span>
</div>

<div class="tab-bar">
  <button class="tb on" onclick="goTab(0,this)">Home</button>
  <button class="tb" onclick="goTab(1,this)">Charts</button>
  <button class="tb" onclick="goTab(2,this)">Feed</button>
  <button class="tb" onclick="goTab(3,this)">Signals</button>
  <button class="tb" onclick="goTab(4,this)">Brain</button>
</div>

<div class="scroll">

<!-- HOME -->
<div class="panel on" id="p0">
  <div class="halt" id="haltBox"><strong>⚡ Bot Halted</strong><span id="haltMsg"></span></div>

  <div class="hero">
    <div class="hero-lbl">Total Profit / Loss</div>
    <div class="hero-pnl cg" id="heroPnl">+$0.00</div>
    <div class="hero-sub" id="heroSub">Start bot to begin tracking</div>
    <div class="hero-stats">
      <div class="hstat">
        <div class="hstat-l">Kalshi Balance</div>
        <div class="hstat-v" id="hBal">—</div>
      </div>
      <div class="hstat">
        <div class="hstat-l">Today</div>
        <div class="hstat-v" id="hDay">—</div>
      </div>
      <div class="hstat">
        <div class="hstat-l">Drawdown</div>
        <div class="hstat-v" id="hDd">—</div>
      </div>
    </div>
  </div>

  <div class="trirow">
    <div class="tristat">
      <div class="tri-l">Deployed</div>
      <div class="tri-v" id="tDeployed">$0</div>
    </div>
    <div class="tristat">
      <div class="tri-l">Trades</div>
      <div class="tri-v" id="tTrades">0</div>
    </div>
    <div class="tristat">
      <div class="tri-l">Open</div>
      <div class="tri-v" id="tOpen">0/5</div>
    </div>
  </div>

  <div class="engine">
    <div class="engine-icon">⚡</div>
    <div class="engine-info">
      <div class="engine-name">AI Trading Engine</div>
      <div class="engine-sub" id="engineSub">Tap to activate</div>
    </div>
    <button class="toggle off" id="toggleBtn" onclick="toggleBot()"></button>
  </div>

  <div class="grid2">
    <div class="sc"><div class="sc-l">Win Rate</div><div class="sc-v" id="gWr">—</div></div>
    <div class="sc"><div class="sc-l">W / L</div><div class="sc-v" id="gWl">—</div></div>
    <div class="sc"><div class="sc-l">Scans / hr</div><div class="sc-v" id="gScans">—</div></div>
    <div class="sc"><div class="sc-l">Brain calls</div><div class="sc-v" id="gCalls">—</div></div>
    <div class="sc sc-full">
      <div class="sc-l">Signal freshness</div>
      <div class="sc-v" id="gSigAge" style="font-size:16px">—</div>
    </div>
  </div>
</div>

<!-- CHARTS -->
<div class="panel" id="p1">
  <div class="ph"><h1>Analytics</h1><p>Session performance</p></div>

  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Equity Curve</span></div>
    <div class="tf">
      <button class="tfb on" onclick="setTf('1h',this)">1H</button>
      <button class="tfb" onclick="setTf('6h',this)">6H</button>
      <button class="tfb" onclick="setTf('all',this)">ALL</button>
    </div>
    <div style="font-size:30px;font-weight:900;letter-spacing:-1px;margin-bottom:3px" id="chartVal">+$0.00</div>
    <div style="font-size:12px;color:var(--t3);margin-bottom:14px" id="chartLbl">No data yet</div>
    <div class="chart-box"><canvas id="cvs" height="140"></canvas></div>
  </div>

  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Performance</span></div>
    <div class="ring-wrap">
      <svg width="86" height="86" viewBox="0 0 86 86" style="flex-shrink:0">
        <circle cx="43" cy="43" r="34" fill="none" stroke="var(--l3)" stroke-width="9"/>
        <circle id="ringArc" cx="43" cy="43" r="34" fill="none" stroke="var(--g)" stroke-width="9"
          stroke-dasharray="0 214" stroke-linecap="round" transform="rotate(-90 43 43)"/>
        <text x="43" y="48" text-anchor="middle" font-size="13" font-weight="800"
          fill="var(--t1)" font-family="Outfit,sans-serif" id="ringTx">—</text>
      </svg>
      <div class="ring-rows">
        <div class="rrow"><span class="rlbl">Wins</span><span class="cg" id="rW">0</span></div>
        <div class="rrow"><span class="rlbl">Losses</span><span class="cr" id="rL">0</span></div>
        <div class="rrow"><span class="rlbl">Total trades</span><span id="rTot">0</span></div>
        <div class="rrow"><span class="rlbl">Brain calls</span><span id="rCalls">0</span></div>
      </div>
    </div>
    <div class="gross-row">
      <span style="color:var(--t2);font-size:14px">Gross P&L</span>
      <span style="font-size:18px;font-weight:800" id="rGross">+$0.00</span>
    </div>
  </div>

  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Recent Trades</span><span class="sec-ct" id="trCt">0</span></div>
    <div id="tradeList"><div class="empty"><div class="ei">📊</div>No completed trades</div></div>
  </div>
</div>

<!-- FEED -->
<div class="panel" id="p2">
  <div class="ph ph-row">
    <div><h1>Live Feed</h1><p>Monitoring markets</p></div>
    <span id="feedBadge" class="badge b-paper" style="margin-top:8px">PAUSED</span>
  </div>
  <div class="chips">
    <button class="chip on" onclick="setFeed('all',this)">All</button>
    <button class="chip" onclick="setFeed('signals',this)">Signals</button>
    <button class="chip" onclick="setFeed('rising',this)">Rising ↑</button>
    <button class="chip" onclick="setFeed('falling',this)">Falling ↓</button>
    <button class="chip" onclick="setFeed('urgent',this)">Urgent &lt;6h</button>
  </div>
  <div id="feedList"><div class="empty"><div class="ei">📡</div><b>Feed is empty</b><br>Enable the bot on Home to start monitoring.</div></div>
</div>

<!-- SIGNALS -->
<div class="panel" id="p3">
  <div class="ph"><h1>Signals</h1><p>Claude AI analysis</p></div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Live Signals</span><span class="sec-ct" id="sigCt">0</span></div>
    <div id="sigList"><div class="empty"><div class="ei">🧠</div>Waiting for brain cycle...</div></div>
  </div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Open Positions</span><span class="sec-ct" id="posCt">0</span></div>
    <div id="posList"><div class="empty">No open positions</div></div>
  </div>
  <div class="btns">
    <button class="btn btn-g" id="btnStart" onclick="doApi('/start')">Start Bot</button>
    <button class="btn btn-r" id="btnStop"  onclick="doApi('/stop')">Stop</button>
  </div>
  <div class="btns">
    <button class="btn" onclick="doApi('/brain')">Force Brain</button>
    <button class="btn" onclick="doApi('/scan')">Force Scan</button>
  </div>
</div>

<!-- BRAIN -->
<div class="panel" id="p4">
  <div class="ph"><h1>Brain</h1><p>Claude memory &amp; logs</p></div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Learnings</span><span class="sec-ct" id="noteCt">0</span></div>
    <div id="noteList"><div class="empty"><div class="ei">💡</div>No learnings yet</div></div>
  </div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">System Log</span></div>
    <div id="logList"><div class="empty">Starting...</div></div>
  </div>
</div>

</div><!-- /scroll -->

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
const $ = id => document.getElementById(id);
const esc = s => { const d=document.createElement('div');d.textContent=String(s||'');return d.innerHTML; };
const fmtP = n => (n>=0?'+':'')+'\$'+Math.abs(n).toFixed(2);
const fmtB = n => '\$'+Number(n).toFixed(2);

let D={}, sigs=[], pos=[], trades=[], cands=[], notes=[], logs=[], pnl=[];
let tf='1h', feedFilter='all', botOn=false;

function goTab(i,btn){
  document.querySelectorAll('.panel').forEach((p,j)=>p.classList.toggle('on',j===i));
  document.querySelectorAll('.tb').forEach((b,j)=>b.classList.toggle('on',j===i));
  document.querySelectorAll('.bnav-btn').forEach((b,j)=>b.classList.toggle('on',j===i));
}
function setTf(m,btn){
  tf=m;
  document.querySelectorAll('.tfb').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  drawChart();
}
function setFeed(f,btn){
  feedFilter=f;
  document.querySelectorAll('.chip').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  renderFeed();
}
function toggleBot(){ doApi(botOn?'/stop':'/start'); }
async function doApi(path){
  try{ await fetch(path,{method:'POST'}); setTimeout(refresh,600); }
  catch(e){ console.error(e); }
}

function drawChart(){
  const canvas=$('cvs');
  if(!canvas) return;
  const W=canvas.offsetWidth, H=140;
  canvas.width=W*devicePixelRatio; canvas.height=H*devicePixelRatio;
  const ctx=canvas.getContext('2d');
  ctx.scale(devicePixelRatio,devicePixelRatio);

  const now=Date.now();
  let slice=pnl;
  if(tf==='1h') slice=pnl.filter(p=>p.ts>now-3600000);
  else if(tf==='6h') slice=pnl.filter(p=>p.ts>now-21600000);

  const last=slice.length?slice[slice.length-1].pnl:0;
  const cv=$('chartVal');
  cv.textContent=fmtP(last);
  cv.className=last>=0?'cg':'cr';
  cv.style.cssText='font-size:30px;font-weight:900;letter-spacing:-1px;margin-bottom:3px';
  $('chartLbl').textContent=slice.length>1?slice.length+' snapshots':'No data yet';

  ctx.clearRect(0,0,W,H);
  if(slice.length<2){
    ctx.fillStyle='rgba(255,255,255,.15)';ctx.font='12px Outfit';ctx.textAlign='center';
    ctx.fillText('Collecting data...',W/2,H/2); return;
  }

  const vals=slice.map(p=>p.pnl);
  const mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||1;
  const px=i=>8+(i/(vals.length-1))*(W-16);
  const py=v=>H-8-((v-mn)/rng)*(H-22);
  const col=last>=0?'0,230,118':'255,69,96';

  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,'rgba('+col+',.28)');
  g.addColorStop(1,'rgba('+col+',0)');

  ctx.beginPath();ctx.moveTo(px(0),py(vals[0]));
  for(let i=1;i<vals.length;i++){const cx=(px(i-1)+px(i))/2;ctx.bezierCurveTo(cx,py(vals[i-1]),cx,py(vals[i]),px(i),py(vals[i]));}
  ctx.lineTo(px(vals.length-1),H);ctx.lineTo(px(0),H);ctx.closePath();
  ctx.fillStyle=g;ctx.fill();

  ctx.beginPath();ctx.moveTo(px(0),py(vals[0]));
  for(let i=1;i<vals.length;i++){const cx=(px(i-1)+px(i))/2;ctx.bezierCurveTo(cx,py(vals[i-1]),cx,py(vals[i]),px(i),py(vals[i]));}
  ctx.strokeStyle='rgb('+col+')';ctx.lineWidth=2.5;ctx.stroke();
}

function renderSigs(){
  const el=$('sigList');
  $('sigCt').textContent=sigs.length;
  if(!sigs.length){el.innerHTML='<div class="empty"><div class="ei">🧠</div>No signals — brain scanning...</div>';return;}
  el.innerHTML=sigs.map(s=>
    '<div class="item"><div class="ihead"><div class="iname">'+esc(s.title||s.ticker)+'</div>'+
    '<span class="tag '+(s.side==='yes'?'t-yes':'t-no')+'">'+s.side.toUpperCase()+'</span></div>'+
    '<div class="imeta">'+
    '<span>Mkt '+((s.marketPrice||0)*100).toFixed(0)+'¢</span>'+
    '<span>True '+((s.trueProb||0)*100).toFixed(0)+'¢</span>'+
    '<span class="cg">Edge '+((s.edge||0)*100).toFixed(1)+'%</span>'+
    (s.limitPrice?'<span>Limit '+s.limitPrice+'¢</span>':'')+
    '<span class="'+(s.confidence==='high'?'cy':'')+'">'+esc(s.confidence||'')+'</span>'+
    '</div>'+(s.reasoning?'<div class="ireason">'+esc(s.reasoning)+'</div>':'')+
    '</div>'
  ).join('');
}

function renderPos(){
  const el=$('posList');
  $('posCt').textContent=pos.length;
  if(!pos.length){el.innerHTML='<div class="empty">No open positions</div>';return;}
  el.innerHTML=pos.map(p=>
    '<div class="item"><div class="ihead"><div class="iname">'+esc(p.title||p.ticker)+'</div>'+
    '<span class="tag '+(p.side==='yes'?'t-yes':'t-no')+'">'+p.side.toUpperCase()+'</span></div>'+
    '<div class="imeta">'+
    '<span>'+p.qty+'ct @ '+p.ep+'¢</span>'+
    '<span>\$'+(p.size||0).toFixed(2)+'</span>'+
    '<span class="cg">Edge '+((p.edge||0)*100).toFixed(1)+'%</span>'+
    '</div>'+(p.reason?'<div class="ireason">'+esc(p.reason)+'</div>':'')+
    '</div>'
  ).join('');
}

function renderTrades(){
  const el=$('tradeList');
  $('trCt').textContent=trades.length;
  if(!trades.length){el.innerHTML='<div class="empty"><div class="ei">📊</div>No completed trades</div>';return;}
  el.innerHTML=trades.slice(0,20).map(t=>
    '<div class="item"><div class="ihead"><div class="iname">'+esc(t.title||t.ticker)+'</div>'+
    '<span class="tag '+(t.won?'t-won':'t-lost')+'">'+(t.won?'WON':'LOST')+'</span></div>'+
    '<div class="imeta">'+
    '<span>'+(t.side||'').toUpperCase()+' @ '+t.ep+'¢</span>'+
    '<span class="'+(t.pnl>=0?'cg':'cr')+'">'+fmtP(t.pnl)+'</span>'+
    '</div></div>'
  ).join('');
}

function renderFeed(){
  const el=$('feedList');
  let list=[...cands];
  if(feedFilter==='signals'){const st=new Set(sigs.map(s=>s.ticker));list=list.filter(c=>st.has(c.ticker));}
  else if(feedFilter==='rising') list=list.filter(c=>c.mom==='↑');
  else if(feedFilter==='falling') list=list.filter(c=>c.mom==='↓');
  else if(feedFilter==='urgent') list=list.filter(c=>parseFloat(c.hrs)<6);
  if(!list.length){el.innerHTML='<div class="empty"><div class="ei">📡</div>No markets match this filter</div>';return;}
  const sigSet=new Set(sigs.map(s=>s.ticker));
  el.innerHTML=list.slice(0,15).map(c=>
    '<div class="item"><div class="ihead">'+
    '<div class="iname" style="font-size:12px">'+esc(c.title)+'</div>'+
    '<span style="font-family:var(--m);font-size:11px;color:var(--t3)">'+c.yes+'¢ '+c.mom+'</span>'+
    '</div><div class="imeta">'+
    '<span>Vol '+c.vol.toLocaleString()+'</span>'+
    '<span>'+c.hrs+'h</span>'+
    '<span>'+esc(c.cat)+'</span>'+
    (sigSet.has(c.ticker)?'<span class="cb">SIGNAL</span>':'')+
    '</div></div>'
  ).join('');
}

function renderNotes(){
  const el=$('noteList');
  $('noteCt').textContent=notes.length;
  if(!notes.length){el.innerHTML='<div class="empty"><div class="ei">💡</div>No learnings yet</div>';return;}
  el.innerHTML=[...notes].reverse().map(n=>'<div class="note">'+esc(n)+'</div>').join('');
}

function renderLogs(){
  const el=$('logList');
  if(!logs.length){el.innerHTML='<div class="empty">No logs</div>';return;}
  el.innerHTML=logs.slice(0,80).map(l=>'<div class="logline">'+esc(l)+'</div>').join('');
}

async function refresh(){
  try{
    const [st,sg,ps,tr,ca,lg,pl,nt]=await Promise.all([
      fetch('/s').then(r=>r.json()),
      fetch('/signals').then(r=>r.json()),
      fetch('/positions').then(r=>r.json()),
      fetch('/trades').then(r=>r.json()),
      fetch('/cands').then(r=>r.json()),
      fetch('/logs').then(r=>r.json()),
      fetch('/pnl').then(r=>r.json()),
      fetch('/notes').then(r=>r.json()),
    ]);
    D=st;sigs=sg;pos=ps;trades=tr;cands=ca;logs=lg;pnl=pl;notes=nt;
    botOn=st.on;

    // Mode badge
    const mb=$('modeBadge');
    if(st.on){mb.textContent='RUNNING';mb.className='badge b-running';}
    else if(st.paper){mb.textContent='PAPER';mb.className='badge b-paper';}
    else{mb.textContent='LIVE';mb.className='badge b-live';}

    // Halt
    const hb=$('haltBox');
    hb.style.display=st.haltMsg?'block':'none';
    if(st.haltMsg)$('haltMsg').textContent=st.haltMsg;

    // Hero P&L
    const pnlEl=$('heroPnl');
    pnlEl.textContent=fmtP(st.totPnl);
    pnlEl.className='hero-pnl '+(st.totPnl>=0?'cg':'cr');
    $('heroSub').textContent=st.on?'Bot running — scanning every 30s':'Start bot to begin tracking';

    // Always show REAL Kalshi balance
    const balEl=$('hBal');
    balEl.textContent=fmtB(st.realBal)+(st.paper?' (real)':'');
    balEl.className='hstat-v';

    const dayEl=$('hDay');
    dayEl.textContent=fmtP(st.dayPnl);
    dayEl.className='hstat-v '+(st.dayPnl>=0?'cg':'cr');

    const ddEl=$('hDd');
    ddEl.textContent=st.dd.toFixed(1)+'%';
    ddEl.className='hstat-v '+(st.dd>15?'cr':st.dd>7?'cy':'cg');

    // Tri row
    const deployed=pos.reduce((a,p)=>a+(p.size||0),0);
    $('tDeployed').textContent='\$'+deployed.toFixed(2);
    $('tTrades').textContent=st.total;
    $('tOpen').textContent=st.open+'/'+st.maxPos;

    // Engine toggle
    const tb=$('toggleBtn'),es=$('engineSub');
    tb.className='toggle '+(st.on?'on2':'off');
    es.textContent=st.on?'Active — scanning every 30s':'Tap to activate';

    // Stats grid
    $('gWr').textContent=st.wr!=null?st.wr+'%':'—';
    $('gWl').textContent=st.wins+' / '+st.losses;
    $('gScans').textContent=st.on?Math.round(3600/30)+'':'0';
    $('gCalls').textContent=st.calls;

    // Signal freshness
    const saEl=$('gSigAge');
    if(st.signalAge===null){saEl.textContent='—';saEl.style.color='var(--t3)';}
    else if(st.signalAge<60){saEl.textContent=st.signalAge+'s ago';saEl.style.color='var(--g)';}
    else if(st.signalAge<180){saEl.textContent=Math.round(st.signalAge/60)+'min ago';saEl.style.color='var(--y)';}
    else{saEl.textContent=Math.round(st.signalAge/60)+'min ago (stale)';saEl.style.color='var(--r)';}

    // Charts
    $('rW').textContent=st.wins;$('rL').textContent=st.losses;
    $('rTot').textContent=st.total;$('rCalls').textContent=st.calls;
    const ringPct=st.wr!=null?st.wr/100:0;
    $('ringArc').setAttribute('stroke-dasharray',(ringPct*214).toFixed(1)+' 214');
    $('ringTx').textContent=st.wr!=null?st.wr+'%':'—';
    const grossEl=$('rGross');
    grossEl.textContent=fmtP(st.totPnl);
    grossEl.style.cssText='font-size:18px;font-weight:800;color:'+(st.totPnl>=0?'var(--g)':'var(--r)');

    // Feed badge
    const fb=$('feedBadge');
    if(st.on){fb.textContent='ACTIVE';fb.className='badge b-running';}
    else{fb.textContent='PAUSED';fb.className='badge b-paper';}

    // Buttons
    if($('btnStart'))$('btnStart').disabled=st.on;
    if($('btnStop'))$('btnStop').disabled=!st.on;

    drawChart();
    renderSigs();renderPos();renderTrades();renderFeed();renderNotes();renderLogs();

  }catch(e){console.error('Refresh:',e);}
}

refresh();
setInterval(refresh,8000);
window.addEventListener('resize',drawChart);
</script>
</body></html>`;
}

// ─── BOOT ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  log('════════════════════════════════════════════');
  log('  KALSHI EDGE v8  —  Production build');
  log('════════════════════════════════════════════');
  log('  Mode:       ' + (C.paper ? 'PAPER (DRY_RUN=true)' : '⚡ LIVE TRADING'));
  log('  Kelly:      ' + C.kelly + ' | Edge live: ' + (C.edgeLive*100).toFixed(0) + '% | paper: ' + (C.edgePaper*100).toFixed(0) + '%');
  log('  Max bet:    $' + C.maxBet + ' | Max positions: ' + C.maxPos);
  log('  Stops:      daily -$' + C.dailyStop + ' | drawdown ' + (C.ddLimit*100).toFixed(0) + '%');
  log('  Cadence:    scan ' + C.scanSec + 's | brain ' + C.brainSec + 's | heartbeat 30min');
  log('  Telegram:   ' + (C.tgTok ? '✓' : '✗ NO TOKEN') + ' | ' + (C.tgChat ? '✓' : '✗ NO CHAT'));
  log('  Claude:     ' + (C.claude ? '✓' : '✗ NO KEY'));
  log('  Kalshi:     ' + (C.keyId ? '✓' : '✗ NO KEY'));
  log('════════════════════════════════════════════');

  // Test Telegram immediately
  if (C.tgTok && C.tgChat) {
    log('Testing Telegram...');
    await tg('🔧 <b>Kalshi Edge v8</b> — boot test, Telegram connected ✓');
  } else {
    log('WARNING: Telegram not configured');
  }

  if (!C.keyId || !C.pem) {
    log('STANDBY — set KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY and redeploy');
    await tg('⚠️ <b>Standby</b> — Kalshi credentials missing.\nSet KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY in Railway.');
    return;
  }

  const ok = await validate();
  if (!ok) {
    log('STANDBY — fix credentials and redeploy');
    return;
  }

  // Build and send full startup checklist
  const checks = [
    (C.keyId             ? '✅' : '❌') + ' Kalshi API key',
    (C.pem.length > 50   ? '✅' : '❌') + ' RSA private key',
    (C.claude            ? '✅' : '❌') + ' Claude API key',
    (C.tgTok             ? '✅' : '❌') + ' Telegram token',
    (C.tgChat            ? '✅' : '❌') + ' Telegram chat ID',
    (!C.paper            ? '✅' : '⚠️') + ' Live mode' + (C.paper ? ' (PAPER — set DRY_RUN=false to go live)' : ' (ACTIVE)'),
  ].join('\n');

  await tg(
    '🟢 <b>Kalshi Edge v8 — Online</b>\n\n' +
    'Mode: ' + (C.paper ? '📝 Paper Trading' : '⚡ LIVE TRADING') + '\n' +
    'Real Kalshi balance: <b>$' + realUsd().toFixed(2) + '</b>\n' +
    (C.paper ? 'Paper sim balance: <b>$' + (S.paperBal / 100).toFixed(2) + '</b>\n' : '') +
    'Kelly: ' + C.kelly + ' | Min edge: ' + (C.edgeLive * 100).toFixed(0) + '%\n' +
    'Daily stop: -$' + C.dailyStop + ' | Drawdown: ' + (C.ddLimit * 100).toFixed(0) + '%\n' +
    'Max bet: $' + C.maxBet + ' | Max positions: ' + C.maxPos + '\n\n' +
    '<b>System checklist:</b>\n' + checks + '\n\n' +
    'Heartbeat every 30 minutes. Bot starts in 3 seconds.'
  );

  log('All checks passed. Real balance: $' + realUsd().toFixed(2) + '. Starting in 3s...');
  setTimeout(startBot, 3000);
});
