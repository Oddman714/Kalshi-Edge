'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────────────
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
  maxPos:     6,           // base — scales dynamically with balance (see dynamicMaxPos)
  kellyFrac:  0.55,        // AGGRESSIVE kelly — max compounding speed
  minEdge:    0.04,        // 4% minimum edge — catch more mispricings
  minProb:    0.55,        // minimum 55% confidence — more trade opportunities
  scanInterval:  20000,   // math scanner: every 20s — reduces Kalshi API load
  brainInterval: 120000,  // claude brain: every 2min — saves ~$130/72h vs 90s
  heartbeatInterval: 1800000, // telegram heartbeat: every 30min
  // Aggressive growth targets
  targetMultiple: 2.0,    // goal: 2x portfolio ASAP
  preferShortDuration: true, // favor markets closing within 24h for faster compounding
};

// ─── GROWTH PHASE ENGINE ───────────────────────────────────────────────────
// The entire bot strategy shifts as balance climbs toward $500K.
// Each phase has its own Kelly fraction, max positions, edge threshold,
// and brain instructions — calibrated for that balance tier.
const PHASES = [
  { name: 'SEED',       min: 0,      max: 50,     kelly: 0.55, minEdge: 0.04, minProb: 0.55, maxPos: 5,  label: '🌱 Seed',       desc: 'Max aggression — swing for first doubles' },
  { name: 'SPROUT',     min: 50,     max: 200,    kelly: 0.50, minEdge: 0.04, minProb: 0.56, maxPos: 6,  label: '🌿 Sprout',     desc: 'Compounding — stay aggressive, protect streaks' },
  { name: 'GROWTH',     min: 200,    max: 1000,   kelly: 0.45, minEdge: 0.05, minProb: 0.57, maxPos: 7,  label: '📈 Growth',     desc: 'Scaling — diversify more, edge bar rises' },
  { name: 'MOMENTUM',   min: 1000,   max: 5000,   kelly: 0.40, minEdge: 0.05, minProb: 0.58, maxPos: 8,  label: '🚀 Momentum',   desc: 'Momentum — protect gains while pressing edges' },
  { name: 'SCALE',      min: 5000,   max: 25000,  kelly: 0.35, minEdge: 0.06, minProb: 0.60, maxPos: 9,  label: '⚡ Scale',      desc: 'Scaling — larger positions, cleaner signals only' },
  { name: 'HARVEST',    min: 25000,  max: 100000, kelly: 0.28, minEdge: 0.06, minProb: 0.62, maxPos: 10, label: '💰 Harvest',    desc: 'Harvest — capital preservation + steady compounding' },
  { name: 'ENDGAME',    min: 100000, max: 500000, kelly: 0.22, minEdge: 0.07, minProb: 0.63, maxPos: 12, label: '🏆 Endgame',    desc: 'Endgame — controlled march to $500K' },
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

// Check if a new doubling milestone was just crossed — call after every balance update
function checkMilestone(prevBal, newBal) {
  const prevD = Math.floor(Math.log2(Math.max(prevBal, CFG.bankroll) / CFG.bankroll));
  const newD  = Math.floor(Math.log2(Math.max(newBal,  CFG.bankroll) / CFG.bankroll));
  if (newD > prevD && newBal > CFG.bankroll) {
    const phase = getPhase();
    tg(`🎯 <b>DOUBLING #${newD} COMPLETE!</b>\n💰 Balance: $${newBal.toFixed(2)}\n📍 Phase: ${phase.label}\n🏁 ${doublingsNeeded()} more doublings to $500K\n📊 Next target: $${nextTarget().toFixed(2)}\n\n${phase.desc}`);
    log(`🎯 MILESTONE: Doubling #${newD} — $${newBal.toFixed(2)} | ${doublingsNeeded()} to $500K`);
  }
}

// Scales max positions with balance — driven by phase engine above.
function dynamicMaxPos() {
  return getPhase().maxPos;
}

// ─── STATE ─────────────────────────────────────────────────────────────────
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
  restingOrders: [],       // unfilled limit orders currently holding cash on Kalshi
  availableCash: 0,        // real spendable cash = balance - reserved by resting orders
  estimatedApiSpend: 0,    // running tally of Claude API spend since deploy
};

function saveState() {
  try {
    const slim = { ...S };
    if (slim.logs.length > 200) slim.logs = slim.logs.slice(-200);
    if (slim.trades.length > 500) slim.trades = slim.trades.slice(-500);
    if (slim.signals.length > 50) slim.signals = slim.signals.slice(-50);
    if (slim.brainMemory.length > 30) slim.brainMemory = slim.brainMemory.slice(-30);
    if (slim.newsCache.length > 20) slim.newsCache = slim.newsCache.slice(-20);
    fs.writeFileSync(STATE_FILE, JSON.stringify(slim));
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
  // Always zero balances on boot — Kalshi API is source of truth, never state.json
  S.balance = 0;
  S.realBalance = 0;
  S.peakBalance = 0;
  // On boot: purge ALL fromKalshi trades so they get re-imported fresh
  if (S.trades && S.trades.length > 0) {
    S.trades = S.trades.filter(t => !t.fromKalshi); // keep only bot-placed trades
    // Rebuild W/L from remaining bot trades
    const resolved = S.trades.filter(t => t.status === 'resolved');
    S.wins = resolved.filter(t => t.won === true).length;
    S.losses = resolved.filter(t => t.won === false).length;
    S.totalPnl = resolved.reduce((sum, t) => sum + (t.pnl || 0), 0);
  }
  // Reset peak if it looks like the env var default (never let $50 bankroll pollute peak)
  if (S.peakBalance >= 50 && S.balance < 30) {
    S.peakBalance = S.balance; // will be updated to real balance on first syncBalance
    log('Peak reset — was stale BANKROLL default');
  }
  if (new Date().toDateString() !== S.todayDate) {
    S.todayPnl = 0;
    S.todayDate = new Date().toDateString();
  }
}

// ─── LOGGING ───────────────────────────────────────────────────────────────
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString().slice(11,19);
  const entry = `[${ts}] ${level}: ${msg}`;
  console.log(entry);
  S.logs.unshift({ ts, level, msg });
  if (S.logs.length > 300) S.logs.pop();
}

// ─── HTTP HELPERS ──────────────────────────────────────────────────────────
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

// ─── KALSHI AUTH ───────────────────────────────────────────────────────────
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
  if (r.status >= 400) throw new Error(`Kalshi ${method} ${endpoint} → ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`);
  return r.body;
}

// ─── TELEGRAM ──────────────────────────────────────────────────────────────
function tg(msg) {
  if (!CFG.tgToken || !CFG.tgChat) return;
  const body = JSON.stringify({ chat_id: CFG.tgChat, text: msg, parse_mode: 'HTML' });
  req(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  }, 5000).catch(() => {});
}

// ─── KALSHI TRADE HISTORY BACKFILL ──────────────────────────────────────────
// Pulls ONLY settled positions from Kalshi — the authoritative source of resolved trades.
// Fills are intentionally skipped: they include open positions, penny contracts,
// multi-leg fills, and other noise that distorts W/L stats.
async function backfillKalshiHistory() {
  try {
    // Use settlements only — these are definitively closed with real revenue
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

      // Skip entries with no revenue and no pnl — phantom/noise
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
      // Rebuild W/L/PnL from settled trades only — open positions don't count yet
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

// ─── BALANCE SYNC ──────────────────────────────────────────────────────────
async function syncBalance() {
  try {
    const r = await kalshi('GET', '/portfolio/balance');
    const rawBal = r.balance || r.balance_dollars || 0;
    const bal = rawBal > 500 ? rawBal / 100 : rawBal;
    if (bal <= 0) { log('Balance sync returned $0 — skipping', 'WARN'); return; }
    const prevBal = S.realBalance || S.balance;
    S.realBalance = bal;
    S.balance = bal;
    if (bal > S.peakBalance) S.peakBalance = bal;
    if (S.peakBalance === 0) S.peakBalance = bal;
    // Check milestone crossings
    checkMilestone(prevBal, bal);
    // Log phase + progress every sync so Railway logs show trajectory
    const phase = getPhase();
    const prog = doublingProgress().toFixed(1);
    const nxt = nextTarget().toFixed(2);
    log(`Balance: $${bal.toFixed(2)} | Peak: $${S.peakBalance.toFixed(2)} | Phase: ${phase.name} | ${prog}% to $${nxt}`);
  } catch(e) {
    log('Balance sync failed: ' + e.message, 'WARN');
  }
}

// ─── SYNC RESTING (UNFILLED) ORDERS ────────────────────────────────────────
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
    S.restingOrders = orders.map(o => {
      const remaining = parseFloat(o.remaining_count != null ? o.remaining_count : (o.count || 0));
      const rawPrice = parseFloat(o.yes_price || o.no_price || 0);
      // Normalize: cents int (13) or dollar decimal (0.13) -> always dollars
      const pricePerContract = rawPrice > 1 ? rawPrice / 100 : rawPrice;
      const reservedCash = remaining * pricePerContract;
      return { orderId: o.order_id, ticker: o.ticker, side: o.side, contracts: remaining, pricePerContract, reservedCash };
    });
    const totalReserved = S.restingOrders.reduce((sum, o) => sum + o.reservedCash, 0);
    const rawBal = S.realBalance > 0 ? S.realBalance : S.balance;
    S.availableCash = Math.max(0, rawBal - totalReserved);
    log(`Cash: total=$${rawBal.toFixed(2)} reserved=$${totalReserved.toFixed(2)} avail=$${S.availableCash.toFixed(2)} (${S.restingOrders.length} resting)`);
  } catch(e) {
    // SAFE: block all trades if we cannot determine reserved cash
    S.availableCash = 0;
    log('Resting sync FAILED — blocking trades to prevent overspend: ' + e.message, 'WARN');
  }
}


function parsePrice(raw) {
  if (raw === null || raw === undefined) return 0;
  const n = parseFloat(raw);
  if (isNaN(n)) return 0;
  // New format: dollar strings like "0.6500" (value between 0-1)
  // Old format: integer cents like 65 (value between 0-100)
  return n > 1 ? n / 100 : n;
}

// ─── SYNC LIVE POSITIONS FROM KALSHI ─────────────────────────────────────────
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
        const exposure = parsePrice(p.market_exposure_dollars || p.market_value_dollars || '0');
        const costPer = (exposure > 0 && contracts > 0) ? exposure / contracts : 0.5;
        return {
          ticker: p.ticker, side, contracts,
          entryPrice: Math.round(costPer * 100),
          cost: exposure > 0 ? exposure : contracts * 0.5,
          currentPrice: Math.round(costPer * 100),
          openedAt: Date.now(), status: 'open',
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

    const liveSet = new Set(livePositions.map(p=>p.ticker));
    const botPos = S.openPositions.filter(p=>!p.fromKalshi);
    const validBot = botPos.filter(p=>{ const ok=liveSet.has(p.ticker); if(!ok) log('Ghost purged: '+p.ticker); return ok; });
    const freshKalshi = livePositions.filter(p=>!new Set(validBot.map(x=>x.ticker)).has(p.ticker));
    S.openPositions=[...validBot,...freshKalshi];
    if(botPos.length>validBot.length){log('Purged '+(botPos.length-validBot.length)+' ghosts');saveState();}

    log(`Synced ${livePositions.length} positions from Kalshi (${freshKalshi.length} new)`);
    tg(`📋 <b>Positions synced from Kalshi</b>\n${livePositions.map(p => `${p.ticker} ${p.side} x${p.contracts}`).join('\n')}`);
    saveState();
  } catch(e) {
    log('Position sync failed: ' + e.message, 'WARN');
  }
}

