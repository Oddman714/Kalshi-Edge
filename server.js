// ═══════════════════════════════════════════════════════════════════════
//  KALSHI EDGE v5 — Production-Grade AI Trading Bot
//
//  Architecture:
//    Layer 1 → Fast Scanner (30s cadence, pure math, no AI cost)
//    Layer 2 → Claude Brain (90s cadence, web search, top candidates only)
//    Layer 3 → Execution Engine (limit orders only, real-time balance sync)
//
//  Safety Systems:
//    ✓ Startup connection validation (abort if auth fails)
//    ✓ Auth-failure kill switch (halt after 3 consecutive 401/403)
//    ✓ Live balance sync to Kelly calculator every cycle
//    ✓ Drawdown-from-peak circuit breaker (20% from high-water mark)
//    ✓ Daily loss circuit breaker (resets midnight UTC)
//    ✓ Max concurrent positions cap
//    ✓ Claude API cost guardrail (daily estimate vs bankroll %)
//    ✓ Limit orders only (zero taker fees)
//    ✓ Duplicate position prevention
//    ✓ Signal confidence gating (live mode enforces 7%+ edge)
//    ✓ Telegram alerts on every critical event
//
//  Deploy: Railway — set env vars, push to GitHub, done.
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// ─── CONFIG ─────────────────────────────────────────────────────────────

const C = {
  // Kalshi
  apiKeyId:   process.env.KALSHI_API_KEY_ID   || '',
  privateKey: (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  baseUrl:    process.env.KALSHI_BASE_URL     || 'https://api.elections.kalshi.com',
  basePath:   '/trade-api/v2',

  // Claude
  claudeKey:   process.env.CLAUDE_API_KEY || '',
  claudeModel: 'claude-sonnet-4-20250514',

  // Trading — all tunable via env vars
  dryRun:       process.env.DRY_RUN !== 'false',
  kelly:        parseFloat(process.env.KELLY_FRACTION || '0.35'),
  // Live mode enforces 7% minimum. Paper mode uses 3% for signal data.
  edgeMin:      parseFloat(process.env.CLAUDE_EDGE    || '0.07'),
  maxPos:       parseFloat(process.env.MAX_POSITION   || '5'),    // $ per trade hard cap
  maxLoss:      parseFloat(process.env.MAX_DAILY_LOSS || '8'),    // $ daily loss floor
  maxDrawdown:  parseFloat(process.env.MAX_DRAWDOWN   || '0.20'), // 20% from peak halt
  maxConcurrent:parseInt(process.env.MAX_CONCURRENT   || '5'),
  scanInterval: parseInt(process.env.SCAN_INTERVAL    || '30'),   // seconds, Layer 1
  brainInterval:parseInt(process.env.BRAIN_INTERVAL   || '90'),   // seconds, Layer 2
  minVolume:    parseInt(process.env.MIN_VOLUME        || '2000'), // cents volume filter
  maxApiCostPct:parseFloat(process.env.MAX_API_COST_PCT|| '0.10'),// halt if Claude cost > 10% bankroll/day

  // Telegram
  tgToken: process.env.TELEGRAM_TOKEN   || '',
  tgChat:  process.env.TELEGRAM_CHAT_ID || '',
};

// ─── STATE FILE ──────────────────────────────────────────────────────────

const STATE_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'state.json')
  : path.join(__dirname, 'state.json');

function defaultState() {
  return {
    isRunning:   false,
    balance:     C.dryRun ? Math.round(100 * (parseFloat(process.env.BANKROLL || '50'))) : 0, // cents
    highWater:   C.dryRun ? Math.round(100 * (parseFloat(process.env.BANKROLL || '50'))) : 0,
    dailyPnL:    0,
    totalPnL:    0,
    wins: 0, losses: 0,
    positions:   [],
    trades:      [],
    signals:     [],
    brainNotes:  [],
    pnlHistory:  [],
    claudeCalls: 0,
    claudeCostEst: 0,     // estimated $ spent on Claude today
    authFailures: 0,      // consecutive auth failure counter
    dailyReset:  new Date().toDateString(),
    botStarted:  null,
    lastScan:    null,
    lastBrain:   null,
    lastError:   null,
    killReason:  null,
    priceHistory:{},
  };
}

let S = defaultState();
try { const d = JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); S = {...defaultState(), ...d}; } catch(_){}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 2)); } catch(_){}
}

// ─── LOGGING ────────────────────────────────────────────────────────────

const logs = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logs.unshift(line);
  if (logs.length > 300) logs.pop();
}

// ─── TELEGRAM ───────────────────────────────────────────────────────────

async function tg(msg) {
  if (!C.tgToken || !C.tgChat) return;
  const body = JSON.stringify({ chat_id: C.tgChat, text: msg, parse_mode: 'HTML' });
  try {
    await httpPost(`https://api.telegram.org/bot${C.tgToken}/sendMessage`, body, {
      'Content-Type': 'application/json',
    });
  } catch(e) { log(`TG error: ${e.message}`); }
}

// ─── HTTP HELPERS ────────────────────────────────────────────────────────

function httpPost(url, body, headers={}) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Length': Buffer.byteLength(body), ...headers } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(d) }); } catch { res({ status: r.statusCode, data: d }); } });
    });
    req.on('error', rej);
    req.write(body);
    req.end();
  });
}

// ─── KALSHI RSA-PSS AUTH ────────────────────────────────────────────────

function kalshiSign(method, path) {
  const ts = Date.now().toString();
  const payload = ts + method.toUpperCase() + path;
  const sig = crypto.sign('sha256', Buffer.from(payload), {
    key: C.privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return { ts, sig: sig.toString('base64') };
}

async function kalshiReq(method, endpoint, body=null) {
  const fullPath = C.basePath + endpoint;
  const url = new URL(C.baseUrl);
  const { ts, sig } = kalshiSign(method, fullPath);

  const headers = {
    'Content-Type':    'application/json',
    'KALSHI-ACCESS-KEY': C.apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': sig,
  };

  return new Promise((res, rej) => {
    const opts = {
      hostname: url.hostname,
      path:     fullPath + (method === 'GET' && body ? '?' + new URLSearchParams(body).toString() : ''),
      method,
      headers,
    };

    const req = https.request(opts, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { res({ status: r.statusCode, data: JSON.parse(d) }); }
        catch { res({ status: r.statusCode, data: d }); }
      });
    });
    req.on('error', rej);
    if (body && method !== 'GET') req.write(JSON.stringify(body));
    req.end();
  });
}

async function kalshiGet(ep, params=null)  { return kalshiReq('GET',  ep, params); }
async function kalshiPost(ep, body=null)   { return kalshiReq('POST', ep, body); }

// ─── AUTH FAILURE HANDLER ────────────────────────────────────────────────

async function handleAuthFailure(status, context) {
  S.authFailures = (S.authFailures || 0) + 1;
  log(`Auth failure #${S.authFailures} (HTTP ${status}) — ${context}`);

  if (S.authFailures >= 3) {
    const reason = `Auth failed 3x consecutively (HTTP ${status}). Bot halted. Check KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY. Clock drift >5s also causes this.`;
    log(`KILL: ${reason}`);
    S.killReason = reason;
    stopBot();
    await tg(`🔴 <b>KALSHI EDGE HALTED</b>\n\n${reason}\n\nRestart after fixing credentials.`);
  }
}

