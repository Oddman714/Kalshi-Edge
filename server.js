'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// =============================================================================
// KalshiBot v19.0 — MID-TRADE EXIT ENGINE + ALL V18 FIXES
// =============================================================================
// STRATEGY TRUTH: KXSOL15M, KXXRP15M, KXBTC15M are "Up or Down in 15 min".
// These ARE directional markets — but they are NOT coin flips if you have edge.
// Edge source: MOMENTUM. Crypto exhibits short-term momentum (price that moved
// up in the last 15min tends to continue up for the next 15min — well documented
// in crypto microstructure research). Additional edges: RSI extremes, volume spikes,
// funding rates, news sentiment. Bot uses all of these via brain + price cache.
//
// WINNING APPROACH FOR 15-MIN MARKETS:
// 1. Fetch live price + price from 15min ago → compute momentum direction
// 2. Check RSI (overbought/oversold), volume relative to average
// 3. Bet WITH momentum when strong (>0.8% move in last 15min = trending)
// 4. Bet AGAINST momentum when RSI extreme (>75 = overbought → bet DOWN)
// 5. Only bet when signal strength is high — skip ambiguous markets
// 6. Target: SOL, XRP, ETH 15min (highest volume, most liquid, fastest settle)
// 7. Brain handles hourly fixed-strike BTC/ETH when 15min signals are weak
//
// FIXED-STRIKE MARKETS (hourly KXBTCH/KXETHH): Use gap strategy as before.
// These are separate — "Will BTC be above $X at 5pm?" when BTC is far away.
//
// v16 CHANGES vs v15:
// - NEW: 15-min momentum engine using price history cache (15s refresh)
// - NEW: RSI-based contrarian signals on 15-min overbought/oversold
// - RESTORED: All 15-min series (SOL, XRP, ETH) targeted for flywheel
// - FIXED: Gap check only applies to fixed-strike markets, not Up/Down
// - BRAIN: Now instructs to analyze momentum + RSI for 15-min signals
// =============================================================================

// --- CONFIG ----------------------------------------------------------------
const CFG = {
  keyId:      process.env.KALSHI_API_KEY_ID || '',
  privKey:    (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  claudeKey:  process.env.CLAUDE_API_KEY || '',
  tgToken:    process.env.TELEGRAM_TOKEN || '',
  tgChat:     process.env.TELEGRAM_CHAT_ID || '',
  dryRun:     process.env.DRY_RUN !== 'false',
  bankroll:   parseFloat(process.env.BANKROLL || '50'),
  port:       parseInt(process.env.PORT || '3000'),
  base:       'https://api.elections.kalshi.com/trade-api/v2',
  maxPos:     5,           // base -- scales dynamically with balance (see dynamicMaxPos)
  kellyFrac:  0.55,        // AGGRESSIVE kelly -- max compounding speed
  minEdge:    0.04,        // 4% minimum edge -- catch more mispricings
  minProb:    0.55,        // minimum 55% confidence -- more trade opportunities
  scanInterval:  15000,   // v14: 15s scan — faster slot-fill detection
  scanIntervalHungry: 10000, // v14: 10s when slots open — maximum flywheel velocity
  brainInterval: 60000,   // v14: always 60s when hungry — set by dynamicBrainInterval()
  heartbeatInterval: 300000,  // telegram heartbeat: every 5min
  // Aggressive growth targets
  targetMultiple: 2.0,    // goal: 2x portfolio ASAP
  preferShortDuration: true, // favor markets closing within 24h for faster compounding
};

// --- GROWTH PHASE ENGINE ---------------------------------------------------
// Research insight (Burgi et al. 2026): High-price contracts (55c+) win more
// than their price implies -- small positive expected return. LOW-price contracts
// (<40c) display favorite-longshot bias -- lose more than priced. Bot targets 50-85c.
// Kalshi fee: ~3-7% on wins. Kelly adjusted to account for fee drag.
// Fee-adjusted EV: gross_ev = p*(1-price) - (1-p)*price; net_ev = gross_ev - p*fee
const KALSHI_FEE = 0.045; // 4.5% avg fee on winning trades -- subtract from EV
// PHASE ENGINE — safe scaling to $500K
// KEY INSIGHT: the blowup happened because Kelly at 35% * 4 slots = 140% exposure.
// New design: hard maxPct cap per bet + hard maxExposurePct across ALL positions.
// Max single bet never exceeds 10% of portfolio. Max total exposure: 30%.
// This guarantees survival through losing streaks while still compounding fast.
// At 60% WR + 4x payout: EV = +140% per cycle — we don't need huge sizes.
// v12 PHASES: FastPath 90%+ gets full kelly. Brain gets 40% of maxBetDollars.
// Caps scale aggressively — the $795 run showed FastPath needs room to size up.
// Protection: hard dollar caps + exposure budget prevent full blowup.
const PHASES = [
  { name: 'SEED',     min: 0,      max: 50,     kelly: 0.35, minEdge: 0.05, minProb: 0.72, maxPos: 4, maxPct: 0.25, maxExposure: 0.65, maxBetDollars: 12,    label: '🌱 Seed',     desc: '4 slots. FastPath $12 max. Brain $5 max.' },
  { name: 'SPROUT',   min: 50,     max: 200,    kelly: 0.35, minEdge: 0.05, minProb: 0.70, maxPos: 4, maxPct: 0.22, maxExposure: 0.60, maxBetDollars: 35,    label: '🌿 Sprout',   desc: '4 slots. FastPath $35 max. Brain $14 max.' },
  { name: 'GROWTH',   min: 200,    max: 1000,   kelly: 0.32, minEdge: 0.05, minProb: 0.68, maxPos: 4, maxPct: 0.18, maxExposure: 0.55, maxBetDollars: 100,   label: '📈 Growth',   desc: '4 slots. FastPath $100 max. Brain $40 max.' },
  { name: 'MOMENTUM', min: 1000,   max: 5000,   kelly: 0.28, minEdge: 0.05, minProb: 0.66, maxPos: 4, maxPct: 0.14, maxExposure: 0.45, maxBetDollars: 350,   label: '🚀 Momentum', desc: '4 slots. FastPath $350 max. Brain $140 max.' },
  { name: 'SCALE',    min: 5000,   max: 25000,  kelly: 0.24, minEdge: 0.05, minProb: 0.65, maxPos: 5, maxPct: 0.10, maxExposure: 0.35, maxBetDollars: 1200,  label: '⚡ Scale',    desc: '5 slots. FastPath $1200 max. Brain $480 max.' },
  { name: 'HARVEST',  min: 25000,  max: 100000, kelly: 0.18, minEdge: 0.05, minProb: 0.65, maxPos: 6, maxPct: 0.07, maxExposure: 0.28, maxBetDollars: 4000,  label: '💰 Harvest',  desc: '6 slots. FastPath $4000 max.' },
  { name: 'ENDGAME',  min: 100000, max: 500000, kelly: 0.14, minEdge: 0.05, minProb: 0.65, maxPos: 8, maxPct: 0.05, maxExposure: 0.22, maxBetDollars: 10000, label: '🏆 Endgame',  desc: '8 slots. FastPath $10K max.' },
];

function getPhase() {
  const bal = S.realBalance > 0 ? S.realBalance : S.balance;
  return PHASES.find(p => bal >= p.min && bal < p.max) || PHASES[PHASES.length - 1];
}

// Doublings completed = log2(current / starting bankroll), floored
function doublingsMade() {
  const start = Math.max(CFG.bankroll, 1);
  const bal = S.realBalance > 0 ? S.realBalance : S.balance;
  return Math.max(0, Math.floor(Math.log2(bal / start)));
}

// How many doublings needed to reach $500K from current balance
function doublingsNeeded() {
  const bal = S.realBalance > 0 ? S.realBalance : S.balance;
  if (bal >= 500000) return 0;
  return Math.ceil(Math.log2(500000 / bal));
}

// Next doubling target from current balance
function nextTarget() {
  const bal = S.realBalance > 0 ? S.realBalance : S.balance;
  const n = doublingsMade();
  return CFG.bankroll * Math.pow(2, n + 1);
}

// Progress % toward next doubling (0-100)
function doublingProgress() {
  const bal = S.realBalance > 0 ? S.realBalance : S.balance;
  const n = doublingsMade();
  const low = CFG.bankroll * Math.pow(2, n);
  const high = CFG.bankroll * Math.pow(2, n + 1);
  return Math.min(100, Math.max(0, ((bal - low) / (high - low)) * 100));
}

// Check if a new doubling milestone was just crossed -- call after every balance update
function checkMilestone(prevBal, newBal) {
  const prevD = Math.floor(Math.log2(Math.max(prevBal, CFG.bankroll) / CFG.bankroll));
  const newD  = Math.floor(Math.log2(Math.max(newBal,  CFG.bankroll) / CFG.bankroll));
  if (newD > prevD && newBal > CFG.bankroll) {
    const phase = getPhase();
    tg(`🎯 <b>DOUBLING #${newD} COMPLETE!</b>\n💰 Balance: $${newBal.toFixed(2)}\n📍 Phase: ${phase.label}\n🏁 ${doublingsNeeded()} more doublings to $500K\n📊 Next target: $${nextTarget().toFixed(2)}\n\n${phase.desc}`);
    log(`🎯 MILESTONE: Doubling #${newD} -- $${newBal.toFixed(2)} | ${doublingsNeeded()} to $500K`);
  }
}

// Scales max positions with balance -- driven by phase engine above.
function dynamicMaxPos() {
  return getPhase().maxPos;
}

// Smart brain interval — slots open = always fire fast (60s). Full = monitor only (5min).
// v14: Brain is NEVER throttled when we have empty trading slots. Every idle slot is lost
// compounding time. When full, fire slower to save API cost and just monitor positions.
function dynamicBrainInterval() {
  const slotsOpen = dynamicMaxPos() - S.openPositions.length;
  if (slotsOpen > 0) return 60000;   // 60s — hungry bot fires fast, ALWAYS
  return 300000;                      // 5min — full slots, just monitor
}

// --- SSE LIVE PUSH ---------------------------------------------------------
const sseClients = new Set();
function ssePush(event, data) {
  if (!sseClients.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of sseClients) { try { r.write(msg); } catch(e) { sseClients.delete(r); } }
}

// --- STATE -----------------------------------------------------------------
const STATE_FILE = path.join(__dirname, 'state.json');
let S = {
  isRunning: false,
  balance: CFG.bankroll,
  realBalance: 0,
  peakBalance: CFG.bankroll,
  trades: [],
  openPositions: [],
  signals: [],
  logs: [],
  brainMemory: [],
  scanCount: 0,
  brainCount: 0,
  totalBrainCount: 0,   // persists across redeploys (brainCount resets each deploy)
  totalScanCount: 0,    // persists across redeploys
  wins: 0,
  losses: 0,
  totalPnl: 0,
  todayPnl: 0,
  todayDate: new Date().toDateString(),
  lastBrainAt: 0,
  lastScanAt: 0,
  lastErr: '',
  startedAt: Date.now(),
  topMarkets: [],
  topTraders: [],
  newsCache: [],
  doublingsMade: 0,
  lastMilestoneAt: 0,
  lastMarketOpenReset: '',
  restingOrders: [],       // unfilled limit orders currently holding cash on Kalshi
  availableCash: 0,        // real spendable cash = balance - reserved by resting orders
  estimatedApiSpend: 0,    // cumulative Claude API spend — persists across redeploys
  totalApiSpend: 0,        // same as estimatedApiSpend but explicit alias for display
  portfolioHistory: [],    // [{t: timestamp, v: balance}] — persists for chart across reloads
  consecutiveLosses: 0,   // circuit breaker counter
  circuitBreakerUntil: 0, // timestamp — trading paused until this time
  sessionPeakBalance: 0,  // highest balance seen this session — drawdown guard
  drawdownHaltUntil: 0,   // timestamp — drawdown protection pause
  sourceWins: { fastpath: 0, sports_fastpath: 0, brain: 0 },   // per-source win tracking
  sourceLosses: { fastpath: 0, sports_fastpath: 0, brain: 0 }, // per-source loss tracking
};

function saveState() {
  try {
    const slim = { ...S };
    if (slim.logs.length > 200) slim.logs = slim.logs.slice(-200);
    if (slim.trades.length > 500) slim.trades = slim.trades.slice(-500);
    if (slim.signals.length > 50) slim.signals = slim.signals.slice(-50);
    if (slim.brainMemory.length > 30) slim.brainMemory = slim.brainMemory.slice(-30);
    if (slim.newsCache.length > 20) slim.newsCache = slim.newsCache.slice(-20);
    if (slim.portfolioHistory && slim.portfolioHistory.length > 2000) slim.portfolioHistory = slim.portfolioHistory.slice(-2000);
    fs.writeFileSync(STATE_FILE, JSON.stringify(slim));
    // Push instant update to all SSE dashboard clients
    ssePush('update', { ts: Date.now(), running: !!S.isRunning, bal: S.realBalance || S.balance });
  } catch(e) { log('Save err: ' + e.message); }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      S = { ...S, ...d };
    }
  } catch(e) { log('Load err: ' + e.message); }
  S.isRunning = false;
  S.availableCash = 0;
  S.restingOrders = [];
  // Clear drawdown halt on every boot — no stale blocks carry over
  S.drawdownHaltUntil = 0;
  // Init session peak from current balance (tracking only, no trading blocks)
  S.sessionPeakBalance = S.realBalance || S.balance || 0;
  // On restart: clear circuit breaker if it was set with old 90min value.
  // New cooldown is 20min. Any breaker > 25min old from now is from old logic — clear it.
  if (S.circuitBreakerUntil && (S.circuitBreakerUntil - Date.now()) > 25 * 60000) {
    log('Boot: clearing stale circuit breaker (was set with 90min rule — cleared on restart)');
    S.circuitBreakerUntil = 0;
    S.consecutiveLosses = 0;
  }
  // Preserve cumulative counters across restarts (don't reset these)
  // brainCount, scanCount, estimatedApiSpend, wins, losses are kept from state.json
  // Always zero balances on boot -- Kalshi API is source of truth, never state.json
  // S.balance kept from state.json until syncBalance() runs
  // S.realBalance kept from state.json until syncBalance() runs
  // S.peakBalance kept from state.json until syncBalance() runs
  // On boot: purge ALL fromKalshi trades so they get re-imported fresh
  if (S.trades && S.trades.length > 0) {
    S.trades = S.trades.filter(t => !t.fromKalshi); // keep only bot-placed trades
    // Rebuild W/L from remaining bot trades
    const resolved = S.trades.filter(t => t.status === 'resolved');
    // Only count REAL trades (cost > 0) for win/loss stats
    // $0 cost backfilled historical settlements are excluded
    const realTrades = resolved.filter(t => (t.cost || 0) > 0.01);
    S.wins = realTrades.filter(t => t.won === true).length;
    S.losses = realTrades.filter(t => t.won === false).length;
    S.totalPnl = realTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  }
  // Reset peak if it looks like the env var default (never let $50 bankroll pollute peak)
  if (S.peakBalance >= 50 && S.balance < 30) {
    S.peakBalance = S.balance; // will be updated to real balance on first syncBalance
    log('Peak reset -- was stale BANKROLL default');
  }
  if (new Date().toDateString() !== S.todayDate) {
    S.todayPnl = 0;
    S.todayDate = new Date().toDateString();
  }
  // v17: Purge slot-blocking weather positions from state on every boot.
  // KXHIGH/KXLOW settle in days — they permanently block flywheel slots.
  // Kalshi syncPositions() will re-add any genuinely still open on exchange.
  if (S.openPositions && S.openPositions.length > 0) {
    const before = S.openPositions.length;
    S.openPositions = S.openPositions.filter(p => {
      if (/kxhigh|kxlow/i.test(p.ticker)) {
        log(`Boot purge WEATHER slot-blocker: ${p.ticker}`);
        return false;
      }
      return true;
    });
    if (S.openPositions.length < before) {
      log(`Boot: freed ${before - S.openPositions.length} weather slots — flywheel can now fill them`);
    }
  }
}

// --- LOGGING ---------------------------------------------------------------
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString().slice(11,19);
  const entry = `[${ts}] ${level}: ${msg}`;
  console.log(entry);
  S.logs.unshift({ ts, level, msg });
  if (S.logs.length > 300) S.logs.pop();
}

// --- HTTP HELPERS ----------------------------------------------------------
function req(url, opts = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const mod = u.protocol === 'https:' ? https : http;
    const request = mod.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => { request.destroy(); reject(new Error('timeout')); });
    if (opts.body) request.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    request.end();
  });
}

