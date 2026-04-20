'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

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
  scanInterval:  15000,   // math scanner: every 15s -- faster slot detection for max position fill
  brainInterval: 90000,   // claude brain: every 90s -- faster slot filling -- saves ~$130/72h vs 90s
  heartbeatInterval: 300000,  // telegram heartbeat: every 5min (was 15min)
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
  { name: 'SEED',     min: 0,      max: 50,     kelly: 0.20, minEdge: 0.06, minProb: 0.72, maxPos: 3, maxPct: 0.20, maxExposure: 0.55, maxBetDollars: 6,     label: '🌱 Seed',     desc: '3 slots. $6 max bet. 20% Kelly. Built to survive 5-loss streaks.' },
  { name: 'SPROUT',   min: 50,     max: 200,    kelly: 0.25, minEdge: 0.06, minProb: 0.70, maxPos: 4, maxPct: 0.20, maxExposure: 0.55, maxBetDollars: 20,    label: '🌿 Sprout',   desc: '4 slots. $20 max bet. 25% Kelly. Disciplined compounding.' },
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

// Smart brain interval — adapts to what's happening right now
// AGGRESSIVE MODE: Fire brain frequently to catch direction markets + sports
// Brain fires INDEPENDENTLY of FastPath — even when FastPath ran
function dynamicBrainInterval() {
  const utcH = new Date().getUTCHours();
  const etH  = (utcH - 4 + 24) % 24; // approx Eastern (EDT)
  const etM  = new Date().getUTCMinutes();
  const minsToHour = 60 - etM;
  // Dead zone 2am-7am ET — very few live events
  if (etH >= 2 && etH < 7)   return 300000; // 5 min dead zone (was 10min)
  // Sweet spot for hourly crypto: 15-45min before each hour — fire FAST
  if (minsToHour >= 15 && minsToHour <= 48) return 90000;  // 90s — crypto window (was 3min)
  // Active: evening games (7-11pm ET) and market hours (9:30am-4pm ET)
  if ((etH >= 19 && etH <= 23) || (etH >= 9 && etH <= 16)) return 75000; // 75s (was 2min)
  return 120000; // default 2 min (was 4min)
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
  brainKillSwitchUntil: 0, // per-source kill switch — brain paused when WR < 42%
  sessionPeakBalance: 0,  // highest balance seen this session — drawdown guard
  drawdownHaltUntil: 0,   // timestamp — drawdown protection pause
  sourceWins: { fastpath: 0, sports_fastpath: 0, brain: 0, arb: 0 },   // per-source win tracking
  sourceLosses: { fastpath: 0, sports_fastpath: 0, brain: 0, arb: 0 }, // per-source loss tracking
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
  // Init session peak from stored balance so drawdown guard doesn't trigger immediately
  if (!S.sessionPeakBalance || S.sessionPeakBalance < (S.realBalance || S.balance)) {
    S.sessionPeakBalance = S.realBalance || S.balance;
  }
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
    // SAFE: block all trades if we cannot determine reserved cash
    S.availableCash = 0;
    log('Resting sync FAILED -- blocking trades to prevent overspend: ' + e.message, 'WARN');
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
      // 15-min crypto — FASTEST, best flywheel velocity (15min resolution)
      'KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M', 'KXBNB15M',
      // 1-hour crypto — excellent (1h resolution)
      'KXBTCH', 'KXETHH', 'KXSOLH', 'KXXRPH',
      // Crypto daily — ONLY include if within 4h of close (filtered by hoursLeft below)
      'KXBTCD', 'KXETHUSD', 'KXSOLD', 'KXXRPD',
      // Indices (market hours only)
      ...(isMarketHours ? ['INXD', 'NASDAQ100D'] : []),
      // Macro
      'FED', 'KXCPI',
      // Weather — small band markets are tradeable
      'KXHIGHNY', 'KXHIGHMIA', 'KXHIGHCHI', 'KXHIGHLA',
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
      'KXBTCD','KXETHUSD','KXBTC15M','KXETH15M','KXBTCH','KXETHH','KXBTCUSDH','KXETHUSDH',
      'KXSOL15M','KXXRP15M','KXDOGE15M','KXBNB15M','KXSOLH','KXXRPH','KXSOLD','KXXRPD',
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

  // SINGLE-MARKET YES+NO ARB SCANNER (zero AI cost, 100% WR when triggered)
  // yes_ask + no_ask < 0.955 on same market = guaranteed profit regardless of outcome.
  // Must have 2 free slots (YES leg + NO leg). Volume >= 20. Resolves within 24h.
  if (S.openPositions.length <= dynamicMaxPos() - 2) {
    const _aHeld = new Set(S.openPositions.map(p => p.ticker));
    for (const _am of allMarkets) {
      if (_aHeld.has(_am.ticker) || _am.mve_collection_ticker) continue;
      const _aY = parsePrice(_am.yes_ask_dollars);
      const _aN = parsePrice(_am.no_ask_dollars) || (1 - parsePrice(_am.yes_bid_dollars || '0'));
      if (!_aY || !_aN || _aY <= 0.05 || _aN <= 0.05 || _aY >= 0.95) continue;
      const _aSum = _aY + _aN;
      const _aVol = parseFloat(_am.volume_fp || _am.volume || 0);
      if (_aVol < 20) continue;
      const _aProfit = (1 - _aSum) * (1 - KALSHI_FEE);
      if (_aProfit >= 0.02) {
        const _aHrs = _am.close_time ? Math.max(0,(new Date(_am.close_time)-Date.now())/3600000) : 999;
        if (_aHrs > 24 || _aHrs < 0.05) continue;
        log(`ARB SIGNAL: ${_am.ticker} YES=${(_aY*100).toFixed(0)}c+NO=${(_aN*100).toFixed(0)}c=+${(_aProfit*100).toFixed(1)}c guaranteed | vol=${_aVol}`);
        tg(`ARB Signal\n${_am.ticker}\nYES@${(_aY*100).toFixed(0)}c + NO@${(_aN*100).toFixed(0)}c = +${(_aProfit*100).toFixed(1)}c/contract (100% WR)\nvol=${_aVol}`);
        const _aReason = `ARB: YES@${(_aY*100).toFixed(0)}c+NO@${(_aN*100).toFixed(0)}c=+${(_aProfit*100).toFixed(1)}c guaranteed`;
        await executeTrade({ ticker:_am.ticker, side:'YES', confidence:0.99, edge:_aProfit,
          marketPrice:_aY, feeAdjustedEdge:_aProfit, netPayoutRatio:((1-_aY)/_aY)*(1-KALSHI_FEE),
          hoursToClose:_aHrs, source:'arb', isArb:true, reasoning:_aReason });
        await executeTrade({ ticker:_am.ticker, side:'NO', confidence:0.99, edge:_aProfit,
          marketPrice:_aN, feeAdjustedEdge:_aProfit, netPayoutRatio:((1-_aN)/_aN)*(1-KALSHI_FEE),
          hoursToClose:_aHrs, source:'arb', isArb:true, reasoning:'ARB NO leg — paired with YES' });
        break;
      }
    }
  }

  // ── NORMALIZE Up/Down markets → YES/NO ──────────────────────────────────────
    // Kalshi 15min "Up/Down" markets (BTC/ETH/SOL/XRP/DOGE/BNB) use different field names:
    //   up_ask_dollars / down_ask_dollars instead of yes_ask_dollars / yes_bid_dollars
    // We normalize them here so all downstream logic treats them uniformly as YES/NO.
    // "Up" = YES (price goes up), "Down" = NO (price goes down).
    for (const m of allMarkets) {
      if (!m.yes_ask_dollars && m.up_ask_dollars) {
        // Map Up → YES, Down → NO
        m.yes_ask_dollars = m.up_ask_dollars;
        m.yes_bid_dollars = m.up_bid_dollars || m.up_ask_dollars;
        m.no_ask_dollars  = m.down_ask_dollars;
        m.no_bid_dollars  = m.down_bid_dollars || m.down_ask_dollars;
        m._isUpDownMarket = true;
      }
    }

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
      const yesSideOk = yesAsk >= 0.05 && yesAsk <= 0.35;    // high-payout (2x+)
      const noSideOk  = noAsk >= 0.05 && noAsk <= 0.35 && yesAsk >= 0.65; // NO underdog
      const yesFavOk  = yesAsk >= 0.55 && yesAsk <= 0.88;    // YES favorite (high conf)
      // Direction markets ("price up/down in next X mins?") — no strike, near-50c pricing
      // Allow 38c-62c range so direction markets pass the payout filter
      const isDirectionMkt = m.title && /price (up|down) in (next|the next)/i.test(m.title) && !m.title.match(/\$[\d]/);
      const directionOk = isDirectionMkt && yesAsk >= 0.38 && yesAsk <= 0.62;
      return yesSideOk || noSideOk || yesFavOk || directionOk;
    });

    log(`After payout filter: ${markets.length} tradeable | Raw was ${allMarkets.length}`);

    // Pre-filters: remove markets that are structurally bad opportunities
    const preFilterCount = markets.length;
    const filteredMarkets = markets.filter(m => {
      const yesAsk = parsePrice(m.yes_ask_dollars);
      const yesBid = parsePrice(m.yes_bid_dollars); // needed for weather NO-side check
      const hoursLeftFilter = m.close_time
        ? Math.max(0, (new Date(m.close_time) - Date.now()) / 3600000) : 999;
      const phase = getPhase();

      // FLYWHEEL BLOCK: KXBTCD (Bitcoin daily) closes tomorrow — 18+ hour hold.
      // These kill slot velocity. Only allow KXBTCD if it closes within 4h (today's end-of-day).
      if (/^KXBTCD/i.test(m.ticker) && hoursLeftFilter > 4) {
        log(`Flywheel filter: ${m.ticker} is tomorrow's BTC daily (${hoursLeftFilter.toFixed(1)}h) — skip`);
        return false;
      }

      // Duration cap — fast-closing markets (<3h) are ALWAYS allowed regardless of phase
      // They are our primary target and should never be filtered out
      if (hoursLeftFilter <= 3.0) return true; // always pass sub-3h markets

      // SEED/SPROUT: allow up to 24h for same-day markets (was 12h — too aggressive, killed all markets)
      // Longer than 24h blocks slots too long for aggressive compounding
      const maxHours = (phase.name === 'SEED' || phase.name === 'SPROUT') ? 24 : 72;
      if (hoursLeftFilter > maxHours) return false;

      // Weather: strict probability filter — market maker has NWS data advantage.
      // Ban: <10% probability (pure donation), 15-40c mid-bands (market maker edge zone)
      const isWeatherTicker = /kxhigh|kxlow/i.test(m.ticker);
      if (isWeatherTicker) {
        // Ban sub-10% probability weather bets — 1% chance = guaranteed loss
        if (yesAsk < 0.10) return false;
        // Also ban the NO side if NO is <10% (YES > 90%)
        const noAsk = 1 - yesBid;
        if (noAsk < 0.10) return false;
        // Ban mid-probability bands — market maker NWS data destroys edge here
        if (yesAsk > 0.15 && yesAsk < 0.40) return false;
      }

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
      const isCrypto = /btc|eth|sol|xrp|doge|bnb|hype|avax|ada|crypto|inxd|inxw|spx|ndx/i.test(m.ticker);
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
    const _cryptoTop = scored.filter(m => /kxbtc|kxeth|kxsol|kxxrp|kxdoge|kxbnb|kxhype|kxavax/i.test(m.ticker) && !_heldSet.has(m.ticker) && m.hoursLeft > 0.08).sort((a,b)=>a.hoursLeft-b.hoursLeft).slice(0, 8);
    const _nonCrypto = reordered.filter(m => !/kxbtc|kxeth|kxsol|kxxrp|kxdoge|kxbnb|kxhype|kxavax/i.test(m.ticker)).slice(0, 12);
    const _cryptoInReordered = reordered.filter(m => /kxbtc|kxeth|kxsol|kxxrp|kxdoge|kxbnb|kxhype|kxavax/i.test(m.ticker));
    // Merge: crypto first, then non-crypto, deduplicated
    const _seen = new Set();
    const _merged = [..._cryptoTop, ..._cryptoInReordered, ..._nonCrypto].filter(m => {
      if (_seen.has(m.ticker)) return false; _seen.add(m.ticker); return true;
    });
    S.topMarkets = _merged.slice(0, 20);
    // Store ALL crypto markets separately so FastPath never misses them
    S._allScoredCrypto = scored.filter(m =>
      /kxbtc|kxeth|kxsol|kxxrp|kxdoge|kxbnb|kxhype|kxavax/i.test(m.ticker) && !_heldSet.has(m.ticker) && m.hoursLeft > 0.08
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

    // TIGHTENED SPORTS THRESHOLDS: higher score margin required, tighter confidence.
    // NBA: 15pt lead late Q4 is real but not 87% — 3-point run flips it. Require 18+.
    // MLB: stays same — run differential late is genuinely high-confidence.
    // NHL: 2-goal lead in 3rd period upgraded from 0.83 to 0.86 (empty net factor).
    if (sport === 'nba' && period >= 4) {
      if (scoreDiff >= 22) { confidence = 0.95; side = 'YES'; reasoning = `NBA Q${period} ${clock}: ${teamAbbrRaw} +${scoreDiff} (blowout)`; }
      else if (scoreDiff >= 18) { confidence = 0.91; side = 'YES'; reasoning = `NBA Q${period} ${clock}: ${teamAbbrRaw} +${scoreDiff}`; }
      else if (scoreDiff <= -22) { confidence = 0.95; side = 'NO'; reasoning = `NBA Q${period} ${clock}: ${teamAbbrRaw} -${Math.abs(scoreDiff)} (losing big)`; }
      else if (scoreDiff <= -18) { confidence = 0.91; side = 'NO'; reasoning = `NBA Q${period} ${clock}: ${teamAbbrRaw} -${Math.abs(scoreDiff)}`; }
    } else if (sport === 'mlb' && period >= 8) {
      if (scoreDiff >= 4) { confidence = 0.93; side = 'YES'; reasoning = `MLB inning ${period}: ${teamAbbrRaw} +${scoreDiff} runs`; }
      else if (scoreDiff >= 3) { confidence = 0.86; side = 'YES'; reasoning = `MLB inning ${period}: ${teamAbbrRaw} +${scoreDiff} runs`; }
      else if (scoreDiff <= -4) { confidence = 0.93; side = 'NO'; reasoning = `MLB inning ${period}: ${teamAbbrRaw} down ${Math.abs(scoreDiff)} runs`; }
      else if (scoreDiff <= -3) { confidence = 0.86; side = 'NO'; reasoning = `MLB inning ${period}: ${teamAbbrRaw} down ${Math.abs(scoreDiff)} runs`; }
    } else if (sport === 'nhl' && period >= 3) {
      if (scoreDiff >= 3) { confidence = 0.93; side = 'YES'; reasoning = `NHL P${period}: ${teamAbbrRaw} +${scoreDiff}`; }
      else if (scoreDiff >= 2) { confidence = 0.86; side = 'YES'; reasoning = `NHL P${period}: ${teamAbbrRaw} +${scoreDiff} (empty net likely)`; }
      else if (scoreDiff <= -3) { confidence = 0.93; side = 'NO'; reasoning = `NHL P${period}: ${teamAbbrRaw} down ${Math.abs(scoreDiff)}`; }
      else if (scoreDiff <= -2) { confidence = 0.86; side = 'NO'; reasoning = `NHL P${period}: ${teamAbbrRaw} down ${Math.abs(scoreDiff)}`; }
    }

    if (!side || confidence < phase.minProb) {
      if (side) log(`SportsFastPath: ${m.ticker} conf ${(confidence*100).toFixed(0)}% < phase min — skip`);
      continue;
    }

    const sidePrice = side === 'YES' ? m.yesAsk : Math.max(0.05, 1 - (m.yesBid || (1 - m.yesAsk)));
    if (sidePrice <= 0.05 || sidePrice >= 0.92) continue;
    const netPayout = ((1 - sidePrice) / sidePrice) * (1 - KALSHI_FEE);
    if (netPayout < 3.0) { log(`SportsFastPath: ${m.ticker} payout ${netPayout.toFixed(2)}x < 3.0x min — skip (sports need 3x+ for quality filter)`); continue; }
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
let _priceCache = { btc: null, eth: null, sol: null, xrp: null, doge: null, bnb: null, hype: null, fetchedAt: 0 };

async function fetchLivePrices() {
  const now = Date.now();
  // Return cache if fresh (30s)
  if (_priceCache.btc && (now - _priceCache.fetchedAt) < 30000) {
    return _priceCache;
  }

  // Source 1: Binance (fastest, no rate limits on public endpoints)
  try {
    const symbols = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT'];
    const results = await Promise.allSettled(symbols.map(s =>
      req(`https://api.binance.com/api/v3/ticker/price?symbol=${s}`, { method:'GET', headers:{} }, 5000)
    ));
    const prices = {};
    const map = { BTCUSDT:'btc', ETHUSDT:'eth', SOLUSDT:'sol', XRPUSDT:'xrp', DOGEUSDT:'doge', BNBUSDT:'bnb' };
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.status === 200) {
        prices[map[symbols[i]]] = parseFloat(r.value.body?.price);
      }
    });
    if (prices.btc && prices.eth) {
      _priceCache = { ...prices, fetchedAt: now };
      log(`Prices (Binance): BTC=$${prices.btc?.toLocaleString()} ETH=$${prices.eth?.toLocaleString()} SOL=$${prices.sol?.toFixed(2)} DOGE=$${prices.doge?.toFixed(4)} BNB=$${prices.bnb?.toFixed(2)}`);
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
// Pure server-side math. No Claude call. No API cost. Fires before every brain.
// Handles: 15-min markets (fastest compounding), 1-hour markets, sub-3h markets.
// Confidence curve is time-aware: 15-min needs bigger gap than 1-hour.
// --- LIVE PRICE UPDATER: refresh currentPrice on open positions ---------------
// Called each scan. Crypto positions updated from CoinGecko (free, instant).
// Sports/other positions updated from Kalshi market endpoint (1 call per position).
async function updateOpenPositionPrices(livePrices) {
  if (S.openPositions.length === 0) return;
  for (const pos of S.openPositions) {
    try {
      const isBTC  = /kxbtc/i.test(pos.ticker);
      const isETH  = /kxeth/i.test(pos.ticker);
      const isSOL  = /kxsol/i.test(pos.ticker);
      const isXRPp = /kxxrp/i.test(pos.ticker);
      const isDOGEp= /kxdoge/i.test(pos.ticker);
      const isBNBp = /kxbnb/i.test(pos.ticker);

      if ((isBTC || isETH || isSOL || isXRPp || isDOGEp || isBNBp) && livePrices) {
        // Parse strike from ticker to compute implied market price
        const liveP = isBTC ? livePrices.btc : isETH ? livePrices.eth : isSOL ? livePrices.sol
          : isXRPp ? livePrices.xrp : isDOGEp ? livePrices.doge : livePrices.bnb;
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

  // Use shared price cache (Binance → Kraken → CoinGecko, 30s cache)
  const prices = await fetchLivePrices();
  await updateOpenPositionPrices(prices); // update open position unrealized P&L
  if (!prices.btc && !prices.eth) { log('FastPath: no prices — skip'); return 0; }

  const phase = getPhase();
  const heldSet = new Set(S.openPositions.map(p => p.ticker));
  let filled = 0;

  // Target: ALL crypto markets from FULL scored list (not just top 20)
  // Critical: sports/weather can push crypto out of topMarkets top 20 slice
  // FastPath uses S._allScoredCrypto which is populated in getTopMarkets()
  // This guarantees BTC/ETH 15min markets are ALWAYS scanned regardless of category rank
  const allCryptoPool = (S._allScoredCrypto || topMarkets).filter(
    m => m.hoursLeft < 4.0 && m.hoursLeft > 0.08 && !heldSet.has(m.ticker)
  );
  const cryptoMarkets = allCryptoPool.sort((a, b) => a.hoursLeft - b.hoursLeft); // fastest first

  for (const m of cryptoMarkets) {
    if (S.openPositions.length >= dynamicMaxPos()) break;

    // --- DIRECTION MARKET HANDLER: DISABLED v17 ---
    // Pure "price up/down in next X min" markets have no computable edge for us.
    // Kline-based momentum on 1min candles is noise at 15-min horizons.
    // These markets are priced at ~50c because they ARE coin flips from our vantage.
    // We skip them entirely and focus capital on strike-gap markets where edge exists.
    const hasDollarTarget = m.title && /\$[\d]/.test(m.title.replace(/,/g, ''));
    const isDirectionMarket = (
      !hasDollarTarget && (
        m._isUpDownMarket === true ||
        (m.title && /price (up|down) in (next|the next)/i.test(m.title))
      )
    );
    if (isDirectionMarket) {
      log(`FastPath: ${m.ticker} direction market — skipped (no edge source v17)`);
      continue;
    }

    // --- COIN DETECTION ---
    const isBTC  = /kxbtc/i.test(m.ticker);
    const isETH  = /kxeth/i.test(m.ticker);
    const isSOL  = /kxsol/i.test(m.ticker);
    const isXRP  = /kxxrp/i.test(m.ticker);
    const isDOGE = /kxdoge/i.test(m.ticker);
    const isBNB  = /kxbnb/i.test(m.ticker);
    const isHYPE = /kxhype/i.test(m.ticker);
    const livePrice = isBTC ? prices.btc
      : isETH  ? prices.eth
      : isSOL  ? prices.sol
      : isXRP  ? prices.xrp
      : isDOGE ? prices.doge
      : isBNB  ? prices.bnb
      : isHYPE ? prices.hype
      : null;
    if (!livePrice) { log(`FastPath: no price for ${m.ticker} — skip`); continue; }

    // --- IS THIS A 15-MIN MARKET? ---
    const is15Min = /15M|15MIN|KXBTC15|KXETH15|KXSOL15|KXXRP15|KXDOGE15|KXBNB15/i.test(m.ticker) || m.hoursLeft < 0.30;

    // --- STRIKE PARSING (multi-strategy, covers all Kalshi ticker formats) ---
    let strike = null;

    // Strategy 1: T<number> suffix — KXBTCH-26APR1700-T94999, KXBTCD-T84.9999
    const tMatch = m.ticker.match(/[-_]T([\d]+\.?[\d]*)(?:[_-]|$)/i);
    if (tMatch) strike = parseFloat(tMatch[1]);

    // Strategy 2: Title — ALWAYS try this for SOL/XRP/alt coins and "-00" tickers
    // SOL 15min: "SOL 15-min: $121.90 or below at 7pm" → strike = 121.90
    // BTC hourly: "BTC at $74,750 or above" → strike = 74750
    if (!strike && m.title) {
      const clean = m.title.replace(/,/g, '');
      const dollarMatch = clean.match(/\$([\d]+\.?[\d]*)/);
      if (dollarMatch) {
        const parsed = parseFloat(dollarMatch[1]);
        if (parsed > 0) strike = parsed;
      }
    }

    // Strategy 3: Numeric segment from ticker — only if it looks like a price not a date
    // SKIP 6-digit numbers like 121900 = date "Apr 12, 19:00" (DDMMMHHMM format)
    // SKIP 2-digit suffixes like -00, -15 = sequence numbers
    // ONLY take 4-5 digit numbers that are plausible asset prices
    if (!strike) {
      const numMatch = m.ticker.match(/[-_]([\d]{4,5})(?:[-_]|$)/i);
      if (numMatch) {
        const candidate = parseFloat(numMatch[1]);
        // Reject if it looks like a date fragment (8000-99999 range = suspicious for alt coins)
        const looksLikeDate = candidate > 10000 && candidate < 99999 &&
          m.ticker.includes('15M') && (isSOL || isXRP); // SOL/XRP 15min dates in this range
        if (!looksLikeDate) strike = candidate;
      }
    }

    // Strategy 4: Decimal in ticker (e.g. T81.9999, T57.99 for ETH/SOL)
    if (!strike) {
      const decMatch = m.ticker.match(/[-_T]([\d]+\.[\d]+)(?:[-_]|$)/i);
      if (decMatch) strike = parseFloat(decMatch[1]);
    }

    if (!strike || strike <= 0) { log(`FastPath: can't parse strike for ${m.ticker} title="${(m.title||'').slice(0,40)}" — skip`); continue; }

    // Sanity check: strike should be in a reasonable range for the coin
    const maxStrike = isBTC ? 200000 : isETH ? 10000 : isSOL ? 2000 : isXRP ? 10
      : isDOGE ? 5 : isBNB ? 5000 : isHYPE ? 500 : 200000;
    const minStrike = isBTC ? 10000 : isETH ? 100 : isSOL ? 0.50 : isXRP ? 0.001
      : isDOGE ? 0.001 : isBNB ? 50 : isHYPE ? 0.50 : 0.001;
    if (strike > maxStrike || strike < minStrike) {
      log(`FastPath: ${m.ticker} strike=${strike} out of range [${minStrike}-${maxStrike}] — skip`);
      continue;
    }

    const gap = Math.abs(livePrice - strike);
    const gapPct = gap / livePrice;

    // --- TIME-AWARE CONFIDENCE CURVE ---
    // BTC at $84,500 vs strike $73,000 = 13.7% gap — extremely confident
    // BTC at $84,500 vs strike $84,000 = 0.6% gap — risky for 1h window
    let confidence;
    // CONFIDENCE CURVES — calibrated to real win rates by time window
    // Key insight: smaller gap = coin flip at short time windows
    // 15min needs 5%+ gap: in 15 min, BTC can move 1-2% easily → tiny gap = loss
    // 1hr needs 3%+ gap: in 1hr, BTC can move 2-3% → need cushion
    // RECALIBRATED CONFIDENCE CURVES v14 — calibrated to real BTC/ETH volatility
    // BTC 1-sigma: ~1.5% per 15min, ~2.5% per 1hr, ~4.5% per 4hr
    // Old curves inflated confidence on weak gaps (e.g. 89% at 5% hourly = ~72% real WR)
    // New curves right-size Kelly bets and stop overconfident small-gap trades
    if (is15Min) {
      // v18: calibrated for range-bound vol regimes. 5% gap on 15min = ~3x vol buffer.
      if (gapPct >= 0.15) confidence = 0.93;       // high conviction
      else if (gapPct >= 0.10) confidence = 0.88;  // strong
      else if (gapPct >= 0.07) confidence = 0.83;  // solid
      else if (gapPct >= 0.05) confidence = 0.78;  // entry-level
      else { log(`FastPath 15min: ${m.ticker} gap ${(gapPct*100).toFixed(2)}% < 5% v18 floor — skip`); continue; }
    } else if (m.hoursLeft < 1.5) {
      // v18: calibrated. 3% gap on 1h = modest but real edge in range-bound regimes.
      if (gapPct >= 0.10) confidence = 0.91;
      else if (gapPct >= 0.07) confidence = 0.85;
      else if (gapPct >= 0.05) confidence = 0.80;
      else if (gapPct >= 0.03) confidence = 0.74;
      else { log(`FastPath hourly: ${m.ticker} gap ${(gapPct*100).toFixed(2)}% < 3% v18 floor — skip`); continue; }
    } else {
      if (gapPct >= 0.10) confidence = 0.91;
      else if (gapPct >= 0.06) confidence = 0.85;
      else if (gapPct >= 0.035) confidence = 0.79;
      else if (gapPct >= 0.020) confidence = 0.74;
      else if (gapPct >= 0.010) confidence = 0.68;
      else { log(`FastPath sub4h: ${m.ticker} gap ${(gapPct*100).toFixed(2)}% < 1% v18 floor — skip`); continue; }
    }

    // Gap bonus — only for clearly large gaps (tightened)
    if (gapPct >= 0.15) confidence = Math.min(0.97, confidence + 0.03);
    else if (gapPct >= 0.10) confidence = Math.min(0.95, confidence + 0.02);

    // Near-expiry caution
    if (m.hoursLeft < 0.12) confidence = Math.min(confidence, 0.72); // <7min: too risky

    // ── UP/DOWN TARGET MARKET: market price drives everything ──────────────────
    // For markets like "BTC 15 min · $74,930 target" the market's OWN PRICING
    // is the best signal. If Down costs 95c, market says 95% chance Down wins.
    // NEVER use gap direction for these — tiny gaps caused 3 consecutive losses
    // by betting 4-12% longshot sides. Always bet the HIGH-PROBABILITY side.
    const isUpDownTargetMkt = m._isUpDownMarket === true;
    if (isUpDownTargetMkt) {
      // upProb = yesAsk = market's implied probability of Up winning
      // downProb = 1 - yesAsk (approx, ignoring spread)
      const upProb   = m.yesAsk;                              // e.g. 0.28 = 28% Up
      const downProb = Math.min(0.97, 1 - (m.yesBid || m.yesAsk)); // e.g. 0.72 = 72% Down
      const betUp   = upProb   >= downProb;                   // Up has higher probability?
      const betProb = betUp ? upProb : downProb;              // probability of our chosen side
      const betSide = betUp ? 'YES' : 'NO';                  // YES=Up, NO=Down
      const betPrice = betUp ? m.yesAsk
        : Math.max(0.05, 1 - (m.yesBid || m.yesAsk));       // price we pay for our side

      // MINIMUM PROBABILITY GATE: only bet if market says >= 60% chance of winning
      const udMinProb = Math.max(phase.minProb, 0.60);
      if (betProb < udMinProb) {
        log(`FastPath UD: ${m.ticker} max prob ${(betProb*100).toFixed(0)}% < ${(udMinProb*100).toFixed(0)}% min — skip (${betUp?'Up':'Down'}@${(betPrice*100).toFixed(0)}c)`);
        continue;
      }
      if (betPrice <= 0.05 || betPrice >= 0.97) {
        log(`FastPath UD: ${m.ticker} price ${(betPrice*100).toFixed(0)}c out of range — skip`);
        continue;
      }

      // MOMENTUM CONFIRMATION: cross-check market price direction vs Binance 1m trend
      // Market says 72% Down but last 3 green candles? Skip — two signals must agree.
      // Agreement adds +0.04 conf. Disagreement = skip entirely (avoids momentum traps).
      let udMomentumBonus = 0;
      try {
        const _coin = isBTC?'BTCUSDT':isETH?'ETHUSDT':isSOL?'SOLUSDT':isXRP?'XRPUSDT':isDOGE?'DOGEUSDT':'BNBUSDT';
        const _klR = await Promise.race([
          req(`https://api.binance.com/api/v3/klines?symbol=${_coin}&interval=1m&limit=4`, {method:'GET',headers:{}}, 4000),
          new Promise((_,rej) => setTimeout(()=>rej(new Error('kline timeout')),4000))
        ]);
        if (_klR.status === 200 && Array.isArray(_klR.body) && _klR.body.length >= 3) {
          // Count how many of last 3 candles are bullish (close > open)
          const _kls = _klR.body.slice(-3);
          const _bullCount = _kls.filter(k => parseFloat(k[4]) > parseFloat(k[1])).length;
          const _trendUp = _bullCount >= 2; // 2+ of 3 candles green = uptrend
          const _trendDown = _bullCount <= 1; // 0-1 green = downtrend
          const _marketSaysUp = betUp; // market price says Up has higher prob
          // Agreement: market direction matches kline momentum
          if ((_marketSaysUp && _trendUp) || (!_marketSaysUp && _trendDown)) {
            udMomentumBonus = 0.04; // both signals agree — boost confidence
            log(`FastPath UD momentum AGREE: market=${betUp?'Up':'Down'} kline=${_trendUp?'Up':'Down'} +0.04 conf`);
          } else {
            // Disagreement: skip — momentum trap risk is too high
            log(`FastPath UD momentum DISAGREE: market=${betUp?'Up':'Down'} kline=${_trendUp?'Up':'Down'} — SKIP`);
            continue;
          }
        }
      } catch(_klErr) {
        // Kline fetch failed — proceed without bonus (don't block on data error)
        log(`FastPath UD: kline fetch failed (${_klErr.message}) — proceeding without momentum check`);
      }

      // Confidence = raw market probability (v17: no bonus layer). If Kalshi
      // says 72%, we use 72%. Adding confidence on top is how we over-Kelly.
      const udConf = Math.min(0.92, betProb); // raw market prob, capped at 92%
      const udPayout   = ((1 - betPrice) / betPrice) * (1 - KALSHI_FEE);
      const udEdge     = udConf - betPrice;
      if (udEdge < phase.minEdge) {
        log(`FastPath UD: ${m.ticker} edge ${(udEdge*100).toFixed(1)}% < ${(phase.minEdge*100).toFixed(0)}% — skip`);
        continue;
      }

      const udCoinLabel = isBTC?'BTC':isETH?'ETH':isSOL?'SOL':isXRP?'XRP':isDOGE?'DOGE':isBNB?'BNB':isHYPE?'HYPE':'ALT';
      const udSig = {
        ticker: m.ticker, side: betSide, confidence: udConf, edge: udEdge,
        marketPrice: betPrice, feeAdjustedEdge: udEdge - (betPrice * KALSHI_FEE),
        netPayoutRatio: udPayout, hoursToClose: m.hoursLeft,
        source: 'fastpath', isFavorite: betPrice >= 0.55, isUpDownTarget: true,
        reasoning: `⚡ FastPath [UD] ${udCoinLabel} ${betSide}(${betUp?'Up':'Down'}) market=${(betProb*100).toFixed(0)}% @${(betPrice*100).toFixed(1)}c = ${udPayout.toFixed(2)}x | strike=$${strike}`,
      };
      log(`⚡ FastPath [UD]: ${m.ticker} ${betSide} | market=${(betProb*100).toFixed(0)}% | ${udPayout.toFixed(2)}x | ${udCoinLabel} ${betUp?'above':'below'} $${strike}`);
      tg(`⚡ <b>FastPath [UD] — $0 AI</b>
${m.ticker} ${betSide} (${betUp?'Up':'Down'})
Market: ${(betProb*100).toFixed(0)}% confident | ${udPayout.toFixed(2)}x
${udCoinLabel}=$${livePrice.toLocaleString()} vs $${strike}`);
      await executeTrade(udSig);
      filled++;
      continue; // handled — skip to next market
    }

    // ── REGULAR STRIKE MARKET: gap-based direction ────────────────────────────
    const priceAbove = livePrice > strike;
    const suggestedSide = priceAbove ? 'YES' : 'NO';

    // SANITY: Never bet YES when price is below strike or NO when above.
    if (suggestedSide === 'YES' && !priceAbove) {
      log(`FastPath SKIP: ${m.ticker} — betting YES but price BELOW strike (${(gapPct*100).toFixed(1)}% gap wrong way)`);
      continue;
    }
    if (suggestedSide === 'NO' && priceAbove) {
      log(`FastPath SKIP: ${m.ticker} — betting NO but price ABOVE strike (${(gapPct*100).toFixed(1)}% gap wrong way)`);
      continue;
    }

    // --- PAYOUT CALC ---
    const sidePrice = suggestedSide === 'YES'
      ? m.yesAsk
      : Math.max(0.05, 1 - (m.yesBid || (1 - m.yesAsk)));
    if (sidePrice <= 0.05 || sidePrice >= 0.95) continue;
    const netPayout = ((1 - sidePrice) / sidePrice) * (1 - KALSHI_FEE);
    const edge = confidence - sidePrice;

    const isUnderdog = sidePrice <= 0.38;
    const isFavorite15min = is15Min && sidePrice >= 0.55 && sidePrice <= 0.92 && confidence >= 0.88 && gapPct >= 0.08;
    const isFavoriteHourly = !is15Min && sidePrice >= 0.55 && sidePrice <= 0.88 && confidence >= 0.85;
    const isFavorite = isFavorite15min || isFavoriteHourly;

    // --- GATE CHECKS ---
    const fastPathMinConf = isUnderdog ? Math.max(phase.minProb, 0.72) : 0.68;
    if (confidence < fastPathMinConf) {
      log(`FastPath: ${m.ticker} conf ${(confidence*100).toFixed(0)}% < ${(fastPathMinConf*100).toFixed(0)}% min — skip`);
      continue;
    }
    if (!isUnderdog && !isFavorite) {
      log(`FastPath: ${m.ticker} price ${(sidePrice*100).toFixed(0)}c not in underdog (5-38c) or favorite (55-88c) zone — skip`);
      continue;
    }
    if (isUnderdog && edge < phase.minEdge) {
      log(`FastPath: ${m.ticker} edge ${(edge*100).toFixed(1)}% < ${(phase.minEdge*100).toFixed(0)}% min — skip`);
      continue;
    }
    const minPayout = isUnderdog ? (is15Min ? 2.0 : 2.5) : 0.20; // favorites: any positive EV
    if (netPayout < minPayout) {
      log(`FastPath: ${m.ticker} payout ${netPayout.toFixed(2)}x < ${minPayout}x floor — skip`);
      continue;
    }
    // Favorite trade: verify EV is truly positive
    if (isFavorite && !isUnderdog) {
      const ev = confidence * netPayout - (1 - confidence);
      if (ev < 0.05) { // need at least 5% positive EV even for favorites
        log(`FastPath: ${m.ticker} favorite EV ${(ev*100).toFixed(1)}% too low — skip`);
        continue;
      }
    }

    const coinLabel = isBTC?'BTC':isETH?'ETH':isSOL?'SOL':isXRP?'XRP':isDOGE?'DOGE':isBNB?'BNB':isHYPE?'HYPE':'ALT';
    const windowLabel = is15Min ? '15min' : m.hoursLeft < 1.5 ? '1hr' : `${m.hoursLeft.toFixed(1)}h`;
    const sig = {
      ticker: m.ticker,
      side: suggestedSide,
      confidence,
      edge,
      marketPrice: sidePrice,
      feeAdjustedEdge: edge - (sidePrice * KALSHI_FEE),
      netPayoutRatio: netPayout,
      hoursToClose: m.hoursLeft,
      source: 'fastpath',
      strike: strike, // stored for strike dedup check
      isFavorite: isFavorite && !isUnderdog, // 15min favorites get 30% Kelly, hourly get 50%
      isUpDownTarget: isUpDownTargetMkt,     // Up/Down target market flag
      reasoning: `⚡ FastPath [${windowLabel}${isUpDownTargetMkt?'/UD':''}] ${coinLabel}=$${livePrice.toLocaleString()} vs strike $${strike.toLocaleString()} | gap=${(gapPct*100).toFixed(2)}% | ${suggestedSide} @${(sidePrice*100).toFixed(1)}c = ${netPayout.toFixed(2)}x | conf=${(confidence*100).toFixed(0)}%`,
    };

    log(`⚡ FastPath [${windowLabel}]: ${m.ticker} ${suggestedSide} | ${(confidence*100).toFixed(0)}% conf | ${netPayout.toFixed(2)}x | gap=${(gapPct*100).toFixed(2)}%`);
    tg(`⚡ <b>FastPath [${windowLabel}] — $0 AI cost</b>\n${m.ticker} ${suggestedSide}\nGap: ${(gapPct*100).toFixed(2)}% | ${(confidence*100).toFixed(0)}% conf | ${netPayout.toFixed(2)}x payout\n${coinLabel}=$${livePrice.toLocaleString()} vs strike $${strike.toLocaleString()}`);

    await executeTrade(sig);
    filled++;
  }

  if (filled > 0) log(`⚡ FastPath v2: filled ${filled} position(s) — $0 AI cost`);
  return filled;
}

// --- CLAUDE BRAIN (fires only when math scanner finds high-value targets) --
async function runBrain(topMarkets) {
  if (!CFG.claudeKey) { log('No Claude key', 'WARN'); return; }
  if (topMarkets.length === 0) { log('Brain skipped: no markets to analyze'); return; }

  // BRAIN KILL SWITCH GATE — check before any API spend
  if (S.brainKillSwitchUntil && S.brainKillSwitchUntil > Date.now()) {
    const _ksMin = Math.ceil((S.brainKillSwitchUntil - Date.now()) / 60000);
    log(`Brain kill switch active - ${_ksMin}min remaining - FastPath only`);
    return;
  }

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
  try {
    const _prices = await fetchLivePrices();
    const _b = _prices.btc, _e = _prices.eth, _s = _prices.sol, _x = _prices.xrp;
    if (_b || _e) {
      const _dg = _prices.doge, _bn = _prices.bnb;
      _priceCtx = `LIVE PRICES @ ${new Date().toLocaleString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'})} ET: BTC=${_b ? '$'+_b.toLocaleString() : 'N/A'} ETH=${_e ? '$'+_e.toLocaleString() : 'N/A'} SOL=${_s ? '$'+_s.toFixed(2) : 'N/A'} XRP=${_x ? '$'+_x.toFixed(4) : 'N/A'} DOGE=${_dg ? '$'+_dg.toFixed(4) : 'N/A'} BNB=${_bn ? '$'+_bn.toFixed(2) : 'N/A'} — USE THESE FOR CRYPTO MATH`;
      log(`Brain prices: BTC=$${_b} ETH=$${_e} SOL=$${_s}`);
    } else {
      _priceCtx = 'PRICES UNAVAILABLE — use 1 web search to find current BTC and ETH prices before analyzing crypto markets';
      log('Brain: no prices available — brain will need to search', 'WARN');
    }
  } catch(_err) {
    _priceCtx = 'PRICES UNAVAILABLE — use 1 web search to find current BTC and ETH prices';
  }

  const prompt = `You are a prediction market trader. Respond ONLY with valid JSON starting with { and ending with }.

LIVE PRICES: ${_priceCtx||'UNAVAILABLE - search for BTC/ETH price'}
TIME: ${new Date().toLocaleString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',weekday:'short'})} ET
HELD (do not trade these): ${_heldStr}
BALANCE: $${_bal.toFixed(2)} | Cash: $${(S.availableCash||0).toFixed(2)} | Slots to fill: ${_slots} | Phase: ${phase.name}

MARKETS (sorted best first):
${JSON.stringify(topMarkets.slice(0,15).map(m=>({ticker:m.ticker,title:(m.title||'').slice(0,70),yesAsk:+(m.yesAsk*100).toFixed(0),yesBid:+((m.yesBid||0)*100).toFixed(0),netPayout:+(m.netPayoutRatio||((1-m.yesAsk)/m.yesAsk*0.955)).toFixed(2),suggestedSide:m.suggestedSide||'YES',hoursLeft:+m.hoursLeft.toFixed(2),held:_heldTickers.includes(m.ticker)})))}

INSTRUCTIONS - follow in order until you have ${_slots} signal(s):

HARD RULES — NEVER VIOLATE:
1. NEVER bet YES on crypto if current price is BELOW the strike (moon shot = always loses)
2. NEVER bet NO on crypto if current price is ABOVE the strike
3. NEVER trade anything with market-implied probability <15% (price <15c = skip)
4. WEATHER TRADES ARE COMPLETELY BANNED — never signal KXHIGH, KXLOW, or any temperature market
5. FASTEST markets only: 15min > 1hr > 3hr. Never tomorrow.
6. Gap direction MUST match side: price ABOVE = YES, price BELOW = NO only
7. NEVER signal a ticker already in HELD list
8. Only signal trades with 80%+ true confidence

STEP 0 - DIRECTION / UP-DOWN MARKETS (title has "Up" or "Down" sides, or says "price up/down in next X mins?"):
- These have NO dollar strike. Check if the 1-minute trend of BTC/ETH is clearly up or down.
- "BTC 15 min · $74,895 target" Up/Down → YES (Up) if BTC is ABOVE $74,895. YES if it will stay above.
- "ETH price down in next 15 mins?" → YES if ETH has been trending DOWN
- "SOL 15 min · $85.30 target" Up → bet YES on Up if SOL price is above the target
- "DOGE 15 min · $0.097 target" Down → bet YES on Down if DOGE is BELOW target
- For Up/Down target markets: use the MARKET PRICE as your signal, not price vs target.
- Up side costs 28c = market says 28% Up, 72% Down → bet Down (NO) with 72% confidence.
- Up side costs 72c = market says 72% Up → bet Up (YES) with 72% confidence.
- ONLY bet the side with market probability >= 60%. Never bet the longshot side (< 40%).
- Confidence = market probability of your chosen side. netPayout must be >= 1.0x.
- Signal up to 2 direction/Up-Down trades per cycle.

STEP 1 - CRYPTO (no search needed, no 15min markets):
- SKIP any market with hoursLeft < 0.5 (less than 30 min) — too volatile for brain
- For each remaining crypto market: find the strike in the title
- YES ONLY if price > strike with gap >= 5%. NO ONLY if price < strike with gap >= 5%
- Signal if gap >= 5% AND netPayout >= 2.0 AND hoursLeft >= 0.5
- Confidence: gap<5%=SKIP, gap 5-8%=80%, gap 8-15%=87%, gap>15%=93%
- A 5% gap means price must move 5%+ against you to lose — that is real edge

STEP 2 - SPORTS (1 search per game): Search "[team] vs [team] live score". Signal ONLY if: NBA leading 18+ points in Q4, MLB leading 3+ runs after 8th, NHL leading 2+ goals in 3rd period. netPayout>=3.0 (same floor as FastPath sports). 85%+ confidence minimum. If margin is smaller than these thresholds, return 0 sports signals — do not lower the bar.

STEP 3 - FALLBACK: If still under ${_slots} signals, only crypto with gap>=6% AND hoursLeft>=0.75h.
- TWO-SOURCE VERIFY: gap must be confirmed by both (a) current price vs strike AND (b) gap is >= 6%.
- If gap is 4-5.9%, DO NOT signal — that is inside normal hourly volatility noise.
- NO 15min markets from brain ever. NO weather. NO borderline trades.
- When in doubt: return 0 signals. Idle slots beat bad bets.

Confidence floors: ALL brain signals need 80%+ minimum. No exceptions.
Quality floor: brain should only fire when the edge is OBVIOUS — not to fill slots.

Respond with this exact JSON structure:
{"signals":[{"ticker":"","side":"YES","confidence":0.85,"edge":0.65,"marketPrice":0.22,"feeAdjustedEdge":0.62,"netPayoutRatio":3.4,"hoursToClose":0.2,"reasoning":""}],"marketSummary":"","skipReason":""}`;



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
        const meetsEdge = _effectiveEdge >= execPhase.minEdge;
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
  // Sizing tiers:
  // - FastPath 88%+ underdog (NO at 20c): full Kelly — this is the primary edge
  // - FastPath 15min favorite with 8%+ gap (YES at 85-92c, 93%+ conf): 70% Kelly
  //   These win ~95%+ of the time, so still size aggressively
  // - FastPath hourly favorite (YES at 60-85c, 89%+ conf): 50% Kelly
  //   Lower payout but very reliable — consistent compounding
  // - Brain signals: 40% Kelly — LLM less reliable than math
  const is15MinFav = isFavoriteTrade && sig && (sig.hoursToClose || 0) < 0.30;
  const kellyFrac = (isFavoriteTrade && is15MinFav) ? phase.kelly * 0.70
    : isFavoriteTrade ? phase.kelly * 0.50
    : isHighConfFastPath ? phase.kelly
    : phase.kelly * 0.40;
  const fracKelly = kelly * kellyFrac;

  const totalBal = Math.max(S.realBalance || 0, S.balance || 0);
  if (totalBal < 3.00) return 0;

  const availCash = S.availableCash > 1 ? S.availableCash
    : (S.restingOrders.length === 0 ? Math.max(0, totalBal - 1.00) : 0);
  if (availCash < 2.00) return 0;

  const rawBet = availCash * fracKelly;

  // 3 hard caps — most restrictive wins
  const capPct   = totalBal * phase.maxPct;
  const capDollar = (source === 'brain') ? phase.maxBetDollars * 0.40 : phase.maxBetDollars;
  const exposure  = S.openPositions.reduce((s, p) => s + (p.cost || 0), 0);
  const capExposure = Math.max(0, totalBal * phase.maxExposure - exposure);

  const bet = Math.min(rawBet, capPct, capDollar, capExposure, availCash * 0.85);
  return Math.max(1.00, bet);
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
  // v17 HARD GATE: short-duration only. Positions must settle within 2 hours.
  // This preserves the flywheel — capital recycles fast, slots don't stagnate on
  // long-dated bets that block short-duration opportunities. Arb trades exempt
  // because they're guaranteed positive regardless of settlement time.
  const _hoursLeft = sig.hoursToClose || 999;
  if (!sig.isArb && _hoursLeft > 2.0) {
    log(`v17 SKIP: ${sig.ticker} settles in ${_hoursLeft.toFixed(1)}h — exceeds 2h flywheel cap`);
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
  // ARB: allow both YES and NO legs on same ticker (that IS the arb — you hold both sides)
  if (!sig.isArb && S.openPositions.find(p => p.ticker === sig.ticker)) {
    log(`Skip ${sig.ticker}: already have position`);
    return;
  }
  // For arb: block only if we already have SAME SIDE on same ticker
  if (sig.isArb && S.openPositions.find(p => p.ticker === sig.ticker && p.side === sig.side)) {
    log(`Skip ${sig.ticker} ${sig.side}: arb leg already placed`);
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
  // If availableCash=0 but there are no resting orders, use realBalance directly
  // (syncRestingOrders may have failed or returned 0 orders incorrectly)
  const effectiveCash = S.availableCash > 0 ? S.availableCash
    : (S.restingOrders.length === 0 ? Math.max(0, (S.realBalance || S.balance) - 1.00) : 0);
  if (effectiveCash < 2.00) {
    const reserved = S.restingOrders.reduce((s,o) => s + o.reservedCash, 0);
    log(`Skip ${sig.ticker}: $${effectiveCash.toFixed(2)} effective cash ($${(S.realBalance||S.balance).toFixed(2)} total, $${reserved.toFixed(2)} in ${S.restingOrders.length} resting orders)`);
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
  // ARB trades exempt from price range gate — their price is pre-validated
  if(!sig.isArb && (sidePriceActual <= 0.08 || sidePriceActual >= 0.92)){
    log('Skip '+sig.ticker+': '+sig.side+' @'+(sidePriceActual*100).toFixed(0)+'c outside 8-92c range — extreme longshot blocked'); return;
  }
  // HARD GATE: market-implied prob <10% = pure donation. Block at execution layer.
  // This is the last line of defense against moon shots, 1% weather bets, etc.
  if (sidePriceActual < 0.10) {
    log("Hard gate: " + sig.ticker + " @" + (sidePriceActual*100).toFixed(0) + "c <10% prob -- BANNED");
    return;
  }
  // HARD GATE: weather trades from brain are permanently banned — consistent losers
  if (/kxhigh|kxlow/i.test(sig.ticker) && (sig.source === 'brain' || !sig.source)) {
    log("Hard gate: weather trade BANNED: " + sig.ticker + " src=" + (sig.source||'unknown'));
    return;
  }
  // HARD GATE: Up/Down target markets — never bet a side with < 58% market probability
  // This is the 60% win rate guarantee. If market prices our side at < 58c, skip.
  // Exception: underdog trades (< 38c) are intentional longshots with high payout.
  if (sig.isUpDownTarget && sig.isFavorite && sig.marketPrice < 0.58) {
    log(`Hard gate: UD market ${sig.ticker} side price ${(sig.marketPrice*100).toFixed(0)}c < 58% min probability — skip`);
    return;
  }
  // HARD GATE: brain on 15min markets — only allowed if it's a direction market (no strike)
  // Direction markets ("price up/down in next 15 mins") are valid for brain since they
  // don't need gap math — they need trend analysis.
  const _isDirectionTitle = sig.reasoning && /\[DIR\]/i.test(sig.reasoning);
  const _isBrainDirection = sig.source === 'brain' && (
    // Allow if title suggests direction market (no dollar strike)
    sig.reasoning && /price up|price down|trend/i.test(sig.reasoning)
  );
  if (/15M|15MIN/i.test(sig.ticker) && sig.source === 'brain' && !_isBrainDirection) {
    log("Hard gate: brain BANNED from 15min strike market: " + sig.ticker + " — FastPath only");
    return;
  }
  // HARD GATE: brain signals need 20min+ to close (relaxed from 45min for direction markets)
  // FastPath signals are exempt — they have mathematical gap enforcement
  // Lowered minimum time from 25min to 18min for brain signals (slots fill faster)
  // Allows brain to catch hourly markets that FastPath missed due to gap threshold
  // Still blocks very-short trades where brain analysis has no time to be correct
  const _minBrainMins = _isBrainDirection ? 12 : 18; // direction: 12min, normal: 18min (was 25)
  if ((sig.hoursToClose || 999) < (_minBrainMins / 60) && sig.source === 'brain') {
    log("Hard gate: brain signal rejected — " + ((sig.hoursToClose||0)*60).toFixed(0) + "min too short (need " + _minBrainMins + "min+)");
    return;
  }

  // HARD PAYOUT GUARD: server-side enforcement of minimum payout ratio
  // This is the key fix: even if brain signals a high-price bet, server rejects it.
  // Net payout = ((1 - tradePrice) / tradePrice) * (1 - KALSHI_FEE)
  // Payout = (1 - sidePrice) / sidePrice * (1 - fee)
  // sidePriceActual already defined above = the actual price of the side (e.g. 0.25 for NO at 25c)
  const sidePriceForPayout = sidePriceActual;
  const netPayoutRatio = ((1 - sidePriceForPayout) / sidePriceForPayout) * (1 - KALSHI_FEE);
  const isCryptoTicker = /kxbtc|kxeth|kxsol|kxxrp|kxdoge|kxbnb|kxhype|kxavax/i.test(sig.ticker);
  const isFastPath = sig.source === 'fastpath';
  // Payout floors — fastpath trades get slight relaxation since the math edge is structural
  // Favorite trades (isFavorite=true) bypass payout floor — they win via high WR not payout
  const isFavoriteExec = sig.isFavorite === true;
  const minPayout = isFavoriteExec ? 0.15  // favorites: just need positive EV
    : isCryptoTicker
    ? ((phase.name === 'SEED' || phase.name === 'SPROUT') ? (isFastPath ? 1.8 : 2.0) : 1.6)
    : ((phase.name === 'SEED' || phase.name === 'SPROUT') ? 2.5 : 1.8);
  // ARB trades bypass payout floor — they're guaranteed by definition (both sides held)
  if (netPayoutRatio < minPayout && !sig.isArb) {
    log(`Skip ${sig.ticker}: payout ${netPayoutRatio.toFixed(2)}x < ${minPayout}x floor (${sig.side}@${(sidePriceForPayout*100).toFixed(0)}c src:${sig.source||'brain'})`);
    return;
  }
  // Tiered confidence guards — these protect against longshots with no real edge
  if (sidePriceActual < 0.12 && sig.confidence < 0.85) {
    log(`Skip ${sig.ticker}: extreme longshot ${sig.side}@${(sidePriceActual*100).toFixed(0)}c needs 85%+ conf, got ${(sig.confidence*100).toFixed(0)}%`);
    return;
  }
  if (sidePriceActual < 0.20 && sig.confidence < 0.76) {
    log(`Skip ${sig.ticker}: longshot ${sig.side}@${(sidePriceActual*100).toFixed(0)}c needs 76%+ conf, got ${(sig.confidence*100).toFixed(0)}%`);
    return;
  }
  if (sidePriceActual < 0.30 && sig.confidence < 0.70) {
    log(`Skip ${sig.ticker}: underdog ${sig.side}@${(sidePriceActual*100).toFixed(0)}c needs 70%+ conf, got ${(sig.confidence*100).toFixed(0)}%`);
    return;
  }
  // Edge calculation — correct for both YES and NO sides
  // tradePrice is the YES-equivalent (used for Kelly and payout math)
  // For edge: we compare confidence to the ACTUAL price paid for the chosen side
  const brainEdge = sig.feeAdjustedEdge || sig.edge || 0;
  // Correct server edge: conf vs the actual price of the side being traded
  // For YES: we pay yesAsk (= tradePrice). For NO: we pay (1 - yesBid) = noAsk.
  const mktP_raw = sig.marketPrice || 0.5;
  const sidePrice = sig.side === 'NO' ? (1 - mktP_raw) : mktP_raw; // actual price for this side
  const serverEdge = sig.confidence - sidePrice;
  // Take best of brain edge and server edge (brain may have better data, server is a sanity check)
  const effectiveEdge = Math.max(brainEdge, serverEdge);
  // For crypto math trades (hourly/daily BTC/ETH), edge from price vs strike is valid
  // Don't block trades where payout clearly justifies the confidence level
  const isCryptoMath = /kxbtc|kxeth|kxsol|kxxrp|kxdoge|kxbnb|kxhype/i.test(sig.ticker);
  const payoutJustifiesEdge = netPayoutRatio >= 2.5 && sig.confidence >= phase.minProb;
  if(effectiveEdge < phase.minEdge && !(isCryptoMath && payoutJustifiesEdge)){
    log('Skip '+sig.ticker+': edge '+(effectiveEdge*100).toFixed(1)+'% < min '+(phase.minEdge*100)+'% [brain:'+(brainEdge*100).toFixed(1)+'% server:'+(serverEdge*100).toFixed(1)+'%]');return;
  }
  if(sig.confidence<phase.minProb){log('Skip '+sig.ticker+': conf '+(sig.confidence*100).toFixed(0)+'% < min '+(phase.minProb*100)+'%');return;}
  // Kelly should use the actual price paid for the side (not YES-equivalent)
  // Kelly uses sidePriceActual — the actual price paid for this side
  const serverKelly = kellySize(sig.confidence, sidePriceActual, sig.source || 'brain', sig);
  // Minimum bet size scales with balance — never bet less than $0.75 or 5% of balance
  // For hourly crypto: allow smaller positions (faster turnover > bigger size)
  const isHourlySig = (sig.hoursToClose || 999) < 1.5;
  const bal4min = S.availableCash > 0 ? S.availableCash : (S.realBalance || S.balance);
  const minBet = isHourlySig
    ? Math.max(0.50, bal4min * 0.03)  // hourly: smaller ok (fast recycling)
    : Math.max(0.50, bal4min * 0.04); // normal: lowered from 5% so small balances can trade
  if(serverKelly < minBet){ log('Skip '+sig.ticker+': Kelly $'+serverKelly.toFixed(2)+' < $'+minBet.toFixed(2)+' min'); return; }

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
        if (!S.sourceWins) S.sourceWins = { fastpath: 0, sports_fastpath: 0, brain: 0, arb: 0 };
        if (!S.sourceLosses) S.sourceLosses = { fastpath: 0, sports_fastpath: 0, brain: 0, arb: 0 };
        if (won) S.sourceWins[src] = (S.sourceWins[src] || 0) + 1;
        else S.sourceLosses[src] = (S.sourceLosses[src] || 0) + 1;

        // PER-SOURCE BRAIN KILL SWITCH
        // Brain WR < 42% in rolling 10 trades -> pause brain 2hr. FastPath unaffected.
        // Kill switch stored in S.brainKillSwitchUntil (timestamp). 0 = inactive.
        if (src === 'brain') {
          const _bW = S.sourceWins.brain || 0, _bL = S.sourceLosses.brain || 0;
          if (_bW + _bL >= 6) {
            const _recB = (S.trades || []).filter(t => (t.source||'brain')==='brain' && t.status==='resolved').slice(-10);
            const _rWR = _recB.length >= 6 ? _recB.filter(t=>t.won===true).length/_recB.length : _bW/(_bW+_bL);
            if (_rWR < 0.42 && !S.brainKillSwitchUntil) {
              S.brainKillSwitchUntil = Date.now() + 2*3600000;
              log(`BRAIN KILL SWITCH: ${(_rWR*100).toFixed(0)}% WR last ${_recB.length} brain trades - paused 2hr`, 'WARN');
              tg(`BRAIN KILL SWITCH ON\nWR ${(_rWR*100).toFixed(0)}% (last ${_recB.length} brain trades)\nBrain paused 2hr - FastPath continues\nResumes ${new Date(S.brainKillSwitchUntil).toLocaleTimeString('en-US',{timeZone:'America/New_York'})} ET`);
            }
            if (S.brainKillSwitchUntil && S.brainKillSwitchUntil < Date.now()) {
              if (_rWR >= 0.55) {
                log(`Brain kill switch lifted - WR ${(_rWR*100).toFixed(0)}% recovered`);
                tg(`BRAIN KILL SWITCH OFF\nWR ${(_rWR*100).toFixed(0)}% - brain resuming`);
                S.brainKillSwitchUntil = 0;
              } else {
                S.brainKillSwitchUntil = Date.now() + 3600000;
                log(`Brain kill switch extended 1hr - WR still ${(_rWR*100).toFixed(0)}% (need 55%)`);
              }
            }
          }
        }

        // ── CIRCUIT BREAKER LOGIC ───────────────────────────────────────────
        if (won) {
          S.consecutiveLosses = 0; // reset on any win
        } else {
          S.consecutiveLosses = (S.consecutiveLosses || 0) + 1;
          if (S.consecutiveLosses >= 5) {
            const pauseMs = 20 * 60000; // 20min pause — was 90min, too long for flywheel
            S.circuitBreakerUntil = Date.now() + pauseMs;
            log(`🔴 CIRCUIT BREAKER: ${S.consecutiveLosses} consecutive losses — pausing 20min`, 'WARN');
            tg(`🔴 <b>Circuit Breaker Triggered</b>\n${S.consecutiveLosses} consecutive losses\nTrading paused 20 minutes\nResumes: ${new Date(S.circuitBreakerUntil).toLocaleTimeString('en-US',{timeZone:'America/New_York'})} ET\n💰 Balance: $${(S.realBalance||S.balance).toFixed(2)}`);
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
        // Clear the current scan timer and restart in 2s (don't wait full 20s interval)
        clearTimeout(scanTimer);
        if (S.isRunning) scanTimer = setTimeout(scan, 2000);
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
        if (S.isRunning) scanTimer = setTimeout(scan, 2000);
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
      if (S.isRunning) scanTimer = setTimeout(scan, CFG.scanInterval);
      return;
    }

    await syncBalance();
    await syncRestingOrders(); // must run after syncBalance -- computes availableCash
    // Sync positions every 3 scans (60s) — fast enough to catch new positions quickly
    if (S.scanCount === 1 || S.scanCount % 3 === 0) await syncPositions();
    // Backfill Kalshi trade history on first scan and every 15 scans (~5 min)
    if (S.scanCount === 1 || S.scanCount % 15 === 0) await backfillKalshiHistory();

    // -- STOP-LOSS GUARD: halt bot completely if total balance is near zero --
    const FLOOR = 2.00;

    // -- PEAK DRAWDOWN GUARD — THE MOST IMPORTANT PROTECTION --
    // Update session peak on every scan
    const curBalForDD = (!CFG.dryRun && S.realBalance > 0) ? S.realBalance : S.balance;
    if (curBalForDD > (S.sessionPeakBalance || 0)) {
      S.sessionPeakBalance = curBalForDD;
    }
    // Drawdown: only log — FastPath runs through it, brain blocked in fire logic
    if ((S.drawdownHaltUntil || 0) > Date.now()) {
      const minsLeft = Math.ceil((S.drawdownHaltUntil - Date.now()) / 60000);
      log(`🛡️ DD guard (${minsLeft}min) — FastPath active, brain paused`);
    }
    // Trigger: 25% drop from peak → pause BRAIN only for 15min (FastPath keeps running)
    if ((S.sessionPeakBalance || 0) > 10 && curBalForDD < S.sessionPeakBalance * 0.75) {
      if (!S.drawdownHaltUntil || S.drawdownHaltUntil < Date.now()) {
        const ddPct = ((S.sessionPeakBalance - curBalForDD) / S.sessionPeakBalance * 100).toFixed(1);
        S.drawdownHaltUntil = Date.now() + 15 * 60000;
        log(`🛡️ DD GUARD: ${ddPct}% drop — brain paused 15min, FastPath continues`, 'WARN');
        tg(`🛡️ <b>Drawdown Guard — Brain Paused 15min</b>
Peak: $${S.sessionPeakBalance.toFixed(2)} → $${curBalForDD.toFixed(2)} (${ddPct}% drop)
FastPath crypto trades continue. Brain resumes ${new Date(S.drawdownHaltUntil).toLocaleTimeString('en-US',{timeZone:'America/New_York'})} ET`);
      }
      // Do NOT return — let FastPath run through drawdown
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

    // Telegram scan update every 3 scans (~60s) — was every 5 (~100s, too slow)
    if (S.scanCount % 3 === 0) {
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
    let cryptoFilled = 0, sportsFilled = 0;
    if (hasSlots && hasMarkets) {
      cryptoFilled = await runCryptoFastPath(markets);
      sportsFilled = await runSportsFastPath(markets);
      const totalFastFilled = cryptoFilled + sportsFilled;
      if (totalFastFilled > 0) log(`⚡ FastPath filled ${totalFastFilled} slot(s) (crypto:${cryptoFilled} sports:${sportsFilled})`);
    }

    // 🧠 BRAIN: ONLY fires when FastPath found nothing AND no drawdown cooldown
    const slotsAfterFastPath = dynamicMaxPos() - S.openPositions.length;
    const fastPathFoundTrade = (cryptoFilled + sportsFilled) > 0;
    const inDDCooldown = (S.drawdownHaltUntil || 0) > Date.now();
    // If 0 markets AND brain hasn't fired in 5+ min — reset timer to fire now
    // This prevents long idle gaps when market availability is temporarily low
    if (!hasMarkets && slotsAfterFastPath > 0 && !inDDCooldown) {
      if ((Date.now() - S.lastBrainAt) > 5 * 60000) {
        log('0 markets found — forcing brain reset to search harder next scan');
        S.lastBrainAt = 0; // fire brain next scan cycle
      }
    }

    // FIXED: Brain fires independently — even if FastPath found a trade.
    // FastPath handles crypto strikes. Brain handles direction markets + sports + fallback.
    // They are complementary, not mutually exclusive.
    if (false && brainReady && slotsAfterFastPath > 0 && hasMarkets && !fastPathFoundTrade) {
      if (fastPathFoundTrade) {
        log(`🧠 Brain firing: FastPath filled ${cryptoFilled+sportsFilled} slot(s), ${slotsAfterFastPath} still open`);
      } else {
        log(`🧠 Brain firing: FastPath=0 trades, ${slotsAfterFastPath} slots open`);
      }
      await runBrain(markets);
    } else if (brainReady && fastPathFoundTrade && slotsAfterFastPath <= 0) {
      log(`Brain skip — FastPath filled ALL slots`);
      S.lastBrainAt = Date.now();
    } else if (brainReady && inDDCooldown) {
      log(`Brain skip — drawdown cooldown active, FastPath only`);
      S.lastBrainAt = Date.now();
    } else if (brainReady && slotsAfterFastPath <= 0) {
      log(`Fast paths filled all slots — brain skipped this cycle`);
      S.lastBrainAt = Date.now();
    } else if (brainReady && !hasSlots) {
      log(`Brain: at cap ${openCount}/${maxPos} — position monitor`);
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
  if (S.isRunning) scanTimer = setTimeout(scan, CFG.scanInterval);
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
  log('[M] KalshiBot v18 started -- running pre-flight sync...');

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
  tg(`🚀 <b>KalshiBot v18 Online</b>
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
  log(`KalshiBot v18 listening on port ${CFG.port}`);
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