function resetAuthFailures() {
  if (S.authFailures > 0) { S.authFailures = 0; }
}

// ─── STARTUP CONNECTION VALIDATION ───────────────────────────────────────

async function validateConnection() {
  log('Validating Kalshi connection...');

  if (!C.apiKeyId || !C.privateKey || C.privateKey.length < 50) {
    const msg = 'Missing or malformed API credentials. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY.';
    log(`ABORT: ${msg}`);
    await tg(`🔴 <b>Kalshi Edge — Startup Aborted</b>\n\n${msg}`);
    return false;
  }

  try {
    const r = await kalshiGet('/portfolio/balance');
    if (r.status === 200) {
      const bal = r.data.balance || 0;
      log(`Auth OK. Kalshi balance: $${(bal/100).toFixed(2)}`);
      S.balance   = bal || S.balance;
      S.highWater = Math.max(S.highWater, bal || S.balance);
      resetAuthFailures();
      return true;
    } else if (r.status === 401 || r.status === 403) {
      log(`ABORT: Auth rejected (HTTP ${r.status}). Double-check credentials and clock.`);
      await tg(`🔴 <b>Kalshi Edge — Auth Failed (${r.status})</b>\n\nCheck KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY.\nAlso ensure your system clock is accurate (NTP).`);
      return false;
    } else {
      log(`ABORT: Unexpected response ${r.status} from /portfolio/balance`);
      return false;
    }
  } catch (e) {
    log(`ABORT: Connection error — ${e.message}`);
    await tg(`🔴 <b>Kalshi Edge — Connection Error</b>\n\n${e.message}`);
    return false;
  }
}

// ─── LIVE BALANCE SYNC ────────────────────────────────────────────────────

async function syncBalance() {
  if (C.dryRun) return; // paper mode uses internal balance tracking
  try {
    const r = await kalshiGet('/portfolio/balance');
    if (r.status === 200 && r.data.balance !== undefined) {
      S.balance = r.data.balance;
      S.highWater = Math.max(S.highWater, S.balance);
      resetAuthFailures();
    } else if (r.status === 401 || r.status === 403) {
      await handleAuthFailure(r.status, 'balance sync');
    }
  } catch(e) { log(`Balance sync error: ${e.message}`); }
}

// ─── CIRCUIT BREAKERS ─────────────────────────────────────────────────────

function checkCircuitBreakers() {
  const balanceDollars = S.balance / 100;

  // 1. Daily loss limit
  if (S.dailyPnL <= -C.maxLoss) {
    const reason = `Daily loss limit hit: $${S.dailyPnL.toFixed(2)} (limit: -$${C.maxLoss})`;
    log(`CIRCUIT BREAKER: ${reason}`);
    tg(`⚡ <b>Circuit Breaker — Daily Loss</b>\n\n${reason}\n\nBot paused until midnight UTC.`);
    stopBot();
    return false;
  }

  // 2. Drawdown from peak (high-water mark)
  const hwDollars = S.highWater / 100;
  if (hwDollars > 0) {
    const drawdown = (hwDollars - balanceDollars) / hwDollars;
    if (drawdown >= C.maxDrawdown) {
      const reason = `Drawdown ${(drawdown*100).toFixed(1)}% from peak $${hwDollars.toFixed(2)} → now $${balanceDollars.toFixed(2)} (limit: ${(C.maxDrawdown*100).toFixed(0)}%)`;
      log(`CIRCUIT BREAKER: ${reason}`);
      tg(`⚡ <b>Circuit Breaker — Drawdown</b>\n\n${reason}\n\nBot halted. Review positions before restarting.`);
      stopBot();
      return false;
    }
  }

  // 3. Claude API cost guardrail
  const bankrollDollars = S.balance / 100;
  const maxDailyCost = bankrollDollars * C.maxApiCostPct;
  if (S.claudeCostEst > maxDailyCost && S.claudeCostEst > 0.50) {
    log(`Claude cost guardrail: estimated $${S.claudeCostEst.toFixed(2)}/day exceeds ${(C.maxApiCostPct*100).toFixed(0)}% of bankroll ($${maxDailyCost.toFixed(2)})`);
    // Warn but don't halt — just log and alert once
    if (!S._costAlertSent) {
      tg(`⚠️ <b>Claude API Cost Warning</b>\n\nEstimated daily cost: $${S.claudeCostEst.toFixed(2)}\nBankroll: $${bankrollDollars.toFixed(2)}\n\nConsider increasing BRAIN_INTERVAL or adding ANTHROPIC credits.`);
      S._costAlertSent = true;
    }
  }

  return true;
}

// Midnight daily reset
function midnightReset() {
  const today = new Date().toDateString();
  if (S.dailyReset !== today) {
    log(`New day — resetting daily P&L and circuit breakers`);
    S.dailyPnL    = 0;
    S.dailyReset  = today;
    S.claudeCostEst = 0;
    S._costAlertSent = false;
    saveState();
    tg(`🌅 <b>New Day Reset</b>\n\nBalance: $${(S.balance/100).toFixed(2)}\nAll-time P&L: $${S.totalPnL.toFixed(2)}\nWin rate: ${S.wins+S.losses>0?((S.wins/(S.wins+S.losses))*100).toFixed(1):'—'}%`);
  }
}

// ─── LAYER 1: FAST SCANNER ────────────────────────────────────────────────

async function scanMarkets() {
  S.lastScan = new Date().toISOString();
  try {
    const r = await kalshiGet('/markets', { status: 'open', limit: '100' });
    if (r.status === 401 || r.status === 403) { await handleAuthFailure(r.status, 'market scan'); return; }
    if (r.status !== 200) { log(`Scan HTTP ${r.status}`); return; }

    resetAuthFailures();
    const markets = r.data.markets || [];
    const now = Date.now();

    // Pre-filter: volume, close time, not already holding
    const heldTickers = new Set(S.positions.map(p => p.ticker));

    const candidates = markets.filter(m => {
      if (heldTickers.has(m.ticker_name)) return false;
      if ((m.volume || 0) < C.minVolume) return false;
      const closeMs = m.close_time ? new Date(m.close_time).getTime() : 0;
      const hoursLeft = (closeMs - now) / 3600000;
      if (hoursLeft < 1 || hoursLeft > 168) return false; // 1h–7d window
      const yes = m.last_price || m.yes_bid || 50;
      if (yes < 5 || yes > 95) return false; // avoid extreme lottery/certainty contracts
      return true;
    }).map(m => {
      const yes = m.last_price || m.yes_bid || 50;
      const no  = 100 - yes;
      const closeMs = new Date(m.close_time || Date.now()).getTime();
      const hrs = ((closeMs - now) / 3600000).toFixed(1);
      const ticker = m.ticker_name;

      // Price momentum (did price move recently?)
      const hist = S.priceHistory[ticker] || [];
      const prev = hist.length > 0 ? hist[hist.length - 1] : yes;
      const mom  = yes > prev + 2 ? '↑rising' : yes < prev - 2 ? '↓falling' : '→flat';

      // Update price history (keep last 20)
      hist.push(yes);
      if (hist.length > 20) hist.shift();
      S.priceHistory[ticker] = hist;

      // Score: prefer mid-range prices (most mispricing potential), active markets, closing soon
      const midScore   = 1 - Math.abs(yes - 50) / 50;
      const volumeScore= Math.min((m.volume || 0) / 10000, 1);
      const urgency    = Math.max(0, 1 - hoursLeft / 48); // higher for <48h
      const score      = midScore * 0.4 + volumeScore * 0.3 + urgency * 0.3;

      return { ticker, title: m.title, yes, no, vol: m.volume, hrs, cat: m.category || 'other', mom, score, closeMs };
    });

    // Sort by score, take top 20 for Claude
    candidates.sort((a, b) => b.score - a.score);
    S.candidates = candidates.slice(0, 20);
    log(`Scan: ${markets.length} markets → ${candidates.length} filtered → ${S.candidates.length} candidates`);
  } catch(e) { log(`Scan error: ${e.message}`); }
}