// --- KALSHI AUTH -----------------------------------------------------------
function signRequest(method, path) {
  const ts = Date.now().toString();
  // Sign: timestamp + method + path (no nonce per Kalshi docs)
  const msg = ts + method + path;
  const sig = crypto.sign('sha256', Buffer.from(msg), {
    key: CFG.privKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return {
    'KALSHI-ACCESS-KEY': CFG.keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': sig.toString('base64'),
    'Content-Type': 'application/json',
  };
}

async function kalshi(method, endpoint, body = null, params = {}) {
  const qstr = Object.keys(params).length
    ? '?' + Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';
  // Kalshi requires signing path WITHOUT query params
  const signPath = '/trade-api/v2' + endpoint;
  const headers = signRequest(method, signPath);
  const url = CFG.base + endpoint + qstr;
  const opts = { method, headers };
  if (body) opts.body = body;
  const r = await req(url, opts, 20000);
  if (r.status >= 400) throw new Error(`Kalshi ${method} ${endpoint} -> ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`);
  return r.body;
}

// --- TELEGRAM --------------------------------------------------------------
function tg(msg) {
  // Strip HTML for SSE plain-text display
  const plain = msg.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  // Push to dashboard live feed regardless of Telegram config
  ssePush('notify', { msg: plain, ts: Date.now() });
  if (!CFG.tgToken || !CFG.tgChat) return;
  const body = JSON.stringify({ chat_id: CFG.tgChat, text: msg, parse_mode: 'HTML' });
  req(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  }, 5000).catch(() => {});
}

// --- KALSHI TRADE HISTORY BACKFILL ------------------------------------------
// Pulls ONLY settled positions from Kalshi -- the authoritative source of resolved trades.
// Fills are intentionally skipped: they include open positions, penny contracts,
// multi-leg fills, and other noise that distorts W/L stats.
async function backfillKalshiHistory() {
  try {
    // Use settlements only -- these are definitively closed with real revenue
    const settleRes = await kalshi('GET', '/portfolio/settlements', null, { limit: '100' });
    const settlements = settleRes.settlements || settleRes.market_settlements || [];

    if (settlements.length === 0) {
      log('Kalshi history: no settlements found yet');
      return;
    }

    // Track existing settled tickers to avoid duplicates
    const existingSettled = new Set(
      S.trades.filter(t => t.status === 'resolved').map(t => t.ticker)
    );
    let added = 0;

    for (const s of settlements) {
      const ticker = s.ticker || s.market_ticker;
      if (!ticker) continue;
      if (existingSettled.has(ticker)) continue;

      // Kalshi settlement fields:
      // revenue_dollars = total payout received (e.g. 2.00 for 2 winning contracts)
      // profit_loss_dollars = net P&L = revenue - cost (the real profit number)
      // no/yes_fee_cost_dollars = what you originally paid
      const revenue = parseFloat(s.revenue_dollars || s.revenue || '0');
      const pnl = parseFloat(s.profit_loss_dollars || '0');
      // Cost = revenue - pnl (if pnl field exists), else fallback
      const cost = (s.profit_loss_dollars && revenue > 0)
        ? revenue - pnl
        : parseFloat(s.no_fee_cost_dollars || s.yes_fee_cost_dollars || s.cost_dollars || '0');
      const contracts = Math.abs(parseFloat(s.contracts_count_fp || s.contracts || 1));
      const won = revenue > 0; // received payout = won

      // Skip entries with no revenue and no pnl -- phantom/noise
      if (revenue === 0 && pnl === 0) continue;

      const trade = {
        ticker,
        side: s.side === 'no' ? 'NO' : 'YES',
        contracts,
        entryPrice: contracts > 0 && cost > 0 ? Math.round((cost / contracts) * 100) : 50,
        cost: parseFloat(cost.toFixed(4)),
        revenue: parseFloat(revenue.toFixed(4)),
        pnl: parseFloat(pnl.toFixed(4)),
        won,
        openedAt: s.market_expiration_time ? new Date(s.market_expiration_time).getTime() : Date.now(),
        resolvedAt: Date.now(),
        status: 'resolved',
        reasoning: 'Settled on Kalshi',
        fromKalshi: true,
      };

      S.trades.push(trade);
      existingSettled.add(ticker);
      added++;
    }

    if (added > 0) {
      // Sort newest first
      S.trades.sort((a, b) => (b.resolvedAt || b.openedAt || 0) - (a.resolvedAt || a.openedAt || 0));
      // Rebuild W/L/PnL from settled trades only -- open positions don't count yet
      const resolved = S.trades.filter(t => t.status === 'resolved');
      S.wins = resolved.filter(t => t.won === true).length;
      S.losses = resolved.filter(t => t.won === false).length;
      S.totalPnl = resolved.reduce((sum, t) => sum + (t.pnl || 0), 0);
      saveState();
      log(`History backfill: +${added} settled trades | ${S.wins}W/${S.losses}L | P&L: $${S.totalPnl.toFixed(2)}`);
    } else {
      log(`History: ${settlements.length} settlements checked, all already tracked`);
    }
  } catch(e) {
    log('History backfill failed: ' + e.message, 'WARN');
  }
}

// --- BALANCE SYNC ----------------------------------------------------------
async function syncBalance() {
  try {
    const r = await kalshi('GET', '/portfolio/balance');
    // Per Kalshi official docs: balance field is ALWAYS in cents (integer).
    // e.g. $48.32 is returned as 4832. Always divide by 100.
    const rawCents = r.balance != null ? Number(r.balance) : 0;
    if (!rawCents || rawCents <= 0) { log('Balance returned 0 cents -- skipping', 'WARN'); return; }
    const bal = parseFloat((rawCents / 100).toFixed(2));
    log(`Balance sync: ${rawCents}c -> $${bal}`);
    const prevBal = S.realBalance || S.balance;
    S.realBalance = bal;
    S.balance = bal;
    if (bal > S.peakBalance) S.peakBalance = bal;
    if (S.peakBalance === 0) S.peakBalance = bal;
    checkMilestone(prevBal, bal);
    // Record portfolio history for persistent chart (keep last 2000 points)
    if (!S.portfolioHistory) S.portfolioHistory = [];
    const lastPt = S.portfolioHistory[S.portfolioHistory.length - 1];
    // Only add point if value changed OR it's been 5+ minutes since last point
    if (!lastPt || lastPt.v !== bal || (Date.now() - lastPt.t) > 60000) {
      S.portfolioHistory.push({ t: Date.now(), v: bal });
      if (S.portfolioHistory.length > 2000) S.portfolioHistory.shift();
    }
    const phase = getPhase();
    log(`Balance: $${bal.toFixed(2)} | Peak: $${S.peakBalance.toFixed(2)} | Phase: ${phase.name} | ${doublingProgress().toFixed(1)}% to $${nextTarget().toFixed(2)}`);
  } catch(e) {
    log('Balance sync failed: ' + e.message, 'WARN');
  }
}

// --- SYNC RESTING (UNFILLED) ORDERS ----------------------------------------
// Kalshi reserves cash the moment a limit order is placed, even before fill.
// We must track this so Kelly sizing never double-spends reserved cash.
async function syncRestingOrders() {
  try {
    // Try status=resting; if that returns nothing, fetch all orders and filter
    let orders = [];
    try {
      const r1 = await kalshi('GET', '/portfolio/orders', null, { status: 'resting', limit: '50' });
      orders = r1.orders || r1.market_orders || [];
    } catch(e1) {
      const r2 = await kalshi('GET', '/portfolio/orders', null, { limit: '50' });
      orders = (r2.orders || r2.market_orders || []).filter(o => {
        const st = (o.status || '').toLowerCase();
        return st === 'resting' || st === 'open' || st === 'pending'
          || parseFloat(o.remaining_count || o.count || 0) > 0;
      });
    }
    // Log raw fields so we can debug field name mismatches in Railway logs
    if (orders.length > 0) {
      const s0 = orders[0];
      log(`Resting fields: yes_price=${s0.yes_price} no_price=${s0.no_price} remaining_count=${s0.remaining_count} count=${s0.count} status=${s0.status}`);
    } else {
      log('syncRestingOrders: 0 orders returned from Kalshi');
    }
    // Preserve placedAt + alertedStale across re-syncs
    const _existOrds = new Map((S.restingOrders||[]).map(o => [o.orderId, o]));
    S.restingOrders = orders.map(o => {
      const remaining = parseFloat(o.remaining_count != null ? o.remaining_count : (o.count || 0));
      const rawPrice = parseFloat(o.yes_price || o.no_price || 0);
      const pricePerContract = rawPrice > 1 ? rawPrice / 100 : rawPrice;
      const reservedCash = remaining * pricePerContract;
      const prev = _existOrds.get(o.order_id) || {};
      return { orderId: o.order_id, ticker: o.ticker, side: o.side,
               contracts: remaining, pricePerContract, reservedCash,
               placedAt: prev.placedAt || Date.now(),
               alertedStale: prev.alertedStale || false };
    });
    const totalReserved = S.restingOrders.reduce((sum, o) => sum + o.reservedCash, 0);
    const rawBal = S.realBalance > 0 ? S.realBalance : S.balance;
    S.availableCash = Math.max(0, rawBal - totalReserved);
    log(`Cash: total=$${rawBal.toFixed(2)} reserved=$${totalReserved.toFixed(2)} avail=$${S.availableCash.toFixed(2)} (${S.restingOrders.length} resting)`);
    // Alert + auto-cancel stale orders — unfilled orders block cash and slots
    const _now_ms = Date.now();
    for (const _ord of S.restingOrders) {
      if (!_ord.placedAt) continue;
      const ageMs = _now_ms - _ord.placedAt;
      // Auto-cancel: order is 90min+ old AND not yet alerted stale
      if (ageMs > 90 * 60000 && !_ord.cancelledStale) {
        _ord.cancelledStale = true;
        log(`🗑️ Auto-cancel stale order: ${_ord.ticker} — ${ageMs/3600000|0}h${((ageMs%3600000)/60000|0)}m unfilled`, 'WARN');
        tg(`🗑️ <b>Auto-cancelling Stale Order</b>\n${_ord.ticker} unfilled for ${(ageMs/60000).toFixed(0)}min\nFreeing $${(_ord.reservedCash||0).toFixed(2)} reserved cash`);
        try {
          if (_ord.orderId) await kalshi('DELETE', `/portfolio/orders/${_ord.orderId}`);
        } catch(ce) { log('Cancel order failed: ' + ce.message, 'WARN'); }
      } else if (ageMs > 60 * 60000 && !_ord.alertedStale) {
        // Alert at 60min (warn before auto-cancel)
        _ord.alertedStale = true;
        log(`⚠️ Stale order 60min+: ${_ord.ticker} @ ${((_ord.pricePerContract||0)*100).toFixed(0)}c — will auto-cancel at 90min`, 'WARN');
        tg(`⚠️ <b>Unfilled Order 60min+</b>\n${_ord.ticker} @ ${((_ord.pricePerContract||0)*100).toFixed(0)}c\nReserving $${(_ord.reservedCash||0).toFixed(2)} — auto-cancels in 30min`);
      }
    }
  } catch(e) {
    // v14 FIX: On resting sync failure, use balance directly minus 10% buffer.
    // Old code zeroed out availableCash on any error — blocked ALL trades.
    // Better: assume conservatively that 10% is reserved, still allow trading.
    const rawBal = S.realBalance > 0 ? S.realBalance : S.balance;
    S.availableCash = Math.max(0, rawBal * 0.90);
    log('Resting sync FAILED — using 90% of balance as available cash: ' + e.message, 'WARN');
  }
}


function parsePrice(raw) {
  if (raw === null || raw === undefined) return 0;
  const n = parseFloat(raw);
  if (!isFinite(n) || isNaN(n)) return 0;
  // Post-March 2026 Kalshi API migration: prices are dollar strings "0.6500"
  // Legacy integer cents fields (yes_bid: 65) have been REMOVED.
  // All _dollars fields are 0.0000-1.0000 range. Safe to use directly.
  // Guard: if somehow a large int slips through (old cached data), convert
  return n > 1.5 ? n / 100 : n;
}

// --- SYNC LIVE POSITIONS FROM KALSHI -----------------------------------------
async function syncPositions() {
  try {
    const r = await kalshi('GET', '/portfolio/positions', null, { limit: '100' });
    const positions = r.market_positions || r.positions || [];

    const livePositions = positions
      .filter(p => Math.abs(parseFloat(p.position_fp || p.position || 0)) > 0)
      .map(p => {
        const qty = parseFloat(p.position_fp || p.position || 0);
        const side = qty > 0 ? 'YES' : 'NO';
        const contracts = Math.abs(qty);
        // Kalshi returns current_price as decimal (0.01 = 1c, 0.50 = 50c)
        const currentPriceDollars = parsePrice(
          p.current_yes_bid_dollars || p.current_no_bid_dollars ||
          p.yes_price_dollars || p.no_price_dollars ||
          p.market_exposure_dollars || p.market_value_dollars || '0'
        );
        const exposure = parsePrice(p.market_exposure_dollars || p.market_value_dollars || '0');
        // entryPrice: use current market price if we can get it, else derive from exposure
        const derivedCostPer = (exposure > 0 && contracts > 0) ? exposure / contracts : 0;
        const entryPriceCents = derivedCostPer > 0 ? Math.round(derivedCostPer * 100)
          : currentPriceDollars > 0 ? Math.round(currentPriceDollars * 100) : 50;
        // FIX: was `costPer` (undefined ReferenceError) — use derivedCostPer or currentPriceDollars
        const currentPriceCents = derivedCostPer > 0 ? Math.round(derivedCostPer * 100)
          : currentPriceDollars > 0 ? Math.round(currentPriceDollars * 100) : entryPriceCents;
        return {
          ticker: p.ticker, side, contracts,
          entryPrice: Math.min(99, Math.max(1, entryPriceCents)),
          cost: exposure > 0 ? exposure : contracts * 0.5,
          currentPrice: Math.min(99, Math.max(1, currentPriceCents)),
          openedAt: Date.now() - (6 * 3600000), // treat synced positions as 6h old → monitor checks them
          status: 'open',
          reasoning: 'Synced from Kalshi', fromKalshi: true,
        };
      });

    if (livePositions.length === 0) {
      log('No open positions on Kalshi');
      if (S.openPositions.some(p => p.fromKalshi)) {
        S.openPositions = S.openPositions.filter(p => !p.fromKalshi);
        saveState();
      }
      return;
    }

    const prevCount = S.openPositions.length;
    const prevTickers = new Set(S.openPositions.map(p => p.ticker));
    const liveSet = new Set(livePositions.map(p=>p.ticker));
    const botPos = S.openPositions.filter(p=>!p.fromKalshi);
    const validBot = botPos.filter(p=>{ const ok=liveSet.has(p.ticker); if(!ok) log('Ghost purged: '+p.ticker); return ok; });
    const validBotSet = new Set(validBot.map(x=>x.ticker));
    const freshKalshi = livePositions.filter(p=>!validBotSet.has(p.ticker));
    // FIX: Do NOT slice to maxPos here — that was hiding the 6th real position.
    // We must DISPLAY all real Kalshi positions accurately. The maxPos cap only
    // applies to BLOCKING NEW TRADES (enforced in executeTrade), not to display.
    const combined = [...validBot, ...freshKalshi];
    S.openPositions = combined; // show all real positions
    const maxAllowed = dynamicMaxPos();
    if (combined.length > maxAllowed) {
      log(`Note: ${combined.length} real positions tracked (${combined.length - maxAllowed} over maxPos=${maxAllowed}) — trades blocked until resolved`);
    }
    if(botPos.length>validBot.length){log('Purged '+(botPos.length-validBot.length)+' ghosts');saveState();}

    // v14: If positions disappeared from Kalshi (resolved externally), trigger immediate rescan
    const resolvedExternally = [...prevTickers].filter(t => !liveSet.has(t));
    if (resolvedExternally.length > 0) {
      log(`⚡ ${resolvedExternally.length} position(s) resolved on Kalshi — forcing immediate brain rescan`);
      S.lastBrainAt = 0;
      clearTimeout(scanTimer);
      if (S.isRunning) scanTimer = setTimeout(scan, 3000);
    }

    log(`Synced ${livePositions.length} positions from Kalshi (${freshKalshi.length} new) | tracking ${S.openPositions.length} total | maxPos=${maxAllowed}`);
    // Only notify Telegram when NEW positions appear (not on every re-sync)
    const genuinelyNew = freshKalshi.filter(p => !prevTickers.has(p.ticker));
    if (genuinelyNew.length > 0) {
      tg(`📋 <b>New position synced from Kalshi</b>\n${genuinelyNew.map(p => `${p.ticker} ${p.side} x${p.contracts}`).join('\n')}`);
    }
    saveState();
  } catch(e) {
    log('Position sync CRASHED: ' + e.message + ' | stack: ' + (e.stack||'').slice(0,120), 'ERROR');
    // Do NOT clear openPositions on error — stale data is safer than empty data
  }
}

// --- MARKET SCANNER (pure math, no Claude calls) ---------------------------
async function getTopMarkets() {
  try {
    const hour = new Date().getUTCHours();
    const isMarketHours = hour >= 13 && hour <= 23;
    const nowTs = Math.floor(Date.now() / 1000);
    const phase = getPhase();

    // ── STRATEGY: primary fetch is time-window based (fast, 1 call) ──────────
    // Secondary: targeted series for sports/macro (batched with timeout)
    // This eliminates the 40-call waterfall that caused 5-min silent gaps.
    const kalshiTimeout = (method, endpoint, body, params, ms = 8000) =>
      Promise.race([
        kalshi(method, endpoint, body, params),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
      ]);

    let allMarkets = [];

    // ── PRIMARY: broad sub-3h fetch (catches ALL fast markets in one call) ───
    try {
      const r = await kalshiTimeout('GET', '/markets', null, {
        status: 'open', limit: '500',
        max_close_ts: (nowTs + 3 * 3600).toString(),
        min_close_ts: (nowTs + 300).toString(),
      }, 10000);
      const mkts = (r.markets || []).filter(m => !m.mve_collection_ticker);
      allMarkets.push(...mkts);
      log(`Primary fetch (sub-3h): ${mkts.length} markets`);
    } catch(e) { log('Primary fetch failed: ' + e.message, 'WARN'); }

    // ── SECONDARY: targeted series for sports + macro (parallel, 8s timeout each) ─
    // Only series that have proven to return markets — trimmed from 40 to 20
    const sportsMacroSeries = [
      // Sports (current season) — dominant Kalshi volume
      'KXNBAGAME', 'KXMLBGAME', 'KXNHLGAME', 'KXNBAPLAYOFFS',
      // 15-min crypto — PRIMARY flywheel: SOL + XRP + ETH + BTC (all 4 coins, 24/7)
      'KXSOL15M', 'KXXRP15M', 'KXETH15M', 'KXBTC15M',
      // 1-hour crypto fixed-strike — secondary flywheel
      'KXBTCH', 'KXETHH',
      // Crypto daily — ONLY if within 4h of close
      'KXBTCD', 'KXETHUSD',
      // Indices (market hours only)
      ...(isMarketHours ? ['INXD', 'NASDAQ100D'] : []),
      // Macro events
      'FED', 'KXCPI',
      // NOTE: Weather series REMOVED — KXHIGH/KXLOW settle in days, kill flywheel
    ];

    const fetches = await Promise.allSettled(
      sportsMacroSeries.map(s =>
        kalshiTimeout('GET', '/markets', null, { series_ticker: s, status: 'open', limit: '50' }, 8000)
      )
    );
    let seriesCount = 0;
    for (const f of fetches) {
      if (f.status === 'fulfilled') {
        allMarkets.push(...(f.value.markets || []));
        seriesCount++;
      }
    }
    log(`Series fetch: ${seriesCount}/${sportsMacroSeries.length} returned markets`);

    if (allMarkets.length === 0) {
      log('All fetches empty -- falling back to generic endpoint', 'WARN');
      try {
        const fallback = await kalshiTimeout('GET', '/markets', null, { status: 'open', limit: '200' }, 10000);
        allMarkets = (fallback.markets || []).filter(m => !m.mve_collection_ticker);
        log(`Fallback: ${allMarkets.length} non-MVE markets`);
      } catch(e) { log('Fallback failed: ' + e.message, 'WARN'); }
    }

    // ── CRYPTO SERIES FETCH: targeted BTC/ETH/15min with timeouts ────────────
    const cryptoSeriesFetches = await Promise.allSettled([
      // v17: SOL15M + XRP15M added — these are the highest-volume 15-min flywheel markets
      'KXSOL15M','KXXRP15M','KXBTC15M','KXETH15M',
      'KXBTCD','KXETHUSD','KXBTCH','KXETHH','KXBTCUSDH','KXETHUSDH'
    ].map(s => kalshiTimeout('GET', '/markets', null, {
      series_ticker: s, status: 'open', limit: '50',
      max_close_ts: (nowTs + 4 * 3600).toString(),
      min_close_ts: (nowTs + 300).toString(),
    }, 8000)));
    let cryptoAdded = 0;
    for (const f of cryptoSeriesFetches) {
      if (f.status === 'fulfilled') {
        allMarkets.push(...(f.value.markets || []));
        cryptoAdded += (f.value.markets || []).length;
      }
    }
    if (cryptoAdded > 0) log(`Crypto series fetch: +${cryptoAdded} markets`);

    // Deduplicate
    const seen = new Set();
    allMarkets = allMarkets.filter(m => {
      if (!m?.ticker || seen.has(m.ticker)) return false;
      seen.add(m.ticker); return true;
    });

    log(`Raw: ${allMarkets.length} markets total (deduped)`);

  // -- PAYOUT-FIRST FILTER --
    // PAYOUT-FIRST FILTER — only let markets through that can deliver 2x+ net payout
    // Net payout = (1-price)/price * (1-fee). Need price <= 32c for 2x+.
    // At 32c: (0.68/0.32)*0.955 = 2.03x. At 25c: 2.87x. At 15c: 5.4x. At 10c: 8.6x
    // Sweet spot: 8c-32c YES side OR equivalent NO side.
    // SLOT PROTECTION: daily BTC (KXBTCD) resolves TOMORROW — kills flywheel.
    // Only allow KXBTCD if it closes within 6h. 15min/hourly always preferred.
    const markets = allMarkets.filter(m => {
      if (m.mve_collection_ticker) return false;
      const yesAsk = parsePrice(m.yes_ask_dollars);
      const yesBid = parsePrice(m.yes_bid_dollars);
      if (yesAsk <= 0 || yesBid <= 0) return false;
      const vol = parseFloat(m.volume_fp || m.volume || 0);
      const isHourly = /H$|15M$|HOURLY|15M|BTCUP|BTCDOWN/i.test(m.ticker) || (m.series_ticker && /H$|15M/i.test(m.series_ticker));
      const hoursLeft = m.close_time ? Math.max(0, (new Date(m.close_time) - Date.now()) / 3600000) : 999;
      const isFastClose = hoursLeft < 3;
      // FLYWHEEL RULE: daily BTC/ETH contracts (KXBTCD, KXETHUSD daily) that close
      // tomorrow are slot killers. Only allow them if they resolve within 6h.
      const isDailyTicker = /^KXBTCD|^KXETHUSD-\d{2}[A-Z]{3}\d{2}[^H]/i.test(m.ticker);
      if (isDailyTicker && hoursLeft > 6) return false; // tomorrow's daily = skip
      // Very low vol floor — at our position sizes liquidity isn't the constraint
      if (vol < (isHourly || isFastClose ? 5 : 25)) return false;
      const spread = yesAsk - yesBid;
      if (spread > (isHourly || isFastClose ? 0.35 : 0.25)) return false;
      // TWO trade archetypes:
      // (A) High-payout underdogs: 5c-35c = 2x+ payout (FastPath primary)
      // (B) High-confidence favorites: 55c-88c YES = near-certain small gain
      //     These are the Burgi research "favorites win more than priced" trades
      //     At 80c: 80% implied prob, FastPath math often shows 90-96% real conf
      //     Payout is only 1.2x but win rate is ~90%+ = solid EV
      const noAsk = Math.max(0.01, 1 - yesBid);
      const yesSideOk = yesAsk >= 0.03 && yesAsk <= 0.40;    // high-payout underdogs (3c-40c)
      const noSideOk  = noAsk >= 0.03 && noAsk <= 0.40 && yesAsk >= 0.60; // NO underdog
      const yesFavOk  = yesAsk >= 0.52 && yesAsk <= 0.90;    // YES favorite (high conf)
      // v17: CRITICAL — 15-min Up/Down markets trade near 50c. They were blocked by all above.
      // Momentum edge applies here — RSI/momentum signal gives us the direction advantage.
      const is15MinUpDown = /kxsol15m|kxxrp15m|kxeth15m|kxbtc15m/i.test(m.ticker);
      const upDownOk = is15MinUpDown && yesAsk >= 0.30 && yesAsk <= 0.70;
      return yesSideOk || noSideOk || yesFavOk || upDownOk;
    });

    log(`After payout filter: ${markets.length} tradeable | Raw was ${allMarkets.length}`);

    // Pre-filters: remove markets that are structurally bad opportunities
    const preFilterCount = markets.length;
    const filteredMarkets = markets.filter(m => {
      const yesAsk = parsePrice(m.yes_ask_dollars);
      const yesBid = parsePrice(m.yes_bid_dollars);
      const hoursLeftFilter = m.close_time
        ? Math.max(0, (new Date(m.close_time) - Date.now()) / 3600000) : 999;
      const phase = getPhase();

      // v17: HARD BAN weather — settle in days, kill flywheel, market maker has NWS edge
      if (/kxhigh|kxlow/i.test(m.ticker)) return false;

      // v17: 15-min Up/Down crypto ALWAYS passes — primary flywheel engine
      if (/kxsol15m|kxxrp15m|kxeth15m|kxbtc15m/i.test(m.ticker)) return true;

      // FLYWHEEL BLOCK: KXBTCD (Bitcoin daily) closes tomorrow — 18+ hour hold.
      if (/^KXBTCD/i.test(m.ticker) && hoursLeftFilter > 4) {
        log(`Flywheel filter: ${m.ticker} is tomorrow's BTC daily (${hoursLeftFilter.toFixed(1)}h) — skip`);
        return false;
      }

      // Duration cap — fast-closing markets (<3h) are ALWAYS allowed regardless of phase
      if (hoursLeftFilter <= 3.0) return true;

      // SEED/SPROUT: allow up to 24h for same-day markets
      const maxHours = (phase.name === 'SEED' || phase.name === 'SPROUT') ? 24 : 72;
      if (hoursLeftFilter > maxHours) return false;

      return true;
    });
    const removedCount = preFilterCount - filteredMarkets.length;
    if (removedCount > 0) {
      log(`Pre-filter removed ${removedCount} markets (>${(getPhase().name==='SEED'?24:72)}h or mid-prob weather) | ${filteredMarkets.length} remain`);
    }

    const scored = filteredMarkets.map(m => {
      const yesAsk = parsePrice(m.yes_ask_dollars);
      const yesBid = parsePrice(m.yes_bid_dollars);
      const spread = Math.max(0, yesAsk - yesBid);
      const vol = parseFloat(m.volume_fp || m.volume || 0);
      const hoursLeft = m.close_time
        ? Math.max(0, (new Date(m.close_time) - Date.now()) / 3600000) : 999;

      // Duration scoring — FASTER = BETTER for compounding speed.
      // Hourly/15min crypto markets are the gold standard: pure math, fast capital recycling.
      const durationScore = hoursLeft < 0.08  ? 0.05  // <5min: too late to fill
        : hoursLeft < 0.25  ? 0.90              // 5-15min: very tight but ok
        : hoursLeft < 0.75  ? 1.80              // 15-45min: BEST — hourly crypto sweet spot
        : hoursLeft < 1.5   ? 1.60              // 45min-1.5h: excellent — still fast
        : hoursLeft < 3     ? 1.40              // 1.5-3h: great
        : hoursLeft < 8     ? 1.20              // 3-8h: good — same-day games/data
        : hoursLeft < 16    ? 0.90              // 8-16h: tonight
        : hoursLeft < 24    ? 0.65              // 16-24h: tomorrow
        : hoursLeft < 36    ? 0.35              // next day extended
        : hoursLeft < 72    ? 0.12              // slow
        : hoursLeft < 168   ? 0.03              // bad
        : 0.01;                                 // multi-week: skip

      const spreadScore = Math.max(0, 1 - spread / 0.10);
      const volScore = Math.min(1, Math.log10(vol + 1) / 5);

      // PAYOUT-FIRST scoring: the lower the price, the higher the payout multiple
      // Net payout ratio = (1-price)/price * (1-fee)
      const netPayoutRatio = ((1 - yesAsk) / yesAsk) * (1 - KALSHI_FEE);
      // Payout scoring: strongly favor 2.5x-5x range.
      const payoutScore = netPayoutRatio >= 5.0 ? 1.15  // ~16c: extreme — needs high conf
        : netPayoutRatio >= 3.5 ? 1.50                   // ~21c: outstanding
        : netPayoutRatio >= 2.5 ? 1.60                   // ~27c: SWEET SPOT — target this
        : netPayoutRatio >= 2.0 ? 1.35                   // ~32c: good
        : netPayoutRatio >= 1.8 ? 1.00                   // ~35c: acceptable minimum
        : 0.30;                                           // <1.8x: deprioritized

      const volWeight = Math.min(1, Math.log10(Math.max(1, vol)) / 4);
      // Edge score: reward markets where one side has very high payout potential
      // Low YES prices (8-25c) = high payout = reward. Near 50c = coin flip = low value.
      // Use distance from center (0.5) but cap to avoid pure longshots with no volume
      const bestPrice = Math.min(yesAsk, 1 - yesAsk); // price of cheaper side
      const edgeScore = (0.5 - bestPrice) * 2.0 * (0.5 + 0.5 * volWeight); // 0 at 50c, 1.0 at 0c
      const feeAdj = 1 - (KALSHI_FEE * (1 - yesAsk)); // fee on YES win

      // Category multipliers: 15-min crypto = absolute best (pure math, fastest compounding)
      const isCrypto = /btc|eth|sol|xrp|doge|crypto|inxd|inxw|spx|ndx/i.test(m.ticker);
      const is15MinCrypto = isCrypto && (/15M|15MIN/i.test(m.ticker) || hoursLeft < 0.30);
      const isHourlyCrypto = isCrypto && !is15MinCrypto && (/H$|HOURLY/i.test(m.ticker) || (m.series_ticker && /H$/i.test(m.series_ticker)) || hoursLeft < 1.5);
      const isWeather = /kxhigh|kxlow/i.test(m.ticker);
      const categoryMult = is15MinCrypto ? 2.00    // 15-min: fastest compounding, pure math
        : isHourlyCrypto ? 1.65                     // hourly: very fast, pure math
        : isCrypto ? 1.30                           // daily/weekly crypto: good
        : isWeather ? 0.65                          // weather: penalize
        : 1.0;

      const totalScore = (
        spreadScore   * 0.10 +
        volScore      * 0.15 +
        durationScore * 0.45 +   // duration is king — fast resolution = fast compounding
        edgeScore     * 0.30
      ) * payoutScore * feeAdj * categoryMult;

      // Also score the NO side — surfaces more opportunities
      const noAskP = Math.max(0.08, Math.min(0.42, 1 - yesBid));
      const noPayoutRatio = ((1 - noAskP) / noAskP) * (1 - KALSHI_FEE);
      const noPaySc = noPayoutRatio >= 5.0 ? 1.15 : noPayoutRatio >= 3.5 ? 1.50
        : noPayoutRatio >= 2.5 ? 1.60 : noPayoutRatio >= 2.0 ? 1.35
        : noPayoutRatio >= 1.8 ? 1.00 : 0.30;
      const noScore = (spreadScore*0.10 + volScore*0.15 + durationScore*0.45 + edgeScore*0.30)
        * noPaySc * (1 - KALSHI_FEE * noAskP) * categoryMult;

      const usNo = noScore > totalScore && noPayoutRatio >= 1.8 && (1-yesBid) > 0.08 && (1-yesBid) < 0.42;
      return {
        ticker: m.ticker, title: m.title, yesAsk, yesBid, spread, volume: vol,
        score: usNo ? noScore : totalScore,
        hoursLeft: parseFloat(hoursLeft.toFixed(1)),
        closeTime: m.close_time, category: m.category || m.series_ticker || 'unknown',
        netPayoutRatio: parseFloat((usNo ? noPayoutRatio : netPayoutRatio).toFixed(2)),
        suggestedSide: usNo ? 'NO' : 'YES',
        edge: 0, // populated by brain after web search
      };
    });

    // Deprioritize markets already held
    const _heldSet = new Set(S.openPositions.map(p => p.ticker));
    scored.forEach(m => { if (_heldSet.has(m.ticker)) m.score *= 0.05; });
    scored.sort((a, b) => b.score - a.score);

    // CRITICAL sort order: 15-min first → hourly → sub-3h → rest
    const _15minMarkets = scored.filter(m => m.hoursLeft < 0.30 && !_heldSet.has(m.ticker));
    const _hourlyMarkets = scored.filter(m => m.hoursLeft >= 0.30 && m.hoursLeft < 2.0 && !_heldSet.has(m.ticker));
    const _sub3hMarkets  = scored.filter(m => m.hoursLeft >= 2.0 && m.hoursLeft < 3.0 && !_heldSet.has(m.ticker));
    const _otherMarkets  = scored.filter(m => m.hoursLeft >= 3.0 || _heldSet.has(m.ticker));
    const reordered = [..._15minMarkets, ..._hourlyMarkets, ..._sub3hMarkets, ..._otherMarkets];
    // Guarantee crypto representation in topMarkets — brain also needs to see them
    // Top 8 slots: best crypto (fastest first). Remaining 12: best of everything else.
    const _cryptoTop = scored.filter(m => /kxbtc|kxeth|kxsol|kxxrp/i.test(m.ticker) && !_heldSet.has(m.ticker) && m.hoursLeft > 0.08).sort((a,b)=>a.hoursLeft-b.hoursLeft).slice(0, 8);
    const _nonCrypto = reordered.filter(m => !/kxbtc|kxeth|kxsol|kxxrp/i.test(m.ticker)).slice(0, 12);
    const _cryptoInReordered = reordered.filter(m => /kxbtc|kxeth|kxsol|kxxrp/i.test(m.ticker));
    // Merge: crypto first, then non-crypto, deduplicated
    const _seen = new Set();
    const _merged = [..._cryptoTop, ..._cryptoInReordered, ..._nonCrypto].filter(m => {
      if (_seen.has(m.ticker)) return false; _seen.add(m.ticker); return true;
    });
    S.topMarkets = _merged.slice(0, 20);
    // Store ALL crypto markets separately so FastPath never misses them
    S._allScoredCrypto = scored.filter(m =>
      /kxbtc|kxeth|kxsol|kxxrp/i.test(m.ticker) && !_heldSet.has(m.ticker) && m.hoursLeft > 0.08
    );
    if (S._allScoredCrypto.length > 0) log(`Crypto pool for FastPath: ${S._allScoredCrypto.length} markets (top8 guaranteed in topMarkets)`);
    if (_15minMarkets.length > 0) log(`15-min markets: ${_15minMarkets.length} surfaced FIRST`);
    if (_hourlyMarkets.length > 0) log(`Hourly markets surfaced: ${_hourlyMarkets.length} markets with hoursLeft<2 sent to brain first`);
    if (S.topMarkets.length > 0) {
      const fastest = S.topMarkets.filter(m => m.hoursLeft < 4);
      const cryptoMkts = S.topMarkets.filter(m => /btc|eth|sol/i.test(m.ticker));
      const sportsMkts = S.topMarkets.filter(m => /game|nba|mlb|nhl/i.test(m.ticker));
      log(`Top: ${S.topMarkets[0].ticker} YES=${(S.topMarkets[0].yesAsk*100).toFixed(1)}c vol=${S.topMarkets[0].volume} score=${S.topMarkets[0].score.toFixed(3)} hours=${S.topMarkets[0].hoursLeft.toFixed(1)}h`);
      log(`Market mix: ${filteredMarkets.length} total | ${fastest.length} resolving<4h | ${cryptoMkts.length} crypto | ${sportsMkts.length} sports`);
    }
    return S.topMarkets;
  } catch(e) {
    log('Market scan failed: ' + e.message, 'WARN');
    return [];
  }
}


// --- SPORTS LIVE SCORE FAST PATH: free ESPN API, zero Claude cost -------------
// Checks live NBA/MLB/NHL scores and signals when a team is losing badly.
// A team down 20pts with 5min left or down 3 runs in the 8th is a strong edge.
// Uses ESPN's public (undocumented but reliable) scoreboard endpoints.
async function runSportsFastPath(topMarkets) {
  if (S.openPositions.length >= dynamicMaxPos()) return 0;

  const phase = getPhase();
  const heldSet = new Set(S.openPositions.map(p => p.ticker));
  let filled = 0;

  // Only sports markets resolving within 5h (live or tonight)
  const sportsMarkets = topMarkets.filter(m =>
    m.hoursLeft < 5.0 && m.hoursLeft > 0.15 &&
    !heldSet.has(m.ticker) &&
    /nba|mlb|nhl|nfl/i.test(m.ticker)
  );
  if (sportsMarkets.length === 0) return 0;

  // Fetch ESPN live scores — one call per sport type needed
  const hasnba = sportsMarkets.some(m => /nba/i.test(m.ticker));
  const hasmlb = sportsMarkets.some(m => /mlb/i.test(m.ticker));
  const hasnhl = sportsMarkets.some(m => /nhl/i.test(m.ticker));

  let espnData = {};
  const espnFetches = [];
  if (hasnba) espnFetches.push(['nba', 'http://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard']);
  if (hasmlb) espnFetches.push(['mlb', 'http://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard']);
  if (hasnhl) espnFetches.push(['nhl', 'http://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard']);

  await Promise.allSettled(espnFetches.map(async ([sport, url]) => {
    try {
      const r = await req(url, { method: 'GET', headers: {} }, 8000);
      if (r.status === 200 && r.body?.events) espnData[sport] = r.body.events;
    } catch(e) { log(`SportsFastPath: ESPN ${sport} fetch failed: ${e.message}`, 'WARN'); }
  }));

  if (Object.keys(espnData).length === 0) { log('SportsFastPath: no ESPN data — skipping'); return 0; }

  for (const m of sportsMarkets) {
    if (S.openPositions.length >= dynamicMaxPos()) break;

    // Determine sport from ticker
    const sport = /nba/i.test(m.ticker) ? 'nba' : /mlb/i.test(m.ticker) ? 'mlb' : /nhl/i.test(m.ticker) ? 'nhl' : null;
    if (!sport || !espnData[sport]) continue;

    // Try to match ESPN game to this Kalshi ticker
    // Kalshi tickers like: KXNBAGAME-26APR-MIA-BOS-MIA
    // Last segment = team abbreviation that wins if YES
    const tickerParts = m.ticker.split('-');
    const teamAbbrRaw = tickerParts[tickerParts.length - 1]; // e.g. MIA

    // Find live game involving this team
    const liveGame = espnData[sport].find(ev => {
      if (!ev.status?.type?.completed === false && ev.status?.type?.state !== 'in') return false;
      return ev.competitions?.[0]?.competitors?.some(c =>
        c.team?.abbreviation?.toUpperCase() === teamAbbrRaw.toUpperCase() ||
        c.team?.shortDisplayName?.toUpperCase().includes(teamAbbrRaw.toUpperCase())
      );
    });
    if (!liveGame) { log(`SportsFastPath: no live ${sport} game for ${teamAbbrRaw} in ${m.ticker}`); continue; }

    const comp = liveGame.competitions?.[0];
    if (!comp) continue;

    const teams = comp.competitors || [];
    const targetTeam = teams.find(c =>
      c.team?.abbreviation?.toUpperCase() === teamAbbrRaw.toUpperCase() ||
      c.team?.shortDisplayName?.toUpperCase().includes(teamAbbrRaw.toUpperCase())
    );
    const otherTeam = teams.find(c => c !== targetTeam);
    if (!targetTeam || !otherTeam) continue;

    const targetScore = parseFloat(targetTeam.score || 0);
    const otherScore = parseFloat(otherTeam.score || 0);
    const scoreDiff = targetScore - otherScore; // positive = target team winning
    const gameState = liveGame.status?.type?.description || '';
    const clock = liveGame.status?.displayClock || '';
    const period = liveGame.status?.period || 0;

    // NBA: signal YES if target team winning by 15+ in Q4, or NO if losing 15+ in Q4
    // MLB: signal YES if target team winning 3+ runs after 7th, NO if losing 3+ after 7th
    // NHL: signal YES if winning 2+ in 3rd period
    let confidence = 0, side = null, reasoning = '';

    if (sport === 'nba' && period >= 4) {
      if (scoreDiff >= 20) { confidence = 0.93; side = 'YES'; reasoning = `NBA Q${period} ${clock}: ${teamAbbrRaw} +${scoreDiff} (blowout)`; }
      else if (scoreDiff >= 15) { confidence = 0.87; side = 'YES'; reasoning = `NBA Q${period} ${clock}: ${teamAbbrRaw} +${scoreDiff}`; }
      else if (scoreDiff <= -20) { confidence = 0.93; side = 'NO'; reasoning = `NBA Q${period} ${clock}: ${teamAbbrRaw} -${Math.abs(scoreDiff)} (losing big)`; }
      else if (scoreDiff <= -15) { confidence = 0.87; side = 'NO'; reasoning = `NBA Q${period} ${clock}: ${teamAbbrRaw} -${Math.abs(scoreDiff)}`; }
    } else if (sport === 'mlb' && period >= 8) {
      if (scoreDiff >= 4) { confidence = 0.92; side = 'YES'; reasoning = `MLB inning ${period}: ${teamAbbrRaw} +${scoreDiff} runs`; }
      else if (scoreDiff >= 3) { confidence = 0.85; side = 'YES'; reasoning = `MLB inning ${period}: ${teamAbbrRaw} +${scoreDiff} runs`; }
      else if (scoreDiff <= -4) { confidence = 0.92; side = 'NO'; reasoning = `MLB inning ${period}: ${teamAbbrRaw} down ${Math.abs(scoreDiff)} runs`; }
      else if (scoreDiff <= -3) { confidence = 0.85; side = 'NO'; reasoning = `MLB inning ${period}: ${teamAbbrRaw} down ${Math.abs(scoreDiff)} runs`; }
    } else if (sport === 'nhl' && period >= 3) {
      if (scoreDiff >= 3) { confidence = 0.91; side = 'YES'; reasoning = `NHL P${period}: ${teamAbbrRaw} +${scoreDiff}`; }
      else if (scoreDiff >= 2) { confidence = 0.83; side = 'YES'; reasoning = `NHL P${period}: ${teamAbbrRaw} +${scoreDiff}`; }
      else if (scoreDiff <= -3) { confidence = 0.91; side = 'NO'; reasoning = `NHL P${period}: ${teamAbbrRaw} down ${Math.abs(scoreDiff)}`; }
      else if (scoreDiff <= -2) { confidence = 0.83; side = 'NO'; reasoning = `NHL P${period}: ${teamAbbrRaw} down ${Math.abs(scoreDiff)}`; }
    }

    if (!side || confidence < phase.minProb) {
      if (side) log(`SportsFastPath: ${m.ticker} conf ${(confidence*100).toFixed(0)}% < phase min — skip`);
      continue;
    }

    const sidePrice = side === 'YES' ? m.yesAsk : Math.max(0.05, 1 - (m.yesBid || (1 - m.yesAsk)));
    if (sidePrice <= 0.05 || sidePrice >= 0.92) continue;
    const netPayout = ((1 - sidePrice) / sidePrice) * (1 - KALSHI_FEE);
    if (netPayout < 2.5) { log(`SportsFastPath: ${m.ticker} payout ${netPayout.toFixed(2)}x < 2.5x min — skip`); continue; }
    const edge = confidence - sidePrice;
    if (edge < phase.minEdge) { log(`SportsFastPath: ${m.ticker} edge ${(edge*100).toFixed(1)}% too low — skip`); continue; }

    const sig = {
      ticker: m.ticker,
      side,
      confidence,
      edge,
      marketPrice: sidePrice,
      feeAdjustedEdge: edge - (sidePrice * KALSHI_FEE),
      netPayoutRatio: netPayout,
      hoursToClose: m.hoursLeft,
      source: 'sports_fastpath',
      reasoning: `🏀 SportsFastPath: ${reasoning} | ${side} @${(sidePrice*100).toFixed(1)}c = ${netPayout.toFixed(2)}x`,
    };

    log(`🏀 SportsFastPath: ${m.ticker} ${side} | ${(confidence*100).toFixed(0)}% | ${netPayout.toFixed(2)}x | ${reasoning}`);
    tg(`🏀 <b>SportsFastPath — $0 AI cost</b>\n${m.ticker} ${side}\n${reasoning}\n${(confidence*100).toFixed(0)}% conf | ${netPayout.toFixed(2)}x payout`);

    await executeTrade(sig);
    filled++;
  }

  if (filled > 0) log(`🏀 SportsFastPath: filled ${filled} position(s) — $0 AI cost`);
  return filled;
}



// --- CRYPTO PRICE CACHE -------------------------------------------------------
// Cache prices for 30s to avoid rate limits. Binance primary, Kraken fallback.
let _priceCache = { btc: null, eth: null, sol: null, xrp: null, fetchedAt: 0 };

async function fetchLivePrices() {
  const now = Date.now();
  // Return cache if fresh (30s)
  if (_priceCache.btc && (now - _priceCache.fetchedAt) < 30000) {
    return _priceCache;
  }

  // Source 1: Binance (fastest, no rate limits on public endpoints)
  try {
    const symbols = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
    const results = await Promise.allSettled(symbols.map(s =>
      req(`https://api.binance.com/api/v3/ticker/price?symbol=${s}`, { method:'GET', headers:{} }, 5000)
    ));
    const prices = {};
    const map = { BTCUSDT:'btc', ETHUSDT:'eth', SOLUSDT:'sol', XRPUSDT:'xrp' };
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.status === 200) {
        prices[map[symbols[i]]] = parseFloat(r.value.body?.price);
      }
    });
    if (prices.btc && prices.eth) {
      _priceCache = { ...prices, fetchedAt: now };
      log(`Prices (Binance): BTC=$${prices.btc?.toLocaleString()} ETH=$${prices.eth?.toLocaleString()} SOL=$${prices.sol?.toFixed(2)}`);
      return _priceCache;
    }
  } catch(e) { log('Binance price fetch failed: ' + e.message, 'WARN'); }

  // Source 2: Kraken fallback
  try {
    const r = await req('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD,XRPUSD', { method:'GET', headers:{} }, 8000);
    if (r.status === 200 && r.body?.result) {
      const res = r.body.result;
      const prices = {
        btc: parseFloat(res['XXBTZUSD']?.c?.[0] || res['XBTUSD']?.c?.[0] || 0),
        eth: parseFloat(res['XETHZUSD']?.c?.[0] || res['ETHUSD']?.c?.[0] || 0),
        sol: parseFloat(res['SOLUSD']?.c?.[0] || 0),
        xrp: parseFloat(res['XXRPZUSD']?.c?.[0] || res['XRPUSD']?.c?.[0] || 0),
      };
      if (prices.btc && prices.eth) {
        _priceCache = { ...prices, fetchedAt: now };
        log(`Prices (Kraken): BTC=$${prices.btc?.toLocaleString()} ETH=$${prices.eth?.toLocaleString()}`);
        return _priceCache;
      }
    }
  } catch(e) { log('Kraken price fetch failed: ' + e.message, 'WARN'); }

  // Source 3: CoinGecko last resort
  try {
    const r = await req('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple&vs_currencies=usd', { method:'GET', headers:{} }, 8000);
    if (r.status === 200 && r.body?.bitcoin?.usd) {
      const prices = { btc: r.body.bitcoin.usd, eth: r.body.ethereum?.usd, sol: r.body.solana?.usd, xrp: r.body.ripple?.usd };
      _priceCache = { ...prices, fetchedAt: now };
      log(`Prices (CoinGecko): BTC=$${prices.btc?.toLocaleString()} ETH=$${prices.eth?.toLocaleString()}`);
      return _priceCache;
    }
  } catch(e) { log('CoinGecko price fetch failed: ' + e.message, 'WARN'); }

  log('ALL price sources failed — returning stale cache', 'WARN');
  return _priceCache; // return stale rather than nothing
}