// ─── MARKET SCANNER (pure math, no Claude calls) ───────────────────────────
async function getTopMarkets() {
  try {
    // Use /markets with series_ticker filter — the correct way per Kalshi docs
    // Fetch in parallel across high-volume series
    // Time-aware series list — add weekly/monthly when daily markets are closed
    const hour = new Date().getUTCHours(); // 0-23 UTC
    const isMarketHours = hour >= 13 && hour <= 23; // 9am-7pm ET roughly
    const seriesList = [
      'KXBTCD','KXBTCW','KXETHUSD','KXETH','KXSOL','KXXRP','KXDOGE',
      'KXNBAGAME','KXNBAPLAYOFFS','KXMLBGAME','KXNHLGAME','KXNFLGAME',
      'KXMMA','KXGOLF','KXTENNIS',
      'FED','FEDRATE','INFL','KXCPI','KXPCE','KXUNEMPLOYMENT',
      'KXOIL','KXGOLD',
      'KXPREZ','KXSENATE','KXHOUSE','KXTARIFF','KXTRADE','KXAPPROVAL',
      ...(isMarketHours?['INXD','NASDAQ100D','KXSPX500','KXEARNINGS','HIGHNY','HIGHMIA']:[]),
      ...(!isMarketHours?['INXW','NASDAQ100W','KXSPX500']:[])
    ];

    const fetches = await Promise.allSettled(
      seriesList.map(s =>
        kalshi('GET', '/markets', null, { series_ticker: s, status: 'open', limit: '50' })
      )
    );

    let allMarkets = [];
    let successCount = 0;
    for (const f of fetches) {
      if (f.status === 'fulfilled') {
        const mkts = f.value.markets || [];
        allMarkets.push(...mkts);
        if (mkts.length > 0) successCount++;
      }
    }
    log(`Series fetch: ${successCount}/${seriesList.length} series returned markets`);

    // Fallback: if all series returned empty, try generic endpoint without MVE filter
    if (allMarkets.length === 0) {
      log('Series fetch empty — falling back to generic /markets endpoint', 'WARN');
      try {
        const fallback = await kalshi('GET', '/markets', null, { status: 'open', limit: '200' });
        allMarkets = (fallback.markets || []).filter(m => !m.mve_collection_ticker);
        log(`Fallback fetch: ${allMarkets.length} non-MVE markets`);
      } catch(e) {
        log('Fallback also failed: ' + e.message, 'WARN');
      }
    }

    // Deduplicate
    const seen = new Set();
    allMarkets = allMarkets.filter(m => {
      if (!m?.ticker || seen.has(m.ticker)) return false;
      seen.add(m.ticker); return true;
    });

    log(`Raw fetch: ${allMarkets.length} markets across ${seriesList.length} series`);

    const markets = allMarkets.filter(m => {
      if (m.mve_collection_ticker) return false;
      const yesAsk = parsePrice(m.yes_ask_dollars || m.yes_ask);
      const yesBid = parsePrice(m.yes_bid_dollars  || m.yes_bid);
      // EDGE FILTER: exclude near-certain outcomes — zero edge, zero return
      if (yesAsk <= 0.12 || yesAsk >= 0.88) return false; // 12¢-88¢ — wider range = more opportunities
      // Exclude illiquid markets with no real bid
      if (yesBid <= 0.01) return false;
      // Exclude markets where spread > 30c — too costly to enter/exit
      if ((yesAsk - yesBid) > 0.30) return false;
      // Minimum volume for liquidity
      const vol = parseFloat(m.volume_fp || m.volume || 0);
      if (vol < 30) return false;
      return true;
    });

    log(`After filter: ${markets.length} tradeable markets (12c-88c, vol>=30, spread<=30c)`);

    const scored = markets.map(m => {
      const yesAsk  = parsePrice(m.yes_ask_dollars  || m.yes_ask);
      const yesBid  = parsePrice(m.yes_bid_dollars  || m.yes_bid);
      const spread  = Math.max(0, yesAsk - yesBid);
      const vol     = parseFloat(m.volume_fp || m.volume || 0);

      // Hours until close — reward short-duration markets for faster compounding
      const hoursLeft = m.close_time
        ? Math.max(0, (new Date(m.close_time) - Date.now()) / 3600000)
        : 999;
      // AGGRESSIVE duration scoring — only care about markets resolving in ≤48h
      // Markets >48h out are slow capital — penalize heavily
      const durationScore = hoursLeft < 0.5 ? 0.1          // too close — risky fill
        : hoursLeft < 2   ? 0.85                            // same-hour — very fast
        : hoursLeft < 6   ? 1.0                             // ideal: resolves today
        : hoursLeft < 12  ? 0.95                            // great: tonight
        : hoursLeft < 24  ? 0.85                            // resolves tomorrow
        : hoursLeft < 48  ? 0.60                            // 2 days — acceptable
        : hoursLeft < 96  ? 0.30                            // 4 days — slow
        : 0.10;                                             // >4 days — skip

      const spreadScore = Math.max(0, 1 - spread / 0.10);
      const volScore    = Math.min(1, Math.log10(vol + 1) / 5);
      // Reward mispriced markets (further from 50¢ = clearer edge potential)
      // Edge × volume: high edge on dead markets can't fill — require both
      const volWeight   = Math.min(1, Math.log10(Math.max(1, vol)) / 4); // 0-1 scale
      const edgeScore   = Math.abs(yesAsk - 0.5) * 1.5 * (0.5 + 0.5 * volWeight);
      // Upside multiplier: cheaper YES = bigger payout if wins
      // Asymmetric payout preference: cheaper YES = bigger upside multiplier
      // YES at 20¢ wins $0.80/contract; YES at 60¢ wins $0.40/contract — 2x better
      const upsideScore = yesAsk < 0.20 ? 1.5 : yesAsk < 0.35 ? 1.35 : yesAsk < 0.50 ? 1.1 : yesAsk < 0.65 ? 0.9 : 0.7;

      const totalScore = (
        spreadScore   * 0.25 +
        volScore      * 0.25 +
        durationScore * 0.30 +   // heavily weight short-duration
        edgeScore     * 0.20
      ) * upsideScore;

      return {
        ticker: m.ticker,
        title: m.title,
        yesAsk, yesBid, spread, volume: vol,
        score: totalScore,
        hoursLeft: parseFloat(hoursLeft.toFixed(1)),
        closeTime: m.close_time,
        category: m.category || m.series_ticker || 'unknown',
      };
    });

    scored.sort((a, b) => b.score - a.score);
    S.topMarkets = scored.slice(0, 20);
    if (S.topMarkets[0]) {
      log(`Top market: ${S.topMarkets[0].ticker} YES=${(S.topMarkets[0].yesAsk*100).toFixed(1)}¢ vol=${S.topMarkets[0].volume}`);
    }
    return S.topMarkets;
  } catch(e) {
    log('Market scan failed: ' + e.message, 'WARN');
    return [];
  }
}


// ─── KALSHI LEADERBOARD — removed by Kalshi, silent no-op ─────────────────
async function getTopTraders() { return []; }

// ─── CLAUDE BRAIN (fires only when math scanner finds high-value targets) ──
async function runBrain(topMarkets) {
  if (!CFG.claudeKey) { log('No Claude key', 'WARN'); return; }
  if (topMarkets.length === 0) { log('Brain skipped: no markets to analyze'); return; }

  // Only skip if ALL slots are full — scan() will call runPositionMonitor separately
  if (S.openPositions.length >= dynamicMaxPos()) {
    log(`Brain: all ${S.openPositions.length}/${dynamicMaxPos()} slots full — skipping signal generation`);
    return;
  }

  S.brainCount++;
  log(`Brain #${S.brainCount} firing on ${Math.min(topMarkets.length, 6)} markets`);

  // Track estimated API spend (Haiku: $0.80/MTok in, $4/MTok out, $0.01/search)
  // Rough per-call estimate: ~$0.055 (conservative with 6 search cap)
  S.estimatedApiSpend = (S.estimatedApiSpend || 0) + 0.055;

  const memSummary = S.brainMemory.slice(-5).map(m =>
    `${m.ticker}: ${m.action} @ ${m.prob}% confidence → ${m.outcome || 'pending'}`
  ).join('\n') || 'No prior trades';

  const marketList = topMarkets.slice(0, 6).map(m =>
    `- ${m.ticker} | "${m.title}" | YES=${(m.yesAsk*100).toFixed(0)}¢ | Vol=${m.volume} | Score=${m.score.toFixed(3)} | Closes: ${m.closeTime ? new Date(m.closeTime).toLocaleDateString() : 'unknown'}`
  ).join('\n');

  const phase = getPhase();
  const _bal = S.realBalance || S.balance;
  const _doublings = doublingsMade();
  const _needed = doublingsNeeded();
  const _next = nextTarget();
  const _progress = doublingProgress().toFixed(0);

  const prompt = `{"task":"generate_trade_signals","rules":["respond with ONLY the JSON object below","no explanation","no preamble","start with {","end with }"],"context":{"MISSION":"Reach $500,000 by doubling. Current: $${_bal.toFixed(2)} | Available cash: $${S.availableCash.toFixed(2)} | Resting orders: ${S.restingOrders.length} | Next target: $${_next.toFixed(2)} | Progress: ${_progress}% | Doublings done: ${_doublings} | Doublings left: ${_needed} | Phase: ${phase.name} — ${phase.desc}. RULES: 1) Conf MUST beat mkt by ${(phase.minEdge*100).toFixed(0)}%+. 2) Only 12c-88c. 3) Min ${(phase.minProb*100).toFixed(0)}% conf. 4) YES 12-55c preferred. 5) Resolves within 48h ideal. 6) Web search AGGRESSIVELY. 7) ONLY suggest trades if available cash > $2. 8) Include marketPrice every signal","mode":"${CFG.dryRun?'paper':'live'}","balance":${_bal.toFixed(2)},"availableCash":${S.availableCash.toFixed(2)},"restingOrders":${S.restingOrders.length},"nextTarget":${_next.toFixed(2)},"doublingProgress":"${_progress}%","phase":"${phase.name}","peak":${S.peakBalance.toFixed(2)},"todayPnl":${S.todayPnl.toFixed(2)},"totalPnl":${S.totalPnl.toFixed(2)},"wins":${S.wins},"losses":${S.losses},"winRate":"${S.wins+S.losses>0?((S.wins/(S.wins+S.losses))*100).toFixed(0)+'%':'new'}","openSlots":${dynamicMaxPos() - S.openPositions.length},"maxPos":${dynamicMaxPos()},"openPositions":${JSON.stringify(S.openPositions.map(p=>({ticker:p.ticker,side:p.side,entryPrice:p.entryPrice,hoursOpen:Math.round((Date.now()-p.openedAt)/3600000)})))},"recentMemory":${JSON.stringify(S.brainMemory.slice(-5))}},"markets":${JSON.stringify(topMarkets.slice(0,6).map(m=>({ticker:m.ticker,title:m.title,yesAsk:Math.round(m.yesAsk*100),yesBid:Math.round((m.yesBid||0)*100),volume:Math.round(m.volume),score:parseFloat(m.score.toFixed(3)),hoursLeft:m.hoursLeft,closesIn:m.closeTime?Math.round((new Date(m.closeTime)-Date.now())/3600000)+'h':'unknown'})))},"searchStrategy":{"instruction":"You have 6 searches total. Use them on the TOP 3 markets by score ONLY. Search 1-2 times per market max. Focus: current price vs market expectation, live game score, breaking news. DO NOT search markets you cannot find a clear edge on.","examples":["BTC current price vs ${m.ticker} strike","NBA game score live today","ETH price action last 2h"]},"strategy":{"priority1":"SHORT-DURATION: Markets closing in 1-48h — fast resolution = fast compounding","priority2":"DECISIVE: A ${(phase.minEdge*100).toFixed(0)}% edge IS worth trading. Do not demand 10%+. ACT on any clear edge.","priority3":"ASYMMETRIC: YES at 12-45c = 2-7x payout — these are the best ROI trades","priority4":"OUTPUT AT LEAST 1 SIGNAL if any market has ANY edge after searching. Only skipReason if every market is perfectly priced with zero information available.","sizing":"Kelly ${(phase.kelly*100).toFixed(0)}% at ${phase.name}. Concentrate to compound toward $${_next.toFixed(0)}."},"required_json_format":{"signals":[{"ticker":"string","side":"YES or NO","confidence":0.60,"edge":0.08,"marketPrice":0.52,"reasoning":"specific data found — price/score/news that market has NOT priced in","hoursToClose":24}],"marketSummary":"best opportunity and why it moves toward $${_next.toFixed(0)}","skipReason":"ONLY if truly zero edge after all searches"}}`;

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
        max_tokens: 2000,
        system: 'You are a JSON-only trading signal generator with ONE goal: double a small portfolio as fast as safely possible toward $500K. You have 6 web searches — use them ONLY on the top 3 markets with highest edge potential. Search for current price/score data that directly confirms or denies an edge. Be decisive: if a market has any edge above the threshold, signal it. Output ONLY valid JSON starting with { and ending with }. No markdown, no explanation.',
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
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
      // Web search responses have multiple content blocks — find the last text block
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
    S.signals = (parsed.signals || []).map(s => {
      const mktP = s.marketPrice || (s.side === 'YES' ? s.confidence : 1 - s.confidence);
      const tradePrice = s.side === 'YES' ? mktP : (1 - mktP);
      const kSize = kellySize(s.confidence, Math.min(0.88, Math.max(0.12, tradePrice)));
      return {
        ...s,
        ts: Date.now(),
        status: 'fresh',
        kellySize: parseFloat(kSize.toFixed(2)),
      };
    });

    log(`Brain #${S.brainCount}: ${S.signals.length} signals | ${parsed.marketSummary || ''}`);

    if (S.signals.length > 0) {
      const sigText = S.signals.map(s =>
        `📊 ${s.ticker} ${s.side} | ${(s.confidence*100).toFixed(0)}% confidence | edge ${(s.edge*100).toFixed(1)}% | $${s.kellySize?.toFixed(2)} | ${s.reasoning}`
      ).join('\n');

      tg(`🧠 <b>Brain #${S.brainCount}</b>\n${sigText}\n\n<i>${parsed.marketSummary || ''}</i>`);

      // Execute trades for valid signals
      for (const sig of S.signals) {
        if (sig.confidence >= CFG.minProb && sig.edge >= CFG.minEdge) {
          await executeTrade(sig);
        }
      }
    } else {
      log(`Brain #${S.brainCount} skip: ${parsed.skipReason || 'no edge found'}`);
    }

    saveState();
  } catch(e) {
    log('Brain error: ' + e.message, 'ERROR');
    S.lastErr = e.message;
  }
}