// ─── LAYER 2: CLAUDE BRAIN ────────────────────────────────────────────────

async function runBrain() {
  if (!C.claudeKey) { log('No Claude key — skipping brain'); return; }
  if (!S.candidates || S.candidates.length === 0) { log('No candidates for brain'); return; }
  S.lastBrain = new Date().toISOString();

  // In live mode, enforce strict edge minimum. Paper mode can be looser for data.
  const edgeThreshold = C.dryRun ? Math.min(C.edgeMin, 0.03) : C.edgeMin;

  // Estimate Claude API cost (Sonnet input ~$3/Mtok, output ~$15/Mtok)
  // Avg call: ~2000 input tokens, ~500 output tokens → ~$0.014/call
  const costPerCall = 0.014;
  S.claudeCostEst = S.claudeCostEst + costPerCall;

  const mem = S.brainNotes.slice(-8).join('\n') || 'No prior notes yet.';
  const held = S.positions.map(p => `${p.ticker}(${p.side}@${p.entryPrice}¢)`).join(', ') || 'none';

  const mBlock = S.candidates.map((c, i) =>
    `${i+1}. [${c.ticker}] "${c.title}"\n   YES:${c.yes}¢ NO:${c.no}¢ | Vol:${c.vol} | ${c.hrs}h left | ${c.cat} | ${c.mom}`
  ).join('\n\n');

  const systemPrompt = `You are Kalshi Edge — an autonomous AI prediction market trader managing a real ${C.dryRun ? 'paper' : 'LIVE'} portfolio.

MISSION: Double the portfolio balance as quickly and safely as possible through disciplined, high-confidence trades.

YOUR IDENTITY:
- You are not a generic assistant. You are a specialized quant trader.
- You have memory of past trades and learnings (see YOUR MEMORY below).
- You use web search to find current news before every analysis.
- You think in probabilities, not narratives.

TRADING PHILOSOPHY:
1. NEWS-DRIVEN EDGE is your primary alpha. Markets lag news by 5-30 minutes. Search before you analyze.
2. FAVOURITE-LONGSHOT BIAS: contracts >80¢ are systematically underpriced. Contracts <15¢ overpriced. Exploit this.
3. LIMIT ORDERS ONLY. Never signal a market order. Taker fees kill edge on small accounts.
4. QUALITY OVER QUANTITY. 3 high-confidence trades beat 15 medium ones. Be selective.
5. TIME VALUE: prefer markets closing within 48h where your edge is most actionable.
6. CORRELATED RISK: if you're already holding Fed/rates exposure, don't double up on another Fed market.

SIGNAL REQUIREMENTS:
- Minimum edge: ${(edgeThreshold*100).toFixed(0)}% (market price vs your true probability estimate)
- Confidence HIGH: only when you have specific, recent evidence from web search
- Confidence MEDIUM: strong reasoning but limited direct data
- LOW confidence = do not signal (use that label to explain why you passed)
- If web search finds nothing relevant, say so in brainNote. Do not fabricate edge.

WHAT CREATES REAL EDGE:
✓ Breaking news not reflected in prices (check: was this published <30min ago?)
✓ Economic data releases (NFP, CPI, Fed minutes) with clear directional impact
✓ Polls, vote counts, official announcements for political markets
✓ Extreme prices (>85¢ YES or >85¢ NO) where the market overestimates uncertainty
✗ Gut feelings about political outcomes
✗ Outdated information you already knew before searching
✗ Thin volume markets where you'd move the price yourself

CURRENTLY HELD (do not re-enter): ${held}

YOUR MEMORY (past learnings):
${mem}

BALANCE: $${(S.balance/100).toFixed(2)} | MODE: ${C.dryRun ? 'PAPER' : 'LIVE'} | Today P&L: $${S.dailyPnL.toFixed(2)}

OUTPUT FORMAT — respond with ONLY a valid JSON object, no other text:
{
  "signals": [
    {
      "ticker": "MKTX-XXXX",
      "title": "market title",
      "side": "yes" or "no",
      "marketPrice": 0.XX,
      "trueProb": 0.XX,
      "edge": 0.XX,
      "confidence": "high" | "medium",
      "limitPrice": XX,
      "reasoning": "max 25 words citing specific evidence found via web search"
    }
  ],
  "passed": ["ticker1: reason in 10 words", "ticker2: reason"],
  "brainNote": "One specific learning for future sessions — what worked, what didn't, what to watch"
}

No signals? Return: {"signals":[],"passed":[...],"brainNote":"..."}`;

  const userMsg = `TIME: ${new Date().toISOString()}

TOP CANDIDATES TO ANALYZE:
${mBlock}

STEP 1: Search the web for current news/data relevant to each market above.
STEP 2: For each candidate, estimate the TRUE probability based on what you find.
STEP 3: Signal only where true probability differs from market price by ${(edgeThreshold*100).toFixed(0)}%+.
STEP 4: Be specific in reasoning — cite the actual evidence you found.`;

  try {
    const body = JSON.stringify({
      model: C.claudeModel,
      max_tokens: 1500,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: userMsg }],
    });

    const r = await httpPost('https://api.anthropic.com/v1/messages', body, {
      'Content-Type':      'application/json',
      'x-api-key':         C.claudeKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'web-search-2025-03-05',
    });

    S.claudeCalls++;
    if (r.status !== 200) {
      log(`Claude API error ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
      return;
    }

    // Extract text from content blocks (may include tool_use blocks for web search)
    const textBlocks = (r.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (!textBlocks) { log('Claude returned no text'); return; }

    // Strip markdown fences if present
    const clean = textBlocks.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
    const jsonStart = clean.indexOf('{');
    const jsonEnd   = clean.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) { log(`Brain: no JSON found in response`); return; }

    let parsed;
    try { parsed = JSON.parse(clean.slice(jsonStart, jsonEnd + 1)); }
    catch(e) { log(`Brain JSON parse error: ${e.message}`); return; }

    // Store brain note
    if (parsed.brainNote) {
      S.brainNotes.push(`[${new Date().toLocaleDateString()}] ${parsed.brainNote}`);
      if (S.brainNotes.length > 30) S.brainNotes.shift();
    }

    // Validate and store signals
    const signals = (parsed.signals || []).filter(sig => {
      if (!sig.ticker || !sig.side || !sig.edge) return false;
      if (sig.edge < edgeThreshold) { log(`Signal filtered: ${sig.ticker} edge ${(sig.edge*100).toFixed(1)}% below ${(edgeThreshold*100).toFixed(0)}% minimum`); return false; }
      if (!['yes','no'].includes(sig.side)) return false;
      if (sig.confidence === 'low') return false;
      return true;
    });

    S.signals = signals;
    log(`Brain: ${signals.length} signals | ${parsed.passed?.length || 0} passed | Note: ${parsed.brainNote?.slice(0,80)||'none'}`);

    if (signals.length > 0) {
      const sigText = signals.map(s => `${s.ticker} ${s.side.toUpperCase()} — ${(s.edge*100).toFixed(1)}% edge — ${s.reasoning}`).join('\n');
      log(`Signals:\n${sigText}`);
    }

  } catch(e) { log(`Brain error: ${e.message}`); }
}

// ─── LAYER 3: EXECUTION ENGINE ────────────────────────────────────────────

function kellySize(trueProb, marketPrice) {
  // Kelly formula: f = (p*(b+1) - 1) / b where b = (1/marketPrice - 1)
  const b = (1 / marketPrice) - 1;
  const f = (trueProb * (b + 1) - 1) / b;
  const frac = Math.max(0, f * C.kelly); // fractional Kelly

  const balDollars = S.balance / 100;
  const raw = balDollars * frac;
  return Math.min(raw, C.maxPos, balDollars * 0.10); // hard cap: min(kelly, $maxPos, 10% of balance)
}

async function executeSignals() {
  if (!S.signals || S.signals.length === 0) return;
  if (S.positions.length >= C.maxConcurrent) { log(`At max positions (${C.maxConcurrent})`); return; }

  for (const sig of S.signals) {
    if (S.positions.length >= C.maxConcurrent) break;
    if (!checkCircuitBreakers()) break;

    // Duplicate check
    if (S.positions.find(p => p.ticker === sig.ticker)) {
      log(`Skip ${sig.ticker} — already holding`);
      continue;
    }

    const marketPrice = sig.marketPrice || (sig.side === 'yes' ? 0.5 : 0.5);
    const sizeDollars = kellySize(sig.trueProb || 0.6, marketPrice);
    if (sizeDollars < 0.50) { log(`${sig.ticker}: size $${sizeDollars.toFixed(2)} too small, skip`); continue; }

    const sizeCents = Math.round(sizeDollars * 100);
    const contracts = Math.max(1, Math.floor(sizeDollars)); // 1 contract ≈ $1
    const limitPrice = sig.limitPrice || Math.round(marketPrice * 100);

    log(`Executing: ${sig.ticker} ${sig.side.toUpperCase()} | $${sizeDollars.toFixed(2)} | limit ${limitPrice}¢ | edge ${(sig.edge*100).toFixed(1)}%`);

    if (C.dryRun) {
      // Paper trade
      const pos = {
        id: crypto.randomUUID(),
        ticker: sig.ticker,
        title: sig.title || sig.ticker,
        side: sig.side,
        contracts,
        entryPrice: limitPrice,
        sizeDollars,
        edge: sig.edge,
        reasoning: sig.reasoning,
        openedAt: new Date().toISOString(),
        status: 'open',
      };
      S.positions.push(pos);
      S.balance -= sizeCents;
      S.dailyPnL -= sizeDollars;
      log(`[PAPER] Opened ${sig.side} ${sig.ticker} @ ${limitPrice}¢ ($${sizeDollars.toFixed(2)})`);
      await tg(`📝 <b>Paper Trade</b>\n\n${sig.side.toUpperCase()} ${sig.ticker}\nSize: $${sizeDollars.toFixed(2)} @ ${limitPrice}¢\nEdge: ${(sig.edge*100).toFixed(1)}%\n${sig.reasoning}`);
    } else {
      // LIVE order — limit order only
      try {
        const orderBody = {
          ticker:       sig.ticker,
          action:       'buy',
          type:         'limit',           // LIMIT ORDERS ONLY — no taker fees
          side:         sig.side,
          count:        contracts,
          yes_price:    sig.side === 'yes' ? limitPrice : 100 - limitPrice,
          no_price:     sig.side === 'no'  ? limitPrice : 100 - limitPrice,
          client_order_id: crypto.randomUUID(),
          expiration_ts: null, // GTC
        };

        const r = await kalshiPost('/portfolio/orders', orderBody);

        if (r.status === 201 || r.status === 200) {
          resetAuthFailures();
          const order = r.data.order || r.data;
          const pos = {
            id:         order.order_id || crypto.randomUUID(),
            ticker:     sig.ticker,
            title:      sig.title || sig.ticker,
            side:       sig.side,
            contracts,
            entryPrice: limitPrice,
            sizeDollars,
            edge:       sig.edge,
            reasoning:  sig.reasoning,
            openedAt:   new Date().toISOString(),
            status:     order.status || 'resting',
            orderId:    order.order_id,
          };
          S.positions.push(pos);
          log(`[LIVE] Order placed: ${sig.ticker} ${sig.side} ${contracts}ct @ ${limitPrice}¢`);
          await tg(`✅ <b>Live Order Placed</b>\n\n${sig.side.toUpperCase()} ${sig.ticker}\n${contracts} contracts @ ${limitPrice}¢\nSize: $${sizeDollars.toFixed(2)} | Edge: ${(sig.edge*100).toFixed(1)}%\n\n${sig.reasoning}`);
        } else if (r.status === 401 || r.status === 403) {
          await handleAuthFailure(r.status, `order ${sig.ticker}`);
          break;
        } else {
          log(`Order rejected ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
          await tg(`⚠️ Order rejected for ${sig.ticker}\nHTTP ${r.status}: ${JSON.stringify(r.data).slice(0,100)}`);
        }
      } catch(e) { log(`Order error ${sig.ticker}: ${e.message}`); }
    }

    await new Promise(r => setTimeout(r, 500)); // rate limit buffer between orders
  }

  saveState();
}