// --- MOMENTUM ENGINE FOR 15-MIN UP/DOWN MARKETS --------------------------------
// 15-min Up/Down markets (KXSOL15M, KXXRP15M, KXETH15M, KXBTC15M) settle based
// on whether price is higher/lower than it was 15min ago. The edge is MOMENTUM:
// crypto price momentum is well documented — a coin moving up tends to continue
// for 1-2 candles (15-30min). We also use RSI extremes for contrarian signals.
//
// PRICE HISTORY: We store last 4 price snapshots per coin (1 per scan ~15s each).
// After 4 snapshots we have ~60s of history. We use 15min-ago estimate via Binance
// kline (candlestick) API which gives us the open price of the current 15min candle.
//
// SIGNAL LOGIC:
// - MOMENTUM: If coin moved >1% in last 15min → bet same direction (trend following)
// - STRONG MOMENTUM: >2% move → higher confidence
// - RSI EXTREME: RSI >75 → bet DOWN (overbought). RSI <25 → bet UP (oversold)
// - FLAT: <0.5% move → skip (no edge, coin flip)
// Edge comes from the well-documented short-term autocorrelation in crypto prices.

let _momentumCache = {}; // { coin: { prices: [{p, t}], rsi14: null, lastKlineAt: 0 } }

async function fetchMomentumSignal(coin) {
  const symbol = coin === 'btc' ? 'BTCUSDT' : coin === 'eth' ? 'ETHUSDT'
    : coin === 'sol' ? 'SOLUSDT' : coin === 'xrp' ? 'XRPUSDT' : null;
  if (!symbol) return null;

  const now = Date.now();
  if (!_momentumCache[coin]) _momentumCache[coin] = { klineOpen: null, klineAt: 0, rsi: null };
  const mc = _momentumCache[coin];

  // Fetch 15-min kline: gives open price of current 15min candle + last 14 candles for RSI
  // Only refresh every 60s to save API calls
  if (now - mc.klineAt > 60000) {
    try {
      // Binance klines: interval=15m, last 15 candles
      const r = await req(
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=15`,
        { method: 'GET', headers: {} }, 5000
      );
      if (r.status === 200 && Array.isArray(r.body) && r.body.length >= 2) {
        // Each candle: [openTime, open, high, low, close, volume, ...]
        const candles = r.body;
        const current = candles[candles.length - 1]; // current in-progress candle
        const prev    = candles[candles.length - 2]; // last completed candle
        mc.klineOpen    = parseFloat(current[1]); // open of current 15min window
        mc.prevClose    = parseFloat(prev[4]);    // close of previous candle
        mc.prevOpen     = parseFloat(prev[1]);    // open of previous candle
        mc.currentVol   = parseFloat(current[5]);
        mc.prevVol      = parseFloat(prev[5]);
        mc.klineAt      = now;

        // RSI-14 using last 14 completed candles
        const closes = candles.slice(0, 14).map(c => parseFloat(c[4]));
        let gains = 0, losses = 0;
        for (let i = 1; i < closes.length; i++) {
          const diff = closes[i] - closes[i-1];
          if (diff > 0) gains += diff; else losses += Math.abs(diff);
        }
        const avgGain = gains / 13, avgLoss = losses / 13;
        mc.rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
        log(`Momentum [${coin.toUpperCase()}]: klineOpen=$${mc.klineOpen?.toFixed(4)} prevClose=$${mc.prevClose?.toFixed(4)} RSI=${mc.rsi?.toFixed(1)} vol=${mc.currentVol?.toFixed(0)}`);
      }
    } catch(e) { log(`Momentum fetch [${coin}]: ${e.message}`, 'WARN'); }
  }

  return mc;
}

async function getMomentumSignalForMarket(coin, currentPrice) {
  const mc = await fetchMomentumSignal(coin);
  if (!mc || !mc.klineOpen || !currentPrice) return null;

  const klineOpen = mc.klineOpen;
  const moveInCurrentWindow = (currentPrice - klineOpen) / klineOpen;
  const prevCandleMove = mc.prevClose && mc.prevOpen
    ? (mc.prevClose - mc.prevOpen) / mc.prevOpen : 0;
  const rsi = mc.rsi;
  const volRatio = mc.prevVol > 0 ? (mc.currentVol / mc.prevVol) : 1;

  let direction = null;
  let confidence = 0;
  let reason = '';

  // --- RSI EXTREMES: strongest contrarian signal ---
  if (rsi !== null && rsi > 75) {
    direction = 'NO';
    confidence = rsi > 85 ? 0.83 : rsi > 80 ? 0.79 : 0.75;
    reason = `RSI ${rsi.toFixed(0)} overbought → SHORT`;
  } else if (rsi !== null && rsi < 25) {
    direction = 'YES';
    confidence = rsi < 15 ? 0.83 : rsi < 20 ? 0.79 : 0.75;
    reason = `RSI ${rsi.toFixed(0)} oversold → LONG`;

  // --- STRONG MOMENTUM: trend following ---
  } else if (moveInCurrentWindow >= 0.020) {
    direction = 'YES';
    confidence = moveInCurrentWindow >= 0.035 ? 0.83 : moveInCurrentWindow >= 0.025 ? 0.79 : 0.75;
    reason = `Strong UP +${(moveInCurrentWindow*100).toFixed(2)}%`;
  } else if (moveInCurrentWindow <= -0.020) {
    direction = 'NO';
    confidence = moveInCurrentWindow <= -0.035 ? 0.83 : moveInCurrentWindow <= -0.025 ? 0.79 : 0.75;
    reason = `Strong DOWN ${(moveInCurrentWindow*100).toFixed(2)}%`;

  // --- MODERATE MOMENTUM + prev candle confirmation ---
  } else if (moveInCurrentWindow >= 0.010 && prevCandleMove >= 0.006) {
    direction = 'YES';
    confidence = 0.74;
    reason = `UP momentum +${(moveInCurrentWindow*100).toFixed(2)}% (prev +${(prevCandleMove*100).toFixed(2)}%)`;
  } else if (moveInCurrentWindow <= -0.010 && prevCandleMove <= -0.006) {
    direction = 'NO';
    confidence = 0.74;
    reason = `DOWN momentum ${(moveInCurrentWindow*100).toFixed(2)}% (prev ${(prevCandleMove*100).toFixed(2)}%)`;

  // --- VOLUME SURGE confirmation even with small move ---
  } else if (Math.abs(moveInCurrentWindow) >= 0.007 && volRatio >= 1.8) {
    direction = moveInCurrentWindow > 0 ? 'YES' : 'NO';
    confidence = 0.73;
    reason = `Volume surge ${volRatio.toFixed(1)}x + ${(moveInCurrentWindow*100).toFixed(2)}% move`;

  } else {
    log(`Momentum [${coin.toUpperCase()}]: flat move ${(moveInCurrentWindow*100).toFixed(2)}%, RSI ${rsi?.toFixed(0)} — skip`);
    return null;
  }

  // Minimum confidence gate — phase.minProb in SEED is 0.72, so 0.73+ passes
  log(`⚡ Momentum [${coin.toUpperCase()}]: ${direction} ${(confidence*100).toFixed(0)}% | ${reason}`);
  return { direction, confidence, reason, rsi, moveInCurrentWindow, volRatio };
}
// Handles: 15-min markets (fastest compounding), 1-hour markets, sub-3h markets.
// Confidence curve is time-aware: 15-min needs bigger gap than 1-hour.
// --- LIVE PRICE UPDATER: refresh currentPrice on open positions ---------------
// Called each scan. Crypto positions updated from CoinGecko (free, instant).
// Sports/other positions updated from Kalshi market endpoint (1 call per position).
async function updateOpenPositionPrices(livePrices) {
  if (S.openPositions.length === 0) return;
  for (const pos of S.openPositions) {
    try {
      const isBTC = /kxbtc/i.test(pos.ticker);
      const isETH = /kxeth/i.test(pos.ticker);
      const isSOL = /kxsol/i.test(pos.ticker);

      if ((isBTC || isETH || isSOL) && livePrices) {
        // Parse strike from ticker to compute implied market price
        const liveP = isBTC ? livePrices.btc : isETH ? livePrices.eth : livePrices.sol;
        const tMatch = pos.ticker.match(/[-_]T([\d]+\.?[\d]*)(?:[_-]|$)/i);
        const titleMatch = pos.ticker.match(/(\d{4,7})$/);
        const strike = tMatch ? parseFloat(tMatch[1]) : titleMatch ? parseFloat(titleMatch[1]) : null;
        if (liveP && strike) {
          const gap = Math.abs(liveP - strike) / liveP;
          // Implied probability price above strike: logistic curve on gap
          const pAbove = Math.min(0.97, Math.max(0.03, 0.5 + Math.tanh(gap * 20) * 0.47));
          const impliedYes = Math.round((liveP > strike ? pAbove : 1 - pAbove) * 100);
          pos.currentPrice = pos.side === 'YES' ? impliedYes : 100 - impliedYes;
          pos.liveUnderlying = liveP;
        }
      }
      // Mark position age for dashboard
      if (!pos.openedAt) pos.openedAt = Date.now() - 3600000;
    } catch(e) { /* silent — price update is non-critical */ }
  }
}

async function runCryptoFastPath(topMarkets) {
  if (S.openPositions.length >= dynamicMaxPos()) return 0;

  const prices = await fetchLivePrices();
  await updateOpenPositionPrices(prices);
  if (!prices.btc && !prices.eth) { log('FastPath: no prices — skip'); return 0; }

  const phase = getPhase();
  const heldSet = new Set(S.openPositions.map(p => p.ticker));
  let filled = 0;

  const allCryptoPool = (S._allScoredCrypto || topMarkets).filter(
    m => m.hoursLeft < 4.0 && m.hoursLeft > 0.08 && !heldSet.has(m.ticker)
  );
  // Sort: 15-min first (fastest flywheel), then hourly, then sub-4h
  const cryptoMarkets = allCryptoPool.sort((a, b) => a.hoursLeft - b.hoursLeft);

  for (const m of cryptoMarkets) {
    if (S.openPositions.length >= dynamicMaxPos()) break;

    const isBTC = /kxbtc/i.test(m.ticker);
    const isETH = /kxeth/i.test(m.ticker);
    const isSOL = /kxsol/i.test(m.ticker);
    const isXRP = /kxxrp/i.test(m.ticker);
    const coin  = isBTC ? 'btc' : isETH ? 'eth' : isSOL ? 'sol' : isXRP ? 'xrp' : null;
    const livePrice = coin ? prices[coin] : null;
    if (!livePrice || !coin) { log(`FastPath: no price for ${m.ticker}`); continue; }

    const is15Min = /15M|15MIN/i.test(m.ticker) || m.hoursLeft < 0.30;

    // ================================================================
    // PATH A: UP/DOWN DIRECTIONAL 15-MIN MARKETS (SOL, XRP, ETH, BTC)
    // "Will SOL be higher in 15 min?" — edge = MOMENTUM + RSI
    // ================================================================
    const titleLower = (m.title || '').toLowerCase();
    const isUpDownMarket = titleLower.includes('up or down') || titleLower.includes('up in') ||
      titleLower.includes('down in') || /kxsol15m|kxxrp15m|kxeth15m|kxbtc15m/i.test(m.ticker);

    if (isUpDownMarket) {
      // Get momentum signal for this coin
      const momSig = await getMomentumSignalForMarket(coin, livePrice);
      if (!momSig) continue; // no edge — flat market, skip

      const { direction, confidence, reason } = momSig;
      if (confidence < phase.minProb) {
        log(`FastPath 15min momentum: ${m.ticker} conf ${(confidence*100).toFixed(0)}% < phase min — skip`);
        continue;
      }

      // Get market price for the signaled direction
      const sidePrice = direction === 'YES'
        ? m.yesAsk
        : Math.max(0.05, 1 - (m.yesBid || (1 - m.yesAsk)));
      if (sidePrice <= 0.05 || sidePrice >= 0.95) continue;

      const netPayout = ((1 - sidePrice) / sidePrice) * (1 - KALSHI_FEE);
      if (netPayout < 0.50) { // minimum 50% return on win
        log(`FastPath 15min: ${m.ticker} payout ${netPayout.toFixed(2)}x too low — skip`);
        continue;
      }

      // For Up/Down markets: edge = confidence advantage over 50% base rate
      // A 50c market with 75% confidence = 25% edge. Standard formula works fine.
      // No minEdge check here — momentum edge is in confidence itself, not price spread.
      const edge = confidence - sidePrice;

      const coinLabel = isBTC?'BTC':isETH?'ETH':isSOL?'SOL':'XRP';
      const sig = {
        ticker: m.ticker, side: direction, confidence, edge,
        marketPrice: sidePrice,
        feeAdjustedEdge: edge - (sidePrice * KALSHI_FEE),
        netPayoutRatio: netPayout,
        hoursToClose: m.hoursLeft,
        source: 'fastpath',
        isFavorite: false,
        reasoning: `⚡ 15min Momentum [${coinLabel}]: ${reason} | ${direction} @${(sidePrice*100).toFixed(1)}c = ${netPayout.toFixed(2)}x | conf=${(confidence*100).toFixed(0)}%`,
      };

      log(`⚡ FastPath 15min MOMENTUM: ${m.ticker} ${direction} | ${(confidence*100).toFixed(0)}% | ${netPayout.toFixed(2)}x | ${reason}`);
      tg(`⚡ <b>15min Momentum [$0 AI]</b>\n${m.ticker} ${direction}\n${reason}\n${(confidence*100).toFixed(0)}% conf | ${netPayout.toFixed(2)}x\n${coinLabel}=$${livePrice.toLocaleString()}`);
      await executeTrade(sig);
      filled++;
      continue;
    }

    // ================================================================
    // PATH B: FIXED-STRIKE MARKETS (KXBTCH, KXETHH, KXBTCD closing soon)
    // "Will BTC be above $71,000 at 5pm?" — edge = PRICE GAP
    // ================================================================
    let strike = null;
    const tMatch = m.ticker.match(/[-_]T([\d]+\.?[\d]*)(?:[_-]|$)/i);
    if (tMatch) strike = parseFloat(tMatch[1]);
    if (!strike && m.title) {
      const clean = m.title.replace(/,/g, '');
      const dollarMatch = clean.match(/\$([\d]+\.?[\d]*)/);
      if (dollarMatch) { const p = parseFloat(dollarMatch[1]); if (p > 0) strike = p; }
    }
    if (!strike) {
      const numMatch = m.ticker.match(/[-_]([\d]{4,5})(?:[-_]|$)/i);
      if (numMatch) {
        const c = parseFloat(numMatch[1]);
        const looksLikeDate = c > 10000 && c < 99999 && m.ticker.includes('15M') && (isSOL || isXRP);
        if (!looksLikeDate) strike = c;
      }
    }
    if (!strike) {
      const decMatch = m.ticker.match(/[-_T]([\d]+\.[\d]+)(?:[-_]|$)/i);
      if (decMatch) strike = parseFloat(decMatch[1]);
    }
    if (!strike || strike <= 0) { log(`FastPath fixed-strike: can't parse strike for ${m.ticker}`); continue; }

    const maxStrike = isBTC ? 200000 : isETH ? 10000 : isSOL ? 2000 : isXRP ? 10 : 200000;
    const minStrike = isBTC ? 10000  : isETH ? 100   : isSOL ? 0.50 : isXRP ? 0.001 : 0.001;
    if (strike > maxStrike || strike < minStrike) {
      log(`FastPath: ${m.ticker} strike=${strike} out of range — skip`); continue;
    }

    const gap = Math.abs(livePrice - strike);
    const gapPct = gap / livePrice;

    // Fixed-strike needs REAL gap — if strike ≈ live price it's probably a rolling market
    if (gapPct < 0.03) {
      log(`FastPath fixed-strike: ${m.ticker} gap ${(gapPct*100).toFixed(2)}% < 3% — near current price, skip`);
      continue;
    }

    let confidence;
    if (is15Min) {
      if (gapPct >= 0.12) confidence = 0.96;
      else if (gapPct >= 0.07) confidence = 0.93;
      else if (gapPct >= 0.05) confidence = 0.88;
      else { log(`FastPath 15min fixed: ${m.ticker} gap ${(gapPct*100).toFixed(2)}% < 5% — skip`); continue; }
    } else if (m.hoursLeft < 1.5) {
      if (gapPct >= 0.12) confidence = 0.96;
      else if (gapPct >= 0.08) confidence = 0.93;
      else if (gapPct >= 0.05) confidence = 0.88;
      else if (gapPct >= 0.03) confidence = 0.82;
      else { log(`FastPath hourly: ${m.ticker} gap ${(gapPct*100).toFixed(2)}% < 3% — skip`); continue; }
    } else {
      if (gapPct >= 0.10) confidence = 0.94;
      else if (gapPct >= 0.07) confidence = 0.89;
      else if (gapPct >= 0.05) confidence = 0.83;
      else { log(`FastPath sub4h: ${m.ticker} gap ${(gapPct*100).toFixed(2)}% < 5% — skip`); continue; }
    }

    if (gapPct >= 0.15) confidence = Math.min(0.97, confidence + 0.04);
    if (m.hoursLeft < 0.12) confidence = Math.min(confidence, 0.72);

    const priceAbove = livePrice > strike;
    const suggestedSide = priceAbove ? 'YES' : 'NO';
    if (suggestedSide === 'YES' && !priceAbove) continue;
    if (suggestedSide === 'NO' && priceAbove) continue;

    const sidePrice = suggestedSide === 'YES'
      ? m.yesAsk
      : Math.max(0.05, 1 - (m.yesBid || (1 - m.yesAsk)));
    if (sidePrice <= 0.05 || sidePrice >= 0.95) continue;
    const netPayout = ((1 - sidePrice) / sidePrice) * (1 - KALSHI_FEE);
    const edge = confidence - sidePrice;

    const isUnderdog = sidePrice <= 0.38;
    const isFavorite15min = is15Min && sidePrice >= 0.55 && sidePrice <= 0.92 && confidence >= 0.88 && gapPct >= 0.05;
    const isFavoriteHourly = !is15Min && sidePrice >= 0.55 && sidePrice <= 0.88 && confidence >= 0.83;
    const isFavorite = isFavorite15min || isFavoriteHourly;

    const fastPathMinConf = isUnderdog ? Math.max(phase.minProb, 0.68) : 0.80;
    if (confidence < fastPathMinConf) { log(`FastPath: ${m.ticker} conf too low`); continue; }
    if (!isUnderdog && !isFavorite) { log(`FastPath: ${m.ticker} price zone mismatch`); continue; }
    if (isUnderdog && edge < phase.minEdge) { log(`FastPath: ${m.ticker} edge too low`); continue; }

    const minPayout = isUnderdog ? (is15Min ? 1.5 : (m.hoursLeft < 2.0 ? 1.2 : 1.8)) : 0.12;
    if (netPayout < minPayout) { log(`FastPath: ${m.ticker} payout ${netPayout.toFixed(2)}x < ${minPayout}x`); continue; }
    if (isFavorite && !isUnderdog) {
      const ev = confidence * netPayout - (1 - confidence);
      if (ev < 0.05) { log(`FastPath: ${m.ticker} favorite EV too low`); continue; }
    }

    const coinLabel = isBTC?'BTC':isETH?'ETH':isSOL?'SOL':'XRP';
    const windowLabel = is15Min ? '15min' : m.hoursLeft < 1.5 ? '1hr' : `${m.hoursLeft.toFixed(1)}h`;
    const sig = {
      ticker: m.ticker, side: suggestedSide, confidence, edge,
      marketPrice: sidePrice,
      feeAdjustedEdge: edge - (sidePrice * KALSHI_FEE),
      netPayoutRatio: netPayout, hoursToClose: m.hoursLeft,
      source: 'fastpath', strike,
      isFavorite: isFavorite && !isUnderdog,
      reasoning: `⚡ FastPath [${windowLabel}] ${coinLabel}=$${livePrice.toLocaleString()} vs strike $${strike.toLocaleString()} | gap=${(gapPct*100).toFixed(2)}% | ${suggestedSide} @${(sidePrice*100).toFixed(1)}c = ${netPayout.toFixed(2)}x | conf=${(confidence*100).toFixed(0)}%`,
    };

    log(`⚡ FastPath [${windowLabel}] fixed-strike: ${m.ticker} ${suggestedSide} | ${(confidence*100).toFixed(0)}% conf | ${netPayout.toFixed(2)}x | gap=${(gapPct*100).toFixed(2)}%`);
    tg(`⚡ <b>FastPath [${windowLabel}] [$0 AI]</b>\n${m.ticker} ${suggestedSide}\nGap: ${(gapPct*100).toFixed(2)}% | ${(confidence*100).toFixed(0)}% conf | ${netPayout.toFixed(2)}x\n${coinLabel}=$${livePrice.toLocaleString()} vs strike $${strike.toLocaleString()}`);
    await executeTrade(sig);
    filled++;
  }

  if (filled > 0) log(`⚡ FastPath v16: filled ${filled} position(s) — $0 AI cost`);
  return filled;
}

// --- CLAUDE BRAIN (fires only when math scanner finds high-value targets) --
async function runBrain(topMarkets) {
  if (!CFG.claudeKey) { log('No Claude key', 'WARN'); return; }
  if (topMarkets.length === 0) { log('Brain skipped: no markets to analyze'); return; }

  // Hard cap: if at or above position limit, skip signal generation entirely
  if (S.openPositions.length >= dynamicMaxPos()) {
    log(`Brain: at position cap (${S.openPositions.length}/${dynamicMaxPos()}) -- skipping signal generation`);
    return;
  }

  S.brainCount++;
  S.totalBrainCount = (S.totalBrainCount || 0) + 1;
  log(`Brain #${S.brainCount} (${S.totalBrainCount} total) firing on ${Math.min(topMarkets.length, 6)} markets`);

  // Track estimated API spend (Haiku: $0.08/MTok in, $0.40/MTok out + $0.01/search)
  // Rough per-call estimate with 3 searches max: ~$0.04
  S.estimatedApiSpend = (S.estimatedApiSpend || 0) + 0.04; // Haiku ~$0.04/call (was $0.28 Sonnet)
  S.totalApiSpend = S.estimatedApiSpend; // keep alias in sync

  const _heldTickers = S.openPositions.map(p => p.ticker);
  const _heldStr = _heldTickers.length ? _heldTickers.join(', ') : 'none';
  const _slots = Math.max(0, dynamicMaxPos() - S.openPositions.length);
  const phase = getPhase();
  const _bal = S.realBalance || S.balance;

  // Use shared price cache (Binance → Kraken → CoinGecko, 30s cache)
  let _priceCtx = '';
  let prices = {};
  try {
    prices = await fetchLivePrices();
    const _b = prices.btc, _e = prices.eth, _s = prices.sol, _x = prices.xrp;
    if (_b || _e) {
      _priceCtx = `LIVE PRICES @ ${new Date().toLocaleString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'})} ET: BTC=${_b ? '$'+_b.toLocaleString() : 'N/A'} ETH=${_e ? '$'+_e.toLocaleString() : 'N/A'} SOL=${_s ? '$'+_s.toFixed(2) : 'N/A'} XRP=${_x ? '$'+_x.toFixed(4) : 'N/A'} — USE THESE FOR CRYPTO MATH`;
      log(`Brain prices: BTC=$${_b} ETH=$${_e} SOL=$${_s}`);
    } else {
      _priceCtx = 'PRICES UNAVAILABLE — use 1 web search to find current BTC and ETH prices before analyzing crypto markets';
      log('Brain: no prices available — brain will need to search', 'WARN');
    }
  } catch(_err) {
    _priceCtx = 'PRICES UNAVAILABLE — use 1 web search to find current BTC and ETH prices';
  }

  // Inject live momentum data into brain prompt so it has real signal data
  let _momentumCtx = '';
  try {
    const coins = ['sol','xrp','eth','btc'];
    const snapshots = await Promise.allSettled(coins.map(c => fetchMomentumSignal(c)));
    const parts = [];
    snapshots.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value?.klineOpen) {
        const mc = r.value;
        const lp = prices[coins[i]];
        const mv = lp && mc.klineOpen ? ((lp - mc.klineOpen) / mc.klineOpen * 100).toFixed(2) : '?';
        parts.push(`${coins[i].toUpperCase()}: move=${mv}% RSI=${mc.rsi?.toFixed(0)||'?'} vol=${mc.currentVol?.toFixed(0)||'?'}`);
      }
    });
    if (parts.length) _momentumCtx = '\nLIVE MOMENTUM: ' + parts.join(' | ');
  } catch(e) { /* non-critical */ }

  const prompt = `You are a prediction market trader. Respond ONLY with valid JSON starting with { and ending with }.

LIVE PRICES: ${_priceCtx||'UNAVAILABLE - search for BTC/ETH price'}${_momentumCtx}
TIME: ${new Date().toLocaleString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',weekday:'short'})} ET
HELD (do not trade these): ${_heldStr}
BALANCE: $${_bal.toFixed(2)} | Cash: $${(S.availableCash||0).toFixed(2)} | Slots: ${_slots} open | Phase: ${phase.name}

MARKETS:
${JSON.stringify(topMarkets.slice(0,15).map(m=>({ticker:m.ticker,title:(m.title||'').slice(0,70),yesAsk:+(m.yesAsk*100).toFixed(0),yesBid:+((m.yesBid||0)*100).toFixed(0),netPayout:+(m.netPayoutRatio||((1-m.yesAsk)/m.yesAsk*0.955)).toFixed(2),suggestedSide:m.suggestedSide||'YES',hoursLeft:+m.hoursLeft.toFixed(2),held:_heldTickers.includes(m.ticker)})))}

MISSION: Fill ALL ${_slots} slot(s). NEVER leave slots empty — every empty slot is lost compounding.

NEVER TRADE:
- Weather: KXHIGH, KXLOW, any temperature market (settles in days, no edge)
- Any ticker in HELD list
- Anything with confidence below 72%

STEP 1 — 15-MIN SOL/XRP/ETH/BTC UP/DOWN (HIGHEST PRIORITY — fills slots fastest):
Use the LIVE MOMENTUM data above. These ask "will price go UP or DOWN in next 15min?"
SIGNAL YES (UP) if: move > +1.0% in current window OR RSI < 28 (oversold reversal)
SIGNAL NO (DOWN) if: move < -1.0% in current window OR RSI > 72 (overbought reversal)
Skip only if move is flat (-0.5% to +0.5%) AND RSI is 40-60 (true coin flip)
Confidence: |move| 1-2%=75%, 2-3%=78%, >3%=82%, RSI extreme=80%
These settle in 15min. ALWAYS fill slots here first if momentum data shows clear direction.

STEP 2 — FIXED-STRIKE HOURLY CRYPTO (KXBTCH, KXETHH):
Signal if gap >= 5% between live price and strike in correct direction.
YES if price > strike by 5%+. NO if price < strike by 5%+.
Confidence: 5-8% gap=84%, 8-12%=90%, >12%=94%

STEP 3 — SPORTS LIVE (1 search max):
Search "[team] vs [team] score". Signal decisive leads Q4/final period.
netPayout >= 2.0, confidence >= 75%

STEP 4 — EVENT MARKETS (TSA, Billboard, elections):
Signal if netPayout >= 5x AND confidence >= 75% after verifying with 1 search.

Respond ONLY with valid JSON:
{"signals":[{"ticker":"KXSOL15M-26APR2345","side":"YES","confidence":0.78,"edge":0.28,"marketPrice":0.50,"feeAdjustedEdge":0.25,"netPayoutRatio":0.91,"hoursToClose":0.25,"reasoning":"SOL move +1.8% current 15min window, RSI=38 neutral-bullish, trend UP"}],"marketSummary":"","skipReason":""}`;



  try {
    const r = await req('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CFG.claudeKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: `You are a prediction market trader. Goal: compound portfolio to $500K via sub-3h trades.

The user message contains LIVE PRICES at the top. Use them directly for crypto math — no search needed for crypto.
Use web search ONLY for sports scores or weather forecasts.

Output ONLY valid JSON. Start with { end with }. No markdown. No explanation outside JSON.`,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }], // 3 searches max — save cost, crypto needs 0
        messages: [{ role: 'user', content: prompt }],
      },
    }, 120000);

    if (r.status !== 200) {
      log(`Brain API error ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`, 'WARN');
      return;
    }

    const hasContent = (r.body.content || []).some(b => b.type === 'text');
    if (!hasContent) { log('Brain: no text response', 'WARN'); return; }

    let parsed;
    try {
      // Web search responses have multiple content blocks -- find the last text block
      // which contains the final JSON output after search results are processed
      const allTextBlocks = (r.body.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text);

      let jsonStr = null;
      // Try each text block from last to first, find one with valid JSON
      for (let i = allTextBlocks.length - 1; i >= 0; i--) {
        const raw = allTextBlocks[i];
        // Find outermost JSON object
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start !== -1 && end > start) {
          try {
            const candidate = raw.slice(start, end + 1);
            parsed = JSON.parse(candidate);
            jsonStr = candidate;
            break;
          } catch(e2) { continue; }
        }
      }

      if (!parsed) {
        log('Brain: no valid JSON in any text block. Blocks: ' + allTextBlocks.length +
          ' | last: ' + (allTextBlocks[allTextBlocks.length-1]||'').slice(0,80), 'WARN');
        return;
      }
    } catch(e) {
      log('Brain parse error: ' + e.message, 'WARN');
      return;
    }

    S.lastBrainAt = Date.now();
    S.signals = (parsed.signals || parsed.OUT?.signals || []).map(s => {
      const mktP = s.marketPrice || (s.side === 'YES' ? s.confidence : 1 - s.confidence);
      const tradePrice = s.side === 'YES' ? mktP : (1 - mktP);
      // Kelly display: use actual side price (marketPrice), not YES-equivalent
      const sideP = Math.min(0.88, Math.max(0.12, s.marketPrice || 0.5));
      const kSize = kellySize(s.confidence, sideP);
      return {
        ...s,
        ts: Date.now(),
        status: 'fresh',
        kellySize: parseFloat(kSize.toFixed(2)),
      };
    });

    const _brainSummary = parsed.marketSummary || parsed.summary || '';
    const _brainSkip = parsed.skipReason || parsed.skip || '';
    log(`Brain #${S.brainCount}: ${S.signals.length} signals | ${_brainSummary}`);
    // Telegram on every brain fire so you see what's happening
    if (S.signals.length === 0) {
      tg(`🔍 <b>Brain #${S.brainCount}</b> — No signals\n${_brainSkip || _brainSummary || 'No edge found'}\nCash: $${S.availableCash.toFixed(2)} | Open: ${S.openPositions.length}/${dynamicMaxPos()}`);
    }

    if (S.signals.length > 0) {
      const sigText = S.signals.map(s => {
        const mktP = s.marketPrice || 0.5;
        const payoutRatio = mktP > 0 ? (((1 - mktP) / mktP) * 0.955).toFixed(2) : '?';
        return `📊 ${s.ticker} ${s.side} | ${(s.confidence*100).toFixed(0)}% conf | edge ${(s.edge*100).toFixed(1)}% | $${(s.kellySize||0).toFixed(2)} | ${payoutRatio}x | ${s.reasoning}`;
      }).join('\n');

      tg(`🧠 <b>Brain #${S.brainCount}</b>\n${sigText}\n\n<i>${_brainSummary}</i>`);

      // Execute trades -- use live PHASE thresholds, not static CFG values
      // CRITICAL: recheck slot count BEFORE each trade -- brain may return multiple
      // signals but we can only fill remaining slots, not all of them at once.
      const execPhase = getPhase();
      for (const sig of S.signals) {
        // Hard slot recheck on every iteration — raw count, no filtering
        const slotsUsed = S.openPositions.length;
        if (slotsUsed >= dynamicMaxPos()) {
          log(`Signal loop: at cap (${slotsUsed}/${dynamicMaxPos()}) -- stopping`);
          break;
        }
        // v15: Use phase.minProb directly (0.55-0.72 in SEED). 
        // Old hardcoded max(phase.minProb, 0.75) was blocking 75% conf signals in SEED (minProb=0.72).
        const meetsConf = sig.confidence >= execPhase.minProb;
        // Edge calculation: brain often returns wrong edge for NO-side trades.
        // Server-side recalculation: edge = confidence - tradePrice (from the BET side)
        // For NO: tradePrice_for_NO = 1 - sig.marketPrice (the actual price paid for NO contracts)
        const _mktP = sig.marketPrice || 0.5;
        const _tradeP_correct = sig.side === 'NO' ? (1 - _mktP) : _mktP; // actual price for the side
        const _serverEdge = sig.confidence - _tradeP_correct;
        const _brainEdge = sig.feeAdjustedEdge || sig.edge || 0;
        // Use the larger of: brain edge OR correct server edge (protects against brain miscalc)
        const _effectiveEdge = Math.max(_brainEdge, _serverEdge);
        // v18: 15-min momentum series bypass minEdge — edge is in win rate not price spread
        const _is15MinMom = /kxsol15m|kxxrp15m|kxeth15m|kxbtc15m/i.test(sig.ticker);
        const meetsEdge = _is15MinMom || (_effectiveEdge >= execPhase.minEdge);
        if (meetsConf && meetsEdge) {
          await executeTrade(sig);
        } else {
          log(`Signal skip ${sig.ticker}: conf=${(sig.confidence*100).toFixed(0)}%(need ${(execPhase.minProb*100).toFixed(0)}%) edge=${(_effectiveEdge*100).toFixed(1)}%(need ${(execPhase.minEdge*100).toFixed(0)}%) [brain:${(_brainEdge*100).toFixed(1)}% server:${(_serverEdge*100).toFixed(1)}%]`);
        }
      }
    } else {
      log(`Brain #${S.brainCount} skip: ${_brainSkip || _brainSummary || 'no edge found'}`);
    }

    saveState();
  } catch(e) {
    log('Brain error: ' + e.message, 'ERROR');
    S.lastErr = e.message;
  }
}