// ─── POSITION MONITOR BRAIN (fires when slots full — looks for early exits) ─
async function runPositionMonitor() {
  if (!CFG.claudeKey || S.openPositions.length === 0) return;
  if (CFG.dryRun) return; // paper mode: positions resolve automatically

  // COST GUARD: only monitor positions that have been open 3+ hours
  // New positions don't need monitoring — they just opened
  const stalePositions = S.openPositions.filter(p =>
    p.openedAt && (Date.now() - p.openedAt) > 3 * 3600000
  );
  if (stalePositions.length === 0) {
    log(`Monitor skipped: all ${S.openPositions.length} positions <3h old`);
    return;
  }
  log(`Monitor checking ${stalePositions.length} positions open 3h+`);

  const positionList = stalePositions.map(p => ({
    ticker: p.ticker,
    side: p.side,
    entryPrice: p.entryPrice,
    contracts: p.contracts,
    cost: p.cost,
    hoursOpen: Math.round((Date.now() - p.openedAt) / 3600000),
    reasoning: p.reasoning,
  }));

  const prompt = `{"task":"position_exit_monitor","context":{"MISSION":"Protect and grow capital — identify any open position that should be exited NOW to prevent loss or lock in profit","balance":${(S.realBalance||S.balance).toFixed(2)},"openPositions":${JSON.stringify(positionList)}},"instructions":"1) Use web search to check current status of each open position's underlying event. 2) Has the event already resolved? Is it trending against our position? Is there breaking news changing the outcome? 3) Only flag positions that clearly should exit NOW — not normal uncertainty. 4) Output required_json_format only.","required_json_format":{"exitNow":[{"ticker":"string","reason":"one sentence why exit now"}],"holdAll":true,"summary":"one sentence"}}`;

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
        max_tokens: 800,
        system: 'You are a position risk monitor. Use web search to check real-time status of open prediction market positions. Output ONLY valid JSON.',
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
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
        log(`🚨 Monitor: EXIT recommended for ${exit.ticker} — ${exit.reason}`);
        tg(`🚨 <b>Position Monitor Alert</b>\nExit: ${exit.ticker}\n${exit.reason}`);
        // Mark position for priority resolution check
        const pos = S.openPositions.find(p => p.ticker === exit.ticker);
        if (pos) pos.monitorFlagged = true;
      }
      await resolvePositions(); // trigger immediate resolution check
    } else {
      log(`📡 Monitor: all ${S.openPositions.length} positions holding — ${parsed.summary || ''}`);
    }
  } catch(e) {
    log('Position monitor error: ' + e.message, 'WARN');
  }
}

// ─── KELLY SIZING ──────────────────────────────────────────────────────────
function kellySize(prob, price) {
  const phase = getPhase();
  const q = 1 - prob;
  const b = (1 - price) / price; // net odds
  const kelly = (b * prob - q) / b;
  const fracKelly = Math.max(0, kelly * phase.kelly);
  // Use availableCash — excludes cash reserved by resting unfilled orders
  const bal = S.availableCash > 1 ? S.availableCash : (S.realBalance > 0 ? S.realBalance : S.balance);
  if (bal < 2.00) return 0; // insufficient cash — executeTrade will skip
  const playable = Math.max(0, bal - 1.50);
  const maxPct = bal < 10 ? 0.80 : bal < 25 ? 0.65 : bal < 50 ? 0.50 : bal < 200 ? 0.38 : bal < 1000 ? 0.28 : 0.20;
  const maxBet = Math.min(bal * maxPct, playable * 0.85);
  return Math.min(maxBet, Math.max(1.50, bal * fracKelly));
}

// ─── TRADE EXECUTION ───────────────────────────────────────────────────────
async function executeTrade(sig) {
  const maxPos = dynamicMaxPos();
  if (S.openPositions.length >= maxPos) {
    log(`Skip ${sig.ticker}: max positions reached (${S.openPositions.length}/${maxPos})`);
    return;
  }
  if (S.openPositions.find(p => p.ticker === sig.ticker)) {
    log(`Skip ${sig.ticker}: already have position`);
    return;
  }

  // ── CASH GUARD — re-sync immediately before every order attempt ──
  await syncBalance();
  await syncRestingOrders();
  if (S.availableCash < 2.00) {
    const reserved = S.restingOrders.reduce((s,o) => s + o.reservedCash, 0);
    log(`Skip ${sig.ticker}: $${S.availableCash.toFixed(2)} available ($${reserved.toFixed(2)} locked in ${S.restingOrders.length} resting orders)`);
    return;
  }

  // PHASE-DRIVEN GUARDS — thresholds adapt as balance grows toward $500K
  const phase = getPhase();
  const bal = S.realBalance>0?S.realBalance:S.balance;
  const mktP = sig.marketPrice||(sig.side==='YES'?sig.confidence:1-sig.confidence);
  const tradePrice = sig.side==='YES'?mktP:(1-mktP);
  if(tradePrice<=0.12||tradePrice>=0.88){log('Skip '+sig.ticker+': '+(tradePrice*100).toFixed(0)+'c outside 12c-88c');return;}
  const edgeVsMarket = sig.confidence-tradePrice;
  if(edgeVsMarket<phase.minEdge){log('Skip '+sig.ticker+': edge '+(edgeVsMarket*100).toFixed(1)+'% < '+phase.name+' min '+(phase.minEdge*100)+'%');return;}
  const serverKelly=kellySize(sig.confidence,tradePrice);
  if(serverKelly<1.50){log('Skip '+sig.ticker+': Kelly $'+serverKelly.toFixed(2)+' < $1.50');return;}
  if(sig.confidence<phase.minProb){log('Skip '+sig.ticker+': conf '+(sig.confidence*100).toFixed(0)+'% < '+phase.name+' min '+(phase.minProb*100)+'%');return;}
  if(tradePrice>0.75&&sig.confidence<0.85){log('Skip '+sig.ticker+': market strong — need 85%+');return;}

  // Block opposite-side bet on the same GAME event (e.g. YES Atlanta + YES New York same game)
  // Only applies to sports games (GAME tickers) where outcomes are mutually exclusive
  // BTC/crypto/index markets at different strikes are independent — allow multiples
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
      log(`Skip ${sig.ticker}: already have ${conflictingEvent.ticker} — same game, both sides blocked`);
      return;
    }
  }

  const orderP=sig.marketPrice||(sig.side==='YES'?sig.confidence:1-sig.confidence);
  const priceCents=Math.round(Math.min(0.87,Math.max(0.13,orderP))*100);
  const priceFloat=priceCents/100;

  const size=kellySize(sig.confidence,priceFloat);
  const contracts=Math.max(1,Math.floor(size/priceFloat));
  const actualCost=(priceCents*contracts)/100;
  const price=priceCents;
  if(actualCost<1.50){log("Skip "+sig.ticker+": cost $"+actualCost.toFixed(2)+" < $1.50 min");return;}
  log("TRADE "+sig.ticker+" "+sig.side+" edge="+(edgeVsMarket*100).toFixed(1)+"% $"+actualCost.toFixed(2));

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
    };
    S.openPositions.push(position);
    S.balance -= position.cost;

    S.brainMemory.push({
      ticker: sig.ticker,
      action: `${sig.side} x${contracts} @ ${price}¢`,
      prob: (sig.confidence * 100).toFixed(0),
      cost: position.cost.toFixed(2),
      ts: Date.now(),
    });

    log(`📝 PAPER TRADE: ${sig.ticker} ${sig.side} x${contracts} @ ${price}¢ = $${position.cost.toFixed(2)}`);
    tg(`📝 <b>Paper Trade</b>\n${sig.ticker} ${sig.side}\n${contracts} contracts @ ${price}¢\nCost: $${position.cost.toFixed(2)}\n💭 ${sig.reasoning}`);
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
        expiration_ts: Math.floor(Date.now() / 1000) + 3600,
      });

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
        status: 'open',
        currentPrice: price,
      };
      S.openPositions.push(position);
      log(`✅ LIVE ORDER: ${sig.ticker} ${sig.side} x${contracts} @ ${price}¢`);
      tg(`✅ <b>Live Order Placed</b>\n${sig.ticker} ${sig.side}\n${contracts} contracts @ ${price}¢\nOrder ID: ${order.order?.order_id}`);
      saveState();
    } catch(e) {
      log(`Order failed ${sig.ticker}: ${e.message}`, 'ERROR');
      tg(`❌ <b>Order Failed</b>\n${sig.ticker}: ${e.message}`);
    }
  }
}

// ─── POSITION RESOLUTION ───────────────────────────────────────────────────
async function resolvePositions() {
  if (S.openPositions.length === 0) return;

  // Fetch recent settlements from Kalshi directly — most reliable source
  let settlements = [];
  try {
    const sr = await kalshi('GET', '/portfolio/settlements', null, { limit: '50' });
    settlements = sr.settlements || sr.market_settlements || [];
    if (settlements.length > 0) log(`Settlements: ${settlements.length} found`);
  } catch(e) {
    // Silently continue — will fall back to market status check
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
        tg(`${won ? '🟢 <b>WIN</b>' : '🔴 <b>LOSS</b>'}
${pos.ticker} ${pos.side}
Revenue: $${revenue.toFixed(2)} | Cost: $${cost.toFixed(2)}
PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Balance: $${S.balance.toFixed(2)}
Total: ${S.wins}W/${S.losses}L | All-time: ${S.totalPnl >= 0 ? '+' : ''}$${S.totalPnl.toFixed(2)}`);
        saveState();
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
      }
    } catch(e) {
      log(`Resolve check ${pos.ticker}: ${e.message}`, 'WARN');
    }
  }
}
// ─── SCAN LOOP ─────────────────────────────────────────────────────────────
let scanTimer, brainTimer, heartbeatTimer;

async function scan() {
  if (!S.isRunning) return;
  S.scanCount++;
  S.lastScanAt = Date.now();

  try {
    await syncBalance();
    await syncRestingOrders(); // must run after syncBalance — computes availableCash
    // Sync positions every 5 scans
    if (S.scanCount === 1 || S.scanCount % 5 === 0) await syncPositions();
    // Backfill Kalshi trade history on first scan and every 10 scans
    if (S.scanCount === 1 || S.scanCount % 10 === 0) await backfillKalshiHistory();

    // ── STOP-LOSS GUARD: halt trading if balance drops below $3 floor ──
    const FLOOR = 3.00;
    const effectiveBal = (!CFG.dryRun && S.realBalance > 0) ? S.realBalance : S.balance;
    if (effectiveBal <= FLOOR && !CFG.dryRun) {
      if (S.isRunning) {
        log('🛑 FLOOR HIT: balance $' + S.balance.toFixed(2) + ' ≤ $' + FLOOR + ' — halting live trading', 'ERROR');
        tg(`🛑 <b>Floor Hit — Trading Halted</b>
Balance: $${S.balance.toFixed(2)} hit the $${FLOOR} safety floor.
All trading stopped to protect remaining capital.
Deposit funds and restart manually when ready.`);
        stopBot();
      }
      return;
    }

    const [markets, topTraders] = await Promise.all([
      getTopMarkets(),
      getTopTraders(),
    ]);
    S.topTraders = topTraders;
    await resolvePositions();

    // Fire brain when: enough time has passed AND we have open slots AND markets exist
    const brainReady = S.scanCount >= 1 && (Date.now() - S.lastBrainAt) >= CFG.brainInterval;
    const maxPos = dynamicMaxPos();
    const hasSlots = S.openPositions.length < maxPos;
    const hasMarkets = markets.length > 0;

    if (brainReady && hasSlots && hasMarkets) {
      log(`Brain ready: ${S.openPositions.length}/${maxPos} positions, ${markets.length} markets, ${maxPos - S.openPositions.length} open slot(s)`);
      await runBrain(markets);
    } else if (brainReady && !hasSlots) {
      // All slots full — run position monitor to check for early exits
      log(`Brain: slots full (${S.openPositions.length}/${maxPos}) — running position monitor`);
      S.lastBrainAt = Date.now();
      await runPositionMonitor();
    } else if (brainReady && !hasMarkets) {
      log('Brain skipped — no markets available', 'WARN');
    } else if (!brainReady) {
      const secsToNext = Math.round((CFG.brainInterval - (Date.now() - S.lastBrainAt)) / 1000);
      if (S.scanCount % 5 === 0) log(`Brain: ${secsToNext}s to next fire | slots: ${S.openPositions.length}/${maxPos}`);
    }

    saveState();
  } catch(e) {
    log('Scan error: ' + e.message, 'ERROR');
    S.lastErr = e.message;
  }

  if (S.isRunning) scanTimer = setTimeout(scan, CFG.scanInterval);
}