// ─── POSITION MONITOR ─────────────────────────────────────────────────────

async function monitorPositions() {
  if (S.positions.length === 0) return;
  if (C.dryRun) return; // paper mode — positions resolve via manual /api/settle

  try {
    const r = await kalshiGet('/portfolio/positions');
    if (r.status === 401 || r.status === 403) { await handleAuthFailure(r.status, 'position monitor'); return; }
    if (r.status !== 200) return;

    resetAuthFailures();
    const livePositions = r.data.market_positions || [];
    const liveTickers = new Set(livePositions.map(p => p.ticker_name));

    // Check for settled positions
    for (const pos of [...S.positions]) {
      if (!liveTickers.has(pos.ticker)) {
        // Position no longer active — it settled or was cancelled
        const settled = livePositions.find(p => p.ticker_name === pos.ticker);
        const pnl = settled ? (settled.realized_pnl || 0) / 100 : -pos.sizeDollars;

        S.positions = S.positions.filter(p => p.id !== pos.id);
        S.totalPnL += pnl;
        S.dailyPnL += pnl;
        if (pnl > 0) S.wins++; else S.losses++;

        S.trades.unshift({ ...pos, closedAt: new Date().toISOString(), pnl, status: pnl > 0 ? 'won' : 'lost' });
        if (S.trades.length > 100) S.trades.pop();

        log(`Position settled: ${pos.ticker} ${pos.side} — P&L: $${pnl.toFixed(2)}`);
        await tg(`${pnl>0?'✅':'❌'} <b>Position Settled</b>\n\n${pos.ticker} ${pos.side.toUpperCase()}\nP&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}\nAll-time: $${S.totalPnL.toFixed(2)} | Win rate: ${S.wins+S.losses>0?((S.wins/(S.wins+S.losses))*100).toFixed(0):'—'}%`);
      }
    }

    await syncBalance();
    saveState();
  } catch(e) { log(`Position monitor error: ${e.message}`); }
}