// --- POSITION MONITOR BRAIN (fires when slots full -- looks for early exits) -
async function runPositionMonitor() {
  if (!CFG.claudeKey || S.openPositions.length === 0) return;
  if (CFG.dryRun) return; // paper mode: positions resolve automatically
  
  // EARLY EXIT CHECK: Flag long-dated positions blocking compounding
  const longDatedBlocking = S.openPositions.filter(p => {
    const closeMatch = p.ticker.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/);
    if (!closeMatch) return false;
    // Check if this is a multi-week position
    return p.ticker.includes('GDP') || p.ticker.includes('PCE') || 
           p.ticker.includes('UNEMPLOYMENT') || p.ticker.includes('JOBS');
  });
  if (longDatedBlocking.length > 0 && S.openPositions.length >= dynamicMaxPos()) {
    log('Monitor: ' + longDatedBlocking.length + ' long-dated positions blocking slots: ' + longDatedBlocking.map(p=>p.ticker).join(', '));
  }

  // COST GUARD: only monitor positions that have been open 3+ hours
  // New positions don't need monitoring -- they just opened
  const stalePositions = S.openPositions.filter(p =>
    p.openedAt && (Date.now() - p.openedAt) > 3 * 3600000
  );
  if (stalePositions.length === 0) {
    log(`Monitor skipped: all ${S.openPositions.length} positions <3h old`);
    return;
  }
  // SEED/SPROUT: our trades target <3h resolution. The monitor only fires when
  // positions are >3h old — meaning they're already near/past resolution.
  // Skip the API call and just let resolvePositions() handle them naturally.
  const phase = getPhase();
  if ((phase.name === 'SEED' || phase.name === 'SPROUT') && stalePositions.every(p => p.hoursLeft < 1)) {
    log('Monitor skipped in SEED/SPROUT — stale positions near resolution, letting resolvePositions handle');
    return;
  }
  log(`Monitor checking ${stalePositions.length} positions open 3h+`);
  S.estimatedApiSpend = (S.estimatedApiSpend || 0) + 0.01; // Haiku monitor ~$0.01/call
  S.totalApiSpend = S.estimatedApiSpend;

  const positionList = stalePositions.map(p => ({
    ticker: p.ticker,
    side: p.side,
    entryPrice: p.entryPrice,
    contracts: p.contracts,
    cost: p.cost,
    hoursOpen: Math.round((Date.now() - p.openedAt) / 3600000),
    reasoning: p.reasoning,
  }));

  const prompt = `{"task":"position_exit_monitor","context":{"MISSION":"Protect and grow capital -- identify any open position that should be exited NOW to prevent loss or lock in profit","balance":${(S.realBalance||S.balance).toFixed(2)},"openPositions":${JSON.stringify(positionList)}},"instructions":"1) Use web search to check current status of each open position's underlying event. 2) Has the event already resolved? Is it trending against our position? Is there breaking news changing the outcome? 3) Only flag positions that clearly should exit NOW -- not normal uncertainty. 4) Output required_json_format only.","required_json_format":{"exitNow":[{"ticker":"string","reason":"one sentence why exit now"}],"holdAll":true,"summary":"one sentence"}}`;

  try {
    const r = await req('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CFG.claudeKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: 'You are a position risk monitor. Use web search ONLY if a position is >6h old or you suspect an event already resolved. Output ONLY valid JSON.',
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
        messages: [{ role: 'user', content: prompt }],
      },
    }, 90000);

    if (r.status !== 200) return;

    const textBlocks = (r.body.content || []).filter(b => b.type === 'text').map(b => b.text);
    let parsed = null;
    for (let i = textBlocks.length - 1; i >= 0; i--) {
      const s = textBlocks[i].indexOf('{'), e = textBlocks[i].lastIndexOf('}');
      if (s !== -1 && e > s) {
        try { parsed = JSON.parse(textBlocks[i].slice(s, e + 1)); break; } catch {}
      }
    }
    if (!parsed) return;

    if (parsed.exitNow && parsed.exitNow.length > 0) {
      for (const exit of parsed.exitNow) {
        log(`🚨 Monitor: EXIT recommended for ${exit.ticker} -- ${exit.reason}`);
        tg(`🚨 <b>Position Monitor Alert</b>\nExit: ${exit.ticker}\n${exit.reason}`);
        // Mark position for priority resolution check
        const pos = S.openPositions.find(p => p.ticker === exit.ticker);
        if (pos) pos.monitorFlagged = true;
      }
      await resolvePositions(); // trigger immediate resolution check
    } else {
      log(`📡 Monitor: all ${S.openPositions.length} positions holding -- ${parsed.summary || ''}`);
    }
  } catch(e) {
    log('Position monitor error: ' + e.message, 'WARN');
  }
}

// --- KELLY SIZING (fee-aware) -----------------------------------------------
// Kalshi charges ~4.5% on winning trades. Model this into Kelly to avoid
// systematically overbetting due to fee drag.
// v12 Kelly: confidence-tiered by source
// FastPath 88%+ = full phase.kelly fraction (aggressive — edge is mathematical)
// Brain / lower conf = 40% fraction (conservative — LLM less reliable than math)
function kellySize(prob, price, source, sig) {
  const phase = getPhase();
  const q = 1 - prob;
  const b = (1 - price) / price;
  const netWin = b * (1 - KALSHI_FEE);
  const kelly = (netWin * prob - q) / netWin;
  if (kelly <= 0) return 0;

  const isHighConfFastPath = (source === 'fastpath' || source === 'sports_fastpath') && prob >= 0.88;
  const isFavoriteTrade = sig && sig.isFavorite;
  // Sizing tiers v15:
  // - FastPath 88%+ (math edge): full Kelly
  // - FastPath 15min favorite: 70% Kelly
  // - FastPath hourly favorite: 55% Kelly
  // - Brain signals: 60% Kelly (was 40% — produced sub-$0.50 bets on small balances)
  const is15MinFav = isFavoriteTrade && sig && (sig.hoursToClose || 0) < 0.30;
  const kellyFrac = (isFavoriteTrade && is15MinFav) ? phase.kelly * 0.70
    : isFavoriteTrade ? phase.kelly * 0.55
    : isHighConfFastPath ? phase.kelly
    : phase.kelly * 0.60;  // v15: was 0.40, now 0.60 so brain bets are large enough to execute
  const fracKelly = kelly * kellyFrac;

  const totalBal = Math.max(S.realBalance || 0, S.balance || 0);
  if (totalBal < 3.00) return 0;

  // v14 FIX: Always compute available cash from balance minus reserved orders.
  // Never return 0 just because availableCash field is stale.
  const _reserved = (S.restingOrders || []).reduce((s, o) => s + (o.reservedCash || 0), 0);
  const availCash = S.availableCash > 1 ? S.availableCash
    : Math.max(0, totalBal - _reserved - 0.50);
  if (availCash < 2.00) return 0;

  const rawBet = availCash * fracKelly;

  // 3 hard caps — most restrictive wins
  const capPct   = totalBal * phase.maxPct;
  const capDollar = (source === 'brain') ? phase.maxBetDollars * 0.40 : phase.maxBetDollars;
  const exposure  = S.openPositions.reduce((s, p) => s + (p.cost || 0), 0);
  const capExposure = Math.max(0, totalBal * phase.maxExposure - exposure);

  const bet = Math.min(rawBet, capPct, capDollar, capExposure, availCash * 0.85);
  return Math.max(0.50, bet);  // v15: $0.50 floor (was $1.00 — too high for 5c event markets)
}

// --- TRADE EXECUTION -------------------------------------------------------
async function executeTrade(sig) {
  // PRE-FLIGHT: check balance floor BEFORE syncing — fast reject if already too low
  // Floor is $2 — bot should trade as long as it has ANY meaningful cash.
  // The $5 floor was stopping trades when we had $22+ in open winning positions.
  const preBal = S.availableCash > 0 ? S.availableCash : (S.realBalance || S.balance);
  if (preBal <= 2.00 && !CFG.dryRun) {
    log(`Skip ${sig.ticker}: available cash $${preBal.toFixed(2)} at or below $2 floor — no new trades`);
    return;
  }
  // HARD GUARD: re-sync positions from Kalshi LIVE before every trade attempt.
  // Ensures we always have an accurate position count before deciding to trade.
  try { await syncPositions(); } catch(e) {
    log('Pre-trade sync failed — skipping trade to be safe: ' + e.message, 'WARN');
    return;
  }

  const maxPos = dynamicMaxPos();
  const hoursToClose = sig.hoursToClose || 999;
  const isLongDated = hoursToClose > 168; // >7 days
  // HARD CAP: ALL open positions count — no cost-based filtering.
  // Synced Kalshi positions have unreliable cost fields (derived from current price,
  // not fill price). The only safe cap is raw position count.
  const totalPosCount = S.openPositions.length;
  if (isLongDated && totalPosCount >= maxPos - 1) {
    log('Skip ' + sig.ticker + ': long-dated (' + hoursToClose.toFixed(0) + 'h) — reserving last slot for <24h trades');
    return;
  }
  // Slot cap logic:
  // 4th slot is available when:
  //   (a) Trade resolves in <1.5h (hourly/15min) — fast capital recycling, OR
  //   (b) Effective cash after this bet would still be > $5 floor with buffer
  const isVeryFast = (sig.hoursToClose || 999) < 1.5;
  const currentBal = S.realBalance || S.balance;
  const availCash = S.availableCash > 0 ? S.availableCash : currentBal;
  // Estimate bet size (Kelly will compute exact, use 30% of balance as safe estimate)
  const estimatedBet = Math.min(availCash * 0.30, 5.00);
  const cashAfterBet = availCash - estimatedBet;
  const floorSafe = cashAfterBet > 5.50; // stays above $5 floor with $0.50 buffer
  const effectiveMax = (isVeryFast || floorSafe) ? maxPos : Math.max(3, maxPos - 1);
  if (totalPosCount >= effectiveMax) {
    log(`Skip ${sig.ticker}: at position cap (${totalPosCount}/${effectiveMax}) [cash=$${availCash.toFixed(2)}, afterBet=$${cashAfterBet.toFixed(2)}, fast=${isVeryFast}]`);
    return;
  }
  if (S.openPositions.find(p => p.ticker === sig.ticker)) {
    log(`Skip ${sig.ticker}: already have position`);
    return;
  }
  // STRIKE DEDUP: don't hold same strike+direction on same coin (correlated loss risk)
  // e.g. BTC YES at $80k strike + BTC YES at $80k strike (diff ticker) = identical bet
  if (sig.strike && sig.side) {
    const dupStrike = S.openPositions.find(p => {
      if (!p.strike || p.side !== sig.side) return false;
      const sameDir = (p.side === sig.side);
      const sameCoin = (/kxbtc/i.test(p.ticker) && /kxbtc/i.test(sig.ticker)) ||
                       (/kxeth/i.test(p.ticker) && /kxeth/i.test(sig.ticker));
      const sameStrike = Math.abs(p.strike - sig.strike) / sig.strike < 0.005; // within 0.5%
      return sameDir && sameCoin && sameStrike;
    });
    if (dupStrike) {
      log(`Skip ${sig.ticker}: already hold same strike $${sig.strike} ${sig.side} on ${dupStrike.ticker}`);
      return;
    }
  }

  // -- CASH GUARD -- re-sync immediately before every order attempt --
  await syncBalance();
  await syncRestingOrders();
  // v14 FIX: If availableCash=0 but balance exists, compute directly from balance.
  // Never block a trade just because resting orders exist — compute properly.
  // reserved = sum of all resting order cash. available = balance - reserved.
  const _totalReserved = (S.restingOrders || []).reduce((s, o) => s + (o.reservedCash || 0), 0);
  const _rawBal = S.realBalance > 0 ? S.realBalance : S.balance;
  const effectiveCash = S.availableCash > 0 ? S.availableCash
    : Math.max(0, _rawBal - _totalReserved - 0.50); // 50c buffer
  if (effectiveCash < 2.00) {
    const reserved = _totalReserved;
    log(`Skip ${sig.ticker}: $${effectiveCash.toFixed(2)} effective cash ($${_rawBal.toFixed(2)} total, $${reserved.toFixed(2)} in ${S.restingOrders.length} resting orders)`);
    return;
  }

  // PHASE-DRIVEN GUARDS -- thresholds adapt as balance grows toward $500K
  const phase = getPhase();
  const bal = S.realBalance>0?S.realBalance:S.balance;
  // Use brain's marketPrice as the actual price to trade at
  // tradePrice kept for edge calculation only (YES-equivalent price for Kelly math)
  const mktP = sig.marketPrice || (sig.side === 'YES' ? sig.confidence : 1 - sig.confidence);
  const tradePrice = sig.side === 'YES' ? mktP : (1 - mktP); // YES-equiv, only for serverEdge fallback
  // Range check on actual side price (not YES-equivalent)
  // marketPrice = the actual price of the side being traded (25c for NO at 25c)
  // No conversion needed — brain reports the price you pay for that side
  const sidePriceActual = Math.max(0.01, Math.min(0.99, sig.marketPrice || 0.5));
  // v15: Allow 3c+ markets. 5c Billboard at 75% conf = 20x payout = exceptional EV.
  // Old 8c floor was blocking the best brain signals. Floor is now 3c.
  // Extreme longshots <3c are still banned (pure lottery tickets).
  if (sidePriceActual < 0.03) {
    log('Skip '+sig.ticker+': '+sig.side+' @'+(sidePriceActual*100).toFixed(1)+'c below 3c absolute floor — too speculative'); return;
  }
  if (sidePriceActual >= 0.94) {
    log('Skip '+sig.ticker+': '+sig.side+' @'+(sidePriceActual*100).toFixed(0)+'c >= 94c — near-certain, no edge'); return;
  }
  // HARD GATE: weather trades from brain are permanently banned — consistent losers
  if (/kxhigh|kxlow/i.test(sig.ticker) && (sig.source === 'brain' || !sig.source)) {
    log("Hard gate: weather trade BANNED: " + sig.ticker + " src=" + (sig.source||'unknown'));
    return;
  }
  // HARD GATE: brain cannot trade sub-12-min markets — too close to expiry for limit fills
  // FastPath IS allowed for 15min (math-based, gap threshold enforced above)
  if (sig.hoursToClose != null && sig.hoursToClose < 0.20 && sig.source === 'brain') {
    log("Hard gate: brain signal rejected — " + (sig.hoursToClose*60).toFixed(0) + "min too close to expiry (need 12min+)");
    return;
  }
  // HARD GATE: brain signals need 12min+ to close — short windows = variance not edge
  // FastPath signals are exempt — they have mathematical gap enforcement
  if ((sig.hoursToClose || 999) < 0.20 && sig.source === 'brain') {
    log("Hard gate: brain signal rejected — " + ((sig.hoursToClose||0)*60).toFixed(0) + "min too short (need 12min+)");
    return;
  }

  // HARD PAYOUT GUARD: server-side enforcement of minimum payout ratio
  // This is the key fix: even if brain signals a high-price bet, server rejects it.
  // Net payout = ((1 - tradePrice) / tradePrice) * (1 - KALSHI_FEE)
  // Payout = (1 - sidePrice) / sidePrice * (1 - fee)
  // sidePriceActual already defined above = the actual price of the side (e.g. 0.25 for NO at 25c)
  const sidePriceForPayout = sidePriceActual;
  const netPayoutRatio = ((1 - sidePriceForPayout) / sidePriceForPayout) * (1 - KALSHI_FEE);
  const isCryptoTicker = /kxbtc|kxeth|kxsol|kxxrp/i.test(sig.ticker);
  const isFastPath = sig.source === 'fastpath';
  const isFavoriteExec = sig.isFavorite === true;
  const isNonCryptoBrain = !isCryptoTicker && sig.source === 'brain';
  // v17: 15-min Up/Down momentum trades (~50c) — payout is ~0.9x but edge is in win rate
  // A 50c bet with 75% win rate = 75%*0.9x - 25%*1 = +42.5% EV. Allow these through.
  const is15MinMomentum = /kxsol15m|kxxrp15m|kxeth15m|kxbtc15m/i.test(sig.ticker); // v18: brain+fastpath both get momentum treatment
  const minPayout = is15MinMomentum ? 0.50  // Up/Down: ~0.9x payout, win rate is the edge
    : isFavoriteExec ? 0.10
    : isNonCryptoBrain ? 3.0
    : isCryptoTicker
    ? (isFastPath ? 1.2 : 1.5)
    : 2.5;
  if (netPayoutRatio < minPayout) {
    log(`Skip ${sig.ticker}: payout ${netPayoutRatio.toFixed(2)}x < ${minPayout}x floor (@${(sidePriceForPayout*100).toFixed(1)}c src:${sig.source||'brain'})`);
    return;
  }
  // Tiered confidence guards — calibrated by price range
  // v15: High-payout low-price markets (3c-12c) need HIGH confidence to offset variance
  // But 75%+ conf at 5c = 15x payout = exceptional positive EV — allow it.
  // The old guards were too strict for non-crypto event markets.
  if (sidePriceActual < 0.06 && sig.confidence < 0.85) {
    log(`Skip ${sig.ticker}: extreme longshot ${sig.side}@${(sidePriceActual*100).toFixed(1)}c needs 85%+ conf, got ${(sig.confidence*100).toFixed(0)}%`);
    return;
  }
  if (sidePriceActual < 0.12 && sig.confidence < 0.78) {
    log(`Skip ${sig.ticker}: very low price ${sig.side}@${(sidePriceActual*100).toFixed(1)}c needs 78%+ conf, got ${(sig.confidence*100).toFixed(0)}%`);
    return;
  }
  if (sidePriceActual < 0.20 && sig.confidence < 0.72) {
    log(`Skip ${sig.ticker}: longshot ${sig.side}@${(sidePriceActual*100).toFixed(1)}c needs 72%+ conf, got ${(sig.confidence*100).toFixed(0)}%`);
    return;
  }
  if (sidePriceActual < 0.35 && sig.confidence < 0.65) {
    log(`Skip ${sig.ticker}: underdog ${sig.side}@${(sidePriceActual*100).toFixed(1)}c needs 65%+ conf, got ${(sig.confidence*100).toFixed(0)}%`);
    return;
  }
  // Edge calculation — correct for both YES and NO sides
  // tradePrice is the YES-equivalent (used for Kelly and payout math)
  // For edge: we compare confidence to the ACTUAL price paid for the chosen side
  const brainEdge = sig.feeAdjustedEdge || sig.edge || 0;
  const mktP_raw = sig.marketPrice || 0.5;
  const sidePrice = sig.side === 'NO' ? (1 - mktP_raw) : mktP_raw;
  const serverEdge = sig.confidence - sidePrice;
  const effectiveEdge = Math.max(brainEdge, serverEdge);
  const isCryptoMath = /kxbtc|kxeth|kxsol|kxxrp/i.test(sig.ticker);
  const payoutJustifiesEdge = netPayoutRatio >= 2.5 && sig.confidence >= phase.minProb;
  // v17: 15-min momentum trades bypass the minEdge check entirely.
  // Their edge is encoded in confidence (75%+ win rate), not in the price spread formula.
  // The formula confidence - 0.50 = 0.25 which is already >> minEdge anyway, but exempt to be safe.
  if (!is15MinMomentum && effectiveEdge < phase.minEdge && !(isCryptoMath && payoutJustifiesEdge)){
    log('Skip '+sig.ticker+': edge '+(effectiveEdge*100).toFixed(1)+'% < min '+(phase.minEdge*100)+'% [brain:'+(brainEdge*100).toFixed(1)+'% server:'+(serverEdge*100).toFixed(1)+'%]');return;
  }
  const minConfGate = is15MinMomentum ? 0.71 : phase.minProb; // v18: 0.71 avoids float precision issues at 72%
  if(sig.confidence<minConfGate){log('Skip '+sig.ticker+': conf '+(sig.confidence*100).toFixed(0)+'% < min '+(minConfGate*100).toFixed(0)+'%');return;}
  // Kelly should use the actual price paid for the side (not YES-equivalent)
  // Kelly uses sidePriceActual — the actual price paid for this side
  const serverKelly = kellySize(sig.confidence, sidePriceActual, sig.source || 'brain', sig);
  // v15: Flat $0.50 minimum bet only. Old percentage floor (3-4% of balance) = $1.32
  // at $33 balance, requiring 26 contracts at 5c — impossible to fill on event markets.
  // Kelly sizing already caps upside appropriately. Just need a floor to avoid dust trades.
  const minBet = 0.50;
  if (serverKelly < minBet) { log('Skip '+sig.ticker+': Kelly $'+serverKelly.toFixed(2)+' < $'+minBet.toFixed(2)+' min'); return; }

  // Block opposite-side bet on the same GAME event (e.g. YES Atlanta + YES New York same game)
  // Only applies to sports games (GAME tickers) where outcomes are mutually exclusive
  // BTC/crypto/index markets at different strikes are independent -- allow multiples
  const isGameTicker = /GAME/i.test(sig.ticker);
  if (isGameTicker) {
    const eventRoot = sig.ticker.split('-').slice(0, -1).join('-'); // strip team suffix
    const conflictingEvent = S.openPositions.find(p => {
      if (p.ticker === sig.ticker) return false;
      if (!/GAME/i.test(p.ticker)) return false;
      const existingRoot = p.ticker.split('-').slice(0, -1).join('-');
      return existingRoot === eventRoot;
    });
    if (conflictingEvent) {
      log(`Skip ${sig.ticker}: already have ${conflictingEvent.ticker} -- same game, both sides blocked`);
      return;
    }
  }

  // Order price = sidePriceActual (already validated above as the correct side price)
  const priceCents = Math.round(Math.min(0.92, Math.max(0.08, sidePriceActual)) * 100);
  const priceFloat = priceCents / 100;

  const size = kellySize(sig.confidence, priceFloat, sig.source || 'brain', sig);
  const contracts=Math.max(1,Math.floor(size/priceFloat));
  const actualCost=(priceCents*contracts)/100;
  const price=priceCents;
  if(actualCost<0.50){log("Skip "+sig.ticker+": cost $"+actualCost.toFixed(2)+" < $0.50 min");return;}
  log("TRADE "+sig.ticker+" "+sig.side+" edge="+(effectiveEdge*100).toFixed(1)+"% $"+actualCost.toFixed(2));

  if (CFG.dryRun) {
    // Paper trade
    const position = {
      ticker: sig.ticker,
      side: sig.side,
      entryPrice: price,
      contracts,
      cost: (price * contracts) / 100,
      confidence: sig.confidence,
      reasoning: sig.reasoning,
      openedAt: Date.now(),
      status: 'open',
      currentPrice: price,
      source: sig.source || 'brain',
    };
    S.openPositions.push(position);
    S.balance -= position.cost;

    S.brainMemory.push({
      ticker: sig.ticker,
      action: `${sig.side} x${contracts} @ ${price}c`,
      prob: (sig.confidence * 100).toFixed(0),
      cost: position.cost.toFixed(2),
      ts: Date.now(),
    });

    log(`📝 PAPER TRADE: ${sig.ticker} ${sig.side} x${contracts} @ ${price}c = $${position.cost.toFixed(2)} | payout ${netPayoutRatio.toFixed(2)}x`);
    tg(`📝 <b>Paper Trade</b>\n${sig.ticker} ${sig.side}\n${contracts} contracts @ ${price}c\nCost: $${position.cost.toFixed(2)} → max return $${(contracts*(100-price)/100).toFixed(2)} (${netPayoutRatio.toFixed(2)}x)\n💭 ${sig.reasoning}`);
    saveState();
  } else {
    // Live trade
    try {
      const order = await kalshi('POST', '/portfolio/orders', {
        ticker: sig.ticker,
        client_order_id: crypto.randomUUID(),
        type: 'limit',
        action: 'buy',
        side: sig.side.toLowerCase(),
        count: contracts,
        yes_price: sig.side === 'YES' ? price : undefined,
        no_price: sig.side === 'NO' ? price : undefined,
        // Smart expiration: 15min markets → 5min, 1hr → 20min, 3hr+ → 2hr
        // Short expiry prevents cash being locked by unfilled orders on fast markets
        expiration_ts: Math.floor(Date.now() / 1000) + (
          sig.hoursToClose < 0.30 ? 5 * 60        // 15min market: 5min expiry
          : sig.hoursToClose < 1.5 ? 20 * 60      // 1hr market: 20min expiry
          : sig.hoursToClose < 3 ? 60 * 60         // sub-3h: 1hr expiry
          : 4 * 3600                                // longer: 4hr expiry
        ),
      });

      // Calculate expected close time from hoursToClose
      const _expectedCloseMs = sig.hoursToClose
        ? Date.now() + (sig.hoursToClose * 3600000)
        : null;
      const position = {
        ticker: sig.ticker,
        side: sig.side,
        entryPrice: price,
        contracts,
        cost: (price * contracts) / 100,
        orderId: order.order?.order_id,
        confidence: sig.confidence,
        reasoning: sig.reasoning,
        openedAt: Date.now(),
        closeTime: _expectedCloseMs ? new Date(_expectedCloseMs).toISOString() : null,
        status: 'open',
        currentPrice: price,
        source: sig.source || 'brain',
      };
      S.openPositions.push(position);
      const srcIcon = (sig.source === 'fastpath' || sig.source === 'sports_fastpath') ? '⚡' : '🧠';
      log(`✅ LIVE ORDER: ${sig.ticker} ${sig.side} x${contracts} @ ${price}c | payout ${netPayoutRatio.toFixed(2)}x | max return $${(contracts*(100-price)/100).toFixed(2)} | src:${sig.source||'brain'}`);
      tg(`${srcIcon} <b>Live Order — ${sig.source === 'fastpath' ? 'FastPath [$0 AI]' : sig.source === 'sports_fastpath' ? 'Sports [$0 AI]' : 'Brain'}</b>\n${sig.ticker} ${sig.side} x${contracts} @ ${price}c\nCost: $${((price*contracts)/100).toFixed(2)} → max $${(contracts*(100-price)/100).toFixed(2)} (${netPayoutRatio.toFixed(2)}x)\nConf: ${(sig.confidence*100).toFixed(0)}% | Edge: ${(effectiveEdge*100).toFixed(1)}%\n💭 ${(sig.reasoning||'').slice(0,120)}`);
      saveState();
    } catch(e) {
      log(`Order failed ${sig.ticker}: ${e.message}`, 'ERROR');
      tg(`❌ <b>Order Failed</b>\n${sig.ticker}: ${e.message}`);
    }
  }
}