function sendHeartbeat() {
  const phase = getPhase();
  const drawdown = S.peakBalance > 0
    ? ((S.peakBalance - S.balance) / S.peakBalance * 100).toFixed(1)
    : '0.0';
  const sigAge = S.lastBrainAt > 0
    ? Math.floor((Date.now() - S.lastBrainAt) / 60000)
    : '—';
  const mode = CFG.dryRun ? '📝 Paper' : '🔴 LIVE';
  const progress = doublingProgress().toFixed(0);
  const barFilled = Math.round(progress / 10);
  const progressBar = '█'.repeat(barFilled) + '░'.repeat(10 - barFilled);
  const bal = (!CFG.dryRun && S.realBalance > 0 ? S.realBalance : S.balance);

  // API cost efficiency: how much did we spend vs earn
  const apiSpend = S.estimatedApiSpend || 0;
  const uptimeHours = S.startedAt ? (Date.now() - S.startedAt) / 3600000 : 0;
  const dailyBurn = uptimeHours > 0 ? (apiSpend / uptimeHours) * 24 : 0;
  const roiVsSpend = apiSpend > 0 ? ((S.totalPnl / apiSpend) * 100).toFixed(0) : '—';

  tg(`📊 <b>Heartbeat — ${phase.label}</b>
${mode} | Scans: ${S.scanCount} | Brain: #${S.brainCount}
💰 Balance: $${bal.toFixed(2)} → Next: $${nextTarget().toFixed(2)}
${progressBar} ${progress}%
Today: ${S.todayPnl >= 0 ? '+' : ''}$${S.todayPnl.toFixed(2)} | All-time: ${S.totalPnl >= 0 ? '+' : ''}$${S.totalPnl.toFixed(2)}
Win: ${S.wins > 0 || S.losses > 0 ? `${((S.wins/(S.wins+S.losses||1))*100).toFixed(0)}%` : '—'} (${S.wins}W/${S.losses}L) | Open: ${S.openPositions.length}/${dynamicMaxPos()}
🏁 ${doublingsNeeded()} doublings to $500K | DD: ${drawdown}%
💸 API: $${apiSpend.toFixed(2)} total (~$${dailyBurn.toFixed(2)}/day) | ROI vs spend: ${roiVsSpend}%`);
}

// ─── FULL PLUMBING VALIDATION ──────────────────────────────────────────────
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
    check('Real Balance', false, 'Cannot fetch — auth failed');
  }

  // 2. Kalshi Markets — use /markets?series_ticker (correct per docs)
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
    check('MVE Filter', tradeable.length > 0, tradeable.length + ' tradeable — e.g. ' + (tradeable[0]?.ticker || 'none'));
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
        max_tokens: 30,
        messages: [{ role: 'user', content: 'Reply only: BRAIN_OK' }],
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
  ? '🟢 <b>LAUNCH READY</b> — All systems operational'
  : `🔴 <b>NOT READY</b> — ${failed} system(s) need attention`}

Mode: ${CFG.dryRun ? '📝 Paper (set DRY_RUN=false to go live)' : '🔴 LIVE'}`);

  log(`Plumbing test: ${passed}/${results.length} passed`);
  return { passed, failed, launchReady, results };
}

let _botStarted = false;
async function startBot() {
  if (S.isRunning || _botStarted) { log('Already running — ignoring duplicate start'); return; }
  _botStarted = true;
  S.isRunning = true;
  log('🚀 KalshiBot v9 started — running pre-flight sync...');

  // ── PRE-FLIGHT SYNC: establish true available cash BEFORE any trade can fire ──
  // This prevents insufficient_balance errors on the very first brain cycle
  try {
    await syncBalance();
    await syncRestingOrders();
    await syncPositions();
    log(`Pre-flight complete: real=$${S.realBalance.toFixed(2)} available=$${S.availableCash.toFixed(2)} resting=${S.restingOrders.length}`);
  } catch(e) {
    log('Pre-flight sync failed: ' + e.message, 'WARN');
  }

  // ── DELAY FIRST BRAIN FIRE: wait 1 full brain interval before trading ──
  // Gives the first scan time to fully establish state before risking capital
  S.lastBrainAt = Date.now();

  tg(`🚀 <b>KalshiBot v9 Online</b>