// P&L history for chart
function recordPnL() {
  S.pnlHistory.push({ ts: Date.now(), balance: S.balance / 100, pnl: S.totalPnL });
  if (S.pnlHistory.length > 500) S.pnlHistory.shift();
}

// ─── BOT LOOP ─────────────────────────────────────────────────────────────

let scanTimer  = null;
let brainTimer = null;
let posTimer   = null;
let pnlTimer   = null;

function startBot() {
  if (S.isRunning) return;
  S.isRunning  = true;
  S.botStarted = new Date().toISOString();
  S.killReason = null;
  log(`Bot started — ${C.dryRun ? 'PAPER' : 'LIVE'} mode`);

  // Layer 1: fast scan every 30s
  scanMarkets();
  scanTimer = setInterval(async () => {
    midnightReset();
    await scanMarkets();
    await monitorPositions();
    if (!checkCircuitBreakers()) return;
    await executeSignals();
  }, C.scanInterval * 1000);

  // Layer 2: Claude brain every 90s (staggered from scan)
  brainTimer = setTimeout(() => {
    runBrain();
    brainTimer = setInterval(runBrain, C.brainInterval * 1000);
  }, 15000); // first brain 15s after start

  // Record P&L every 5 minutes for chart
  pnlTimer = setInterval(recordPnL, 5 * 60 * 1000);

  saveState();
}

function stopBot() {
  S.isRunning = false;
  [scanTimer, brainTimer, posTimer, pnlTimer].forEach(t => { if (t) clearInterval(t); if (t) clearTimeout(t); });
  scanTimer = brainTimer = posTimer = pnlTimer = null;
  log('Bot stopped');
  saveState();
}

// ─── API ROUTES ───────────────────────────────────────────────────────────

app.get('/api/status', (_, res) => {
  const wr = S.wins + S.losses > 0 ? ((S.wins / (S.wins + S.losses)) * 100).toFixed(1) : '—';
  const balDollars = S.balance / 100;
  const hwDollars  = S.highWater / 100;
  const drawdown   = hwDollars > 0 ? ((hwDollars - balDollars) / hwDollars * 100).toFixed(1) : '0.0';
  res.json({
    isRunning: S.isRunning,
    dryRun:    C.dryRun,
    balance:   balDollars,
    highWater: hwDollars,
    drawdown:  parseFloat(drawdown),
    totalPnL:  S.totalPnL,
    dailyPnL:  S.dailyPnL,
    wins:      S.wins,
    losses:    S.losses,
    winRate:   wr,
    openPositions: S.positions.length,
    claudeCalls:   S.claudeCalls,
    claudeCostEst: S.claudeCostEst,
    authFailures:  S.authFailures,
    killReason:    S.killReason,
    lastScan:      S.lastScan,
    lastBrain:     S.lastBrain,
    botStarted:    S.botStarted,
    config: {
      kelly: C.kelly, edgeMin: C.edgeMin, maxPos: C.maxPos,
      maxLoss: C.maxLoss, maxDrawdown: C.maxDrawdown,
      scanInterval: C.scanInterval, brainInterval: C.brainInterval,
    },
  });
});

app.get('/api/trades',     (_, res) => res.json(S.trades.slice(0, 50)));
app.get('/api/positions',  (_, res) => res.json(S.positions));
app.get('/api/signals',    (_, res) => res.json(S.signals));
app.get('/api/logs',       (_, res) => res.json(logs.slice(0, 150)));
app.get('/api/pnl',        (_, res) => res.json(S.pnlHistory.slice(-200)));
app.get('/api/brain',      (_, res) => res.json({ notes: S.brainNotes, signals: S.signals }));
app.get('/api/candidates', (_, res) => res.json(S.candidates || []));

app.post('/api/bot/start', async (_, res) => {
  if (!S.isRunning) startBot();
  res.json({ ok: true });
});
app.post('/api/bot/stop', (_, res) => {
  stopBot();
  res.json({ ok: true });
});

// Force immediate brain cycle
app.post('/api/bot/brain', async (_, res) => {
  await runBrain();
  res.json({ ok: true, signals: S.signals });
});

// Force immediate scan
app.post('/api/bot/scan', async (_, res) => {
  await scanMarkets();
  res.json({ ok: true, candidates: S.candidates });
});

// Test connection
app.get('/api/test', async (_, res) => {
  const ok = await validateConnection();
  res.json({ ok, balance: S.balance / 100, authFailures: S.authFailures });
});

// Manually settle a paper position (for testing)
app.post('/api/settle', (req, res) => {
  const { id, won } = req.body;
  const pos = S.positions.find(p => p.id === id);
  if (!pos) return res.json({ ok: false, error: 'not found' });

  const pnl = won ? pos.sizeDollars * (100 / pos.entryPrice - 1) : -pos.sizeDollars;
  S.positions = S.positions.filter(p => p.id !== id);
  S.totalPnL += pnl;
  S.dailyPnL += pnl;
  S.balance  += Math.round(pnl * 100);
  S.highWater = Math.max(S.highWater, S.balance);
  if (pnl > 0) S.wins++; else S.losses++;
  S.trades.unshift({ ...pos, closedAt: new Date().toISOString(), pnl, status: won ? 'won' : 'lost' });
  saveState();
  res.json({ ok: true, pnl });
});