// --- MID-TRADE EXIT ENGINE --------------------------------------------------
// Monitors open positions for reversal signals and sells out early when momentum
// has strongly flipped against our bet direction. Targets hourly+ positions only
// (15-min settle before meaningful reversal can be detected + acted on).
//
// HOW IT WORKS:
// 1. Fetches live market bid price from Kalshi (what we can sell for RIGHT NOW)
// 2. For crypto positions: checks if momentum has inverted using Binance kline cache
// 3. Exit trigger: momentum inverted 2%+ AND price moved >25% against entry
// 4. Sells by placing a limit SELL order at current bid (or 1c below for fast fill)
// 5. Records partial recovery as PnL — better than losing 100%
//
// COST: $0 — uses Binance kline cache (already warmed). No Claude API calls.
// FREQUENCY: Every scan when positions are open (every 10-15s).
// SAFETY: Only exits when BOTH price AND momentum confirm reversal.
// Never exits in last 3 minutes of a 15-min market (too late, let settle).
async function runMidTradeExitEngine() {
  if (S.openPositions.length === 0) return;
  if (CFG.dryRun) return; // paper mode: positions auto-settle, no exit needed

  const prices = await fetchLivePrices();
  const now = Date.now();

  for (const pos of [...S.openPositions]) {
    try {
      // Only check positions open >3 minutes (give fills time to confirm)
      const ageMs = now - (pos.openedAt || now);
      if (ageMs < 3 * 60000) continue;

      // Don't exit positions closing in <3 min — let them settle naturally
      const timeToClose = pos.closeTime
        ? (new Date(pos.closeTime).getTime() - now) / 60000
        : 999;
      if (timeToClose < 3) continue;

      // Only exit hourly+ positions via momentum reversal check
      // 15-min positions: if we're >5min in with >5min left, check price only
      const isHourlyOrLonger = (pos.hoursToClose || (timeToClose / 60)) > 0.5;
      const is15MinPos = /kxsol15m|kxxrp15m|kxeth15m|kxbtc15m/i.test(pos.ticker);

      // --- MOMENTUM REVERSAL CHECK (crypto positions only) ---
      const isCryptoPos = /kxbtc|kxeth|kxsol|kxxrp/i.test(pos.ticker);
      if (isCryptoPos) {
        const coin = /kxbtc/i.test(pos.ticker) ? 'btc'
          : /kxeth/i.test(pos.ticker) ? 'eth'
          : /kxsol/i.test(pos.ticker) ? 'sol'
          : /kxxrp/i.test(pos.ticker) ? 'xrp' : null;

        if (coin && prices[coin] && _momentumCache[coin]?.klineOpen) {
          const mc = _momentumCache[coin];
          const liveP = prices[coin];
          const moveNow = (liveP - mc.klineOpen) / mc.klineOpen;

          // REVERSAL DETECTION:
          // We bet YES (UP) but price is now moving DOWN strongly → momentum inverted
          // We bet NO (DOWN) but price is now moving UP strongly → momentum inverted
          const bettingUp = pos.side === 'YES';
          const momentumInverted = bettingUp
            ? (moveNow <= -0.018)   // bet UP but down 1.8%+ → invert signal
            : (moveNow >= 0.018);   // bet DOWN but up 1.8%+ → invert signal

          // RSI extreme in wrong direction adds confirmation
          const rsiConfirmsReversal = bettingUp
            ? (mc.rsi > 75)   // overbought while we're short = confirmation reversal
            : (mc.rsi < 25);  // oversold while we're long = confirmation reversal

          const strongReversal = momentumInverted || rsiConfirmsReversal;

          if (strongReversal) {
            // Fetch live market price to see what we can sell for
            try {
              const mktData = await kalshi('GET', `/markets/${pos.ticker}`);
              const market = mktData.market || mktData;
              const yesBid = parsePrice(market.yes_bid_dollars);
              const noBid = parsePrice(market.no_bid_dollars || (market.yes_ask_dollars ? (1 - parsePrice(market.yes_ask_dollars)) : 0));
              const sellBid = pos.side === 'YES' ? yesBid : noBid;

              if (sellBid <= 0) continue; // can't determine exit price

              const entryPriceCents = pos.entryPrice || 50;
              const entryPriceFloat = entryPriceCents / 100;
              const priceDropPct = (entryPriceFloat - sellBid) / entryPriceFloat;

              // Only exit if we've lost >20% of position value AND momentum confirms reversal
              // At 20% drop: exit now saves 80% of loss vs holding to zero
              if (priceDropPct > 0.20 && strongReversal) {
                const recoverable = sellBid * pos.contracts;
                const originalCost = pos.cost || (entryPriceFloat * pos.contracts);
                const exitSaves = recoverable; // vs losing everything
                const lostIfHold = originalCost;

                log(`🔄 Mid-trade EXIT: ${pos.ticker} ${pos.side} | Entry ${entryPriceCents}c → Bid ${(sellBid*100).toFixed(0)}c | Drop ${(priceDropPct*100).toFixed(0)}% | Recovers $${recoverable.toFixed(2)} of $${originalCost.toFixed(2)} | moveNow ${(moveNow*100).toFixed(2)}% | RSI ${mc.rsi?.toFixed(0)}`);
                tg(`🔄 <b>Mid-Trade Exit</b>\n${pos.ticker} ${pos.side}\nReversal: ${bettingUp ? '📉 momentum flipped DOWN' : '📈 momentum flipped UP'}\nEntry ${entryPriceCents}c → sell ${(sellBid*100).toFixed(0)}c\nRecovering $${recoverable.toFixed(2)} (lost $${(originalCost - recoverable).toFixed(2)} vs $${originalCost.toFixed(2)} full loss)\nmoveNow ${(moveNow*100).toFixed(2)}% | RSI ${mc.rsi?.toFixed(0)}`);

                // Place sell order at current bid (or 1c above for better fill)
                const sellPriceCents = Math.max(1, Math.round(sellBid * 100));
                try {
                  await kalshi('POST', '/portfolio/orders', {
                    ticker: pos.ticker,
                    client_order_id: crypto.randomUUID(),
                    type: 'limit',
                    action: 'sell',
                    side: pos.side.toLowerCase(),
                    count: pos.contracts,
                    yes_price: pos.side === 'YES' ? sellPriceCents : undefined,
                    no_price: pos.side === 'NO' ? sellPriceCents : undefined,
                    expiration_ts: Math.floor(Date.now() / 1000) + (3 * 60), // 3min expiry
                  });

                  // Record partial recovery as a "resolved" trade
                  const pnl = recoverable - originalCost;
                  S.totalPnl += pnl;
                  S.todayPnl += pnl;
                  // Don't count as win/loss — it's a managed exit
                  S.openPositions = S.openPositions.filter(p => p.ticker !== pos.ticker);
                  S.trades.push({ ...pos, resolvedAt: now, won: false, pnl, revenue: recoverable, exitType: 'momentum_reversal' });
                  S.consecutiveLosses = (S.consecutiveLosses || 0) + 1;
                  saveState();
                  // Immediately rescan to fill freed slot
                  S.lastBrainAt = 0;
                  clearTimeout(scanTimer);
                  if (S.isRunning) scanTimer = setTimeout(scan, 3000);
                  log(`✅ Exit order placed: ${pos.ticker} | Recovering $${recoverable.toFixed(2)}`);
                } catch(exitErr) {
                  log(`Exit order failed ${pos.ticker}: ${exitErr.message}`, 'WARN');
                }
              } else if (strongReversal) {
                log(`Mid-trade watch: ${pos.ticker} reversal signal but price drop only ${(priceDropPct*100).toFixed(0)}% — monitoring`);
              }
            } catch(mktErr) {
              log(`Exit price fetch ${pos.ticker}: ${mktErr.message}`, 'WARN');
            }
          }
        }
      }
    } catch(e) {
      log(`Exit engine ${pos.ticker}: ${e.message}`, 'WARN');
    }
  }
}

// --- POSITION RESOLUTION ---------------------------------------------------
async function resolvePositions() {
  if (S.openPositions.length === 0) return;

  // Fetch recent settlements from Kalshi directly -- most reliable source
  let settlements = [];
  try {
    const sr = await kalshi('GET', '/portfolio/settlements', null, { limit: '50' });
    settlements = sr.settlements || sr.market_settlements || [];
    if (settlements.length > 0) log(`Settlements: ${settlements.length} found`);
  } catch(e) {
    // Silently continue -- will fall back to market status check
    if (!e.message.includes('authentication')) {
      log('Settlement fetch: ' + e.message.slice(0,60), 'WARN');
    }
  }

  for (const pos of [...S.openPositions]) {
    try {
      // Check settlements first (most accurate)
      const settled = settlements.find(s => s.ticker === pos.ticker || s.market_ticker === pos.ticker);
      if (settled) {
        const revenue = parsePrice(settled.revenue_dollars || settled.revenue || '0');
        const cost = pos.cost;
        const pnl = revenue - cost;
        const won = pnl > 0;

        const prevBal = S.balance;
        S.balance += revenue;
        S.totalPnl += pnl;
        S.todayPnl += pnl;
        if (won) S.wins++; else S.losses++;
        if (S.balance > S.peakBalance) S.peakBalance = S.balance;
        checkMilestone(prevBal, S.balance);

        const memEntry = S.brainMemory.find(m => m.ticker === pos.ticker);
        if (memEntry) memEntry.outcome = won ? `WON +$${pnl.toFixed(2)}` : `LOST $${pnl.toFixed(2)}`;

        S.openPositions = S.openPositions.filter(p => p.ticker !== pos.ticker);
        S.trades.push({ ...pos, resolvedAt: Date.now(), won, pnl, revenue });

        log(`${won ? '🟢 WIN' : '🔴 LOSS'}: ${pos.ticker} ${pos.side} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);

        // ── SOURCE WIN/LOSS TRACKING ────────────────────────────────────────
        const src = pos.source || 'brain';
        if (!S.sourceWins) S.sourceWins = { fastpath: 0, sports_fastpath: 0, brain: 0 };
        if (!S.sourceLosses) S.sourceLosses = { fastpath: 0, sports_fastpath: 0, brain: 0 };
        if (won) S.sourceWins[src] = (S.sourceWins[src] || 0) + 1;
        else S.sourceLosses[src] = (S.sourceLosses[src] || 0) + 1;

        // ── CIRCUIT BREAKER LOGIC ───────────────────────────────────────────
        if (won) {
          S.consecutiveLosses = 0; // reset on any win
        } else {
          S.consecutiveLosses = (S.consecutiveLosses || 0) + 1;
          if (S.consecutiveLosses >= 4) {
            // v14: Trigger at 4 consecutive losses (was 5). Pause 15min (was 20min).
            // Shorter pause = less lost compounding time. 4 losses in a row = genuine signal to stop.
            const pauseMs = 15 * 60000;
            S.circuitBreakerUntil = Date.now() + pauseMs;
            log(`🔴 CIRCUIT BREAKER: ${S.consecutiveLosses} consecutive losses — pausing 15min`, 'WARN');
            tg(`🔴 <b>Circuit Breaker Triggered</b>\n${S.consecutiveLosses} consecutive losses\nTrading paused 15 minutes\nResumes: ${new Date(S.circuitBreakerUntil).toLocaleTimeString('en-US',{timeZone:'America/New_York'})} ET\n💰 Balance: $${(S.realBalance||S.balance).toFixed(2)}`);
          }
        }
        const _winRate = (S.wins + S.losses) > 0 ? ((S.wins / (S.wins + S.losses)) * 100).toFixed(0) : '--';
        const _dblProg = doublingProgress().toFixed(1);
        const _dblNext = nextTarget().toFixed(2);
        const _srcStats = Object.keys(S.sourceWins||{}).map(k => {
          const w = (S.sourceWins[k]||0), l = (S.sourceLosses||{})[k]||0;
          return w+l>0 ? `${k}:${w}W/${l}L` : null;
        }).filter(Boolean).join(' | ');
        tg(`${won ? '🟢 <b>WIN</b>' : '🔴 <b>LOSS</b>'} — ${pos.ticker} ${pos.side}
Revenue: $${revenue.toFixed(2)} | Cost: $${cost.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
💰 Balance: $${S.balance.toFixed(2)} | ${S.wins}W/${S.losses}L (${_winRate}% WR)
📈 ${_dblProg}% to $${_dblNext} | ${doublingsNeeded()} doublings left to $500K${_srcStats ? '\n📊 ' + _srcStats : ''}`);
        saveState();
        // Slot freed — reset brain timer AND force immediate rescan to fill the slot ASAP
        S.lastBrainAt = 0;
        log(`🔄 Slot freed: ${pos.ticker} resolved — forcing immediate rescan to refill`);
        // Clear the current scan timer and restart in 3s (short enough to be instant, long enough to avoid API hammering)
        clearTimeout(scanTimer);
        if (S.isRunning) scanTimer = setTimeout(scan, 3000);
        continue;
      }

      // Fallback: check market status directly
      const m = await kalshi('GET', `/markets/${pos.ticker}`);
      const market = m.market || m;
      const currentYes = parsePrice(market.yes_ask_dollars || market.yes_ask);
      pos.currentPrice = pos.side === 'YES'
        ? Math.round(currentYes * 100)
        : Math.round((1 - currentYes) * 100);

      if (market.status === 'finalized' || market.status === 'settled' || market.result) {
        const result = market.result;
        const won = (pos.side === 'YES' && result === 'yes') || (pos.side === 'NO' && result === 'no');
        const payout = won ? pos.contracts * 1.0 : 0; // each contract pays $1.00
        const pnl = payout - pos.cost;

        S.balance += payout;
        S.totalPnl += pnl;
        S.todayPnl += pnl;
        if (won) S.wins++; else S.losses++;
        if (S.balance > S.peakBalance) S.peakBalance = S.balance;

        S.openPositions = S.openPositions.filter(p => p.ticker !== pos.ticker);
        S.trades.push({ ...pos, resolvedAt: Date.now(), won, pnl, result });

        log(`${won ? '🟢 WIN' : '🔴 LOSS'}: ${pos.ticker} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
        tg(`${won ? '🟢 <b>WIN</b>' : '🔴 <b>LOSS</b>'}
${pos.ticker} ${pos.side}
PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Balance: $${S.balance.toFixed(2)}`);
        saveState();
        // Slot freed — reset brain timer and force immediate rescan
        S.lastBrainAt = 0;
        clearTimeout(scanTimer);
        if (S.isRunning) scanTimer = setTimeout(scan, 3000);
      }
    } catch(e) {
      log(`Resolve check ${pos.ticker}: ${e.message}`, 'WARN');
    }
  }
}
// --- SCAN LOOP -------------------------------------------------------------
let scanTimer, brainTimer, heartbeatTimer, watchdogTimer;

async function scan() {
  if (!S.isRunning) return;
  S.scanCount++;
  S.totalScanCount = (S.totalScanCount || 0) + 1;
  S.lastScanAt = Date.now();

  try {
    // ── CIRCUIT BREAKER ────────────────────────────────────────────────────
    if ((S.circuitBreakerUntil || 0) > Date.now()) {
      const minsLeft = Math.ceil((S.circuitBreakerUntil - Date.now()) / 60000);
      log(`🔴 Circuit breaker ACTIVE — ${minsLeft}min left | ${S.consecutiveLosses} consecutive losses`);
      // Still sync + resolve during cooldown — open positions should close & free slots
      try { await syncBalance(); } catch(e) {}
      try { await resolvePositions(); } catch(e) {}
      // Use hungry interval so we catch slot frees fast even during cooldown
      const slotsNowCB = dynamicMaxPos() - S.openPositions.length;
      if (S.isRunning) scanTimer = setTimeout(scan, slotsNowCB > 0 ? CFG.scanIntervalHungry : CFG.scanInterval);
      return;
    }

    await syncBalance();
    await syncRestingOrders(); // must run after syncBalance -- computes availableCash
    // v14: Sync positions every scan when slots open (critical for flywheel velocity)
    // When full, sync every 3 scans to save API rate limit
    const slotsBeforeSync = dynamicMaxPos() - S.openPositions.length;
    if (slotsBeforeSync > 0 || S.scanCount === 1 || S.scanCount % 3 === 0) {
      await syncPositions();
    }
    // Backfill Kalshi trade history on first scan and every 15 scans (~2.5 min)
    if (S.scanCount === 1 || S.scanCount % 15 === 0) await backfillKalshiHistory();

    // -- STOP-LOSS GUARD: halt bot completely if total balance is near zero --
    const FLOOR = 2.00;

    // Track session peak for display only — no trading blocks from it
    const curBalForDD = (!CFG.dryRun && S.realBalance > 0) ? S.realBalance : S.balance;
    if (curBalForDD > (S.sessionPeakBalance || 0)) {
      S.sessionPeakBalance = curBalForDD;
    }
    // Drawdown guard REMOVED — was blocking trading at exactly wrong time.
    // Protection is handled by: circuit breaker (5 losses → 20min), gap minimums,
    // brain 15min ban, weather ban, payout floors. No need for additional block.
    // Clear any lingering DD halt so it never blocks again
    if (S.drawdownHaltUntil && S.drawdownHaltUntil > 0) {
      S.drawdownHaltUntil = 0;
    }
    const effectiveBal = (!CFG.dryRun && S.realBalance > 0) ? S.realBalance : S.balance;
    if (effectiveBal <= FLOOR && !CFG.dryRun) {
      if (S.isRunning) {
        log('🛑 FLOOR HIT: balance $' + S.balance.toFixed(2) + ' <= $' + FLOOR + ' -- halting live trading', 'ERROR');
        tg(`🛑 <b>Floor Hit — Trading Halted</b>
Balance $${(S.realBalance||S.balance).toFixed(2)} hit the $${FLOOR} safety floor.

Steps to recover:
1. Wait for open positions to resolve — they will refill your cash
2. Cancel any unfilled resting orders on Kalshi to recover reserved cash
3. If balance is truly depleted, deposit at least $25 to restart
4. Bot auto-restarts when cash is available`);
        stopBot();
      }
      return;
    }

    const [markets] = await Promise.all([
      Promise.race([getTopMarkets(), new Promise(r => setTimeout(() => r([]), 25000))]),
    ]);
    S.topTraders = [];

    // PROACTIVE RESOLUTION: check any position whose close_time has passed
    // This catches 15min trades the moment they expire, not waiting for settlement API
    const _nowMs = Date.now();
    let _proactiveResolved = 0;
    for (const pos of S.openPositions) {
      if (!pos.closeTime) continue;
      const closeMs = new Date(pos.closeTime).getTime();
      if (_nowMs > closeMs + 30000) { // 30s grace after close_time
        log(`Proactive resolve check: ${pos.ticker} close_time passed ${((_nowMs-closeMs)/60000).toFixed(1)}min ago`);
        _proactiveResolved++;
      }
    }
    if (_proactiveResolved > 0) {
      await resolvePositions(); // extra resolve pass when positions are overdue
    }
    await resolvePositions();

    // v19: Mid-trade exit engine — checks for momentum reversals on open positions
    // Runs every scan when positions exist. $0 cost (uses cached Binance data).
    // Only targets positions >3min old with >3min left to close.
    if (S.openPositions.length > 0) {
      await runMidTradeExitEngine();
    }

    // Fire brain when: enough time has passed AND we have open slots AND markets exist
    const _activeBrainMs = dynamicBrainInterval();
    const brainReady = S.scanCount >= 2 && (Date.now() - S.lastBrainAt) >= _activeBrainMs;
    const maxPos = dynamicMaxPos();
    const hasMarkets = markets.length > 0;
    const secsToNext = Math.max(0, Math.round((_activeBrainMs - (Date.now() - S.lastBrainAt)) / 1000));
    const effectiveCash = S.availableCash > 0 ? S.availableCash
      : (S.restingOrders.length === 0 ? Math.max(0, (S.realBalance||S.balance) - 1.00) : 0);

    // Log scan summary every scan so Railway shows live state clearly
    log(`Scan #${S.scanCount} | bal=$${(S.realBalance||S.balance).toFixed(2)} cash=$${effectiveCash.toFixed(2)} | pos=${S.openPositions.length}/${maxPos} | mkts=${markets.length} | brain ${brainReady?'READY':'in '+secsToNext+'s'}`);
    S.lastSuccessfulScan = Date.now(); // watchdog heartbeat

    // Telegram scan update every 5 scans (~50-75s) — was every 3
    if (S.scanCount % 5 === 0) {
      const posStr = S.openPositions.length > 0
        ? '\n📋 ' + S.openPositions.map(p => {
            const src = p.source === 'fastpath' ? '⚡' : p.source === 'sports_fastpath' ? '🏀' : '🧠';
            return src + p.ticker.split('-').slice(-1)[0] + ' ' + p.side + (p.cost ? ' $' + p.cost.toFixed(2) : '');
          }).join(' | ')
        : '';
      const overLimit = S.openPositions.length > maxPos ? ` ⚠️ ${S.openPositions.length - maxPos} over limit` : '';
      const phase = getPhase();
      const unrealizedSum = S.openPositions.reduce((sum, p) => {
        const cur = (p.currentPrice||0) / 100;
        const entry = (p.entryPrice||0) / 100;
        const cts = p.contracts||0;
        if (cur > 0 && entry > 0 && cts > 0) return sum + ((p.side==='YES' ? cur-entry : entry-cur) * cts);
        return sum;
      }, 0);
      const unrealLine = unrealizedSum !== 0 ? '\n📈 Unrealized: ' + (unrealizedSum >= 0 ? '+' : '') + '$' + unrealizedSum.toFixed(2) : '';
      const topMkts = (S.topMarkets||[]).slice(0,3).map(m =>
        `${m.ticker.split('-').slice(-1)[0]} ${m.suggestedSide||'YES'} ${(m.hoursLeft||0).toFixed(1)}h ${(m.netPayoutRatio||0).toFixed(1)}x`
      ).join(' | ');
      const circuitLine = (S.circuitBreakerUntil||0) > Date.now()
        ? `\n🔴 Circuit breaker: ${Math.ceil((S.circuitBreakerUntil-Date.now())/60000)}min left` : '';
      tg('📡 <b>Scan #' + S.scanCount + '</b> | ' + phase.label + '\n💰 $' + (S.realBalance||S.balance).toFixed(2) + ' | Cash: $' + effectiveCash.toFixed(2) + '\n📊 ' + S.openPositions.length + '/' + maxPos + ' pos' + overLimit + ' | ' + markets.length + ' mkts' + unrealLine + '\n🧠 Brain ' + (brainReady ? 'READY 🔥' : 'in ' + secsToNext + 's') + (topMkts ? '\n🎯 ' + topMkts : '') + circuitLine + posStr);
    }

    // SLOT CHECK
    const openCount = S.openPositions.length;
    const hasSlots = openCount < maxPos;

    // ⚡ FAST PATHS run on EVERY scan with open slots — zero cost, zero reason to wait
    // Declared outside if-block so fastPathFoundTrade can reference them below
    // v17: PRE-WARM momentum cache for all 4 coins in parallel — $0 cost (Binance free)
    // This ensures momentum signals are fresh when FastPath evaluates 15-min markets.
    // Run regardless of slots — data is useful for next scan too.
    if (hasMarkets) {
      Promise.allSettled([
        fetchMomentumSignal('btc'),
        fetchMomentumSignal('eth'),
        fetchMomentumSignal('sol'),
        fetchMomentumSignal('xrp'),
      ]).catch(() => {}); // fire and forget — non-blocking, errors silently ignored
    }

    let cryptoFilled = 0, sportsFilled = 0;
    if (hasSlots && hasMarkets) {
      cryptoFilled = await runCryptoFastPath(markets);
      sportsFilled = await runSportsFastPath(markets);
      const totalFastFilled = cryptoFilled + sportsFilled;
      if (totalFastFilled > 0) log(`⚡ FastPath filled ${totalFastFilled} slot(s) (crypto:${cryptoFilled} sports:${sportsFilled})`);
    }

    // 🧠 BRAIN: v14 — fires independently when slots open, regardless of FastPath.
    // KEY FIX: removing !fastPathFoundTrade gate — brain and FastPath target DIFFERENT
    // markets. FastPath = BTC/ETH math gaps. Brain = hourly/sports/cross-market edge.
    // Both should run every cycle when slots exist. FastPath saved $0 AI — brain adds
    // intelligent multi-market analysis. Run both, pick best, fill all slots.
    const slotsAfterFastPath = dynamicMaxPos() - S.openPositions.length;

    // If 0 markets AND brain hasn't fired in 5+ min — reset timer to fire now
    if (!hasMarkets && slotsAfterFastPath > 0) {
      if ((Date.now() - S.lastBrainAt) > 5 * 60000) {
        log('0 markets found — forcing brain reset to search harder next scan');
        S.lastBrainAt = 0;
      }
    }

    if (brainReady && slotsAfterFastPath > 0 && hasMarkets) {
      // Always fire brain when slots are open — FastPath may have missed hourly/sports
      log(`🧠 Brain firing: ${slotsAfterFastPath} slots open (FastPath filled ${cryptoFilled + sportsFilled})`);
      await runBrain(markets);
    } else if (brainReady && slotsAfterFastPath <= 0) {
      log(`All ${dynamicMaxPos()} slots filled — brain running position monitor`);
      S.lastBrainAt = Date.now();
      await runPositionMonitor();
    } else if (brainReady && !hasMarkets) {
      log('⚠️ Brain ready but 0 markets found', 'WARN');
      tg(`⚠️ <b>0 markets found</b> — Scan #${S.scanCount}\nCheck Railway logs`);
      S.lastBrainAt = Date.now();
    }

    // Force brain at US market open (9:30am ET) — new opportunities every trading day
    const _etH = (new Date().getUTCHours() - 4 + 24) % 24;
    const _etM = new Date().getUTCMinutes();
    const _isMarketOpen = _etH === 9 && _etM >= 28 && _etM <= 38;
    if (_isMarketOpen && S.lastMarketOpenReset !== new Date().toDateString()) {
      S.lastMarketOpenReset = new Date().toDateString();
      S.lastBrainAt = 0;
      log('🔔 Market open — brain reset for immediate opportunity scan');
    }

    saveState();
  } catch(e) {
    log('Scan error: ' + e.message, 'ERROR');
    S.lastErr = e.message;
    // Alert on scan errors so we know the bot is struggling
    if (!S._lastErrAlertAt || (Date.now() - S._lastErrAlertAt) > 300000) {
      S._lastErrAlertAt = Date.now();
      tg(`⚠️ <b>Scan Error</b>\n${e.message.slice(0,150)}\nBot continuing — scan #${S.scanCount}`);
    }
  }

  // ALWAYS reschedule — never let the loop die from an error
  // v14: HUNGRY MODE — 10s scan when slots open. 15s when full (save API rate limit).
  if (S.isRunning) {
    const slotsNow = dynamicMaxPos() - S.openPositions.length;
    const nextScan = slotsNow > 0 ? CFG.scanIntervalHungry : CFG.scanInterval;
    scanTimer = setTimeout(scan, nextScan);
  }
}

function sendHeartbeat() {
  const phase = getPhase();
  const drawdown = S.peakBalance > 0
    ? ((S.peakBalance - S.balance) / S.peakBalance * 100).toFixed(1)
    : '0.0';
  const mode = CFG.dryRun ? '📝 Paper' : '🔴 LIVE';
  const progress = doublingProgress().toFixed(0);
  const barFilled = Math.round(progress / 10);
  const progressBar = '█'.repeat(barFilled) + '░'.repeat(10 - barFilled);
  const bal = (!CFG.dryRun && S.realBalance > 0 ? S.realBalance : S.balance);
  const apiSpend = S.estimatedApiSpend || 0;
  const uptimeHours = S.startedAt ? (Date.now() - S.startedAt) / 3600000 : 0;
  const hourlyBurn = uptimeHours > 0 ? (apiSpend / uptimeHours).toFixed(3) : '0';

  // Source win/loss breakdown
  const sw = S.sourceWins || {}, sl = S.sourceLosses || {};
  const srcLine = ['fastpath','sports_fastpath','brain'].map(k => {
    const w = sw[k]||0, l = sl[k]||0;
    return (w+l) > 0 ? `${k==='fastpath'?'⚡':k==='sports_fastpath'?'🏀':'🧠'}${w}W/${l}L` : null;
  }).filter(Boolean).join(' ');

  // Unrealized P&L
  const unrealized = S.openPositions.reduce((sum, p) => {
    const cur = (p.currentPrice||0) / 100, entry = (p.entryPrice||0) / 100, cts = p.contracts||0;
    return (cur > 0 && entry > 0 && cts > 0) ? sum + ((p.side==='YES' ? cur-entry : entry-cur)*cts) : sum;
  }, 0);

  // Scan health
  const scanSilentMin = S.lastSuccessfulScan
    ? ((Date.now() - S.lastSuccessfulScan) / 60000).toFixed(1) : '?';

  const _openList = S.openPositions.length > 0
    ? '\n📋 ' + S.openPositions.map(p => {
        const src = p.source === 'fastpath' ? '⚡' : p.source === 'sports_fastpath' ? '🏀' : '🧠';
        return src + p.ticker.split('-').slice(-1)[0] + ' ' + p.side;
      }).join(' | ')
    : '';

  const circuitLine = (S.circuitBreakerUntil||0) > Date.now()
    ? `\n🔴 Circuit breaker: ${Math.ceil((S.circuitBreakerUntil-Date.now())/60000)}min` : '';

  const ddGuardLine = (S.drawdownHaltUntil||0) > Date.now()
    ? `\n\u{1F6E1}\uFE0F DD guard: ${Math.ceil((S.drawdownHaltUntil-Date.now())/60000)}min left` : '';
  const sessionPeakLine = (S.sessionPeakBalance||0) > bal
    ? `\n\u{1F4C9} Session peak: $${(S.sessionPeakBalance||0).toFixed(2)} | off peak: ${(((S.sessionPeakBalance||bal)-bal)/(S.sessionPeakBalance||bal)*100).toFixed(1)}%` : '';
  const ph2 = getPhase();
  const capLine = `\n\u{1F512} Cap: $${ph2.maxBetDollars}/bet | ${(ph2.maxPct*100).toFixed(0)}% max | ${(ph2.maxExposure*100).toFixed(0)}% total exposure`;
  tg(`💓 <b>Heartbeat — ${phase.label}</b>
${mode} | Scan #${S.scanCount} | Brain #${S.brainCount}
💰 $${bal.toFixed(2)} → $${nextTarget().toFixed(2)} target
${progressBar} ${progress}% to next 2x | DD: ${drawdown}%
📈 Unrealized: ${unrealized >= 0 ? '+' : ''}$${unrealized.toFixed(2)}
Today: ${S.todayPnl >= 0 ? '+' : ''}$${S.todayPnl.toFixed(2)} | Total: ${S.totalPnl >= 0 ? '+' : ''}$${S.totalPnl.toFixed(2)}
🎯 ${S.wins}W/${S.losses}L (${S.wins+S.losses > 0 ? ((S.wins/(S.wins+S.losses))*100).toFixed(0) : '--'}% WR) | ${doublingsNeeded()} doublings left${srcLine ? '\n' + srcLine : ''}
🔋 API: $${apiSpend.toFixed(3)} ($${hourlyBurn}/hr) | Last scan: ${scanSilentMin}min ago${circuitLine}${ddGuardLine}${sessionPeakLine}${capLine}${_openList}`);
}

// --- FULL PLUMBING VALIDATION ----------------------------------------------
async function runPlumbingTest() {
  log('🔬 Starting full plumbing validation...');
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
  };

  // 1. Kalshi Auth + Balance
  try {
    const r = await kalshi('GET', '/portfolio/balance');
    const bal = (r.balance || 0) / 100;
    check('Kalshi Auth', true, `Balance $${bal.toFixed(2)}`);
    check('Real Balance', bal > 0, `$${bal.toFixed(2)} on account`);
  } catch(e) {
    check('Kalshi Auth', false, e.message.slice(0, 60));
    check('Real Balance', false, 'Cannot fetch -- auth failed');
  }

  // 2. Kalshi Markets -- use /markets?series_ticker (correct per docs)
  try {
    const testSeries = ['INXD', 'KXBTCD', 'KXNBAGAME', 'FED', 'INXW'];
    const fetches = await Promise.allSettled(
      testSeries.map(s => kalshi('GET', '/markets', null, { series_ticker: s, status: 'open', limit: '20' }))
    );
    let testMarkets = [];
    for (const f of fetches) {
      if (f.status === 'fulfilled') testMarkets.push(...(f.value.markets || []));
    }
    const seen = new Set();
    testMarkets = testMarkets.filter(m => { if(!m?.ticker||seen.has(m.ticker)) return false; seen.add(m.ticker); return true; });
    const tradeable = testMarkets.filter(m => {
      if (m.mve_collection_ticker) return false;
      const p = parsePrice(m.yes_ask_dollars || m.yes_ask);
      return p > 0.005 && p < 0.995;
    });
    if (tradeable[0]) log('DEBUG: ' + tradeable[0].ticker + ' ask=' + tradeable[0].yes_ask_dollars + ' vol_fp=' + tradeable[0].volume_fp);
    check('Market Access', testMarkets.length > 0, testMarkets.length + ' fetched via series_ticker');
    check('MVE Filter', tradeable.length > 0, tradeable.length + ' tradeable -- e.g. ' + (tradeable[0]?.ticker || 'none'));
  } catch(e) {
    check('Market Access', false, e.message.slice(0, 60));
    check('MVE Filter', false, e.message.slice(0, 50));
  }

  // 3. Claude Brain
  try {
    const r = await req('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CFG.claudeKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: 'claude-haiku-4-5-20251001',
      },
    }, 30000);
    const ok = r.status === 200;
    const text = (r.body && r.body.content && r.body.content[0] ? r.body.content[0].text : '').slice(0, 30);
    check('Claude Brain', ok, ok ? `Responded: ${text}` : `HTTP ${r.status}`);
  } catch(e) {
    check('Claude Brain', false, e.message.slice(0, 60));
  }

  // 4. Telegram
  try {
    const body = JSON.stringify({ chat_id: CFG.tgChat, text: '🔬 Plumbing test: Telegram ✅' });
    const r = await req(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    }, 8000);
    check('Telegram', r.status === 200, r.status === 200 ? 'Message delivered' : `HTTP ${r.status}`);
  } catch(e) {
    check('Telegram', false, e.message.slice(0, 60));
  }

  // 5. Kelly Sizing
  const testKelly = kellySize(0.65, 0.40);
  check('Kelly Sizer', testKelly > 0 && testKelly <= S.balance * 0.10, `Test size: $${testKelly.toFixed(2)}`);

  // 6. Position Tracker
  check('Position Tracker', Array.isArray(S.openPositions), `${S.openPositions.length} positions tracked`);

  // 7. State Persistence
  try {
    saveState();
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    check('State Persistence', d.scanCount !== undefined, `state.json OK, scans=${d.scanCount}`);
  } catch(e) {
    check('State Persistence', false, e.message.slice(0, 60));
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const lines = results.map(r => `${r.ok ? '✅' : '❌'} <b>${r.name}</b>: ${r.detail}`).join('\n');
  const launchReady = failed === 0;

  tg(`🔬 <b>Plumbing Test Complete</b>
${passed}/${results.length} checks passed

${lines}

${launchReady
  ? '🟢 <b>LAUNCH READY</b> -- All systems operational'
  : `🔴 <b>NOT READY</b> -- ${failed} system(s) need attention`}

Mode: ${CFG.dryRun ? '📝 Paper (set DRY_RUN=false to go live)' : '🔴 LIVE'}
Open positions:
${S.openPositions.length > 0 ? S.openPositions.map(p => `  ${p.ticker} ${p.side} x${p.contracts}`).join('\n') : '  None'}`);
  // Also send to SSE
  ssePush('notify', { msg: 'Heartbeat: $' + bal.toFixed(2) + ' | ' + S.wins + 'W/' + S.losses + 'L', ts: Date.now() });;

  log(`Plumbing test: ${passed}/${results.length} passed`);
  return { passed, failed, launchReady, results };
}