Mode: ${CFG.dryRun ? '📝 Paper' : '🔴 LIVE'}
Real: $${S.realBalance > 0 ? S.realBalance.toFixed(2) : '...syncing'}
Available: $${S.availableCash.toFixed(2)} | Resting: ${S.restingOrders.length} orders
Max positions: ${dynamicMaxPos()} | Phase: ${getPhase().label}
Brain interval: ${CFG.brainInterval/60000}min | Scan: ${CFG.scanInterval/1000}s`);

  scan();
  heartbeatTimer = setInterval(sendHeartbeat, CFG.heartbeatInterval);
  saveState();
}

function stopBot() {
  S.isRunning = false;
  _botStarted = false; // FIX: allow restart after stop
  clearTimeout(scanTimer);
  clearInterval(heartbeatTimer);
  log('Bot stopped');
  tg('⏹ <b>KalshiBot stopped</b>');
  saveState();
}

// ─── DASHBOARD HTML ────────────────────────────────────────────────────────
const DASHBOARD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="cache-control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="pragma" content="no-cache">
<meta http-equiv="expires" content="0">
<title>KalshiBot 20260408161922</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#06060a;--s1:#0d0d12;--s2:#13131a;--s3:#1a1a24;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.04);
  --text:#eeeef5;--muted:rgba(238,238,245,0.45);--muted2:rgba(238,238,245,0.22);
  --green:#05d47c;--green-d:rgba(5,212,124,0.12);--green-g:rgba(5,212,124,0.22);
  --red:#ff3d5a;--red-d:rgba(255,61,90,0.12);
  --blue:#4d8af0;--blue-d:rgba(77,138,240,0.12);
  --gold:#f5a623;--gold-d:rgba(245,166,35,0.12);
  --font:'DM Sans',-apple-system,sans-serif;--mono:'DM Mono',monospace;
  --safe-top:env(safe-area-inset-top,0px);--safe-bot:env(safe-area-inset-bottom,0px);
}
html,body{background:var(--bg)}
body{font-family:var(--font);color:var(--text);min-height:100dvh;overflow-x:hidden;-webkit-font-smoothing:antialiased}
.app{max-width:430px;margin:0 auto;padding-bottom:calc(74px + var(--safe-bot));min-height:100dvh}
#errBanner{display:none;position:fixed;top:0;left:0;right:0;background:#ff3d5a;color:#fff;font-size:12px;font-weight:600;padding:10px 16px;text-align:center;z-index:9999}
.nav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:rgba(6,6,10,0.94);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-top:1px solid var(--border);display:flex;padding-bottom:var(--safe-bot);z-index:200}
.nav-item{flex:1;display:flex;flex-direction:column;align-items:center;padding:10px 0 6px;cursor:pointer;color:var(--muted);transition:color 0.15s;gap:3px;position:relative}
.nav-item.active{color:var(--text)}
.nav-pip{position:absolute;top:0;left:50%;transform:translateX(-50%);width:20px;height:2px;background:var(--green);border-radius:0 0 2px 2px;opacity:0}
.nav-item.active .nav-pip{opacity:1}
.nav-icon{width:22px;height:22px;display:flex;align-items:center;justify-content:center}
.nav-label{font-size:10px;font-weight:500}
.page{display:none}.page.active{display:block}
.home-top{padding:calc(var(--safe-top) + 16px) 20px 0;display:flex;align-items:center;justify-content:space-between}
.home-brand{font-size:14px;font-weight:600;color:var(--muted)}
.mode-pill{display:flex;align-items:center;gap:5px;padding:5px 11px;border-radius:20px;font-size:11px;font-weight:700}
.pill-live{background:var(--green-d);color:var(--green);border:1px solid rgba(5,212,124,0.25)}
.pill-paper{background:var(--gold-d);color:var(--gold);border:1px solid rgba(245,166,35,0.25)}
.pill-dot{width:6px;height:6px;border-radius:50%}
.hero{padding:20px 20px 0;text-align:center}
.hero-eyebrow{font-size:11px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:0.12em;margin-bottom:8px}
.hero-amount{font-size:56px;font-weight:700;letter-spacing:-3px;line-height:1}
.hero-change-row{display:flex;justify-content:center;margin:10px 0 16px}
.hero-chip{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:600;padding:6px 16px;border-radius:22px}
.chip-up{background:var(--green-d);color:var(--green)}
.chip-dn{background:var(--red-d);color:var(--red)}
.chip-flat{background:var(--s3);color:var(--muted)}
.hero-row{display:grid;grid-template-columns:1fr 1fr 1fr;background:var(--s1);border-radius:16px;border:1px solid var(--border);overflow:hidden}
.hero-cell{padding:12px 8px;text-align:center;border-right:1px solid var(--border)}
.hero-cell:last-child{border-right:none}
.hc-label{font-size:9px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px}
.hc-val{font-size:15px;font-weight:700}
.chart-wrap{padding:14px 0 0}
.tf-row{display:flex;gap:2px;padding:0 20px;margin-bottom:8px}
.tf-btn{flex:1;padding:7px;text-align:center;font-size:12px;font-weight:600;color:var(--muted);background:none;border:none;border-radius:8px;cursor:pointer;font-family:var(--font)}
.tf-btn.active{background:var(--s3);color:var(--text)}
.chart-svg-wrap{width:100%;height:160px;overflow:hidden}
svg.main-chart{width:100%;height:160px;display:block}
.stat-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:14px 20px 0}
.stat-card{background:var(--s1);border-radius:14px;padding:14px 12px;border:1px solid var(--border);display:flex;flex-direction:column;gap:5px;position:relative;overflow:hidden}
.stat-top-bar{position:absolute;top:0;left:0;right:0;height:2px}
.sc-label{font-size:9px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.1em}
.sc-val{font-size:19px;font-weight:700;letter-spacing:-0.5px;line-height:1.1}
.sc-sub{font-size:10px;color:var(--muted2)}
.action-row{display:flex;gap:10px;padding:14px 20px 0}
.abtn{flex:1;padding:16px;border-radius:14px;border:none;font-family:var(--font);font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}
.abtn:active{transform:scale(0.97)}
.abtn-start{background:var(--green);color:#000}
.abtn-stop{background:rgba(255,61,90,0.15);color:var(--red);border:1px solid rgba(255,61,90,0.3)}
.abtn-icon{background:var(--s2);color:var(--text);flex:0;padding:16px 18px;border:1px solid var(--border)}
.card{margin:12px 20px 0;background:var(--s1);border-radius:18px;border:1px solid var(--border);overflow:hidden}
.card-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 0}
.card-title{font-size:11px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.1em}
.card-badge{font-size:10px;font-weight:700;padding:3px 9px;border-radius:20px}
.badge-green{background:var(--green-d);color:var(--green);border:1px solid rgba(5,212,124,0.2)}
.badge-gold{background:var(--gold-d);color:var(--gold)}
.badge-muted{background:var(--s3);color:var(--muted)}
.engine-body{display:flex;align-items:center;gap:12px;padding:12px 16px 14px}
.engine-dot{width:9px;height:9px;border-radius:50%;background:var(--muted2);flex-shrink:0}
.engine-dot.on{background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 var(--green-g)}70%{box-shadow:0 0 0 10px transparent}100%{box-shadow:0 0 0 0 transparent}}
.engine-name{font-size:15px;font-weight:600}
.engine-sub{font-size:12px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brain-body{padding:10px 16px 14px}
.brain-text{font-size:13px;line-height:1.55;color:rgba(238,238,245,0.75);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.journey-body{padding:12px 16px 16px}
.journey-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px}
.journey-phase-name{font-size:20px;font-weight:700;letter-spacing:-0.5px}
.journey-phase-desc{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.35;max-width:190px}
.journey-target{text-align:right;flex-shrink:0}
.journey-target-lbl{font-size:9px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px}
.journey-target-val{font-size:22px;font-weight:700;color:var(--gold);letter-spacing:-0.5px}
.j-track{height:8px;background:var(--s3);border-radius:4px;overflow:hidden;margin-bottom:8px}
.j-fill{height:100%;background:linear-gradient(90deg,var(--green),#00ff88);border-radius:4px;transition:width 0.8s ease}
.j-meta{display:flex;justify-content:space-between;margin-bottom:14px}
.j-pct{font-size:13px;font-weight:700;color:var(--green)}
.j-left{font-size:12px;color:var(--muted)}
.j-pips{display:flex;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.j-pips::-webkit-scrollbar{display:none}
.j-pip{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:34px;flex-shrink:0}
.pip-node{width:10px;height:10px;border-radius:50%;background:var(--s3);border:2px solid var(--border)}
.pip-node.done{background:var(--green);border-color:var(--green)}
.pip-node.now{border-color:var(--gold);animation:nowpip 1.8s infinite}
@keyframes nowpip{0%,100%{box-shadow:0 0 0 2px rgba(245,166,35,0.15)}50%{box-shadow:0 0 0 5px rgba(245,166,35,0.3)}}
.pip-lbl{font-size:8px;font-weight:600;color:var(--muted2);text-align:center;font-family:var(--mono)}
.pip-lbl.done{color:var(--green)}.pip-lbl.now{color:var(--gold)}
.j-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--border2);border-radius:12px;overflow:hidden;margin-top:12px}
.j-stat{background:var(--s2);padding:10px 8px;text-align:center}
.j-stat-lbl{font-size:9px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px}
.j-stat-val{font-size:14px;font-weight:700}
.page-hdr{padding:calc(var(--safe-top) + 18px) 20px 12px}
.page-title{font-size:30px;font-weight:700;letter-spacing:-1px}
.page-sub{font-size:13px;color:var(--muted);margin-top:2px}
.sec-label{padding:4px 20px 6px;font-size:11px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.12em}
.pos-card{background:var(--s1);border-radius:16px;margin:0 20px 8px;border:1px solid var(--border);overflow:hidden}
.pos-inner{display:flex;align-items:center;gap:12px;padding:14px 14px 10px}
.pos-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex-shrink:0;background:var(--s3);border:1px solid var(--border2)}
.pos-icon.btc{background:rgba(247,147,26,0.12);border-color:rgba(247,147,26,0.2)}
.pos-icon.eth{background:rgba(98,126,234,0.12);border-color:rgba(98,126,234,0.2)}
.pos-icon.nba{background:rgba(29,66,138,0.18);border-color:rgba(29,66,138,0.25)}
.pos-icon.nfl{background:rgba(1,81,36,0.18);border-color:rgba(1,81,36,0.25)}
.pos-icon.cpi{background:var(--blue-d);border-color:rgba(77,138,240,0.2)}
.pos-icon.fed{background:rgba(155,126,248,0.1);border-color:rgba(155,126,248,0.2)}
.pos-info{flex:1;min-width:0}
.pos-ticker{font-size:13px;font-weight:700;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pos-tags{display:flex;align-items:center;gap:6px;margin-top:5px}
.side-tag{padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700}
.tag-yes{background:var(--green-d);color:var(--green)}
.tag-no{background:var(--red-d);color:var(--red)}
.pos-meta-tag{font-size:10px;color:var(--muted)}
.pos-right{text-align:right;flex-shrink:0;min-width:70px}
.pos-price-big{font-size:20px;font-weight:700;letter-spacing:-0.5px}
.pos-cost-line{font-size:11px;color:var(--muted);margin-top:2px}
.pos-pnl-line{font-size:12px;font-weight:600;margin-top:2px}
.pnl-pos{color:var(--green)}.pnl-neg{color:var(--red)}.pnl-zero{color:var(--muted2)}
.pos-footer{display:flex;justify-content:space-between;padding:8px 14px;border-top:1px solid var(--border2);background:var(--s2)}
.pf-item{display:flex;flex-direction:column;gap:2px}
.pf-lbl{font-size:9px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.08em}
.pf-val{font-size:12px;font-weight:600;color:var(--muted)}
.sig-card{background:var(--s1);border-radius:14px;margin:0 20px 8px;padding:14px;border:1px solid var(--border);border-left:3px solid var(--green)}
.sig-card.sig-no{border-left-color:var(--red)}
.sig-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.sig-ticker{font-size:14px;font-weight:700;font-family:var(--mono)}
.sig-reason{font-size:12px;color:var(--muted);line-height:1.45;margin-bottom:8px}
.sig-stats-row{display:flex;gap:12px;flex-wrap:wrap}
.sig-stat{font-size:11px;color:var(--muted2)}
.sig-stat strong{color:var(--text);font-weight:600}
.wl-wrap{margin:0 20px 8px;background:var(--s1);border-radius:14px;padding:14px;border:1px solid var(--border)}
.wl-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.wl-title{font-size:11px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.1em}
.wl-score{font-size:13px;font-weight:700}
.wl-bars{display:flex;align-items:flex-end;gap:3px;height:54px}
.wl-bar{flex:1;border-radius:3px 3px 0 0;min-height:4px}
.wl-w{background:var(--green);opacity:0.8}.wl-l{background:var(--red);opacity:0.8}.wl-e{background:var(--s3)}
.filter-row{display:flex;gap:8px;padding:0 20px 14px;overflow-x:auto;scrollbar-width:none}
.filter-row::-webkit-scrollbar{display:none}
.f-chip{padding:7px 14px;border-radius:20px;background:var(--s2);font-size:13px;font-weight:500;color:var(--muted);white-space:nowrap;cursor:pointer;border:1px solid transparent;font-family:var(--font)}
.f-chip.active{background:rgba(255,255,255,0.07);color:var(--text);border-color:var(--border)}
.tx-month{padding:6px 20px 4px;font-size:13px;font-weight:600;color:var(--muted)}
.tx-row{display:flex;align-items:center;padding:13px 20px;gap:12px}
.tx-icon{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;font-weight:700}
.ti-win{background:var(--green-d);color:var(--green)}
.ti-loss{background:var(--red-d);color:var(--red)}
.ti-open{background:var(--blue-d);color:var(--blue)}
.tx-info{flex:1;min-width:0}
.tx-title{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-sub{font-size:12px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-right{text-align:right;flex-shrink:0}
.tx-amt{font-size:15px;font-weight:700}
.tx-amt-pos{color:var(--green)}.tx-amt-neg{color:var(--red)}.tx-amt-zero{color:var(--muted)}
.tx-time{font-size:11px;color:var(--muted2);margin-top:2px}
.tx-div{height:1px;background:var(--border2);margin:0 20px}
.empty-state{text-align:center;padding:40px 20px;color:var(--muted);font-size:14px}
.mkt-card{background:var(--s1);border-radius:14px;margin:0 20px 8px;padding:14px;border:1px solid var(--border)}
.mkt-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px}
.mkt-title{font-size:13px;font-weight:600;line-height:1.35;flex:1}
.mkt-exp{font-size:11px;color:var(--muted);flex-shrink:0}
.mkt-exp.soon{color:var(--gold)}
.mkt-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.mkt-yes{font-size:22px;font-weight:700;color:var(--green)}
.mkt-no-block{text-align:right}
.mkt-no{font-size:14px;font-weight:600;color:var(--red)}
.mkt-vol{font-size:10px;color:var(--muted2);margin-top:2px}
.mkt-track{height:5px;background:rgba(255,61,90,0.2);border-radius:3px;overflow:hidden}
.mkt-fill{height:100%;background:var(--green);border-radius:3px}
.mkt-badge{display:inline-flex;font-size:10px;font-weight:700;padding:2px 8px;border-radius:5px;margin-top:8px}
.mb-high{background:var(--green-d);color:var(--green)}.mb-med{background:var(--gold-d);color:var(--gold)}
.settings-wrap{padding:calc(var(--safe-top) + 18px) 20px 0}
.settings-title{font-size:30px;font-weight:700;letter-spacing:-1px;margin-bottom:20px}
.s-section{margin-bottom:18px}
.s-section-lbl{font-size:11px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.12em;margin-bottom:8px;padding:0 4px}
.s-group{background:var(--s1);border-radius:18px;overflow:hidden;border:1px solid var(--border)}
.s-row{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border2)}
.s-row:last-child{border-bottom:none}
.s-name{font-size:15px;font-weight:500}
.s-sub{font-size:11px;color:var(--muted);margin-top:2px}
.s-val{font-size:14px;font-weight:600;color:var(--muted)}
.sv-green{color:var(--green)}.sv-red{color:var(--red)}.sv-gold{color:var(--gold)}
.j-settings-block{padding:14px 16px;border-bottom:1px solid var(--border2)}
.jsb-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.jsb-name{font-size:18px;font-weight:700;letter-spacing:-0.4px}
.jsb-pct{font-size:13px;font-weight:700;color:var(--gold)}
.jsb-desc{font-size:12px;color:var(--muted);margin-bottom:12px;line-height:1.4}
.jsb-track{height:8px;background:var(--s3);border-radius:4px;overflow:hidden;margin-bottom:6px}
.jsb-fill{height:100%;background:linear-gradient(90deg,var(--green),#00ff88);border-radius:4px;transition:width 0.8s ease}
.jsb-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--muted)}
.wr-note{font-size:10px;color:var(--muted2);margin-top:3px}
.dd-wrap{padding:0 16px 14px}
.dd-track{height:5px;background:var(--s3);border-radius:3px;overflow:hidden}
.dd-fill{height:100%;background:linear-gradient(90deg,var(--green),var(--gold),var(--red));border-radius:3px;transition:width 0.8s}
.log-wrap{background:var(--s1);border-radius:18px;padding:14px;border:1px solid var(--border);max-height:240px;overflow-y:auto;font-family:var(--mono);font-size:11px;color:rgba(238,238,245,0.45);line-height:1.65}
.log-ts{color:var(--muted2);margin-right:6px}
.log-err{color:rgba(255,61,90,0.7)}.log-warn{color:rgba(245,166,35,0.7)}
.gap{height:12px}
</style>
</head>
<body>
<div id="errBanner"></div>
<div class="app">

<!-- HOME -->
<div id="page-home" class="page active">
  <div class="home-top">
    <div class="home-brand">KalshiBot</div>
    <div id="modePill" class="mode-pill pill-paper">
      <div id="pillDot" class="pill-dot" style="background:var(--gold)"></div>
      <span id="pillText">PAPER</span>
    </div>
  </div>
  <div class="hero">
    <div class="hero-eyebrow">Portfolio Value</div>
    <div class="hero-amount" id="heroBalance">$--</div>
    <div class="hero-change-row">
      <div class="hero-chip chip-flat" id="heroChip">
        <span id="heroArr">--</span> <span id="heroChangeText">loading...</span>
      </div>
    </div>
    <div class="hero-row">
      <div class="hero-cell"><div class="hc-label">Real</div><div class="hc-val" id="heroReal">$--</div></div>
      <div class="hero-cell"><div class="hc-label">Peak</div><div class="hc-val" id="heroPeak">$--</div></div>
      <div class="hero-cell"><div class="hc-label">All-time P&L</div><div class="hc-val" id="heroTotal" style="color:var(--green)">$--</div></div>
    </div>
  </div>
  <div class="chart-wrap">
    <div class="tf-row">
      <button class="tf-btn" onclick="setTF(this,'1H')">1H</button>
      <button class="tf-btn active" onclick="setTF(this,'1D')">1D</button>
      <button class="tf-btn" onclick="setTF(this,'1W')">1W</button>
      <button class="tf-btn" onclick="setTF(this,'ALL')">ALL</button>
    </div>
    <div class="chart-svg-wrap"><svg class="main-chart" id="mainChart" viewBox="0 0 430 160" preserveAspectRatio="none"></svg></div>
  </div>
  <div class="stat-row">
    <div class="stat-card">
      <div class="stat-top-bar" id="wrBar" style="background:var(--muted2)"></div>
      <div class="sc-label">Win Rate</div>
      <div class="sc-val" id="statWR" style="color:var(--muted)">--</div>
      <div class="sc-sub" id="statWRsub">-- resolved</div>
    </div>
    <div class="stat-card">
      <div class="stat-top-bar" id="todayBar" style="background:var(--muted2)"></div>
      <div class="sc-label">Today P&L</div>
      <div class="sc-val" id="statToday" style="color:var(--muted)">$0.00</div>
      <div class="sc-sub" id="statTodaySub">$0.00 all-time</div>
    </div>
    <div class="stat-card">
      <div class="stat-top-bar" style="background:var(--blue)"></div>
      <div class="sc-label">Positions</div>
      <div class="sc-val" id="statPos">0</div>
      <div class="sc-sub" id="statPosSub">of 5 max</div>
    </div>
  </div>
  <div class="action-row">
    <button class="abtn abtn-start" id="startBtn" onclick="toggleBot()">Start</button>
    <button class="abtn abtn-stop" id="stopBtn" onclick="toggleBot()" style="display:none">Stop</button>
    <button class="abtn abtn-icon" onclick="forceSync()" title="Force sync positions">&#8635;</button>
  </div>
  <div class="card">
    <div class="card-head"><div class="card-title">Trading Engine</div><div id="modeBadge" class="card-badge badge-muted">PAPER</div></div>
    <div class="engine-body">
      <div class="engine-dot" id="engineDot"></div>
      <div style="flex:1;min-width:0"><div class="engine-name" id="engineName">Stopped</div><div class="engine-sub" id="engineSub">Tap Start to begin</div></div>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><div class="card-title">Road to $500K</div><div class="card-badge badge-gold" id="homePhaseLabel">--</div></div>
    <div class="journey-body">
      <div class="journey-top">
        <div><div class="journey-phase-name" id="jPhaseName">--</div><div class="journey-phase-desc" id="jPhaseDesc">--</div></div>
        <div class="journey-target"><div class="journey-target-lbl">Next Target</div><div class="journey-target-val" id="jNextTarget">$--</div></div>
      </div>
      <div class="j-track"><div class="j-fill" id="jFill" style="width:0%"></div></div>
      <div class="j-meta"><div class="j-pct" id="jPct">0.0%</div><div class="j-left" id="jLeft">-- doublings left</div></div>
      <div class="j-pips" id="jPips"></div>
      <div class="j-stats">
        <div class="j-stat"><div class="j-stat-lbl">Doublings</div><div class="j-stat-val sv-green" id="jDone">0x</div></div>
        <div class="j-stat"><div class="j-stat-lbl">Kelly</div><div class="j-stat-val sv-gold" id="jKelly">--</div></div>
        <div class="j-stat"><div class="j-stat-lbl">Min Edge</div><div class="j-stat-val" style="color:var(--blue)" id="jEdge">--</div></div>
      </div>
    </div>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-head"><div class="card-title">AI Brain</div><div class="card-badge badge-muted" id="brainCount">Signal #--</div></div>
    <div class="brain-body"><div class="brain-text" id="brainText">Waiting for first signal...</div></div>
  </div>
  <div style="text-align:center;font-size:9px;color:rgba(238,238,245,0.15);padding:6px;font-family:monospace">v20260408161922</div>
  <div class="gap"></div>
</div>

<!-- TRADE -->
<div id="page-trade" class="page">
  <div class="page-hdr"><div class="page-title">Positions</div><div class="page-sub" id="tradeSubtitle">0 open</div></div>
  <div id="positionsList"><div class="empty-state">No open positions</div></div>
  <div class="sec-label" style="margin-top:8px">Recent Signals</div>
  <div id="signalsList"><div class="empty-state" style="padding:16px 20px">No signals yet</div></div>
  <div class="sec-label" style="margin-top:4px">Win / Loss 24h</div>
  <div class="wl-wrap" id="wlWrap">
    <div class="wl-head"><div class="wl-title">Trade Outcomes</div><div class="wl-score" id="wlSummary">--W / --L</div></div>
    <div class="wl-bars" id="wlBars"></div>
  </div>
  <div class="gap"></div>
</div>

<!-- ACTIVITY -->
<div id="page-activity" class="page">
  <div class="page-hdr" style="padding-bottom:4px"><div class="page-title">Activity</div></div>
  <div class="filter-row">
    <button class="f-chip active" onclick="filterTx('all',this)">All</button>
    <button class="f-chip" onclick="filterTx('win',this)">Wins</button>
    <button class="f-chip" onclick="filterTx('loss',this)">Losses</button>
    <button class="f-chip" onclick="filterTx('open',this)">Open</button>
  </div>
  <div id="txFeed"></div>
</div>

<!-- PREDICT -->
<div id="page-predict" class="page">
  <div class="page-hdr"><div class="page-title">Markets</div><div class="page-sub">Ranked by edge</div></div>
  <div id="marketsList"><div class="empty-state">Loading...</div></div>
  <div class="gap"></div>
</div>

<!-- SETTINGS -->
<div id="page-settings" class="page">
  <div class="settings-wrap">
    <div class="settings-title">Settings</div>
    <div class="s-section">
      <div class="s-section-lbl">Journey to $500K</div>
      <div class="s-group">
        <div class="j-settings-block">
          <div class="jsb-top"><div class="jsb-name" id="cfgPhase">--</div><div class="jsb-pct" id="cfgPct">0.0%</div></div>
          <div class="jsb-desc" id="cfgPhaseDesc">--</div>
          <div class="jsb-track"><div class="jsb-fill" id="cfgFill" style="width:0%"></div></div>
          <div class="jsb-labels"><span id="cfgCurBal">$--</span><span id="cfgNextTarget">$--</span></div>
        </div>
        <div class="s-row"><div><div class="s-name">Doublings Completed</div></div><div class="s-val sv-green" id="cfgDoublings">0x done</div></div>
        <div class="s-row"><div><div class="s-name">Doublings Left to $500K</div></div><div class="s-val" id="cfgNeeded">-- left</div></div>
        <div class="s-row"><div><div class="s-name">Starting Bankroll</div><div class="s-sub">Initial capital from env</div></div><div class="s-val" id="cfgBankroll">$--</div></div>
        <div class="s-row"><div><div class="s-name">Phase Kelly</div></div><div class="s-val sv-gold" id="cfgKelly">--</div></div>
      </div>
    </div>
    <div class="s-section">
      <div class="s-section-lbl">Performance</div>
      <div class="s-group">
        <div class="s-row"><div><div class="s-name">Win Rate</div><div class="wr-note s-sub" id="wrNote">-- resolved</div></div><div class="s-val sv-green" id="cfgWR">--</div></div>
        <div class="s-row"><div><div class="s-name">Win / Loss</div></div><div class="s-val" id="cfgWL">--</div></div>
        <div class="s-row"><div><div class="s-name">All-time P&L</div></div><div class="s-val" id="cfgTotalPnl">$0.00</div></div>
        <div class="s-row"><div><div class="s-name">Today P&L</div></div><div class="s-val" id="cfgTodayPnl">$0.00</div></div>
        <div class="s-row"><div><div class="s-name">Total Scans</div></div><div class="s-val" id="cfgScans">--</div></div>
        <div class="s-row"><div><div class="s-name">Brain Signals</div></div><div class="s-val" id="cfgBrainCount">--</div></div>
      </div>
    </div>
    <div class="s-section">
      <div class="s-section-lbl">Portfolio</div>
      <div class="s-group">
        <div class="s-row"><div><div class="s-name">Real Balance</div></div><div class="s-val sv-green" id="cfgReal">$--</div></div>
        <div class="s-row"><div><div class="s-name">Available Cash</div></div><div class="s-val sv-green" id="cfgAvail">$--</div></div>
        <div class="s-row"><div><div class="s-name">Peak Balance</div></div><div class="s-val" id="cfgPeak">$--</div></div>
        <div>
          <div class="s-row" style="border-bottom:none;padding-bottom:6px"><div><div class="s-name">Drawdown from Peak</div></div><div class="s-val sv-red" id="cfgDD">0.0%</div></div>
          <div class="dd-wrap"><div class="dd-track"><div class="dd-fill" id="cfgDDFill" style="width:0%"></div></div></div>
        </div>
      </div>
    </div>
    <div class="s-section">
      <div class="s-section-lbl">Bot Config</div>
      <div class="s-group">
        <div class="s-row"><div><div class="s-name">Mode</div></div><div class="s-val" id="cfgMode">--</div></div>
        <div class="s-row"><div><div class="s-name">Max Positions</div></div><div class="s-val" id="cfgMaxPos">--</div></div>
        <div class="s-row"><div><div class="s-name">Brain Interval</div></div><div class="s-val" id="cfgBrainInt">--</div></div>
        <div class="s-row"><div><div class="s-name">Open / Max</div></div><div class="s-val" id="cfgOpen">--</div></div>
        <div class="s-row"><div><div class="s-name">Est. API Spend</div><div class="s-sub">since last deploy</div></div><div class="s-val sv-gold" id="cfgApiSpend">$0.00</div></div>
        <div class="s-row"><div><div class="s-name">Daily Burn Rate</div></div><div class="s-val sv-gold" id="cfgDailyBurn">$0.00/day</div></div>
      </div>
    </div>
    <div class="s-section">
      <div class="s-section-lbl">Live Log</div>
      <div class="log-wrap" id="logWrap"><span style="color:var(--muted2)">Loading...</span></div>
    </div>
    <div class="gap"></div>
  </div>
</div>

<!-- NAV -->
<nav class="nav">
  <div class="nav-item active" onclick="goPage('home',this)">
    <div class="nav-pip"></div>
    <div class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 12L5 10M5 10L12 3L19 10M5 10V20C5 20.6 5.4 21 6 21H9M19 10L21 12M19 10V20C19 20.6 18.6 21 18 21H15M9 21V15C9 14.4 9.4 14 10 14H14C14.6 14 15 14.4 15 15V21M9 21H15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div class="nav-label">Home</div>
  </div>
  <div class="nav-item" onclick="goPage('trade',this)">
    <div class="nav-pip"></div>
    <div class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="16 7 22 7 22 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div class="nav-label">Trade</div>
  </div>
  <div class="nav-item" onclick="goPage('activity',this)">
    <div class="nav-pip"></div>
    <div class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.8"/><line x1="8" y1="9" x2="16" y2="9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="8" y1="13" x2="16" y2="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="8" y1="17" x2="12" y2="17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
    <div class="nav-label">Activity</div>
  </div>
  <div class="nav-item" onclick="goPage('predict',this)">
    <div class="nav-pip"></div>
    <div class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z" stroke="currentColor" stroke-width="1.8"/><path d="M2 12h4M18 12h4M12 2v4M12 18v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
    <div class="nav-label">Predict</div>
  </div>
  <div class="nav-item" onclick="goPage('settings',this)">
    <div class="nav-pip"></div>
    <div class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="1.8"/></svg></div>
    <div class="nav-label">Settings</div>
  </div>
</nav>
</div>

<script>
var API='',POLL=10000,state=null,chartData=[],allTx=[],currentTF='1D',txFilter='all';

function goPage(id,el){
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active');});
  document.querySelectorAll('.nav-item').forEach(function(n){n.classList.remove('active');});
  var pg=document.getElementById('page-'+id);
  if(pg) pg.classList.add('active');
  el.classList.add('active');
  if(id==='activity') renderTxFeed(allTx,txFilter);
  if(id==='predict') renderMarkets();
}

function setTF(el,tf){
  currentTF=tf;
  document.querySelectorAll('.tf-btn').forEach(function(b){b.classList.remove('active');});
  el.classList.add('active');
  drawChart();
}

function pushChartPoint(v){
  chartData.push({t:Date.now(),v:v});
  if(chartData.length>600) chartData.shift();
  drawChart();
}

function drawChart(){
  var svg=document.getElementById('mainChart');
  if(!svg||chartData.length<2){if(svg)svg.innerHTML='';return;}
  var now=Date.now(),cuts={1H:3600000,1D:86400000,1W:604800000,ALL:1e15};
  var d=chartData.filter(function(p){return now-p.t<(cuts[currentTF]||1e15);});
  var data=d.length>1?d:chartData;
  if(data.length<2){svg.innerHTML='';return;}
  var W=430,H=160,pad=10;
  var vals=data.map(function(p){return p.v;});
  var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals),rng=mx-mn||0.01;
  function tx(i){return pad+(i/(data.length-1))*(W-pad*2);}
  function ty(v){return H-pad-((v-mn)/rng)*(H-pad*2-16);}
  var up=data[data.length-1].v>=data[0].v,col=up?'#05d47c':'#ff3d5a';
  var area='M '+pad+','+(H+4)+' L '+pad+','+ty(data[0].v)+' '+data.map(function(p,i){return 'L '+tx(i)+','+ty(p.v);}).join(' ')+' L '+(W-pad)+','+(H+4)+' Z';
  var line='M '+data.map(function(p,i){return tx(i)+','+ty(p.v);}).join(' L ');
  var lx=tx(data.length-1),ly=ty(data[data.length-1].v);
  svg.innerHTML='<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+col+'" stop-opacity="0.18"/><stop offset="90%" stop-color="'+col+'" stop-opacity="0"/></linearGradient></defs><path d="'+area+'" fill="url(#cg)"/><path d="'+line+'" fill="none" stroke="'+col+'" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="'+lx+'" cy="'+ly+'" r="4" fill="'+col+'"/><circle cx="'+lx+'" cy="'+ly+'" r="8" fill="'+col+'" opacity="0.15"/>';
}

function renderWLBars(trades){
  var wrap=document.getElementById('wlBars');
  if(!wrap) return;
  var now=Date.now(),buckets=[];
  for(var i=0;i<24;i++) buckets.push({w:0,l:0});
  (trades||[]).forEach(function(t){
    var hr=Math.floor((now-(t.resolvedAt||t.openedAt||now))/3600000);
    if(hr<24){if(t.won)buckets[23-hr].w++;else buckets[23-hr].l++;}
  });
  var mx=Math.max.apply(null,buckets.map(function(b){return b.w+b.l;}));if(mx<1)mx=1;
  wrap.innerHTML=buckets.map(function(b){
    if(!b.w&&!b.l) return '<div class="wl-bar wl-e" style="height:5px"></div>';
    return '<div class="wl-bar '+(b.w>=b.l?'wl-w':'wl-l')+'" style="height:'+Math.max(7,((b.w+b.l)/mx)*50)+'px"></div>';
  }).join('');
  var wins=(trades||[]).filter(function(t){return t.won;}).length;
  var losses=(trades||[]).filter(function(t){return t.status==='resolved'&&!t.won;}).length;
  var el=document.getElementById('wlSummary');
  if(el){el.textContent=wins+'W / '+losses+'L';el.style.color=wins>=losses?'var(--green)':'var(--red)';}
}

function mktIcon(ticker){
  if(/BTC|KXBTCD/i.test(ticker)) return{e:'BTC',cls:'btc'};
  if(/ETH|KXETH/i.test(ticker)) return{e:'ETH',cls:'eth'};
  if(/NBA|KXNBA/i.test(ticker)) return{e:'NBA',cls:'nba'};
  if(/NFL|KXNFL/i.test(ticker)) return{e:'NFL',cls:'nfl'};
  if(/CPI|KXCPI/i.test(ticker)) return{e:'CPI',cls:'cpi'};
  if(/FED|KXFED/i.test(ticker)) return{e:'FED',cls:'fed'};
  return{e:'~',cls:'gen'};
}

function fm(n){return '$'+(Math.abs(n||0)).toFixed(2);}
function fs(n){return(n>=0?'+':'-')+fm(n);}

function renderPositions(positions){
  var wrap=document.getElementById('positionsList');
  var sub=document.getElementById('tradeSubtitle');
  if(!wrap) return;
  if(!positions||!positions.length){wrap.innerHTML='<div class="empty-state">No open positions</div>';if(sub)sub.textContent='0 open';return;}
  if(sub) sub.textContent=positions.length+' open';
  wrap.innerHTML=positions.map(function(p){
    var isYes=(p.side||'YES').toUpperCase()==='YES';
    var pnl=p.pnl||0,ep=p.entryPrice||50,contracts=p.contracts||1;
    var cost=p.cost||(ep*contracts/100);
    var hoursOpen=p.openedAt?Math.round((Date.now()-p.openedAt)/3600000):0;
    var conf=p.confidence?Math.round(p.confidence*100)+'%':'--';
    var icon=mktIcon(p.ticker||'');
    var pnlCls=pnl>0?'pnl-pos':pnl<0?'pnl-neg':'pnl-zero';
    return '<div class="pos-card"><div class="pos-inner"><div class="pos-icon '+icon.cls+'">'+icon.e+'</div><div class="pos-info"><div class="pos-ticker">'+(p.ticker||'--')+'</div><div class="pos-tags"><span class="side-tag '+(isYes?'tag-yes':'tag-no')+'">'+(isYes?'YES':'NO')+'</span><span class="pos-meta-tag">'+contracts+' ct &middot; '+icon.cls.toUpperCase()+'</span></div></div><div class="pos-right"><div class="pos-price-big">'+ep+'c</div><div class="pos-cost-line">Cost '+fm(cost)+'</div><div class="pos-pnl-line '+pnlCls+'">'+(pnl>=0?'+':'')+fm(pnl)+'</div></div></div><div class="pos-footer"><div class="pf-item"><div class="pf-lbl">Confidence</div><div class="pf-val">'+conf+'</div></div><div class="pf-item" style="align-items:center"><div class="pf-lbl">Open</div><div class="pf-val">'+hoursOpen+'h</div></div><div class="pf-item" style="align-items:flex-end"><div class="pf-lbl">Value</div><div class="pf-val">'+fm(ep*contracts/100)+'</div></div></div></div>';
  }).join('');
}

function renderSignals(signals){
  var wrap=document.getElementById('signalsList');
  if(!wrap) return;
  if(!signals||!signals.length){wrap.innerHTML='<div class="empty-state" style="padding:16px 20px">No signals yet</div>';return;}
  wrap.innerHTML=signals.slice(0,5).map(function(s){
    var isYes=(s.side||'YES').toUpperCase()==='YES';
    return '<div class="sig-card '+(isYes?'':'sig-no')+'"><div class="sig-top"><div class="sig-ticker">'+(s.ticker||'--')+'</div><span class="side-tag '+(isYes?'tag-yes':'tag-no')+'">'+(s.side||'YES')+'</span></div><div class="sig-reason">'+(s.reasoning||'--')+'</div><div class="sig-stats-row"><div class="sig-stat">Conf <strong>'+Math.round((s.confidence||0)*100)+'%</strong></div><div class="sig-stat">Edge <strong>'+Math.round((s.edge||0)*100)+'%</strong></div><div class="sig-stat">Size <strong>'+fm(s.kellySize||0)+'</strong></div>'+(s.hoursToClose?'<div class="sig-stat">Closes <strong>'+s.hoursToClose+'h</strong></div>':'')+'</div></div>';
  }).join('');
}

function buildTx(trades){
  return (trades||[]).map(function(t){
    return{type:t.status==='open'?'open':(t.won?'win':'loss'),ticker:t.ticker||'--',pnl:t.pnl||0,cost:t.cost||0,ts:t.resolvedAt||t.openedAt||Date.now(),side:t.side||'YES',contracts:t.contracts||1,won:t.won,status:t.status};
  });
}

function renderTxFeed(txList,filter){
  txFilter=filter||txFilter;
  var wrap=document.getElementById('txFeed');
  if(!wrap) return;
  var fl=txList;
  if(txFilter==='win') fl=txList.filter(function(t){return t.type==='win';});
  else if(txFilter==='loss') fl=txList.filter(function(t){return t.type==='loss';});
  else if(txFilter==='open') fl=txList.filter(function(t){return t.type==='open';});
  if(!fl.length){wrap.innerHTML='<div class="empty-state">No transactions yet</div>';return;}
  var groups={};
  fl.forEach(function(tx){var k=new Date(tx.ts).toLocaleString('en-US',{month:'long',year:'numeric'});if(!groups[k])groups[k]=[];groups[k].push(tx);});
  wrap.innerHTML=Object.keys(groups).map(function(month){
    var txs=groups[month];
    return '<div class="tx-month">'+month+'</div>'+txs.map(function(tx,i){
      var lbl=tx.type==='win'?'Win':tx.type==='loss'?'Loss':'Open';
      var iconCls='ti-'+(tx.type==='win'?'win':tx.type==='loss'?'loss':'open');
      var pnlD=tx.type==='win'&&tx.pnl>0?'+'+fm(tx.pnl):tx.type==='win'?'+$0.00':tx.type==='loss'?'-'+fm(Math.abs(tx.pnl||0)):'-'+fm(Math.abs(tx.cost||0));
      var pnlC=tx.type==='win'?'tx-amt-pos':tx.type==='loss'?'tx-amt-neg':'tx-amt-zero';
      return '<div class="tx-row"><div class="tx-icon '+iconCls+'">'+(tx.type==='win'?'W':tx.type==='loss'?'L':'~')+'</div><div class="tx-info"><div class="tx-title">'+lbl+' &middot; '+tx.ticker+'</div><div class="tx-sub">'+tx.side+' &middot; '+(tx.contracts||1)+' ct &middot; '+new Date(tx.ts).toLocaleDateString('en-US',{month:'short',day:'numeric'})+'</div></div><div class="tx-right"><div class="tx-amt '+pnlC+'">'+pnlD+'</div><div class="tx-time">'+new Date(tx.ts).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})+'</div></div></div>'+(i<txs.length-1?'<div class="tx-div"></div>':'');
    }).join('');
  }).join('');
}

function filterTx(type,el){
  document.querySelectorAll('.f-chip').forEach(function(c){c.classList.remove('active');});
  el.classList.add('active');
  renderTxFeed(allTx,type);
}

function renderMarkets(){
  var wrap=document.getElementById('marketsList');
  if(!wrap) return;
  if(!state||!state.topMarkets||!state.topMarkets.length){
    wrap.innerHTML='<div class="empty-state">'+(state?'No markets loaded yet — scanner running...':'Loading...')+'</div>';
    return;
  }
  wrap.innerHTML=state.topMarkets.slice(0,15).map(function(m){
    var yp=Math.round((m.yesAsk||0)*100),np=100-yp,hl=m.hoursLeft||999,soon=hl<24,edge=m.edge||0;
    return '<div class="mkt-card"><div class="mkt-top"><div class="mkt-title">'+(m.title||m.ticker)+'</div><div class="mkt-exp'+(soon?' soon':'')+'">'+( hl<999?(hl<1?'<1h':Math.round(hl)+'h'):'--')+'</div></div><div class="mkt-row"><div class="mkt-yes">'+yp+'c YES</div><div class="mkt-no-block"><div class="mkt-no">'+np+'c NO</div><div class="mkt-vol">vol '+(m.volume||0).toLocaleString()+'</div></div></div><div class="mkt-track"><div class="mkt-fill" style="width:'+yp+'%"></div></div>'+(edge>0?'<span class="mkt-badge '+(edge>0.08?'mb-high':'mb-med')+'">Edge '+(edge*100).toFixed(0)+'%</span>':'')+'</div>';
  }).join('');
}

function renderPips(done,needed,bankroll){
  var wrap=document.getElementById('jPips');if(!wrap)return;
  var total=Math.min((done||0)+(needed||16),16),html='';
  for(var i=0;i<total;i++){
    var amt=(bankroll||50)*Math.pow(2,i+1);
    var lbl=amt>=1000?'$'+(amt/1000).toFixed(0)+'K':'$'+Math.round(amt);
    var isDone=i<done,isCur=i===done;
    html+='<div class="j-pip"><div class="pip-node'+(isDone?' done':isCur?' now':'')+'"></div><div class="pip-lbl'+(isDone?' done':isCur?' now':'')+'">'+lbl+'</div></div>';
  }
  wrap.innerHTML=html;
}

function setText(id,val){var e=document.getElementById(id);if(e)e.textContent=val;}
function setStyle(id,prop,val){var e=document.getElementById(id);if(e)e.style[prop]=val;}

var _retries=0;
function loadState(){
  // 6-second timeout - prevents silent hang on slow mobile connections
  var ctrl=typeof AbortController!=='undefined'?new AbortController():null;
  var timer=ctrl?setTimeout(function(){ctrl.abort();},6000):null;
  var url=API+'/api/state?_='+Date.now();
  fetch(url,{cache:'no-store',signal:ctrl?ctrl.signal:undefined})
    .then(function(r){
      if(timer)clearTimeout(timer);
      if(!r.ok)throw new Error('HTTP '+r.status);
      return r.json();
    })
    .then(function(s){
      state=s;_retries=0;
      var eb=document.getElementById('errBanner');
      if(eb)eb.style.display='none';
      applyState(s);
    })
    .catch(function(e){
      if(timer)clearTimeout(timer);
      _retries++;
      var delay=Math.min(3000*_retries,20000);
      var msg=e.name==='AbortError'?'Server timeout - retrying...':e.message;
      console.error('loadState err #'+_retries+':',msg);
      var eb=document.getElementById('errBanner');
      if(eb){
        eb.textContent='Connecting to KalshiBot... ('+msg+') retry '+_retries;
        eb.style.display='block';
      }
      setTimeout(loadState,delay);
    });
}

function applyState(s){
  try{
    var real=s.realBalance||0,bal=real>0?real:(s.balance||0),avail=s.availableCash||0;
    var today=s.todayPnl||0,total=s.totalPnl||0,peak=s.peakBalance||bal;
    var w=s.wins||0,l=s.losses||0,totalTrades=w+l;
    var openCnt=(s.openPositions||[]).length,mp=s.maxPos||5;
    var wr=s.winRate!==null&&s.winRate!==undefined&&s.winRate!==''?parseFloat(s.winRate):null;
    var bankroll=s.startingBankroll||50,dryRun=s.dryRun!==false;

    // FIX: show syncing state instead of $-- when balance hasn't loaded yet
    var balDisplay = bal>0 ? fm(bal) : (s.isRunning ? '...' : '$0.00');
    setText('heroBalance', balDisplay);
    setText('heroReal', real>0 ? fm(real) : (s.isRunning ? '...' : '$0.00'));
    setText('heroPeak', peak>0 ? fm(peak) : '$0.00');
    var totEl=document.getElementById('heroTotal');
    if(totEl){totEl.textContent=fs(total);totEl.style.color=total>=0?'var(--green)':'var(--red)';}
    setText('heroArr',today>=0?'+':'-');
    setText('heroChangeText',fm(today)+' today');
    var chip=document.getElementById('heroChip');
    if(chip)chip.className='hero-chip '+(today>0?'chip-up':today<0?'chip-dn':'chip-flat');
    pushChartPoint(bal);

    var pill=document.getElementById('modePill');
    var dot=document.getElementById('pillDot');
    setText('pillText',dryRun?'PAPER':'LIVE');
    if(pill)pill.className='mode-pill '+(dryRun?'pill-paper':'pill-live');
    if(dot)dot.style.background=dryRun?'var(--gold)':'var(--green)';

    var wrEl=document.getElementById('statWR'),wrBar=document.getElementById('wrBar');
    if(wr!==null){
      if(wrEl){wrEl.textContent=wr.toFixed(0)+'%';wrEl.style.color=wr>=70?'var(--green)':wr>=50?'var(--gold)':'var(--red)';}
      if(wrBar)wrBar.style.background=wr>=70?'var(--green)':wr>=50?'var(--gold)':'var(--red)';
    }else{
      if(wrEl){wrEl.textContent='--';wrEl.style.color='var(--muted)';}
      if(wrBar)wrBar.style.background='var(--muted2)';
    }
    setText('statWRsub',totalTrades+' resolved');

    var tdEl=document.getElementById('statToday');
    if(tdEl){tdEl.textContent=(today>=0?'+':'')+fm(today);tdEl.style.color=today>0?'var(--green)':today<0?'var(--red)':'var(--muted)';}
    setStyle('todayBar','background',today>0?'var(--green)':today<0?'var(--red)':'var(--muted2)');
    setText('statTodaySub',fs(total)+' all-time');
    setText('statPos',openCnt+'/'+mp);
    setText('statPosSub','of '+mp+' max — '+((mp-openCnt)>0?(mp-openCnt)+' open':'full'));

    var running=s.isRunning;
    var edot=document.getElementById('engineDot');
    if(edot)edot.className='engine-dot'+(running?' on':'');
    setText('engineName',running?'Engine Running':'Engine Stopped');
    setText('engineSub',running?'Scan #'+(s.scanCount||0)+' - '+openCnt+' open - '+fm(avail)+' avail':'Tap Start to begin');
    var sb=document.getElementById('startBtn'),stb=document.getElementById('stopBtn');
    if(sb)sb.style.display=running?'none':'flex';
    if(stb)stb.style.display=running?'flex':'none';
    var badge=document.getElementById('modeBadge');
    if(badge){badge.textContent=dryRun?'PAPER':'LIVE';badge.className='card-badge '+(dryRun?'badge-gold':'badge-green');}

    var sig0=s.signals&&s.signals[0];
    var brainAge=s.lastBrainAt>0?Math.round((Date.now()-s.lastBrainAt)/60000):null;
    var brainAgeStr=brainAge!==null?(' — '+brainAge+'m ago'):'';
    if(sig0)setText('brainText',sig0.reasoning||'Analyzing...');
    else if(s.lastBrainReason)setText('brainText',s.lastBrainReason);
    else if(s.isRunning)setText('brainText','Scanner active'+brainAgeStr+' — awaiting next analysis cycle...');
    else setText('brainText','Start the bot to begin signal generation');
    setText('brainCount','Signal #'+(s.brainCount||0)+brainAgeStr);

    if(s.phaseLabel){
      var dm=s.doublingsMade||0,dn=s.doublingsNeeded||0;
      var pct=parseFloat(s.doublingProgress||0),nxt=parseFloat(s.nextTarget||0);
      setText('homePhaseLabel',s.phaseLabel);
      setText('jPhaseName',s.phaseLabel);
      setText('jPhaseDesc',s.phaseDesc||'');
      setText('jNextTarget','$'+nxt.toLocaleString('en-US',{maximumFractionDigits:0}));
      setStyle('jFill','width',Math.min(100,pct)+'%');
      setText('jPct',pct.toFixed(1)+'%');
      setText('jLeft',dn+' doubling'+(dn!==1?'s':'')+' to $500K');
      setText('jDone',dm+'x');
      if(s.cfg){setText('jKelly',Math.round((s.cfg.kellyFrac||0.55)*100)+'%');setText('jEdge',Math.round((s.cfg.minEdge||0.04)*100)+'%');}
      renderPips(dm,dn,bankroll);
      setText('cfgPhase',s.phaseLabel);setText('cfgPhaseDesc',s.phaseDesc||'');
      setText('cfgPct',pct.toFixed(1)+'%');setStyle('cfgFill','width',Math.min(100,pct)+'%');
      setText('cfgCurBal',fm(bal));setText('cfgNextTarget','-> $'+nxt.toLocaleString('en-US',{maximumFractionDigits:0}));
      setText('cfgDoublings',dm+'x done');setText('cfgNeeded',dn+' left');
      if(s.cfg)setText('cfgKelly',Math.round((s.cfg.kellyFrac||0.55)*100)+'%');
    }
    setText('cfgBankroll',fm(bankroll));

    var cfgWrEl=document.getElementById('cfgWR');
    if(cfgWrEl){cfgWrEl.textContent=wr!==null?wr.toFixed(1)+'%':'--';cfgWrEl.className='s-val '+(wr>=70?'sv-green':wr>=50?'sv-gold':wr!==null?'sv-red':'');}
    setText('wrNote',totalTrades+' resolved - '+openCnt+' open');
    var cfgWlEl=document.getElementById('cfgWL');
    if(cfgWlEl){cfgWlEl.textContent=w+'W / '+l+'L';cfgWlEl.className='s-val '+(w>l?'sv-green':w<l?'sv-red':'');}
    var tpEl=document.getElementById('cfgTotalPnl');
    if(tpEl){tpEl.textContent=fs(total);tpEl.className='s-val '+(total>=0?'sv-green':'sv-red');}
    var tdEl2=document.getElementById('cfgTodayPnl');
    if(tdEl2){tdEl2.textContent=fs(today);tdEl2.className='s-val '+(today>=0?'sv-green':'sv-red');}
    setText('cfgScans',(s.scanCount||0).toLocaleString());
    setText('cfgBrainCount',(s.brainCount||0).toLocaleString());
    setText('cfgReal',fm(real));setText('cfgAvail',fm(avail));setText('cfgPeak',fm(peak));
    var dd=parseFloat(s.drawdown||0);
    setText('cfgDD',dd.toFixed(1)+'%');setStyle('cfgDDFill','width',Math.min(100,dd)+'%');
    setText('cfgMode',dryRun?'Paper':'LIVE');
    setText('cfgMaxPos',mp);
    setText('cfgBrainInt',s.cfg?((s.cfg.brainInterval||120000)/60000).toFixed(1)+'min':'2.0min');
    setText('cfgOpen',openCnt+' of '+mp);
    var apiSpend=parseFloat(s.estimatedApiSpend||0);
    var uptimeH=s.startedAt?(Date.now()-s.startedAt)/3600000:0;
    var burn=uptimeH>0.5?(apiSpend/uptimeH)*24:0;
    setText('cfgApiSpend','$'+apiSpend.toFixed(2));
    var burnEl=document.getElementById('cfgDailyBurn');
    if(burnEl){burnEl.textContent='$'+burn.toFixed(2)+'/day';burnEl.style.color=burn>bal?'var(--red)':'var(--gold)';}

    renderPositions(s.openPositions||[]);
    renderSignals(s.signals||[]);
    renderWLBars(s.trades||[]);
    allTx=buildTx(s.trades||[]);
    renderMarkets();

    if(s.logs&&s.logs.length){
      var lw=document.getElementById('logWrap');
      if(lw)lw.innerHTML=s.logs.slice(0,60).map(function(l){
        var lvl=(l.level||'').toLowerCase();
        var cls=lvl==='error'||lvl==='err'?' class="log-err"':lvl==='warn'?' class="log-warn"':'';
        return '<div'+cls+'><span class="log-ts">'+(l.ts||'')+'</span>'+(l.msg||l)+'</div>';
      }).join('');
    }
  }catch(err){
    console.error('applyState error:',err);
    var eb=document.getElementById('errBanner');
    if(eb){eb.textContent='Display error: '+err.message;eb.style.display='block';}
  }
}

function forceSync(){
  var btn=document.querySelector('.abtn-icon');
  if(btn){btn.style.opacity='0.5';btn.disabled=true;}
  fetch(API+'/api/sync',{method:'POST'})
    .then(function(r){return r.json();})
    .then(function(s){
      state=s;applyState(s);
      if(btn){btn.style.opacity='';btn.disabled=false;}
    })
    .catch(function(e){
      console.error('Sync err:',e);
      if(btn){btn.style.opacity='';btn.disabled=false;}
      setTimeout(loadState,500);
    });
}

function toggleBot(){
  fetch(API+'/api/toggle',{method:'POST'}).then(function(){setTimeout(loadState,800);}).catch(function(e){console.error(e);});
}

for(var _i=15;_i>=0;_i--) chartData.push({t:Date.now()-_i*300000,v:12});
drawChart();
loadState();
setInterval(loadState,POLL);
</script>
</body>
</html>
`;