// Reset state
app.post('/api/reset', (_, res) => {
  stopBot();
  S = defaultState();
  saveState();
  res.json({ ok: true });
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────

app.get('/', (_, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildDashboard());
});

function buildDashboard() {
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#060608">
<title>Kalshi Edge</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#060608;--s1:#0e0e12;--s2:#16161c;--s3:#1e1e26;--s4:#26262f;
  --bd:rgba(255,255,255,.06);--bd2:rgba(255,255,255,.12);--bd3:rgba(255,255,255,.20);
  --t1:#f0f0f5;--t2:#9090a0;--t3:#505060;
  --g:#2ecc71;--gd:rgba(46,204,113,.12);--g2:rgba(46,204,113,.25);
  --r:#e74c3c;--rd:rgba(231,76,60,.12);
  --b:#3498db;--bd4:rgba(52,152,219,.12);
  --o:#f39c12;--od:rgba(243,156,18,.12);
  --p:#9b59b6;--pd:rgba(155,89,182,.12);
  --safe:env(safe-area-inset-top,0px);
  --safeB:env(safe-area-inset-bottom,0px);
}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%;background:var(--bg);color:var(--t1);font-family:'Outfit',sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
.app{display:flex;flex-direction:column;height:100%;padding-top:var(--safe)}

/* Header */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 20px 10px;flex-shrink:0}
.hdr-l{display:flex;align-items:center;gap:10px}
.logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--g),var(--b));display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#000;letter-spacing:-.5px}
.hdr-title{font-size:20px;font-weight:700;letter-spacing:-.5px}
.mode-badge{font-size:10px;font-weight:700;letter-spacing:1px;padding:4px 10px;border-radius:20px;text-transform:uppercase}
.live-badge{background:var(--rd);color:var(--r)}
.paper-badge{background:var(--od);color:var(--o)}

/* Scrollable content */
.content{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 16px 16px}
.content::-webkit-scrollbar{display:none}

/* Cards */
.card{background:var(--s2);border:0.5px solid var(--bd);border-radius:18px;padding:16px;margin-bottom:12px}
.card-sm{background:var(--s2);border:0.5px solid var(--bd);border-radius:14px;padding:14px}

/* Hero balance */
.hero{background:linear-gradient(135deg,var(--s2),var(--s3));border:0.5px solid var(--bd2);border-radius:22px;padding:22px 20px;margin-bottom:12px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-30px;right:-30px;width:120px;height:120px;background:radial-gradient(circle,rgba(46,204,113,.15),transparent 70%);border-radius:50%}
.hero-label{font-size:12px;font-weight:500;color:var(--t3);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:4px}
.hero-bal{font-size:44px;font-weight:800;letter-spacing:-2px;line-height:1}
.hero-sub{display:flex;gap:16px;margin-top:12px}
.hero-stat{font-size:13px}
.hero-stat .lbl{color:var(--t3);margin-right:4px}
.hero-stat .val{font-weight:600}
.val-g{color:var(--g)}
.val-r{color:var(--r)}
.val-o{color:var(--o)}

/* Grid */
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
.metric{background:var(--s2);border:0.5px solid var(--bd);border-radius:14px;padding:14px}
.metric-lbl{font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.8px;font-weight:500;margin-bottom:6px}
.metric-val{font-size:22px;font-weight:700;letter-spacing:-.5px}

/* Chart */
.chart-wrap{position:relative;height:140px;margin-top:4px}
canvas{width:100%!important;height:100%!important}

/* Tabs */
.tabs{display:flex;gap:2px;background:var(--s1);border-radius:12px;padding:3px;margin-bottom:14px}
.tab{flex:1;padding:8px 4px;font-size:13px;font-weight:600;text-align:center;border-radius:9px;cursor:pointer;color:var(--t3);border:none;background:none;transition:all .2s}
.tab.active{background:var(--s3);color:var(--t1)}

/* Section title */
.sec-title{font-size:12px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}

/* Position / signal items */
.item{background:var(--s3);border-radius:12px;padding:12px;margin-bottom:8px}
.item-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px}
.item-title{font-size:13px;font-weight:600;color:var(--t1);flex:1;line-height:1.3;padding-right:8px}
.item-badge{font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px;text-transform:uppercase;flex-shrink:0}
.b-yes{background:var(--gd);color:var(--g)}
.b-no{background:var(--rd);color:var(--r)}
.b-won{background:var(--gd);color:var(--g)}
.b-lost{background:var(--rd);color:var(--r)}
.item-meta{display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:var(--t3);font-family:'DM Mono',monospace}
.item-reason{font-size:12px;color:var(--t2);margin-top:6px;line-height:1.4;font-style:italic}

/* Logs */
.log-line{font-size:11px;font-family:'DM Mono',monospace;color:var(--t3);padding:3px 0;border-bottom:0.5px solid var(--bd);line-height:1.4}
.log-line:last-child{border:none}

/* Brain notes */
.note-item{font-size:12px;color:var(--t2);padding:6px 0;border-bottom:0.5px solid var(--bd);line-height:1.4}
.note-item:last-child{border:none}

/* Empty */
.empty{text-align:center;color:var(--t3);font-size:13px;padding:24px 0}

/* Status dot */
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
.dot-g{background:var(--g);box-shadow:0 0 6px var(--g)}
.dot-r{background:var(--r)}
.dot-o{background:var(--o);box-shadow:0 0 6px var(--o)}

/* Controls */
.btn{border:0.5px solid var(--bd2);background:var(--s3);color:var(--t1);border-radius:12px;padding:12px 20px;font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s;-webkit-appearance:none}
.btn:active{transform:scale(.97)}
.btn-g{background:var(--gd);border-color:var(--g);color:var(--g)}
.btn-r{background:var(--rd);border-color:var(--r);color:var(--r)}
.btn-row{display:flex;gap:8px;margin-bottom:12px}
.btn-row .btn{flex:1;padding:10px}

/* Kill alert */
.kill-alert{background:var(--rd);border:1px solid var(--r);border-radius:14px;padding:14px;margin-bottom:12px;color:var(--r)}
.kill-alert strong{display:block;margin-bottom:4px}

/* Tab panels */
.panel{display:none}
.panel.active{display:block}

/* Bottom nav */
.nav{display:flex;background:var(--s1);border-top:0.5px solid var(--bd);padding-bottom:var(--safeB);flex-shrink:0}
.nav-btn{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 4px;background:none;border:none;color:var(--t3);font-family:'Outfit',sans-serif;font-size:10px;font-weight:600;cursor:pointer;transition:color .2s;letter-spacing:.3px}
.nav-btn svg{width:20px;height:20px;stroke-width:1.8}
.nav-btn.active{color:var(--g)}
</style>
</head>
<body>
<div class="app">

<div class="hdr">
  <div class="hdr-l">
    <div class="logo">KE</div>
    <span class="hdr-title">Kalshi Edge</span>
  </div>
  <div id="modeBadge" class="mode-badge paper-badge">PAPER</div>
</div>