let _botStarted = false;
async function startBot() {
  if (S.isRunning || _botStarted) { log('Already running -- ignoring duplicate start'); return; }
  _botStarted = true;
  S.isRunning = true;
  log('[M] KalshiBot v19.0 started -- running pre-flight sync...');

  // -- PRE-FLIGHT SYNC: establish true available cash BEFORE any trade can fire --
  // This prevents insufficient_balance errors on the very first brain cycle
  try {
    await syncBalance();
    await syncRestingOrders();
    await syncPositions();
    log(`Pre-flight complete: real=$${S.realBalance.toFixed(2)} available=$${S.availableCash.toFixed(2)} resting=${S.restingOrders.length}`);
  } catch(e) {
    log('Pre-flight sync failed: ' + e.message, 'WARN');
  }

  // Fire brain after just 30 seconds on first start (enough time for first sync)
  S.lastBrainAt = Date.now() - CFG.brainInterval + 30000;
  S.lastSuccessfulScan = Date.now(); // init watchdog timestamp

  const _startPosList = S.openPositions.length > 0
    ? '\nPositions: ' + S.openPositions.map(p => `${p.ticker} ${p.side} x${p.contracts}`).join(', ')
    : '\nNo open positions';
  tg(`🚀 <b>KalshiBot v19.0 Online</b>
Mode: ${CFG.dryRun ? '📝 Paper' : '🔴 LIVE'}
Real: $${S.realBalance > 0 ? S.realBalance.toFixed(2) : '...syncing'}
Available: $${S.availableCash.toFixed(2)} | Resting: ${S.restingOrders.length} orders
Max positions: ${dynamicMaxPos()} | Phase: ${getPhase().label}
⚡ FastPath + 🏀 Sports + 🧠 Brain engines active
Scan: ${CFG.scanInterval/1000}s | Brain: ${(dynamicBrainInterval()/60000).toFixed(1)}min | Heartbeat: ${CFG.heartbeatInterval/60000}min | Watchdog: 3min${_startPosList}`);

  scan();
  heartbeatTimer = setInterval(sendHeartbeat, CFG.heartbeatInterval);

  // ── WATCHDOG: alert if scans go silent for >3 minutes ──────────────────
  // Fires every 90s, checks if last successful scan was >3min ago
  watchdogTimer = setInterval(() => {
    if (!S.isRunning) return;
    const silentMs = Date.now() - (S.lastSuccessfulScan || S.startedAt || Date.now());
    if (silentMs > 3 * 60000) { // 3 min silence
      const silentMins = (silentMs / 60000).toFixed(1);
      log(`🚨 WATCHDOG: no successful scan in ${silentMins}min — restarting scan loop`, 'ERROR');
      tg(`🚨 <b>Watchdog Alert</b>\nNo scan for ${silentMins} minutes — restarting scan loop\nLast error: ${S.lastErr || 'none'}`);
      clearTimeout(scanTimer);
      S.lastSuccessfulScan = Date.now(); // reset to avoid spam
      scan(); // force restart
    }
  }, 90000);
  saveState();
}

function stopBot() {
  S.isRunning = false;
  _botStarted = false; // FIX: allow restart after stop
  clearTimeout(scanTimer);
  clearInterval(heartbeatTimer);
  clearInterval(watchdogTimer);
  log('Bot stopped');
  tg('⏹ <b>KalshiBot stopped</b>');
  saveState();
}

// --- DASHBOARD HTML --------------------------------------------------------

// --- DASHBOARD HTML --------------------------------------------------------
const DASHBOARD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="cache-control" content="no-cache,no-store,must-revalidate">
<title>KalshiBot</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#06060a;--s1:#0d0d12;--s2:#13131a;--s3:#1a1a24;
  --b:rgba(255,255,255,0.07);--b2:rgba(255,255,255,0.04);
  --txt:#eeeef5;--m:rgba(238,238,245,0.5);--m2:rgba(238,238,245,0.25);
  --g:#05d47c;--gd:rgba(5,212,124,0.12);--gg:rgba(5,212,124,0.22);
  --r:#ff3d5a;--rd:rgba(255,61,90,0.12);
  --bl:#4d8af0;--bld:rgba(77,138,240,0.12);
  --gold:#f5a623;--goldd:rgba(245,166,35,0.12);
  --sat:env(safe-area-inset-top,0px);--sab:env(safe-area-inset-bottom,0px);
  --font:'DM Sans',-apple-system,sans-serif;--mono:'DM Mono',monospace;
}
html,body{background:var(--bg);min-height:100%}
body{font-family:var(--font);color:var(--txt);-webkit-font-smoothing:antialiased;overflow-x:hidden}
.app{max-width:430px;margin:0 auto;padding-bottom:calc(68px + var(--sab))}

/* NAV */
.nav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;
  background:rgba(6,6,10,0.96);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border-top:1px solid var(--b);display:flex;padding-bottom:var(--sab);z-index:100}
.ni{flex:1;display:flex;flex-direction:column;align-items:center;padding:10px 0 6px;
  cursor:pointer;color:var(--m);gap:3px;transition:color .15s}
.ni.on{color:var(--txt)}
.ni-pip{width:20px;height:2px;background:var(--g);border-radius:0 0 2px 2px;opacity:0;margin-bottom:2px}
.ni.on .ni-pip{opacity:1}
.ni-lbl{font-size:10px;font-weight:500;letter-spacing:.01em}

/* PAGES */
.pg{display:none}.pg.on{display:block}

/* HOME */
.top{padding:calc(var(--sat)+14px) 20px 0;display:flex;align-items:center;justify-content:space-between}
.brand{font-size:14px;font-weight:600;color:var(--m)}
.pill{display:flex;align-items:center;gap:5px;padding:5px 11px;border-radius:20px;font-size:11px;font-weight:700}
.pill-live{background:var(--gd);color:var(--g);border:1px solid rgba(5,212,124,.25)}
.pill-paper{background:var(--goldd);color:var(--gold);border:1px solid rgba(245,166,35,.25)}
.pill-dot{width:6px;height:6px;border-radius:50%}

.hero{padding:18px 20px 0;text-align:center}
.hero-eye{font-size:11px;font-weight:600;color:var(--m2);text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px}
.hero-bal{font-size:52px;font-weight:700;letter-spacing:-2.5px;line-height:1.05;min-height:58px;display:flex;align-items:center;justify-content:center}
.hero-chip{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:600;padding:6px 16px;border-radius:22px;margin:10px 0 14px;background:var(--s3);color:var(--txt)}
.chip-up{background:var(--gd);color:var(--g)}
.chip-dn{background:var(--rd);color:var(--r)}
.hero-row{display:grid;grid-template-columns:1fr 1fr 1fr;background:var(--s1);border-radius:16px;border:1px solid var(--b);overflow:hidden}
.hcell{padding:11px 8px;text-align:center;border-right:1px solid var(--b)}
.hcell:last-child{border-right:none}
.hcell-lbl{font-size:9px;font-weight:700;color:var(--m2);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px}
.hcell-val{font-size:14px;font-weight:700}

.chart-wrap{padding:12px 0 0}
.tf-row{display:flex;gap:2px;padding:0 20px;margin-bottom:6px}
.tfb{flex:1;padding:7px;text-align:center;font-size:12px;font-weight:600;color:var(--m);background:none;border:none;border-radius:8px;cursor:pointer;font-family:var(--font)}
.tfb.on{background:var(--s3);color:var(--txt)}
svg#CH{width:100%;height:140px;display:block}

.stat-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:12px 20px 0}
.sc{background:var(--s1);border-radius:14px;padding:13px 11px;border:1px solid var(--b);display:flex;flex-direction:column;gap:4px;position:relative;overflow:hidden}
.sc-bar{position:absolute;top:0;left:0;right:0;height:2px}
.sc-lbl{font-size:9px;font-weight:700;color:var(--m2);text-transform:uppercase;letter-spacing:.1em}
.sc-val{font-size:18px;font-weight:700;letter-spacing:-.5px;line-height:1.1}
.sc-sub{font-size:10px;color:var(--m2)}

.act-row{display:flex;gap:10px;padding:12px 20px 0}
.abtn{flex:1;padding:15px;border-radius:14px;border:none;font-family:var(--font);font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center}
.abtn:active{transform:scale(.97)}
.abtn-go{background:var(--g);color:#000}
.abtn-stop{background:rgba(255,61,90,.15);color:var(--r);border:1px solid rgba(255,61,90,.3)}
.abtn-sync{flex:0;padding:15px 17px;background:var(--s2);color:var(--txt);border:1px solid var(--b);font-size:17px}
.abtn-purge{flex:0;padding:15px 14px;background:var(--s2);color:var(--gold);border:1px solid rgba(245,166,35,.3);font-size:15px}

.card{margin:10px 20px 0;background:var(--s1);border-radius:18px;border:1px solid var(--b);overflow:hidden}
.card-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px 0}
.card-title{font-size:11px;font-weight:700;color:var(--m2);text-transform:uppercase;letter-spacing:.1em}
.cbadge{font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px}
.cb-g{background:var(--gd);color:var(--g);border:1px solid rgba(5,212,124,.2)}
.cb-gold{background:var(--goldd);color:var(--gold)}
.cb-muted{background:var(--s3);color:var(--m)}

.eng-body{display:flex;align-items:center;gap:11px;padding:11px 15px 13px}
.eng-dot{width:9px;height:9px;border-radius:50%;background:var(--m2);flex-shrink:0}
.eng-dot.on{background:var(--g);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 var(--gg)}70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}
.eng-name{font-size:15px;font-weight:600}
.eng-sub{font-size:12px;color:var(--m);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.j-body{padding:11px 15px 14px}
.j-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px}
.j-phase{font-size:19px;font-weight:700;letter-spacing:-.5px}
.j-desc{font-size:12px;color:var(--m);margin-top:2px;line-height:1.3;max-width:185px}
.j-tgt{text-align:right}
.j-tgt-lbl{font-size:9px;font-weight:700;color:var(--m2);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px}
.j-tgt-val{font-size:21px;font-weight:700;color:var(--gold)}
.j-track{height:7px;background:var(--s3);border-radius:4px;overflow:hidden;margin-bottom:7px}
.j-fill{height:100%;background:linear-gradient(90deg,var(--g),#00ff88);border-radius:4px;transition:width .8s}
.j-meta{display:flex;justify-content:space-between;margin-bottom:12px}
.j-pct{font-size:13px;font-weight:700;color:var(--g)}
.j-left{font-size:12px;color:var(--m)}
.j-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--b2);border-radius:11px;overflow:hidden;margin-top:10px}
.jstat{background:var(--s2);padding:9px 7px;text-align:center}
.jstat-lbl{font-size:9px;font-weight:700;color:var(--m2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px}
.jstat-val{font-size:13px;font-weight:700}
.cg{color:var(--g)}.cr{color:var(--r)}.cgold{color:var(--gold)}.cbl{color:var(--bl)}.cm{color:var(--m)}

.brain-body{padding:9px 15px 13px}
.brain-txt{font-size:13px;line-height:1.5;color:rgba(238,238,245,.75);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}

/* TRADE PAGE */
.ph{padding:calc(var(--sat)+16px) 20px 10px}
.pt{font-size:29px;font-weight:700;letter-spacing:-1px}
.psub{font-size:13px;color:var(--m);margin-top:2px}
.sec-lbl{padding:4px 20px 5px;font-size:11px;font-weight:700;color:var(--m2);text-transform:uppercase;letter-spacing:.12em}
.pos-card{background:var(--s1);border-radius:15px;margin:0 20px 8px;border:1px solid var(--b);overflow:hidden}
.pos-inner{display:flex;align-items:center;gap:11px;padding:13px 13px 9px}
.pos-ico{width:42px;height:42px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;background:var(--s3);border:1px solid var(--b2)}
.ico-btc{background:rgba(247,147,26,.12);border-color:rgba(247,147,26,.2)}
.ico-eth{background:rgba(98,126,234,.12);border-color:rgba(98,126,234,.2)}
.ico-nba{background:rgba(29,66,138,.18);border-color:rgba(29,66,138,.25)}
.ico-cpi{background:var(--bld);border-color:rgba(77,138,240,.2)}
.pos-info{flex:1;min-width:0}
.pos-tick{font-size:13px;font-weight:700;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pos-tags{display:flex;align-items:center;gap:5px;margin-top:4px}
.stag{padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700}
.stag-y{background:var(--gd);color:var(--g)}.stag-n{background:var(--rd);color:var(--r)}
.pos-meta{font-size:10px;color:var(--m)}
.pos-r{text-align:right;flex-shrink:0;min-width:68px}
.pos-price{font-size:19px;font-weight:700}
.pos-cost{font-size:11px;color:var(--m);margin-top:1px}
.pos-pnl{font-size:12px;font-weight:600;margin-top:1px}
.ppos{color:var(--g)}.pneg{color:var(--r)}.pzero{color:var(--m2)}
.pos-foot{display:flex;justify-content:space-between;padding:7px 13px;border-top:1px solid var(--b2);background:var(--s2)}
.pf{display:flex;flex-direction:column;gap:2px}
.pf-lbl{font-size:9px;font-weight:700;color:var(--m2);text-transform:uppercase;letter-spacing:.08em}
.pf-val{font-size:12px;font-weight:600;color:var(--m)}

.sig-card{background:var(--s1);border-radius:13px;margin:0 20px 8px;padding:13px;border:1px solid var(--b);border-left:3px solid var(--g)}
.sig-no{border-left-color:var(--r)}
.sig-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:7px}
.sig-tick{font-size:14px;font-weight:700;font-family:var(--mono)}
.sig-reas{font-size:12px;color:var(--m);line-height:1.4;margin-bottom:7px}
.sig-stats{display:flex;gap:10px;flex-wrap:wrap}
.ss{font-size:11px;color:var(--m2)}.ss strong{color:var(--txt);font-weight:600}

/* ACTIVITY */
.f-row{display:flex;gap:8px;padding:0 20px 12px;overflow-x:auto;scrollbar-width:none}
.f-row::-webkit-scrollbar{display:none}
.fchip{padding:7px 13px;border-radius:20px;background:var(--s2);font-size:13px;font-weight:500;color:var(--m);cursor:pointer;border:1px solid transparent;font-family:var(--font)}
.fchip.on{background:rgba(255,255,255,.07);color:var(--txt);border-color:var(--b)}
.tx-mon{padding:5px 20px 3px;font-size:13px;font-weight:600;color:var(--m)}
.tx-row{display:flex;align-items:center;padding:12px 20px;gap:11px}
.tx-ico{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;font-weight:700}
.tiw{background:var(--gd);color:var(--g)}.til{background:var(--rd);color:var(--r)}.tio{background:var(--bld);color:var(--bl)}
.tx-info{flex:1;min-width:0}
.tx-ttl{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-sub{font-size:12px;color:var(--m);margin-top:2px}
.tx-r{text-align:right;flex-shrink:0}
.tx-amt{font-size:15px;font-weight:700}
.ta-p{color:var(--g)}.ta-n{color:var(--r)}.ta-z{color:var(--m)}
.tx-time{font-size:11px;color:var(--m2);margin-top:2px}
.tx-div{height:1px;background:var(--b2);margin:0 20px}

/* PREDICT */
.mkt-card{background:var(--s1);border-radius:13px;margin:0 20px 8px;padding:13px;border:1px solid var(--b)}
.mkt-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:9px}
.mkt-ttl{font-size:13px;font-weight:600;line-height:1.3;flex:1}
.mkt-exp{font-size:11px;color:var(--m);flex-shrink:0}
.mkt-exp.soon{color:var(--gold)}
.mkt-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}
.mkt-yes{font-size:21px;font-weight:700;color:var(--g)}
.mkt-nr{text-align:right}
.mkt-no{font-size:13px;font-weight:600;color:var(--r)}
.mkt-vol{font-size:10px;color:var(--m2);margin-top:1px}
.mkt-track{height:4px;background:rgba(255,61,90,.2);border-radius:3px;overflow:hidden}
.mkt-fill{height:100%;background:var(--g);border-radius:3px}
.mbadge{display:inline-flex;font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;margin-top:7px}
.mb-hi{background:var(--gd);color:var(--g)}.mb-med{background:var(--goldd);color:var(--gold)}

/* SETTINGS */
.set-wrap{padding:calc(var(--sat)+16px) 20px 0}
.set-ttl{font-size:29px;font-weight:700;letter-spacing:-1px;margin-bottom:18px}
.ssec{margin-bottom:16px}
.ssec-lbl{font-size:11px;font-weight:700;color:var(--m2);text-transform:uppercase;letter-spacing:.12em;margin-bottom:7px;padding:0 4px}
.sgrp{background:var(--s1);border-radius:17px;overflow:hidden;border:1px solid var(--b)}
.srow{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid var(--b2)}
.srow:last-child{border-bottom:none}
.sn{font-size:15px;font-weight:500}
.sv{font-size:14px;font-weight:600;color:var(--m)}
.sv-g{color:var(--g)}.sv-r{color:var(--r)}.sv-gold{color:var(--gold)}
.log-wrap{background:var(--s1);border-radius:17px;padding:13px;border:1px solid var(--b);max-height:220px;overflow-y:auto;font-family:var(--mono);font-size:11px;color:rgba(238,238,245,.4);line-height:1.6}
.log-ts{color:var(--m2);margin-right:5px}
.log-err{color:rgba(255,61,90,.7)}.log-warn{color:rgba(245,166,35,.7)}

.empty{text-align:center;padding:36px 20px;color:var(--m);font-size:14px}
.gap{height:10px}

/* TOASTS */
.toast{position:fixed;top:calc(var(--sat)+14px);left:50%;transform:translateX(-50%) translateY(-90px);
  max-width:370px;width:calc(100% - 40px);padding:11px 16px;border-radius:14px;
  font-size:13px;font-weight:500;line-height:1.4;z-index:9999;text-align:center;
  background:var(--s2);color:var(--txt);border:1px solid var(--b);
  box-shadow:0 12px 40px rgba(0,0,0,.6);opacity:0;
  transition:transform .35s cubic-bezier(.34,1.56,.64,1),opacity .3s}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.toast-error{background:rgba(255,61,90,.15);border-color:rgba(255,61,90,.3);color:var(--r)}
.toast-warn{background:rgba(245,166,35,.12);border-color:rgba(245,166,35,.25);color:var(--gold)}
.toast-win,.toast-signal{background:rgba(5,212,124,.12);border-color:rgba(5,212,124,.25);color:var(--g)}
.toast-trade{background:rgba(77,138,240,.12);border-color:rgba(77,138,240,.25);color:var(--bl)}

/* LIVE FEED */
.live-feed{margin:0 20px 10px;background:var(--s1);border-radius:14px;border:1px solid var(--b);overflow:hidden;max-height:210px;overflow-y:auto}
.lf-row{display:flex;align-items:flex-start;gap:9px;padding:8px 13px;border-bottom:1px solid var(--b2);min-height:32px}
.lf-row:last-child{border-bottom:none}
.lf-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:5px}
.lf-g{background:var(--g)}.lf-r{background:var(--r)}.lf-gold{background:var(--gold)}.lf-m{background:var(--m2)}
.lf-msg{font-size:12px;color:var(--m);line-height:1.4;flex:1;word-break:break-word}
.lf-ts{font-size:10px;color:var(--m2);flex-shrink:0;font-family:var(--mono);margin-top:2px;white-space:nowrap}
.lf-empty{padding:18px 16px;font-size:13px;color:var(--m2);text-align:center}
</style>
</head>
<body>
<div class="app">