// ─── EXPRESS SERVER ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST');

  // Dashboard - served at both / and /app, no redirects
  if (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/dashboard') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    return res.end(DASHBOARD);
  }

  if (url.pathname === '/api/state') {
    const total = S.wins + S.losses;
    const winRate = total > 0 ? (S.wins / total * 100).toFixed(1) : null;
    const drawdown = S.peakBalance > 0
      ? ((S.peakBalance - S.balance) / S.peakBalance * 100).toFixed(1) : '0.0';
    const phase = getPhase();
    // SLIM response - only send what the dashboard needs, not full S object
    // Full S can be 500KB+ with trades/logs - causes mobile fetch timeouts
    const slim = {
      isRunning: S.isRunning,
      balance: S.balance,
      realBalance: S.realBalance,
      peakBalance: S.peakBalance,
      availableCash: S.availableCash,
      todayPnl: S.todayPnl,
      totalPnl: S.totalPnl,
      wins: S.wins,
      losses: S.losses,
      scanCount: S.scanCount,
      brainCount: S.brainCount,
      startedAt: S.startedAt,
      lastBrainAt: S.lastBrainAt,
      lastErr: S.lastErr,
      estimatedApiSpend: parseFloat((S.estimatedApiSpend || 0).toFixed(2)),
      // Slim arrays - only what's needed for display
      openPositions: S.openPositions.slice(0, 10),
      signals: (S.signals || []).slice(0, 5),
      trades: (S.trades || []).slice(0, 50),  // last 50 only for activity feed
      logs: (S.logs || []).slice(0, 30),       // last 30 for log view
      topMarkets: (S.topMarkets || []).slice(0, 15),
      // Computed fields
      dryRun: CFG.dryRun,
      maxPos: dynamicMaxPos(),
      winRate,
      drawdown,
      openCount: S.openPositions.length,
      phase: phase.name,
      phaseLabel: phase.label,
      phaseDesc: phase.desc,
      doublingsMade: doublingsMade(),
      doublingsNeeded: doublingsNeeded(),
      nextTarget: nextTarget(),
      doublingProgress: doublingProgress().toFixed(1),
      restingOrderCount: S.restingOrders.length,
      startingBankroll: CFG.bankroll,
      cfg: { kellyFrac: phase.kelly, minEdge: phase.minEdge, minProb: phase.minProb, brainInterval: CFG.brainInterval, scanInterval: CFG.scanInterval },
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
    return res.end(JSON.stringify(slim));
  }

  if (url.pathname === '/api/toggle' && req.method === 'POST') {
    if (S.isRunning) stopBot(); else startBot();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
    return res.end(JSON.stringify({ ...S, dryRun: CFG.dryRun }));
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
    // Force immediate full sync: balance + positions + settlements
    Promise.all([
      syncBalance(),
      syncPositions(),
      resolvePositions(),
      backfillKalshiHistory(),
    ]).then(() => {
      saveState();
      log('🔄 Manual sync from dashboard');
      const total = S.wins + S.losses;
      const winRate = total > 0 ? (S.wins / total * 100).toFixed(1) : null;
      const drawdown = S.peakBalance > 0
        ? ((S.peakBalance - S.balance) / S.peakBalance * 100).toFixed(1) : '0.0';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...S, dryRun: CFG.dryRun, maxPos: dynamicMaxPos(),
        winRate, drawdown, openCount: S.openPositions.length, synced: true,
      }));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
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

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
    return res.end(JSON.stringify({
      ok: true, running: S.isRunning, scans: S.scanCount, brain: S.brainCount,
      balance: S.balance, positions: S.openPositions.length,
    }));
  }

  res.writeHead(404);
  res.end('Not found');
});

// ─── BOOT ───────────────────────────────────────────────────────────────────
loadState();
server.listen(CFG.port, () => {
  log(`KalshiBot v9 listening on port ${CFG.port}`);
  log(`Mode: ${CFG.dryRun ? 'PAPER' : 'LIVE'} | Bankroll: $${CFG.bankroll}`);
  // Auto-start after 5 seconds — gives Railway time to stabilize before pre-flight sync
  setTimeout(() => {
    log('Auto-starting bot...');
    startBot();
  }, 5000);
});