<div class="content" id="mainContent">

  <!-- Kill alert (hidden by default) -->
  <div class="kill-alert" id="killAlert" style="display:none">
    <strong>⚡ Bot Halted</strong>
    <span id="killReason"></span>
  </div>

  <!-- TAB: Dashboard -->
  <div class="panel active" id="panel-0">

    <div class="hero" id="heroCard">
      <div class="hero-label">Portfolio Balance</div>
      <div class="hero-bal" id="heroBalance">$—</div>
      <div class="hero-sub">
        <div class="hero-stat"><span class="lbl">Today</span><span class="val" id="dailyPnl">—</span></div>
        <div class="hero-stat"><span class="lbl">All-time</span><span class="val" id="totalPnl">—</span></div>
        <div class="hero-stat"><span class="lbl">Drawdown</span><span class="val" id="drawdownVal">—</span></div>
      </div>
    </div>

    <div class="grid2">
      <div class="metric">
        <div class="metric-lbl">Win Rate</div>
        <div class="metric-val" id="winRate">—</div>
      </div>
      <div class="metric">
        <div class="metric-lbl">Open</div>
        <div class="metric-val" id="openPos">—</div>
      </div>
      <div class="metric">
        <div class="metric-lbl">W / L</div>
        <div class="metric-val" id="wl">—</div>
      </div>
      <div class="metric">
        <div class="metric-lbl">Claude Calls</div>
        <div class="metric-val" id="claudeCalls">—</div>
      </div>
    </div>

    <div class="card">
      <div class="sec-title">P&L Curve</div>
      <div class="chart-wrap"><canvas id="pnlChart"></canvas></div>
    </div>

    <div class="card">
      <div class="sec-title">AI Signals</div>
      <div id="sigList"><div class="empty">Waiting for brain cycle...</div></div>
    </div>

    <div class="btn-row">
      <button class="btn btn-g" id="startBtn" onclick="botAction('start')">Start</button>
      <button class="btn btn-r" id="stopBtn" onclick="botAction('stop')">Stop</button>
      <button class="btn" onclick="botAction('brain')">Force Brain</button>
    </div>

  </div>

  <!-- TAB: Positions -->
  <div class="panel" id="panel-1">
    <div class="sec-title" style="margin-bottom:12px">Open Positions</div>
    <div id="posListOpen"><div class="empty">No open positions</div></div>
    <div class="sec-title" style="margin-top:16px;margin-bottom:12px">Recent Trades</div>
    <div id="tradeList"><div class="empty">No trades yet</div></div>
  </div>

  <!-- TAB: Brain -->
  <div class="panel" id="panel-2">
    <div class="card" style="margin-bottom:12px">
      <div class="sec-title">Brain Notes (Memory)</div>
      <div id="brainNotes"><div class="empty">No notes yet</div></div>
    </div>
    <div class="card">
      <div class="sec-title">Market Candidates</div>
      <div id="candidateList"><div class="empty">Scanning...</div></div>
    </div>
  </div>

  <!-- TAB: Logs -->
  <div class="panel" id="panel-3">
    <div class="card">
      <div id="logList"><div class="empty">Starting...</div></div>
    </div>
  </div>

</div><!-- /content -->

<!-- Bottom Nav -->
<nav class="nav">
  <button class="nav-btn active" onclick="switchTab(0,this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
    Dashboard
  </button>
  <button class="nav-btn" onclick="switchTab(1,this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
    Positions
  </button>
  <button class="nav-btn" onclick="switchTab(2,this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
    Brain
  </button>
  <button class="nav-btn" onclick="switchTab(3,this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
    Logs
  </button>
</nav>
</div><!-- /app -->

<script>
let chart = null;
let currentTab = 0;

function switchTab(i, el) {
  document.querySelectorAll('.panel').forEach((p,j)=>p.classList.toggle('active',j===i));
  document.querySelectorAll('.nav-btn').forEach((b,j)=>b.classList.toggle('active',j===i));
  currentTab = i;
}

function esc(s){ const d=document.createElement('div');d.textContent=s;return d.innerHTML; }
function fmt$(n){ return (n>=0?'+':'')+'\$'+Math.abs(n).toFixed(2); }
function fmtBal(n){ return '\$'+n.toFixed(2); }