<!-- HOME -->
<div id="pg-home" class="pg on">
  <div class="top">
    <div class="brand">KalshiBot <span id="connDot" title="Connecting..." style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--m2);vertical-align:middle;margin-left:3px;transition:background .5s"></span></div>
    <div id="modePill" class="pill __INIT_PILL__"><div id="pillDot" class="pill-dot"></div><span id="pillTxt">__INIT_MODE__</span></div>
  </div>
  <div class="hero">
    <div class="hero-eye">Portfolio Value</div>
    <div id="heroBal" class="hero-bal">__INIT_BAL__</div>
    <div id="heroChip" class="hero-chip"><span id="heroArr">^</span>&nbsp;<span id="heroChg">loading...</span></div>
    <div class="hero-row">
      <div class="hcell"><div class="hcell-lbl">Real</div><div class="hcell-val cm" id="heroReal">__INIT_REAL__</div></div>
      <div class="hcell"><div class="hcell-lbl">Peak</div><div class="hcell-val cm" id="heroPeak">__INIT_PEAK__</div></div>
      <div class="hcell"><div class="hcell-lbl">P&L</div><div class="hcell-val cg" id="heroPnl">...</div></div>
    </div>
  </div>
  <div class="chart-wrap">
    <div class="tf-row">
      <button class="tfb" onclick="setTF(this,'1H')">1H</button>
      <button class="tfb on" onclick="setTF(this,'1D')">1D</button>
      <button class="tfb" onclick="setTF(this,'1W')">1W</button>
      <button class="tfb" onclick="setTF(this,'ALL')">ALL</button>
    </div>
    <svg id="CH" viewBox="0 0 430 140" preserveAspectRatio="none"></svg>
  </div>
  <div class="stat-row">
    <div class="sc"><div id="wrBar" class="sc-bar" style="background:var(--m2)"></div><div class="sc-lbl">Win Rate</div><div id="statWR" class="sc-val cm">--</div><div id="statWRsub" class="sc-sub">-- trades</div></div>
    <div class="sc"><div id="todayBar" class="sc-bar" style="background:var(--m2)"></div><div class="sc-lbl">Today P&L</div><div id="statToday" class="sc-val cm">$0.00</div><div id="statTodaySub" class="sc-sub">all-time</div></div>
    <div class="sc"><div class="sc-bar" style="background:var(--bl)"></div><div class="sc-lbl">Positions</div><div id="statPos" class="sc-val">0</div><div id="statPosSub" class="sc-sub">of 5 max</div></div>
  </div>
  <div class="act-row">
    <button class="abtn abtn-go" id="startBtn" onclick="toggleBot()">Start</button>
    <button class="abtn abtn-stop" id="stopBtn" onclick="toggleBot()" style="display:none">Stop</button>
    <button class="abtn abtn-sync" id="syncBtn" onclick="doSync()">&#8635;</button>
    <button class="abtn abtn-purge" id="purgeBtn" onclick="doPurge()" title="Purge stale positions">🗑</button>
    <button class="abtn" id="breakerBtn" onclick="resetBreaker()" title="Clear circuit breaker" style="background:rgba(255,61,90,.18);color:var(--r);border:1px solid rgba(255,61,90,.3);display:none">🔴 Reset</button>
  </div>
  <div class="card">
    <div class="card-head"><div class="card-title">Engine</div><div id="modeBadge" class="cbadge cb-muted">PAPER</div></div>
    <div class="eng-body"><div id="engDot" class="eng-dot"></div><div style="flex:1;min-width:0"><div id="engName" class="eng-name">__INIT_RUNNING__</div><div id="engSub" class="eng-sub">Scan #__INIT_SCANS__</div></div></div>
  </div>
  <div class="card">
    <div class="card-head"><div class="card-title">Road to $500K</div><div id="homePhase" class="cbadge cb-gold">__INIT_PHASE__</div></div>
    <div class="j-body">
      <div class="j-top">
        <div><div id="jPhase" class="j-phase">--</div><div id="jDesc" class="j-desc">--</div></div>
        <div class="j-tgt"><div class="j-tgt-lbl">Next Target</div><div id="jNext" class="j-tgt-val">$--</div></div>
      </div>
      <div class="j-track"><div id="jFill" class="j-fill" style="width:0%"></div></div>
      <div class="j-meta"><div id="jPct" class="j-pct">0.0%</div><div id="jLeft" class="j-left">-- doublings left</div></div>
      <div class="j-stats">
        <div class="jstat"><div class="jstat-lbl">Doublings</div><div id="jDone" class="jstat-val cg">0x</div></div>
        <div class="jstat"><div class="jstat-lbl">Kelly</div><div id="jKelly" class="jstat-val cgold">--</div></div>
        <div class="jstat"><div class="jstat-lbl">Min Edge</div><div id="jEdge" class="jstat-val cbl">--</div></div>
      </div>
    </div>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-head"><div class="card-title">AI Brain</div><div id="brainBadge" class="cbadge cb-muted">Signal #0</div></div>
    <div class="brain-body"><div id="brainTxt" class="brain-txt">Waiting...</div></div>
  </div>
  <div style="text-align:center;font-size:9px;color:rgba(238,238,245,.1);padding:8px;font-family:monospace">KalshiBot v10 -- SSE live push</div>
  <div class="gap"></div>
</div>

<!-- TRADE -->
<div id="pg-trade" class="pg">
  <div class="ph"><div class="pt">Positions</div><div id="tradeSub" class="psub">0 open</div></div>
  <div id="posList"><div class="empty">No open positions</div></div>
  <div class="sec-lbl" style="margin-top:6px">Recent Signals</div>
  <div id="sigList"><div class="empty" style="padding:14px 20px">No signals yet</div></div>
  <div class="gap"></div>
</div>

<!-- ACTIVITY -->
<div id="pg-activity" class="pg">
  <div class="ph" style="padding-bottom:4px"><div class="pt">Activity</div></div>
  <div class="sec-lbl" style="margin-top:2px;padding-top:4px">Live Feed</div>
  <div id="liveFeed" class="live-feed"><div class="lf-empty">Start the bot to see live events</div></div>
  <div class="f-row">
    <button class="fchip on" onclick="filt('all',this)">All</button>
    <button class="fchip" onclick="filt('win',this)">Wins</button>
    <button class="fchip" onclick="filt('loss',this)">Losses</button>
    <button class="fchip" onclick="filt('open',this)">Open</button>
  </div>
  <div id="txFeed"></div>
</div>

<!-- PREDICT -->
<div id="pg-predict" class="pg">
  <div class="ph"><div class="pt">Markets</div><div class="psub">Ranked by edge</div></div>
  <div id="mktList"><div class="empty">Loading...</div></div>
  <div class="gap"></div>
</div>

<!-- SETTINGS -->
<div id="pg-settings" class="pg">
  <div class="set-wrap">
    <div class="set-ttl">Settings</div>
    <div class="ssec"><div class="ssec-lbl">Portfolio</div>
      <div class="sgrp">
        <div class="srow"><div class="sn">Real Balance</div><div id="cfgReal" class="sv sv-g">$--</div></div>
        <div class="srow"><div class="sn">Available Cash</div><div id="cfgAvail" class="sv sv-g">$--</div></div>
        <div class="srow"><div class="sn">Peak Balance</div><div id="cfgPeak" class="sv">$--</div></div>
        <div class="srow"><div class="sn">All-time P&L</div><div id="cfgPnl" class="sv">$0.00</div></div>
      </div>
    </div>
    <div class="ssec"><div class="ssec-lbl">Performance</div>
      <div class="sgrp">
        <div class="srow"><div class="sn">Win Rate</div><div id="cfgWR" class="sv sv-g">--</div></div>
        <div class="srow"><div class="sn">Win / Loss</div><div id="cfgWL" class="sv">--</div></div>
        <div class="srow"><div class="sn">Today P&L</div><div id="cfgToday" class="sv">$0.00</div></div>
        <div class="srow"><div class="sn">Scans</div><div id="cfgScans" class="sv">--</div></div>
        <div class="srow"><div class="sn">Brain Cycles</div><div id="cfgBrain" class="sv">--</div></div>
        <div class="srow"><div class="sn">Daily Growth Rate</div><div id="cfgCompound" class="sv sv-g">--</div></div>
        <div class="srow"><div class="sn">API Spend</div><div id="cfgSpend" class="sv sv-gold">$0.00</div></div>
      </div>
    </div>
    <div class="ssec"><div class="ssec-lbl">Config</div>
      <div class="sgrp">
        <div class="srow"><div class="sn">Mode</div><div id="cfgMode" class="sv">--</div></div>
        <div class="srow"><div class="sn">Phase</div><div id="cfgPhase" class="sv sv-gold">--</div></div>
        <div class="srow"><div class="sn">Max Positions</div><div id="cfgMax" class="sv">--</div></div>
        <div class="srow"><div class="sn">Open / Max</div><div id="cfgOpen" class="sv">--</div></div>
        <div class="srow"><div class="sn">Brain Interval</div><div id="cfgBrainInt" class="sv">--</div></div>
      </div>
    </div>
    <div class="ssec"><div class="ssec-lbl">Live Log</div>
      <div id="logWrap" class="log-wrap">Loading...</div>
    </div>
    <div class="gap"></div>
  </div>
</div>

</div><!-- .app -->

<!-- NAV -->
<nav class="nav">
  <div class="ni on" onclick="nav('home',this)"><div class="ni-pip"></div><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 12L5 10M5 10L12 3L19 10M5 10V20a1 1 0 001 1h3m10-11V20a1 1 0 01-1 1h-3m-6 0V15a1 1 0 011-1h2a1 1 0 011 1v6m-4 0h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="ni-lbl">Home</div></div>
  <div class="ni" onclick="nav('trade',this)"><div class="ni-pip"></div><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="16 7 22 7 22 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="ni-lbl">Trade</div></div>
  <div class="ni" onclick="nav('activity',this)"><div class="ni-pip"></div><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.8"/><line x1="8" y1="9" x2="16" y2="9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="8" y1="13" x2="16" y2="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="8" y1="17" x2="12" y2="17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><div class="ni-lbl">Activity</div></div>
  <div class="ni" onclick="nav('predict',this)"><div class="ni-pip"></div><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M2 12h4M18 12h4M12 2v4M12 18v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><div class="ni-lbl">Predict</div></div>
  <div class="ni" onclick="nav('settings',this)"><div class="ni-pip"></div><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" stroke-width="1.8"/></svg><div class="ni-lbl">Settings</div></div>
</nav>

<script>
/* KalshiBot v10 Dashboard - Complete Rewrite */
var KB = {
  api: '',
  state: null,
  chart: [],
  allTx: [],
  feed: [],
  tf: '1D',
  txf: 'all',
  loaded: false,
  retries: 0,
  pollTimer: null,
  sse: null,
  prevLogKey: '',
  lastBrain: 0,
  lastWins: 0,
  chartSeeded: false,
  sessionStart: Date.now(),
  VERSION: '20260411P'
};

/* ---- UTILS ---- */
function g(id) { return document.getElementById(id); }
function st(id, v) { var e = g(id); if (e) e.textContent = String(v != null ? v : ''); }
function ss(id, p, v) { var e = g(id); if (e) e.style[p] = v; }
function fm(n) { var x = isFinite(+n) ? Math.abs(+n) : 0; return '$' + x.toFixed(2); }
function fmBig(n) {
  if (!isFinite(+n)) return '$0';
  var x = Math.abs(+n);
  if (x >= 1000) return '$' + (x/1000).toFixed(1) + 'K';
  return '$' + x.toFixed(2);
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function timeAgo(ts) {
  if (!ts) return '--';
  var sec = Math.floor((Date.now()-ts)/1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec/60) + 'm ago';
  if (sec < 86400) return Math.floor(sec/3600) + 'h ago';
  return Math.floor(sec/86400) + 'd ago';
}
function catIcon(ticker) {
  ticker = ticker || '';
  if (/KXBTC|KXETH|KXSOL|KXXRP|KXDOGE|KXBNB|KXAVAX/i.test(ticker)) return {e:'₿', c:'ico-btc', label:'Crypto'};
  if (/KXNBA|KXNHL|KXMLB|KXNFL|KXMMA|KXGOLF|KXTENNIS|KXSOCCER/i.test(ticker)) return {e:'🏆', c:'ico-nba', label:'Sports'};
  if (/KXHIGH|KXTEMP|KXRAIN|KXSNOW/i.test(ticker)) return {e:'🌤', c:'ico-cpi', label:'Weather'};
  if (/KXCPI|KXPCE|FED|FEDRATE|INFL|KXGDP|KXJOBS|KXUNEMPLOYMENT/i.test(ticker)) return {e:'📈', c:'ico-cpi', label:'Macro'};
  if (/KXPREZ|KXSENATE|KXHOUSE|KXTARIFF|KXAPPROVAL/i.test(ticker)) return {e:'🏛', c:'ico-cpi', label:'Politics'};
  if (/INXD|NASDAQ|KXSPX|KXVIX|SP500/i.test(ticker)) return {e:'📊', c:'ico-cpi', label:'Index'};
  return {e:'~', c:'', label:'Other'};
}

/* ---- TOAST ---- */
function toast(msg, type) {
  try {
    var t = document.createElement('div');
    t.className = 'toast toast-' + (type || 'info');
    t.textContent = String(msg || '').slice(0, 90);
    document.body.appendChild(t);
    setTimeout(function() { t.classList.add('show'); }, 10);
    setTimeout(function() { t.classList.remove('show'); setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 350); }, 3800);
  } catch(e) {}
}

/* ---- LIVE FEED ---- */
function pushFeed(msg, type) {
  if (!msg) return;
  var ts = new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'});
  KB.feed.unshift({msg: String(msg).slice(0, 200), type: type||'info', ts: ts});
  if (KB.feed.length > 80) KB.feed.pop();
  renderFeed();
}
function renderFeed() {
  var w = g('liveFeed'); if (!w) return;
  if (!KB.feed.length) { w.innerHTML = '<div class="lf-empty">No events yet</div>'; return; }
  w.innerHTML = KB.feed.slice(0, 30).map(function(f) {
    var dc = f.type==='win'?'lf-g':f.type==='loss'||f.type==='error'?'lf-r':f.type==='brain'?'lf-g':f.type==='trade'?'lf-gold':'lf-m';
    return '<div class="lf-row"><span class="lf-dot '+dc+'"></span><span class="lf-msg">'+esc(f.msg)+'</span><span class="lf-ts">'+f.ts+'</span></div>';
  }).join('');
}

/* ---- SSE ---- */
function sseConnect() {
  try {
    if (KB.sse) { try { KB.sse.close(); } catch(e) {} }
    var es = new EventSource(KB.api + '/api/events');
    KB.sse = es;
    es.addEventListener('update', function() { clearTimeout(KB.pollTimer); KB.pollTimer = setTimeout(loadState, 300); });
    es.addEventListener('notify', function(ev) {
      try {
        var d = JSON.parse(ev.data);
        var m = d.msg || '';
        var type = /WIN|profit/i.test(m)?'win':/LOSS|error/i.test(m)?'loss':/Brain|signal/i.test(m)?'brain':/Order|trade/i.test(m)?'trade':'info';
        pushFeed(m, type);
        if (/WIN|LOSS|Order|Brain|Alert/i.test(m)) toast(m.slice(0, 80), type);
      } catch(ex) {}
    });
    es.onopen = function() {
      var d = g('connDot'); if (d) { d.style.background = 'var(--g)'; d.title = 'Live'; }
      startPoll(8000);
    };
    es.onerror = function() {
      var d = g('connDot'); if (d) { d.style.background = 'var(--r)'; d.title = 'Reconnecting'; }
      startPoll(4000);
      setTimeout(sseConnect, 20000);
    };
  } catch(ex) { startPoll(4000); }
}
function startPoll(ms) {
  if (KB.pollTimer) clearTimeout(KB.pollTimer);
  KB.pollTimer = setTimeout(function loop() {
    loadState().then(function() { KB.pollTimer = setTimeout(loop, ms||5000); });
  }, 0);
}

/* ---- NAV ---- */
function nav(id, el) {
  document.querySelectorAll('.pg').forEach(function(p) { p.classList.remove('on'); });
  document.querySelectorAll('.ni').forEach(function(n) { n.classList.remove('on'); });
  var pg = g('pg-' + id); if (pg) pg.classList.add('on');
  if (el) el.classList.add('on');
  if (id === 'activity') { renderTx(); renderFeed(); }
  if (id === 'predict') renderMkts();
}

/* ---- CHART ---- */
function seedChartFromHistory(history) {
  if (!history || !history.length) return;
  // Merge server history into KB.chart, deduplicating by timestamp
  var existing = new Set(KB.chart.map(function(p){return p.t;}));
  history.forEach(function(p) {
    if (p.v > 0 && isFinite(p.v) && !existing.has(p.t)) {
      KB.chart.push({t: p.t, v: p.v});
      existing.add(p.t);
    }
  });
  KB.chart.sort(function(a,b){return a.t-b.t;});
  if (KB.chart.length > 1000) KB.chart = KB.chart.slice(-1000);
  drawChart();
}
function pushPt(v) {
  if (!isFinite(v) || v <= 0) return;
  // Only add a new point if value changed, or 5+ min since last point
  var last = KB.chart[KB.chart.length - 1];
  if (last && last.v === +v && (Date.now() - last.t) < 60000) { drawChart(); return; }
  KB.chart.push({t: Date.now(), v: +v});
  if (KB.chart.length > 1000) KB.chart.shift();
  drawChart();
}
function drawChart() {
  var svg = g('CH'); if (!svg) return;
  var cuts = {'1H':3600000,'1D':86400000,'1W':604800000,'ALL':1e15};
  var now = Date.now();
  var d = KB.chart.filter(function(p) { return p.v > 0 && now - p.t < (cuts[KB.tf]||1e15); });
  // Always need at least 2 points to draw — synthesize a start if needed
  if (d.length === 1) { d = [{t: d[0].t - 600000, v: d[0].v}, d[0]]; }
  if (d.length === 0) {
    svg.innerHTML = '<text x="215" y="75" text-anchor="middle" fill="rgba(238,238,245,0.15)" font-size="12" font-family="DM Mono">Waiting for data...</text>';
    return;
  }
  var W=430, H=140, pad=12;
  var vs = d.map(function(p){return p.v;});
  var mn = Math.min.apply(null,vs), mx = Math.max.apply(null,vs);
  // When balance is flat (all points equal), show a centered green line instead of broken chart
  var isFlat = (mx - mn) < 0.005;
  var rng = isFlat ? (mx * 0.10) : (mx - mn); // use 10% of value as range when flat
  var midY = isFlat ? (H / 2) : undefined;
  function tx(i){return pad+(i/(Math.max(d.length-1,1)))*(W-pad*2);}
  function ty(v){ if(isFlat) return H/2; return H-pad-((v-mn)/rng)*(H-pad*2-10); }
  var up = d[d.length-1].v >= d[0].v, col = up?'#05d47c':'#ff3d5a';
  var area='M'+pad+','+(H+4)+' L'+pad+','+ty(d[0].v)+' '+d.map(function(p,i){return'L'+tx(i)+','+ty(p.v);}).join(' ')+' L'+(W-pad)+','+(H+4)+'Z';
  var line='M'+d.map(function(p,i){return tx(i)+','+ty(p.v);}).join(' L');
  var lx=tx(d.length-1),ly=ty(d[d.length-1].v);
  // Add min/max labels
  var mxLabel='$'+mx.toFixed(2), mnLabel='$'+mn.toFixed(2);
  svg.innerHTML='<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+col+'" stop-opacity="0.2"/><stop offset="90%" stop-color="'+col+'" stop-opacity="0"/></linearGradient></defs>'
    +'<path d="'+area+'" fill="url(#cg)"/>'
    +'<path d="'+line+'" fill="none" stroke="'+col+'" stroke-width="2" stroke-linecap="round"/>'
    +'<circle cx="'+lx+'" cy="'+ly+'" r="4" fill="'+col+'"/>'
    +'<circle cx="'+lx+'" cy="'+ly+'" r="9" fill="'+col+'" opacity="0.2"/>'
    +'<text x="'+(W-pad)+'" y="'+(ty(mx)+4)+'" text-anchor="end" fill="'+col+'" font-size="9" font-family="DM Mono">'+mxLabel+'</text>'
    +'<text x="'+(W-pad)+'" y="'+(ty(mn)+4)+'" text-anchor="end" fill="rgba(238,238,245,0.3)" font-size="9" font-family="DM Mono">'+mnLabel+'</text>';
}
function setTF(el, t) {
  KB.tf = t;
  document.querySelectorAll('.tfb').forEach(function(b){b.classList.remove('on');});
  el.classList.add('on');
  drawChart();
}

/* ---- POSITIONS ---- */
function renderPos(positions) {
  var w = g('posList'), sub = g('tradeSub'); if (!w) return;
  if (!positions || !positions.length) {
    w.innerHTML = '<div class="empty">No open positions</div>';
    if (sub) sub.textContent = '0 open'; return;
  }
  if (sub) sub.textContent = positions.length + ' open';
  w.innerHTML = positions.map(function(p) {
    var isY = (p.side||'YES').toUpperCase() === 'YES';
    var ep = +(p.entryPrice||50), ct = +(p.contracts||1);
    var cost = +(p.cost||(ep*ct/100)), pnl = +(p.pnl||0);
    var hrs = p.openedAt ? Math.max(0, Math.round((Date.now()-p.openedAt)/3600000)) : 0;
    var conf = p.confidence ? Math.round(p.confidence*100)+'%' : '--';
    var ic = catIcon(p.ticker);
    var pc = pnl>0?'ppos':pnl<0?'pneg':'pzero';
    // Net payout ratio: ((100-price)/price) * 0.955
    var netPayout = ep > 0 ? (((100-ep)/ep)*0.955).toFixed(2) : '--';
    var maxReturn = ep > 0 ? (ct * (100-ep) / 100).toFixed(2) : '--';
    var payoutColor = parseFloat(netPayout) >= 2.0 ? 'var(--g)' : parseFloat(netPayout) >= 1.5 ? 'var(--gold)' : 'var(--r)';
    return '<div class="pos-card"><div class="pos-inner">'
      +'<div class="pos-ico '+ic.c+'" title="'+ic.label+'"><span style="font-size:16px">'+ic.e+'</span></div>'
      +'<div class="pos-info">'
      +'<div class="pos-cat" style="font-size:9px;color:var(--m2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px">'+ic.label+'</div>'
      +'<div class="pos-tick">'+esc(p.ticker||'--')+'</div>'
      +'<div class="pos-tags"><span class="stag '+(isY?'stag-y':'stag-n')+'">'+(isY?'YES':'NO')+'</span>'
      +'<span class="pos-meta">'+ct+' ct @ '+ep+'c</span></div>'
      +'<div style="margin-top:3px;font-size:11px;font-weight:700;color:'+payoutColor+'">'+netPayout+'x payout → max $'+maxReturn+'</div>'
      +'</div>'
      +'<div class="pos-r"><div class="pos-price">'+ep+'c</div>'
      +'<div class="pos-cost">'+fm(cost)+'</div>'
      +'<div class="pos-pnl '+pc+'">'+(pnl>=0?'+':'')+fm(Math.abs(pnl))+'</div></div>'
      +'</div><div class="pos-foot">'
      +'<div class="pf"><div class="pf-lbl">Conf</div><div class="pf-val">'+conf+'</div></div>'
      +'<div class="pf"><div class="pf-lbl">Open</div><div class="pf-val">'+hrs+'h</div></div>'
      +'<div class="pf"><div class="pf-lbl">Cost</div><div class="pf-val">'+fm(cost)+'</div></div>'
      +'</div></div>';
  }).join('');
}

/* ---- SIGNALS ---- */
function renderSigs(sigs) {
  var w = g('sigList'); if (!w) return;
  if (!sigs || !sigs.length) { w.innerHTML = '<div class="empty" style="padding:14px 20px">No signals — brain scanning...</div>'; return; }
  w.innerHTML = sigs.slice(0, 5).map(function(s) {
    var isY = (s.side||'YES').toUpperCase() === 'YES';
    var ic = catIcon(s.ticker);
    var mktPct = s.marketPrice ? (s.marketPrice*100).toFixed(0) : '--';
    var payoutX = s.marketPrice > 0 ? ((1/s.marketPrice)-1).toFixed(2) : '--';
    var netEdge = s.feeAdjustedEdge || s.edge || 0;
    return '<div class="sig-card '+(isY?'':'sig-no')+'">'
      +'<div class="sig-top">'
      +'<div style="display:flex;align-items:center;gap:6px">'
      +'<span style="font-size:16px">'+ic.e+'</span>'
      +'<div><div class="sig-tick">'+esc(s.ticker||'--')+'</div>'
      +'<div style="font-size:9px;color:var(--m2);text-transform:uppercase">'+ic.label+'</div></div></div>'
      +'<span class="stag '+(isY?'stag-y':'stag-n')+'">'+(s.side||'YES')+'</span></div>'
      +'<div class="sig-reas">'+esc(s.reasoning||'--')+'</div>'
      +'<div class="sig-stats">'
      +'<div class="ss">Conf <strong>'+(Math.round((s.confidence||0)*100))+'%</strong></div>'
      +'<div class="ss">Net edge <strong>'+(netEdge*100).toFixed(1)+'%</strong></div>'
      +'<div class="ss">Size <strong>'+fm(s.kellySize||0)+'</strong></div>'
      +'<div class="ss">Payout <strong>'+payoutX+'x</strong></div>'
      +'</div></div>';
  }).join('');
}

/* ---- MARKETS ---- */
function renderMkts() {
  var w = g('mktList'); if (!w) return;
  if (!KB.state || !KB.state.topMarkets || !KB.state.topMarkets.length) {
    w.innerHTML = '<div class="empty">'+(KB.state?'Scanner active...':'Loading...')+'</div>'; return;
  }
  w.innerHTML = KB.state.topMarkets.slice(0, 15).map(function(m) {
    var yp=Math.round((m.yesAsk||0)*100), np=100-yp;
    var hl=+(m.hoursLeft||999), soon=hl<24;
    var hlStr=hl<999?(hl<1?'<1h':hl<24?Math.round(hl)+'h':Math.floor(hl/24)+'d'):'--';
    var edge=+(m.edge||0);
    var ic = catIcon(m.ticker);
    // Net payout ratio: ((100-price)/price) * 0.955
    var netPayout = yp > 0 ? (((100-yp)/yp)*0.955).toFixed(2) : '--';
    var payoutColor = parseFloat(netPayout)>=2.5?'var(--g)':parseFloat(netPayout)>=1.8?'var(--gold)':'var(--r)';
    var payoutBadge = parseFloat(netPayout)>=1.8 ? '✅' : '❌';
    return '<div class="mkt-card">'
      +'<div class="mkt-top">'
      +'<div style="display:flex;align-items:center;gap:6px">'
      +'<span style="font-size:14px">'+ic.e+'</span>'
      +'<div><div class="mkt-ttl">'+esc(m.title||m.ticker)+'</div>'
      +'<div style="font-size:9px;color:var(--m2);text-transform:uppercase">'+ic.label+'</div></div></div>'
      +'<div class="mkt-exp'+(soon?' soon':'')+'">'+hlStr+'</div></div>'
      +'<div class="mkt-row"><div class="mkt-yes">YES '+yp+'c</div>'
      +'<div class="mkt-nr"><div class="mkt-no">NO '+(100-yp)+'c</div>'
      +'<div class="mkt-vol" style="color:'+payoutColor+'">'+payoutBadge+' '+netPayout+'x net payout | vol '+(m.volume||0).toLocaleString()+'</div></div></div>'
      +'<div class="mkt-track"><div class="mkt-fill" style="width:'+yp+'%"></div></div>'
      +(edge>0?'<span class="mbadge '+(edge>0.08?'mb-hi':'mb-med')+'">Edge '+(edge*100).toFixed(0)+'%</span>':'')
      +'</div>';
  }).join('');
}

/* ---- TRANSACTIONS ---- */
function renderTx() {
  var w = g('txFeed'); if (!w) return;
  // Combine open positions + resolved trades for complete picture
  var allItems = [];
  
  // Add open positions as "open" transactions
  if (KB.state && KB.state.openPositions) {
    KB.state.openPositions.forEach(function(p) {
      allItems.push({
        type: 'open', ticker: p.ticker||'--', pnl: 0,
        cost: +(p.cost||0), ts: p.openedAt||Date.now(),
        side: p.side||'YES', contracts: p.contracts||1,
        won: false, status: 'open', category: catIcon(p.ticker).label
      });
    });
  }
  
  // Add resolved trades
  KB.allTx.forEach(function(t) { allItems.push(t); });
  
  var fl = allItems;
  if (KB.txf === 'win') fl = allItems.filter(function(t){return t.type==='win';});
  else if (KB.txf === 'loss') fl = allItems.filter(function(t){return t.type==='loss';});
  else if (KB.txf === 'open') fl = allItems.filter(function(t){return t.type==='open';});
  
  if (!fl.length) { w.innerHTML = '<div class="empty">No transactions yet</div>'; return; }
  
  var groups = {};
  fl.forEach(function(tx) {
    var k = new Date(tx.ts).toLocaleString('en-US', {month:'long', day:'numeric', year:'numeric'});
    if (!groups[k]) groups[k] = [];
    groups[k].push(tx);
  });
  
  w.innerHTML = Object.keys(groups).map(function(day) {
    return '<div class="tx-mon">'+day+'</div>'+groups[day].map(function(tx, i) {
      var lbl = tx.type==='win'?'Win':tx.type==='loss'?'Loss':'Open';
      var ic = catIcon(tx.ticker);
      var icClass = 'ti'+(tx.type==='win'?'w':tx.type==='loss'?'l':'o');
      var amt = tx.type==='win'&&tx.pnl>0?'+'+fm(tx.pnl):tx.type==='loss'?'-'+fm(Math.abs(tx.pnl||0)):fm(tx.cost||0);
      var ac = 'ta-'+(tx.type==='win'?'p':tx.type==='loss'?'n':'z');
      return '<div class="tx-row">'
        +'<div class="tx-ico '+icClass+'" title="'+ic.label+'"><span style="font-size:14px">'+ic.e+'</span></div>'
        +'<div class="tx-info">'
        +'<div class="tx-ttl">'+lbl+' · '+esc(tx.ticker)+'</div>'
        +'<div class="tx-sub" style="display:flex;gap:8px;align-items:center">'
        +'<span style="font-size:9px;background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:4px;color:var(--m2);text-transform:uppercase">'+ic.label+'</span>'
        +'<span>'+tx.side+' · '+tx.contracts+' ct</span></div></div>'
        +'<div class="tx-r"><div class="tx-amt '+ac+'">'+amt+'</div>'
        +'<div class="tx-time">'+new Date(tx.ts).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})+'</div></div>'
        +'</div>'+(i<groups[day].length-1?'<div class="tx-div"></div>':'');
    }).join('');
  }).join('');
}
function filt(type, el) {
  KB.txf = type;
  document.querySelectorAll('.fchip').forEach(function(c){c.classList.remove('on');});
  el.classList.add('on');
  renderTx();
}

/* ---- APPLY STATE ---- */
function applyState(s) {
  if (!s) return;
  try {
    var _n = function(v){var x=+(v);return isFinite(x)?x:0;};
    var _s = function(v){return v!=null?String(v):'';};

    var real=_n(s.realBalance);
    var bal=real>0?real:_n(s.balance);
    var avail=_n(s.availableCash);
    var today=_n(s.todayPnl);
    var total=_n(s.totalPnl);
    var unrealized=_n(s.unrealizedPnl);
    var peak=_n(s.peakBalance)||bal;
    
    // Win/loss - only count real trades (cost > 0)
    var w=_n(s.wins), l=_n(s.losses), tt=w+l;
    var openCnt=(s.openPositions||[]).length, mp=_n(s.maxPos)||5;
    var wr=(s.winRate!=null&&isFinite(+s.winRate))?+s.winRate:null;
    var dryRun=s.dryRun!==false, running=!!s.isRunning;
    var brainAge=s.lastBrainAt>0?Math.round((Date.now()-s.lastBrainAt)/60000):null;

    /* HERO */
    st('heroBal', bal>0?fmBig(bal):'$0.00');
    st('heroReal', real>0?fm(real):'$0.00');
    st('heroPeak', peak>0?fm(peak):'$0.00');
    var pnlEl=g('heroPnl');
    var totalWithUnrealized = total + unrealized;
    if(pnlEl){pnlEl.textContent=(totalWithUnrealized>=0?'+':'-')+fm(Math.abs(totalWithUnrealized));pnlEl.style.color=totalWithUnrealized>=0?'var(--g)':'var(--r)';}
    var todayWithUnrealized = today + unrealized;
    st('heroArr',todayWithUnrealized>=0?'^':'v');
    st('heroChg',fm(Math.abs(todayWithUnrealized))+(unrealized!==0?' (incl. open)':'')+' today');
    var chip=g('heroChip');
    if(chip)chip.className='hero-chip '+(todayWithUnrealized>0?'chip-up':todayWithUnrealized<0?'chip-dn':'');
    // Seed chart from server history — also re-seed if chart somehow got empty
    if (s.portfolioHistory && s.portfolioHistory.length && (!KB.chartSeeded || KB.chart.length < 2)) {
      seedChartFromHistory(s.portfolioHistory);
      KB.chartSeeded = true;
    }
    pushPt(bal);

    /* PILL */
    st('pillTxt',dryRun?'PAPER':'LIVE');
    var pill=g('modePill');
    if(pill)pill.className='pill '+(dryRun?'pill-paper':'pill-live');
    var dot=g('pillDot');
    if(dot)dot.style.background=dryRun?'var(--gold)':'var(--g)';

    /* STATS */
    var wrEl=g('statWR'),wrBar=g('wrBar');
    if(wr!=null&&tt>0){
      if(wrEl){wrEl.textContent=wr.toFixed(0)+'%';wrEl.style.color=wr>=65?'var(--g)':wr>=50?'var(--gold)':'var(--r)';}
      if(wrBar)wrBar.style.background=wr>=65?'var(--g)':wr>=50?'var(--gold)':'var(--r)';
    } else {
      if(wrEl){wrEl.textContent='--';wrEl.style.color='var(--m)';}
      if(wrBar)wrBar.style.background='var(--m2)';
    }
    st('statWRsub',tt>0?tt+' trades':'no trades yet');
    var tdEl=g('statToday');
    // Show realized today + unrealized open positions combined
    var displayToday = today + unrealized;
    if(tdEl){tdEl.textContent=(displayToday>=0?'+':'')+fm(Math.abs(displayToday));tdEl.style.color=displayToday>0?'var(--g)':displayToday<0?'var(--r)':'var(--m)';}
    if(g('todayBar'))g('todayBar').style.background=displayToday>0?'var(--g)':displayToday<0?'var(--r)':'var(--m2)';
    var subParts=[];
    if(total!==0)subParts.push((total>=0?'+':'-')+fm(Math.abs(total))+' realized');
    if(unrealized!==0)subParts.push((unrealized>=0?'+':'-')+fm(Math.abs(unrealized))+' open');
    st('statTodaySub',subParts.length?subParts.join(' | '):'$0.00 all-time');
    st('statPos',openCnt);
    st('statPosSub','of '+mp+' max');

    /* ENGINE */
    var ed=g('engDot');if(ed)ed.className='eng-dot'+(running?' on':'');
    st('engName',running?'Engine Running':'Engine Stopped');
    var age=brainAge!=null?' - brain '+brainAge+'m ago':'';
    var availStr='$'+avail.toFixed(2)+' cash';
    st('engSub',running?'Scan #'+(s.scanCount||0)+' - '+openCnt+'/'+mp+' - '+availStr+age:'Tap Start to begin');
    var sb=g('startBtn'),stb=g('stopBtn');
    if(sb)sb.style.display=running?'none':'flex';
    if(stb)stb.style.display=running?'flex':'none';
    // Circuit breaker button — show when breaker is active
    var bb=g('breakerBtn');
    var breakerActive=(s.circuitBreakerUntil||0)>Date.now();
    if(bb)bb.style.display=breakerActive?'flex':'none';
    if(bb&&breakerActive){var mLeft=Math.ceil((s.circuitBreakerUntil-Date.now())/60000);bb.textContent='🔴 Reset ('+mLeft+'m)';}
    var badge=g('modeBadge');
    if(badge){badge.textContent=dryRun?'PAPER':'LIVE';badge.className='cbadge '+(dryRun?'cb-gold':'cb-g');}

    /* BRAIN */
    var sig0=s.signals&&s.signals[0];
    if(sig0)st('brainTxt',_s(sig0.reasoning)||'Analyzing...');
    else if(running)st('brainTxt','Scanning'+age+' - hunting for edge across '+((s.topMarkets||[]).length)+' markets...');
    else st('brainTxt','Start the bot to begin');
    st('brainBadge','Brain #'+(s.totalBrainCount||s.brainCount||0)+' | API: $'+(_n(s.totalApiSpend||s.estimatedApiSpend)).toFixed(2));

    /* JOURNEY */
    if(s.phaseLabel){
      var dm=_n(s.doublingsMade),dn=_n(s.doublingsNeeded);
      var pct=_n(s.doublingProgress),nxt=_n(s.nextTarget);
      st('homePhase',_s(s.phaseLabel));st('jPhase',_s(s.phaseLabel));st('jDesc',_s(s.phaseDesc));
      st('jNext','$'+nxt.toLocaleString('en-US',{maximumFractionDigits:0}));
      var jFill=g('jFill');if(jFill)jFill.style.width=Math.min(100,pct)+'%';
      st('jPct',pct.toFixed(1)+'%');
      st('jLeft',dn+' doubling'+(dn!==1?'s':'')+' to $500K');
      st('jDone',dm+'x');
      if(s.cfg){
        st('jKelly',Math.round((_n(s.cfg.kellyFrac)||0.5)*100)+'%');
        st('jEdge',Math.round((_n(s.cfg.minEdge)||0.05)*100)+'%+');
      }
    }

    /* SETTINGS - accurate data */
    st('cfgReal',fm(real));st('cfgAvail',fm(avail));st('cfgPeak',fm(peak));
    var pnEl=g('cfgPnl');if(pnEl){pnEl.textContent=(total>=0?'+':'-')+fm(Math.abs(total));pnEl.className='sv '+(total>=0?'sv-g':'sv-r');}
    // W/L - real trades only
    var wrCfg=g('cfgWR');if(wrCfg){wrCfg.textContent=wr!=null&&tt>0?wr.toFixed(1)+'%':'-- (no real trades yet)';wrCfg.className='sv '+(wr!=null&&tt>0?(wr>=65?'sv-g':wr>=50?'sv-gold':'sv-r'):'');}
    var wlCfg=g('cfgWL');if(wlCfg){wlCfg.textContent=w+'W / '+l+'L'+(tt===0?' (pending)':'');wlCfg.className='sv '+(w>l?'sv-g':w<l?'sv-r':'');}
    var tdCfg=g('cfgToday');if(tdCfg){var todayDisp=today+unrealized;tdCfg.textContent=(todayDisp>=0?'+':'-')+fm(Math.abs(todayDisp))+(unrealized!==0?' *':'');tdCfg.className='sv '+(todayDisp>=0?'sv-g':'sv-r');}
    st('cfgScans',_n(s.totalScanCount||s.scanCount).toLocaleString());
    var totalBrain = _n(s.totalBrainCount||s.brainCount);
    var brainBlockReason = totalBrain===0 ? (openCnt>=mp ? ' (slots full — monitor mode)' : ' (firing soon)') : ' total';
    st('cfgBrain', totalBrain.toLocaleString() + brainBlockReason);
    var apiSpend = _n(s.totalApiSpend||s.estimatedApiSpend);
    st('cfgSpend','$'+apiSpend.toFixed(2));
    st('cfgMode',dryRun?'Paper':'LIVE');
    st('cfgPhase',_s(s.phaseLabel)||'--');
    st('cfgMax',mp);st('cfgOpen',openCnt+' / '+mp);
    st('cfgBrainInt',s.cfg?((_n(s.cfg.brainInterval)||90000)/60000).toFixed(1)+'min':'1.5min');
    // Add compounding rate
    var cfgComp=g('cfgCompound');
    if(cfgComp){
      var daysSinceStart=s.startedAt?(Date.now()-s.startedAt)/86400000:1;
      var dailyGrowth=daysSinceStart>0&&bal>0&&s.startingBankroll>0?Math.pow(bal/s.startingBankroll,1/daysSinceStart)-1:0;
      cfgComp.textContent=daysSinceStart<0.1?'--':(dailyGrowth*100).toFixed(1)+'%/day';
    }

    /* LOGS */
    var lw=g('logWrap');
    if(lw&&s.logs&&s.logs.length){
      lw.innerHTML=s.logs.slice(0,25).map(function(l){
        var lvl=(l.level||'').toLowerCase();
        var cls=lvl==='error'?'log-err':lvl==='warn'?'log-warn':'';
        return '<div'+(cls?' class="'+cls+'"':'')+'><span class="log-ts">'+(l.ts||'')+'</span>'+esc(l.msg||'')+'</div>';
      }).join('');
      if(s.logs[0]){
        var newKey=(s.logs[0].ts||'')+'|'+(s.logs[0].msg||'');
        if(newKey!==KB.prevLogKey){
          KB.prevLogKey=newKey;
          var l0=s.logs[0];
          var lvl0=(l0.level||'').toLowerCase();
          var ftype=lvl0==='error'?'error':lvl0==='warn'?'warn':/WIN/.test(l0.msg)?'win':/LOSS/.test(l0.msg)?'loss':/Brain/.test(l0.msg)?'brain':/Order|OK/.test(l0.msg)?'trade':'info';
          pushFeed(l0.msg,ftype);
        }
      }
    }

    /* BRAIN TOAST on new cycle */
    if(s.brainCount&&s.brainCount>KB.lastBrain&&KB.lastBrain>0){
      var bs=s.signals&&s.signals[0];
      toast('Brain #'+s.brainCount+(bs?' → '+bs.ticker+' '+bs.side+' ('+(((bs.feeAdjustedEdge||bs.edge||0)*100).toFixed(1))+'% edge)':' no signals found'),'brain');
    }
    KB.lastBrain=_n(s.brainCount);

    /* POSITIONS + SIGNALS + TRADES + MARKETS */
    renderPos(s.openPositions||[]);
    renderSigs(s.signals||[]);
    KB.allTx=(s.trades||[]).filter(function(t){return (t.cost||0)>0.01;}).map(function(t){
      return{type:t.status==='open'?'open':(t.won?'win':'loss'),
        ticker:_s(t.ticker)||'--',pnl:_n(t.pnl),cost:_n(t.cost),
        ts:_n(t.resolvedAt||t.openedAt)||Date.now(),
        side:_s(t.side)||'YES',contracts:_n(t.contracts)||1,won:!!t.won,status:_s(t.status)};
    });
    if(document.getElementById('pg-activity')&&document.getElementById('pg-activity').classList.contains('on'))renderTx();
    renderMkts();
    KB.loaded=true;

  } catch(e) {
    var hb=g('heroBal');
    if(hb)hb.textContent='Error: '+e.message;
    console.error('applyState crash:',e);
  }
}

/* ---- LOAD STATE ---- */
function loadState() {
  return fetch(KB.api+'/api/state?v='+KB.VERSION+'&_='+Date.now(),{cache:'no-store'})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();})
    .then(function(txt){
      var s;
      try{s=JSON.parse(txt);}
      catch(e){var hb=g('heroBal');if(hb)hb.textContent='Parse error';throw new Error('Bad JSON');}
      KB.retries=0;KB.state=s;
      applyState(s);
    })
    .catch(function(e){
      KB.retries++;
      var hb=g('heroBal');
      if(hb)hb.textContent='Retry '+KB.retries+': '+e.message.slice(0,25);
    });
}

/* ---- ACTIONS ---- */
function doSync(){
  var btn=g('syncBtn');if(btn)btn.style.opacity='0.4';
  fetch(KB.api+'/api/sync',{method:'POST'})
    .then(function(r){return r.text();})
    .then(function(t){try{var s=JSON.parse(t);KB.state=s;applyState(s);}catch(e){loadState();}if(btn)btn.style.opacity='1';})
    .catch(function(){loadState();if(btn)btn.style.opacity='1';});
}
function doPurge(){
  if(!confirm('Remove stale synced positions? Your real Kalshi positions are unaffected.'))return;
  fetch(KB.api+'/api/purge-positions',{method:'POST'})
    .then(function(r){return r.json();})
    .then(function(d){toast('Purged '+d.removed+' stale positions','trade');setTimeout(loadState,500);})
    .catch(function(){toast('Purge failed','error');});
}
function resetBreaker(){
  if(!confirm('Clear the circuit breaker and resume trading now?'))return;
  fetch(KB.api+'/api/reset-breaker',{method:'POST'})
    .then(function(r){return r.json();})
    .then(function(d){toast('🟢 Circuit breaker cleared — trading resumed','win');setTimeout(loadState,500);})
    .catch(function(){toast('Reset failed','error');});
}
function toggleBot(){
  fetch(KB.api+'/api/toggle',{method:'POST'}).then(function(){setTimeout(loadState,500);});
}

/* ---- BOOT ---- */
document.addEventListener('DOMContentLoaded', function() {
  loadState();
  sseConnect();
  startPoll(5000);
});
if(document.readyState==='complete'||document.readyState==='interactive'){
  loadState();
  sseConnect();
  startPoll(5000);
}
</script>
</body>
</html>
`;

// --- EXPRESS SERVER ---------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST');

  // Dashboard - served dynamically with server-side balance pre-seeded
  // This means balance shows INSTANTLY even before JS fetches /api/state
  if (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/dashboard') {
    const _b = S.realBalance > 0 ? S.realBalance : S.balance;
    const _html = DASHBOARD
      .replace('__INIT_BAL__', _b > 0 ? '$' + _b.toFixed(2) : '$0.00')
      .replace('__INIT_REAL__', _b > 0 ? '$' + _b.toFixed(2) : '$0.00')
      .replace('__INIT_PEAK__', S.peakBalance > 0 ? '$' + S.peakBalance.toFixed(2) : '$0.00')
      .replace('__INIT_MODE__', CFG.dryRun ? 'PAPER' : 'LIVE')
      .replace('__INIT_PILL__', CFG.dryRun ? 'pill-paper' : 'pill-live')
      .replace('__INIT_RUNNING__', S.isRunning ? 'Running' : 'Stopped')
      .replace('__INIT_SCANS__', String(S.scanCount || 0))
      .replace('__INIT_PHASE__', (getPhase().label || '🌱 Seed'));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    return res.end(_html, "utf8");
  }

  if (url.pathname === '/api/purge-positions' && req.method === 'POST') {
    const before = S.openPositions.length;
    S.openPositions = S.openPositions.filter(p => !p.fromKalshi);
    saveState();
    const removed = before - S.openPositions.length;
    log(`Manual purge: removed ${removed} Kalshi-synced positions, ${S.openPositions.length} bot positions remain`);
    tg(`🗑 <b>Manual Purge</b>\nRemoved ${removed} stale synced positions\nRemaining: ${S.openPositions.length} bot positions`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, removed, remaining: S.openPositions.length }));
  }

  if (url.pathname === '/debug') {
    const phase = getPhase();
    const txt = [
      `KalshiBot v10 DEBUG -- ${new Date().toISOString()}`,
      `Running: ${S.isRunning} | DryRun: ${CFG.dryRun}`,
      `realBalance: ${S.realBalance} | balance: ${S.balance} | peak: ${S.peakBalance}`,
      `availableCash: ${S.availableCash} | restingOrders: ${S.restingOrders.length}`,
      `scanCount: ${S.scanCount} | brainCount: ${S.brainCount}`,
      `openPositions: ${S.openPositions.length} | signals: ${S.signals.length}`,
      `phase: ${phase.name} (${phase.label})`,
      `lastErr: ${S.lastErr || 'none'}`,
      `sseClients: ${sseClients.size}`,
      `Last 5 logs:`,
      ...(S.logs||[]).slice(0,5).map(l => `  [${l.ts}] ${l.level}: ${l.msg}`),
    ].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end(txt);
  }

  // -- SSE live push -- dashboard connects here for instant updates
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');
    // Immediately send current state hint
    res.write(`event: update\ndata: ${JSON.stringify({ ts: Date.now(), bal: S.realBalance || S.balance })}\n\n`);
    sseClients.add(res);
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch(e) { clearInterval(hb); sseClients.delete(res); }
    }, 25000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }

  // -- External notify -- push a message to SSE live feed (e.g. from scripts)
  if (url.pathname === '/api/notify' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        ssePush('notify', { msg: (d.msg||'').slice(0,300), ts: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch(e) { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  if (url.pathname === '/api/state') {
    // Helpers OUTSIDE try/catch so fallback can use them (fixes crash-on-crash bug)
    const _nn = v => { const n = Number(v); return isFinite(n) ? n : 0; };
    const _ss = (v, max) => {
      if (v == null) return '';
      try {
        const str = String(v).replace(/[\u0000-\u001F\u007F\\"]/g, ' ').trim();
        return max ? str.slice(0, max) : str.slice(0, 300);
      } catch { return ''; }
    };
    try {
      const total = S.wins + S.losses;
      const phase = getPhase();
      const slim = {
        isRunning: !!S.isRunning,
        balance: _nn(S.balance),
        realBalance: _nn(S.realBalance),
        peakBalance: _nn(S.peakBalance),
        availableCash: _nn(S.availableCash),
        todayPnl: _nn(S.todayPnl),
        totalPnl: _nn(S.totalPnl),
        wins: _nn(S.wins),
        losses: _nn(S.losses),
        scanCount: _nn(S.scanCount),
        brainCount: _nn(S.brainCount),
        totalBrainCount: _nn(S.totalBrainCount || S.brainCount), // cumulative across redeploys
        totalScanCount: _nn(S.totalScanCount || S.scanCount),
        startedAt: _nn(S.startedAt),
        lastBrainAt: _nn(S.lastBrainAt),
        lastErr: _ss(S.lastErr, 120),
        estimatedApiSpend: _nn(S.estimatedApiSpend || 0),
        totalApiSpend: _nn(S.totalApiSpend || S.estimatedApiSpend || 0),
        dryRun: !!CFG.dryRun,
        maxPos: dynamicMaxPos(),
        winRate: total > 0 ? parseFloat((_nn(S.wins) / total * 100).toFixed(1)) : null,
        drawdown: _nn(S.peakBalance) > 0 ? parseFloat(((_nn(S.peakBalance) - _nn(S.balance)) / _nn(S.peakBalance) * 100).toFixed(1)) : 0,
        openCount: (S.openPositions||[]).length,
        // Unrealized P&L: sum of (currentPrice - entryPrice) * contracts for open positions
        unrealizedPnl: (S.openPositions||[]).reduce((sum, p) => {
          const cur = _nn(p.currentPrice) / 100; // stored as cents int
          const entry = _nn(p.entryPrice) / 100;
          const contracts = _nn(p.contracts);
          if (cur > 0 && entry > 0 && contracts > 0) {
            const side = (p.side||'YES').toUpperCase();
            const unrealized = side === 'YES' ? (cur - entry) * contracts : (entry - cur) * contracts;
            return sum + unrealized;
          }
          return sum;
        }, 0),
        phase: phase.name,
        phaseLabel: _ss(phase.label, 30),
        phaseDesc: _ss(phase.desc, 100),
        doublingsMade: doublingsMade(),
        doublingsNeeded: doublingsNeeded(),
        nextTarget: nextTarget(),
        doublingProgress: parseFloat(doublingProgress().toFixed(1)),
        restingOrderCount: (S.restingOrders||[]).length,
        startingBankroll: _nn(CFG.bankroll),
        cfg: { kellyFrac: phase.kelly, minEdge: phase.minEdge, minProb: phase.minProb,
               brainInterval: CFG.brainInterval, scanInterval: CFG.scanInterval },
        openPositions: (S.openPositions||[]).slice(0,20).map(p => ({
          ticker: _ss(p.ticker,20), side: _ss(p.side,4),
          entryPrice: _nn(p.entryPrice), contracts: _nn(p.contracts),
          cost: _nn(p.cost), pnl: _nn(p.pnl),
          confidence: _nn(p.confidence), openedAt: _nn(p.openedAt),
          reasoning: _ss(p.reasoning, 150), fromKalshi: !!p.fromKalshi,
          currentPrice: _nn(p.currentPrice),
        })),
        signals: (S.signals||[]).slice(0,5).map(s => ({
          ticker: _ss(s.ticker,20), side: _ss(s.side,4),
          confidence: _nn(s.confidence), edge: _nn(s.edge),
          feeAdjustedEdge: _nn(s.feeAdjustedEdge || s.edge),  // was missing — shows correct net edge
          marketPrice: _nn(s.marketPrice), kellySize: _nn(s.kellySize),
          reasoning: _ss(s.reasoning, 150), hoursToClose: _nn(s.hoursToClose),
        })),
        trades: (S.trades||[]).slice(0,30).map(t => ({
          ticker: _ss(t.ticker,20), side: _ss(t.side,4),
          contracts: _nn(t.contracts), cost: _nn(t.cost), pnl: _nn(t.pnl),
          won: !!t.won, status: _ss(t.status,10),
          openedAt: _nn(t.openedAt), resolvedAt: _nn(t.resolvedAt),
        })),
        logs: (S.logs||[]).slice(0,25).map(l => ({
          ts: _ss(l.ts,10), level: _ss(l.level,5), msg: _ss(l.msg, 150),
        })),
        topMarkets: (S.topMarkets||[]).slice(0,15).map(m => ({
          ticker: _ss(m.ticker,20), title: _ss(m.title, 80),
          yesAsk: _nn(m.yesAsk), yesBid: _nn(m.yesBid),
          volume: _nn(m.volume), score: _nn(m.score),
          hoursLeft: _nn(m.hoursLeft), edge: _nn(m.edge),
          netPayoutRatio: _nn(m.netPayoutRatio || ((1-m.yesAsk)/Math.max(m.yesAsk,0.01)*0.955)),
        })),
        portfolioHistory: (S.portfolioHistory||[]).slice(-500).map(p => ({ t: _nn(p.t), v: _nn(p.v) })),
        circuitBreakerUntil: _nn(S.circuitBreakerUntil || 0),
        consecutiveLosses: _nn(S.consecutiveLosses || 0),
      };
      const json = JSON.stringify(slim);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
      return res.end(json);
    } catch(e) {
      log('api/state crash: ' + e.message, 'ERROR');
      // _nn and _ss are defined above the try -- always available here
      const fallback = JSON.stringify({
        isRunning: !!S.isRunning, balance: _nn(S.balance), realBalance: _nn(S.realBalance),
        peakBalance: _nn(S.peakBalance), availableCash: 0,
        todayPnl: 0, totalPnl: 0, wins: _nn(S.wins), losses: _nn(S.losses),
        scanCount: _nn(S.scanCount), brainCount: _nn(S.brainCount),
        dryRun: !!CFG.dryRun, maxPos: 5, winRate: null, drawdown: 0, openCount: 0,
        phase: 'SEED', phaseLabel: 'Seed', phaseDesc: 'Recovering...',
        doublingsMade: 0, doublingsNeeded: 14, nextTarget: 100,
        doublingProgress: 0, startingBankroll: _nn(CFG.bankroll),
        lastBrainAt: 0, startedAt: _nn(S.startedAt),
        error: _ss(e.message, 80),
        openPositions: [], signals: [], trades: [], logs: [], topMarkets: [],
        cfg: { kellyFrac: 0.55, minEdge: 0.04, minProb: 0.55, brainInterval: 120000, scanInterval: 20000 },
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
      return res.end(fallback);
    }
  }

  if (url.pathname === '/api/toggle' && req.method === 'POST') {
    if (S.isRunning) stopBot(); else startBot();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
    return res.end(JSON.stringify({ ok: true, isRunning: !!S.isRunning }));
  }

  if (url.pathname === '/api/reset') {
    stopBot();
    S = {
      isRunning: false, balance: CFG.bankroll, realBalance: 0,
      peakBalance: CFG.bankroll, trades: [], openPositions: [], signals: [],
      logs: [], brainMemory: [], scanCount: 0, brainCount: 0,
      wins: 0, losses: 0, totalPnl: 0, todayPnl: 0,
      todayDate: new Date().toDateString(), lastBrainAt: 0, lastScanAt: 0,
      lastErr: '', startedAt: Date.now(), topMarkets: [], newsCache: [],
    };
    saveState();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname === '/api/validate') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    runPlumbingTest().then(r => res.end(JSON.stringify(r))).catch(e => res.end(JSON.stringify({ error: e.message })));
    return;
  }

    if (url.pathname === '/api/sync' && req.method === 'POST') {
    // Force immediate full sync
    Promise.allSettled([
      syncBalance(),
      syncRestingOrders(),
      syncPositions(),
      resolvePositions(),
      backfillKalshiHistory(),
    ]).then(() => {
      saveState();
      log('🔄 Manual sync from dashboard');
      tg(`🔄 <b>Manual Sync</b>\n💰 $${(S.realBalance||S.balance).toFixed(2)} | ${S.openPositions.length}/${dynamicMaxPos()} pos | ${S.wins}W/${S.losses}L`);
      // Return sanitized state -- never raw ...S (breaks Safari JSON parser)
      const _n = v => { const n = Number(v); return isFinite(n) ? n : 0; };
      const total = _n(S.wins) + _n(S.losses);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
      res.end(JSON.stringify({
        isRunning: !!S.isRunning,
        balance: _n(S.balance), realBalance: _n(S.realBalance),
        peakBalance: _n(S.peakBalance), availableCash: _n(S.availableCash),
        todayPnl: _n(S.todayPnl), totalPnl: _n(S.totalPnl),
        wins: _n(S.wins), losses: _n(S.losses),
        scanCount: _n(S.scanCount), brainCount: _n(S.brainCount),
        dryRun: !!CFG.dryRun, maxPos: dynamicMaxPos(),
        winRate: total > 0 ? parseFloat((_n(S.wins) / total * 100).toFixed(1)) : null,
        openPositions: (S.openPositions||[]).slice(0,10),
        signals: (S.signals||[]).slice(0,5),
        trades: (S.trades||[]).slice(0,20),
        logs: (S.logs||[]).slice(0,20),
        topMarkets: (S.topMarkets||[]).slice(0,12),
        synced: true,
      }));
    }).catch(e => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, isRunning: !!S.isRunning, balance: 0, realBalance: 0,
        openPositions:[], signals:[], trades:[], logs:[], topMarkets:[] }));
    });
    return;
  }

  if (url.pathname === '/api/history') {
    // Return full trade history + settled positions for History tab
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
    return res.end(JSON.stringify({
      trades: S.trades || [],
      wins: S.wins,
      losses: S.losses,
      totalPnl: S.totalPnl,
      todayPnl: S.todayPnl,
    }));
  }

  if (url.pathname === '/api/kalshi-positions') {
    // Fetch live positions directly from Kalshi for dashboard
    kalshi('GET', '/portfolio/positions', null, { limit: '50', status: 'open' })
      .then(r => {
        const positions = r.market_positions || r.positions || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ positions, count: positions.length }));
      })
      .catch(e => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ positions: [], error: e.message }));
      });
    return;
  }

  if (url.pathname === '/health' || url.pathname === '/api/ping') {
    // Diagnose why brain might not be firing
    const phase = getPhase();
    const brainReadyIn = S.lastBrainAt > 0
      ? Math.max(0, Math.round((CFG.brainInterval - (Date.now() - S.lastBrainAt)) / 1000))
      : 0;
    const effectiveCash = S.availableCash > 0 ? S.availableCash
      : (S.restingOrders.length === 0 ? Math.max(0, (S.realBalance || S.balance) - 1.00) : 0);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
    return res.end(JSON.stringify({
      ok: true, running: S.isRunning, scans: S.scanCount, brain: S.brainCount,
      balance: S.balance, realBalance: S.realBalance,
      availableCash: S.availableCash, effectiveCash,
      restingOrders: S.restingOrders.length,
      positions: S.openPositions.length, maxPos: dynamicMaxPos(),
      openSlots: dynamicMaxPos() - S.openPositions.length,
      brainReadyInSecs: brainReadyIn,
      phase: phase.name, dryRun: CFG.dryRun,
      lastErr: S.lastErr,
      topMarketsCount: (S.topMarkets||[]).length,
    }));
  }

  res.writeHead(404);
  res.end('Not found');
});

// --- BOOT -------------------------------------------------------------------
loadState();
server.listen(CFG.port, () => {
  log(`KalshiBot v19.0 listening on port ${CFG.port}`);
  log(`Mode: ${CFG.dryRun ? 'PAPER' : 'LIVE'} | Bankroll: $${CFG.bankroll}`);

  // -- BOOT SYNC: fetch real balance+positions immediately so dashboard shows data
  // even before the bot auto-starts. Runs silently, errors are non-fatal.
  setTimeout(async () => {
    try {
      log('Boot sync: fetching balance + positions...');
      await syncBalance();
      await syncPositions();
      await backfillKalshiHistory();
      saveState();
      log(`Boot sync complete: $${S.realBalance.toFixed(2)} | ${S.openPositions.length} positions`);
    } catch(e) {
      log('Boot sync failed (non-fatal): ' + e.message, 'WARN');
    }
  }, 2000); // 2s -- let Railway network stabilize first

  // Auto-start after 7 seconds -- after boot sync completes
  setTimeout(() => {
    log('Auto-starting bot...');
    startBot();
  }, 7000);
});