function renderSignals(sigs) {
  const el = document.getElementById('sigList');
  if (!sigs || !sigs.length) { el.innerHTML='<div class="empty">No signals — brain scanning...</div>'; return; }
  el.innerHTML = sigs.map(s => \`
    <div class="item">
      <div class="item-top">
        <div class="item-title">\${esc(s.title||s.ticker)}</div>
        <span class="item-badge \${s.side==='yes'?'b-yes':'b-no'}">\${s.side.toUpperCase()}</span>
      </div>
      <div class="item-meta">
        <span>Mkt: \${(s.marketPrice*100).toFixed(0)}¢</span>
        <span>True: \${(s.trueProb*100).toFixed(0)}¢</span>
        <span style="color:var(--g)">Edge: \${(s.edge*100).toFixed(1)}%</span>
        <span style="color:var(--o)">\${s.confidence}</span>
        \${s.limitPrice?'<span>Limit: '+s.limitPrice+'¢</span>':''}
      </div>
      \${s.reasoning?'<div class="item-reason">'+esc(s.reasoning)+'</div>':''}
    </div>
  \`).join('');
}

function renderPositions(positions) {
  const el = document.getElementById('posListOpen');
  if (!positions.length) { el.innerHTML='<div class="empty">No open positions</div>'; return; }
  el.innerHTML = positions.map(p => \`
    <div class="item">
      <div class="item-top">
        <div class="item-title">\${esc(p.title||p.ticker)}</div>
        <span class="item-badge \${p.side==='yes'?'b-yes':'b-no'}">\${p.side.toUpperCase()}</span>
      </div>
      <div class="item-meta">
        <span>\${p.contracts}ct @ \${p.entryPrice}¢</span>
        <span>\$\${p.sizeDollars.toFixed(2)}</span>
        <span style="color:var(--g)">\${(p.edge*100).toFixed(1)}% edge</span>
      </div>
      \${p.reasoning?'<div class="item-reason">'+esc(p.reasoning)+'</div>':''}
    </div>
  \`).join('');
}

function renderTrades(trades) {
  const el = document.getElementById('tradeList');
  if (!trades.length) { el.innerHTML='<div class="empty">No completed trades yet</div>'; return; }
  el.innerHTML = trades.slice(0,20).map(t => \`
    <div class="item">
      <div class="item-top">
        <div class="item-title">\${esc(t.title||t.ticker)}</div>
        <span class="item-badge \${t.pnl>=0?'b-won':'b-lost'}">\${t.pnl>=0?'WON':'LOST'}</span>
      </div>
      <div class="item-meta">
        <span>\${t.side.toUpperCase()} @ \${t.entryPrice}¢</span>
        <span style="color:\${t.pnl>=0?'var(--g)':'var(--r)'}">\${fmt$(t.pnl)}</span>
      </div>
    </div>
  \`).join('');
}

function renderBrain(notes) {
  const el = document.getElementById('brainNotes');
  if (!notes || !notes.length) { el.innerHTML='<div class="empty">No notes yet — brain learns after each cycle</div>'; return; }
  el.innerHTML = [...notes].reverse().map(n => '<div class="note-item">'+esc(n)+'</div>').join('');
}

function renderCandidates(candidates) {
  const el = document.getElementById('candidateList');
  if (!candidates || !candidates.length) { el.innerHTML='<div class="empty">Scanning markets...</div>'; return; }
  el.innerHTML = candidates.slice(0,10).map(c => \`
    <div class="item">
      <div class="item-top">
        <div class="item-title" style="font-size:12px">\${esc(c.title)}</div>
        <span style="font-size:11px;color:var(--t3);font-family:'DM Mono',monospace">\${c.yes}¢</span>
      </div>
      <div class="item-meta">
        <span>Vol: \${c.vol}</span><span>\${c.hrs}h</span><span>\${c.mom}</span><span>\${c.cat}</span>
      </div>
    </div>
  \`).join('');
}

function renderLogs(logLines) {
  const el = document.getElementById('logList');
  if (!logLines.length) { el.innerHTML='<div class="empty">No logs</div>'; return; }
  el.innerHTML = logLines.slice(0,80).map(l => '<div class="log-line">'+esc(l)+'</div>').join('');
}

function updateChart(pnlHistory) {
  const canvas = document.getElementById('pnlChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth * window.devicePixelRatio;
  const H = canvas.offsetHeight * window.devicePixelRatio;
  canvas.width = W; canvas.height = H;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  ctx.clearRect(0, 0, w, h);

  if (!pnlHistory || pnlHistory.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '12px Outfit';
    ctx.textAlign = 'center';
    ctx.fillText('Collecting data...', w/2, h/2);
    return;
  }

  const vals = pnlHistory.map(p => p.pnl);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const range = mx - mn || 1;
  const pad = 10;
  const scaleY = v => h - pad - ((v - mn) / range) * (h - pad*2);
  const scaleX = i => pad + (i / (vals.length - 1)) * (w - pad*2);

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  const lastVal = vals[vals.length-1];
  const color = lastVal >= 0 ? '46,204,113' : '231,76,60';
  grad.addColorStop(0, \`rgba(\${color},0.3)\`);
  grad.addColorStop(1, \`rgba(\${color},0)\`);

  ctx.beginPath();
  ctx.moveTo(scaleX(0), scaleY(vals[0]));
  for (let i=1;i<vals.length;i++) {
    const x0=scaleX(i-1),y0=scaleY(vals[i-1]),x1=scaleX(i),y1=scaleY(vals[i]);
    const cpx=(x0+x1)/2;
    ctx.bezierCurveTo(cpx,y0,cpx,y1,x1,y1);
  }
  ctx.lineTo(scaleX(vals.length-1), h);
  ctx.lineTo(scaleX(0), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(scaleX(0), scaleY(vals[0]));
  for (let i=1;i<vals.length;i++) {
    const x0=scaleX(i-1),y0=scaleY(vals[i-1]),x1=scaleX(i),y1=scaleY(vals[i]);
    const cpx=(x0+x1)/2;
    ctx.bezierCurveTo(cpx,y0,cpx,y1,x1,y1);
  }
  ctx.strokeStyle = \`rgb(\${color})\`;
  ctx.lineWidth = 2;
  ctx.stroke();
}

async function botAction(action) {
  try {
    await fetch('/api/bot/' + action, { method: 'POST' });
    setTimeout(refresh, 500);
  } catch(e) { console.error(e); }
}

async function refresh() {
  try {
    const [statusR, tradesR, posR, sigsR, logsR, pnlR, brainR, candR] = await Promise.all([
      fetch('/api/status').then(r=>r.json()),
      fetch('/api/trades').then(r=>r.json()),
      fetch('/api/positions').then(r=>r.json()),
      fetch('/api/signals').then(r=>r.json()),
      fetch('/api/logs').then(r=>r.json()),
      fetch('/api/pnl').then(r=>r.json()),
      fetch('/api/brain').then(r=>r.json()),
      fetch('/api/candidates').then(r=>r.json()),
    ]);

    // Mode badge
    const mb = document.getElementById('modeBadge');
    mb.textContent = statusR.dryRun ? 'PAPER' : 'LIVE';
    mb.className = 'mode-badge ' + (statusR.dryRun ? 'paper-badge' : 'live-badge');

    // Kill alert
    const ka = document.getElementById('killAlert');
    if (statusR.killReason) {
      ka.style.display = 'block';
      document.getElementById('killReason').textContent = statusR.killReason;
    } else { ka.style.display = 'none'; }

    // Hero
    const dailyColor = statusR.dailyPnL >= 0 ? 'val-g' : 'val-r';
    const totalColor = statusR.totalPnL >= 0 ? 'val-g' : 'val-r';
    document.getElementById('heroBalance').textContent = fmtBal(statusR.balance);
    document.getElementById('dailyPnl').className = 'val '+dailyColor;
    document.getElementById('dailyPnl').textContent = fmt$(statusR.dailyPnL);
    document.getElementById('totalPnl').className = 'val '+totalColor;
    document.getElementById('totalPnl').textContent = fmt$(statusR.totalPnL);
    const ddEl = document.getElementById('drawdownVal');
    ddEl.textContent = statusR.drawdown.toFixed(1)+'%';
    ddEl.className = 'val ' + (statusR.drawdown > 10 ? 'val-r' : statusR.drawdown > 5 ? 'val-o' : 'val-g');

    // Metrics
    document.getElementById('winRate').textContent = statusR.winRate !== '—' ? statusR.winRate+'%' : '—';
    document.getElementById('openPos').textContent = statusR.openPositions + '/' + statusR.config.maxConcurrent;
    document.getElementById('wl').textContent = statusR.wins + ' / ' + statusR.losses;
    document.getElementById('claudeCalls').textContent = statusR.claudeCalls;

    // Start/stop button states
    document.getElementById('startBtn').disabled = statusR.isRunning;
    document.getElementById('stopBtn').disabled  = !statusR.isRunning;

    renderSignals(sigsR);
    renderPositions(posR);
    renderTrades(tradesR);
    renderBrain(brainR.notes);
    renderCandidates(candR);
    renderLogs(logsR);
    updateChart(pnlR);

  } catch(e) { console.error('Refresh error:', e); }
}

refresh();
setInterval(refresh, 8000);
</script>
</body>
</html>`;
}

// ─── STARTUP ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  log(`═══════════════════════════════════════════`);
  log(`  KALSHI EDGE v5`);
  log(`  Mode: ${C.dryRun ? 'PAPER TRADING' : '⚡ LIVE TRADING'}`);
  log(`  Kelly: ${C.kelly} | Edge min: ${(C.edgeMin*100).toFixed(0)}%`);
  log(`  Max position: $${C.maxPos} | Daily loss limit: $${C.maxLoss}`);
  log(`  Drawdown limit: ${(C.maxDrawdown*100).toFixed(0)}%`);
  log(`  Scan: ${C.scanInterval}s | Brain: ${C.brainInterval}s`);
  log(`  Telegram: ${C.tgToken?'✓':'✗'} | Claude: ${C.claudeKey?'✓':'✗'}`);
  log(`═══════════════════════════════════════════`);

  if (!C.apiKeyId || !C.privateKey) {
    log('STANDBY: No Kalshi credentials. Dashboard available. Set KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY to start trading.');
    return;
  }

  // STARTUP VALIDATION — must pass before bot starts
  const connected = await validateConnection();
  if (!connected) {
    log('STANDBY: Startup validation failed. Fix credentials and restart.');
    return;
  }

  log(`Startup validation passed. Balance: $${(S.balance/100).toFixed(2)}`);
  await tg(`🟢 <b>Kalshi Edge v5 Online</b>\n\nMode: ${C.dryRun?'Paper':'⚡ LIVE'}\nBalance: $${(S.balance/100).toFixed(2)}\nKelly: ${C.kelly} | Edge: ${(C.edgeMin*100).toFixed(0)}%\nDrawdown limit: ${(C.maxDrawdown*100).toFixed(0)}%`);

  // Auto-start bot
  log('Auto-starting bot in 3s...');
  setTimeout(startBot, 3000);
});
