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
  scanInterval:  15000,   // math scanner: every 15s (faster)
  brainInterval: 90000,   // claude brain: every 90s (more frequent signals)
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
    S.realBalance = bal;
    S.balance = bal;
    if (bal > S.peakBalance) S.peakBalance = bal;
    if (S.peakBalance === 0) S.peakBalance = bal;
    log(`Balance: $${bal.toFixed(2)} | Peak: $${S.peakBalance.toFixed(2)}`);
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
      // Prefer markets closing in 1-48h — sweet spot for quick resolution
      const durationScore = hoursLeft < 1 ? 0.2          // too close — risky
        : hoursLeft < 6   ? 1.0                           // ideal: resolves today
        : hoursLeft < 24  ? 0.9                           // great: resolves tomorrow
        : hoursLeft < 48  ? 0.75                          // good: 2 days
        : hoursLeft < 168 ? 0.5                           // ok: within a week
        : 0.2;                                            // slow: penalize

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

  S.brainCount++;
  log(`Brain #${S.brainCount} firing on ${Math.min(topMarkets.length, 8)} markets`);

  const memSummary = S.brainMemory.slice(-5).map(m =>
    `${m.ticker}: ${m.action} @ ${m.prob}% confidence → ${m.outcome || 'pending'}`
  ).join('\n') || 'No prior trades';

  const marketList = topMarkets.slice(0, 8).map(m =>
    `- ${m.ticker} | "${m.title}" | YES=${(m.yesAsk*100).toFixed(0)}¢ | Vol=${m.volume} | Score=${m.score.toFixed(3)} | Closes: ${m.closeTime ? new Date(m.closeTime).toLocaleDateString() : 'unknown'}`
  ).join('\n');

  const phase = getPhase();
  const _bal = S.realBalance || S.balance;
  const _doublings = doublingsMade();
  const _needed = doublingsNeeded();
  const _next = nextTarget();
  const _progress = doublingProgress().toFixed(0);

  const prompt = `{"task":"generate_trade_signals","rules":["respond with ONLY the JSON object below","no explanation","no preamble","start with {","end with }"],"context":{"MISSION":"Reach $500,000 by doubling. Current: $${_bal.toFixed(2)} | Available cash: $${S.availableCash.toFixed(2)} | Resting orders: ${S.restingOrders.length} | Next target: $${_next.toFixed(2)} | Progress: ${_progress}% | Doublings done: ${_doublings} | Doublings left: ${_needed} | Phase: ${phase.name} — ${phase.desc}. RULES: 1) Conf MUST beat mkt by ${(phase.minEdge*100).toFixed(0)}%+. 2) Only 12c-88c. 3) Min ${(phase.minProb*100).toFixed(0)}% conf. 4) YES 12-55c preferred. 5) Resolves within 48h ideal. 6) Web search AGGRESSIVELY. 7) ONLY suggest trades if available cash > $2. 8) Include marketPrice every signal","mode":"${CFG.dryRun?'paper':'live'}","balance":${_bal.toFixed(2)},"availableCash":${S.availableCash.toFixed(2)},"restingOrders":${S.restingOrders.length},"nextTarget":${_next.toFixed(2)},"doublingProgress":"${_progress}%","phase":"${phase.name}","peak":${S.peakBalance.toFixed(2)},"todayPnl":${S.todayPnl.toFixed(2)},"totalPnl":${S.totalPnl.toFixed(2)},"wins":${S.wins},"losses":${S.losses},"winRate":"${S.wins+S.losses>0?((S.wins/(S.wins+S.losses))*100).toFixed(0)+'%':'new'}","openSlots":${dynamicMaxPos() - S.openPositions.length},"maxPos":${dynamicMaxPos()},"openPositions":${JSON.stringify(S.openPositions.map(p=>({ticker:p.ticker,side:p.side,entryPrice:p.entryPrice,hoursOpen:Math.round((Date.now()-p.openedAt)/3600000)})))},"recentMemory":${JSON.stringify(S.brainMemory.slice(-5))}},"markets":${JSON.stringify(topMarkets.slice(0,10).map(m=>({ticker:m.ticker,title:m.title,yesAsk:Math.round(m.yesAsk*100),yesBid:Math.round((m.yesBid||0)*100),volume:Math.round(m.volume),score:parseFloat(m.score.toFixed(3)),hoursLeft:m.hoursLeft,closesIn:m.closeTime?Math.round((new Date(m.closeTime)-Date.now())/3600000)+'h':'unknown'})))},"strategy":{"priority1":"SHORT-DURATION: Markets closing in 1-48h score highest — fast resolution = fast compounding toward next doubling at $${_next.toFixed(0)}","priority2":"HIGH-EDGE: Search web for breaking news, live sports scores, BTC/ETH current price — anything market has not priced in yet","priority3":"ASYMMETRIC: YES at 12-40c = 2.5-7x payout if wins — actively seek these at ${(phase.minProb*100).toFixed(0)}%+ confidence","priority4":"SPORTS: Any game today or tomorrow is valid. ${(phase.minEdge*100).toFixed(0)}% edge is enough at ${phase.name} phase — take it","priority5":"CRYPTO: BTC/ETH at key technical levels or reacting to news = always worth checking even with macro uncertainty","avoid":"Only truly skip when ZERO information edge exists — general uncertainty alone is NOT a reason to skip","sizing":"Kelly fraction: ${(phase.kelly*100).toFixed(0)}% at ${phase.name} phase. Concentrate bets to compound toward $${_next.toFixed(0)} target"},"instructions":"1) Search web for current BTC price, ETH price, any sports scores/results today, any breaking political/economic news RIGHT NOW. 2) Search for each ticker specifically to find if market is mispriced. 3) A ${(phase.minEdge*100).toFixed(0)}-5% edge is WORTH TRADING at ${phase.name} phase — do not demand 10%+ edge. 4) If a YES is at 25c but you are ${(phase.minProb*100).toFixed(0)}% confident, that is a massive edge — take it. 5) Sports games happening today or tomorrow = always check scores and momentum. 6) Apply Kelly sizing at ${(phase.kelly*100).toFixed(0)}% fraction. 7) Output AT LEAST 1 signal if ANY edge found. Only skipReason if every single market is perfectly priced after checking.","required_json_format":{"signals":[{"ticker":"string","side":"YES or NO","confidence":0.60,"edge":0.08,"marketPrice":0.52,"reasoning":"cite specific current news or data market has NOT priced in","hoursToClose":24}],"marketSummary":"one sentence on best opportunity and how it helps reach $${_next.toFixed(0)}","skipReason":"only if truly zero edge found across ALL markets after multiple web searches"}}`;

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
        system: 'You are a JSON-only trading signal generator laser-focused on doubling a small portfolio as fast as safely possible. You have web search — use it aggressively to find breaking news, live scores, crypto prices, and any information that reveals market mispricing. Search multiple times for different tickers. Then output ONLY a valid JSON object parseable by JSON.parse(). Start with { and end with }. No markdown, no explanation, no preamble.',
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
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
    S.signals = (parsed.signals || []).map(s => ({
      ...s,
      ts: Date.now(),
      status: 'fresh',
    }));

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
  if (CFG.dryRun) return; // paper mode: skip, positions resolve automatically

  const positionList = S.openPositions.map(p => ({
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

    // Only fire brain if: enough time passed, we have open slots, markets exist,
    // AND we're past scan #1 (ensures pre-flight data is established)
    const brainReady = S.scanCount >= 2 && (Date.now() - S.lastBrainAt) >= CFG.brainInterval;
    const maxPos = dynamicMaxPos();
    const hasSlots = S.openPositions.length < maxPos;
    const hasMarkets = markets.length > 0;

    if (brainReady && hasSlots && hasMarkets) {
      // Slots open + markets available → hunt for new trades
      await runBrain(markets);
    } else if (brainReady && !hasSlots) {
      // Positions full → monitor existing ones for early exit opportunities
      log(`Brain: slots full (${S.openPositions.length}/${maxPos}) — running position monitor`);
      S.lastBrainAt = Date.now(); // reset timer so monitor doesn't spam
      await runPositionMonitor();
    } else if (brainReady && !hasMarkets) {
      log('Brain skipped — no markets available', 'WARN');
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

  tg(`📊 <b>Heartbeat — ${phase.label}</b>
${mode} | Scans: ${S.scanCount}
💰 Balance: $${(!CFG.dryRun && S.realBalance > 0 ? S.realBalance : S.balance).toFixed(2)} → Next: $${nextTarget().toFixed(2)}
${progressBar} ${progress}%
Today: ${S.todayPnl >= 0 ? '+' : ''}$${S.todayPnl.toFixed(2)} | All-time: ${S.totalPnl >= 0 ? '+' : ''}$${S.totalPnl.toFixed(2)}
Win: ${S.wins > 0 || S.losses > 0 ? `${((S.wins/(S.wins+S.losses||1))*100).toFixed(0)}%` : '—'} (${S.wins}W/${S.losses}L) | Open: ${S.openPositions.length}/${dynamicMaxPos()}
🏁 ${doublingsNeeded()} doublings to $500K | Drawdown: ${drawdown}%
Brain #${S.brainCount} | Sig age: ${sigAge}min`);
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
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>KalshiBot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#060608;--surface:#0f1014;--surface2:#161820;--surface3:#1e2028;--border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.04);
  --text:#f0f0f5;--muted:rgba(240,240,245,0.45);--muted2:rgba(240,240,245,0.22);
  --green:#00e5a0;--green-dim:rgba(0,229,160,0.12);--green-glow:rgba(0,229,160,0.25);
  --red:#ff4d6a;--red-dim:rgba(255,77,106,0.12);
  --blue:#4f8ef7;--blue-dim:rgba(79,142,247,0.12);
  --gold:#f7a520;--gold-dim:rgba(247,165,32,0.12);
  --purple:#a78bfa;--purple-dim:rgba(167,139,250,0.12);
  --font:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif;
  --mono:'DM Mono',monospace;
  --safe-top:env(safe-area-inset-top,0px);--safe-bot:env(safe-area-inset-bottom,0px);
  --r:18px;--r-sm:12px;--r-xs:8px;
}
html{background:var(--bg)}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100dvh;overflow-x:hidden;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
.app{max-width:430px;margin:0 auto;padding-bottom:calc(76px + var(--safe-bot));min-height:100dvh}

/* ── NAV ── */
.nav{position:fixed;bottom:0;left:0;right:0;background:rgba(6,6,8,0.88);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);border-top:1px solid var(--border);display:flex;padding-bottom:var(--safe-bot);z-index:200;max-width:430px;margin:0 auto;left:50%;transform:translateX(-50%);width:100%}
.nav-item{flex:1;display:flex;flex-direction:column;align-items:center;padding:10px 0 6px;cursor:pointer;color:var(--muted);transition:color 0.18s;gap:4px;position:relative}
.nav-item.active{color:var(--text)}
.nav-item.active::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:28px;height:2px;background:var(--green);border-radius:0 0 2px 2px}
.nav-icon{width:22px;height:22px;display:flex;align-items:center;justify-content:center}
.nav-label{font-size:10px;font-weight:500;letter-spacing:0.03em}

/* ── PAGES ── */
.page{display:none;animation:fadeUp 0.22s ease}.page.active{display:block}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

/* ── HOME PAGE ── */
.home-header{padding:calc(var(--safe-top) + 20px) 20px 0;display:flex;align-items:center;justify-content:space-between}
.home-greeting{font-size:13px;font-weight:500;color:var(--muted)}
.live-pill{display:flex;align-items:center;gap:5px;padding:4px 10px;background:var(--green-dim);border-radius:20px;font-size:11px;font-weight:600;color:var(--green);border:1px solid rgba(0,229,160,0.2)}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
.paper-pill{background:var(--gold-dim);color:var(--gold);border-color:rgba(247,165,32,0.2)}

/* ── HERO BALANCE ── */
.hero-section{padding:20px 20px 0;text-align:center}
.hero-label{font-size:11px;font-weight:600;color:var(--muted2);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:8px}
.hero-amount{font-size:58px;font-weight:700;letter-spacing:-3px;line-height:1;background:linear-gradient(135deg,#fff 40%,rgba(255,255,255,0.7));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero-change-wrap{display:flex;justify-content:center;margin:10px 0 14px}
.hero-change{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:600;padding:5px 14px;border-radius:20px}
.hero-change.pos{background:var(--green-dim);color:var(--green)}
.hero-change.neg{background:var(--red-dim);color:var(--red)}
.hero-change.neu{background:var(--surface2);color:var(--muted)}
.hero-meta{display:flex;justify-content:center;gap:0;background:var(--surface);border-radius:var(--r);overflow:hidden;border:1px solid var(--border);margin:0 0 0}
.hero-meta-item{flex:1;padding:12px 8px;text-align:center;border-right:1px solid var(--border)}
.hero-meta-item:last-child{border-right:none}
.hm-label{font-size:10px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px}
.hm-val{font-size:15px;font-weight:700}

/* ── CHART ── */
.chart-wrap{padding:16px 0 0;position:relative}
.chart-timeframes{display:flex;gap:2px;padding:0 20px;margin-bottom:8px}
.tf-btn{flex:1;padding:7px 0;text-align:center;font-size:12px;font-weight:600;color:var(--muted);background:none;border:none;border-radius:8px;cursor:pointer;transition:all 0.15s;font-family:var(--font)}
.tf-btn.active{background:var(--surface2);color:var(--text)}
.chart-svg-wrap{width:100%;height:170px;position:relative;overflow:hidden}
svg.main-chart{width:100%;height:170px;display:block}

/* ── STATS STRIP ── */
.stats-strip{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:14px 20px 0}
.stat-card{background:var(--surface);border-radius:var(--r-sm);padding:14px 12px;border:1px solid var(--border);display:flex;flex-direction:column;gap:5px;position:relative;overflow:hidden}
.stat-card::after{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.stat-card.green-top::after{background:linear-gradient(90deg,var(--green),transparent)}
.stat-card.red-top::after{background:linear-gradient(90deg,var(--red),transparent)}
.stat-card.blue-top::after{background:linear-gradient(90deg,var(--blue),transparent)}
.stat-label{font-size:9px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.1em}
.stat-val{font-size:20px;font-weight:700;letter-spacing:-0.5px;line-height:1}
.stat-val.green{color:var(--green)}.stat-val.red{color:var(--red)}.stat-val.gold{color:var(--gold)}.stat-val.blue{color:var(--blue)}

/* ── ACTION ROW ── */
.action-row{display:flex;gap:10px;padding:14px 20px 0}
.btn-main{flex:1;padding:16px;border-radius:var(--r-sm);border:none;font-family:var(--font);font-size:15px;font-weight:600;cursor:pointer;transition:all 0.15s;display:flex;align-items:center;justify-content:center;gap:8px;letter-spacing:-0.2px}
.btn-main:active{transform:scale(0.97);opacity:0.9}
.btn-start{background:var(--green);color:#000}
.btn-stop{background:rgba(255,77,106,0.15);color:var(--red);border:1px solid rgba(255,77,106,0.3)}
.btn-icon{background:var(--surface2);color:var(--text);flex:0;padding:16px 18px;border-radius:var(--r-sm);border:1px solid var(--border)}

/* ── CARDS ── */
.card{margin:12px 20px 0;background:var(--surface);border-radius:var(--r);border:1px solid var(--border)}
.card-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 12px}
.card-title{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em}
.card-badge{font-size:10px;font-weight:700;padding:3px 9px;border-radius:20px}
.badge-green{background:var(--green-dim);color:var(--green);border:1px solid rgba(0,229,160,0.2)}
.badge-red{background:var(--red-dim);color:var(--red)}
.badge-muted{background:var(--surface2);color:var(--muted)}
.badge-gold{background:var(--gold-dim);color:var(--gold)}

/* ── ENGINE CARD ── */
.engine-body{padding:0 16px 14px;display:flex;align-items:center;gap:12px}
.engine-dot{width:9px;height:9px;border-radius:50%;background:var(--muted2);flex-shrink:0;position:relative}
.engine-dot.running{background:var(--green);box-shadow:0 0 0 0 var(--green-glow);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 var(--green-glow)}70%{box-shadow:0 0 0 10px rgba(0,229,160,0)}100%{box-shadow:0 0 0 0 rgba(0,229,160,0)}}
.engine-info{flex:1;min-width:0}
.engine-name{font-size:15px;font-weight:600;letter-spacing:-0.2px}
.engine-sub{font-size:12px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── BRAIN CARD ── */
.brain-body{padding:0 16px 14px}
.brain-text{font-size:13px;line-height:1.55;color:rgba(240,240,245,0.8);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}

/* ── JOURNEY CARD (500K) ── */
.journey-body{padding:0 16px 16px}
.journey-phase-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.journey-phase-name{font-size:18px;font-weight:700;letter-spacing:-0.4px}
.journey-phase-desc{font-size:12px;color:var(--muted);margin-top:2px}
.journey-target-box{text-align:right}
.journey-target-label{font-size:10px;color:var(--muted2);font-weight:600;text-transform:uppercase;letter-spacing:0.08em}
.journey-target-val{font-size:20px;font-weight:700;color:var(--gold);letter-spacing:-0.5px}
.journey-progress-track{width:100%;height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;margin-bottom:8px;position:relative}
.journey-progress-fill{height:100%;background:linear-gradient(90deg,var(--green),#00ff99);border-radius:4px;transition:width 0.8s cubic-bezier(0.4,0,0.2,1);position:relative}
.journey-progress-fill::after{content:'';position:absolute;right:0;top:0;bottom:0;width:12px;background:rgba(255,255,255,0.4);border-radius:4px;filter:blur(3px)}
.journey-meta-row{display:flex;justify-content:space-between;align-items:center}
.journey-pct{font-size:13px;font-weight:600;color:var(--green)}
.journey-left{font-size:12px;color:var(--muted)}
.journey-milestones{display:flex;gap:6px;margin-top:12px;overflow-x:auto;scrollbar-width:none}
.journey-milestones::-webkit-scrollbar{display:none}
.milestone-pip{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:36px}
.pip-dot{width:10px;height:10px;border-radius:50%;background:var(--surface2);border:2px solid var(--border);transition:all 0.4s}
.pip-dot.done{background:var(--green);border-color:var(--green);box-shadow:0 0 6px var(--green-glow)}
.pip-dot.current{background:transparent;border-color:var(--gold);box-shadow:0 0 6px var(--gold-dim);animation:pipPulse 1.8s infinite}
@keyframes pipPulse{0%,100%{box-shadow:0 0 6px var(--gold-dim)}50%{box-shadow:0 0 14px rgba(247,165,32,0.5)}}
.pip-label{font-size:8px;font-weight:600;color:var(--muted2);text-align:center;font-family:var(--mono)}
.pip-label.done{color:var(--green)}
.pip-label.current{color:var(--gold)}

/* ── TRADE PAGE ── */
.page-header{padding:calc(var(--safe-top) + 18px) 20px 14px;display:flex;align-items:flex-end;justify-content:space-between}
.page-title{font-size:28px;font-weight:700;letter-spacing:-0.8px}
.page-subtitle{font-size:12px;color:var(--muted);margin-top:2px}
.section-label{padding:6px 20px 8px;font-size:11px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.12em}

/* ── POSITION CARDS ── */
.pos-card{background:var(--surface);border-radius:var(--r-sm);margin:0 20px 8px;padding:14px;border:1px solid var(--border);display:flex;align-items:center;gap:12px;transition:border-color 0.15s}
.pos-card:active{border-color:rgba(255,255,255,0.12)}
.pos-icon-wrap{width:40px;height:40px;border-radius:10px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;border:1px solid var(--border)}
.pos-info{flex:1;min-width:0}
.pos-ticker{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--mono);color:var(--text)}
.pos-meta{display:flex;align-items:center;gap:6px;margin-top:4px}
.side-chip{padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;letter-spacing:0.04em}
.chip-yes{background:var(--green-dim);color:var(--green)}
.chip-no{background:var(--red-dim);color:var(--red)}
.pos-contracts{font-size:11px;color:var(--muted)}
.pos-right{text-align:right;flex-shrink:0}
.pos-price-tag{font-size:17px;font-weight:700;letter-spacing:-0.3px}
.pos-cost{font-size:11px;color:var(--muted);margin-top:2px}
.pos-pnl{font-size:11px;font-weight:600;margin-top:2px}
.pnl-pos{color:var(--green)}.pnl-neg{color:var(--red)}.pnl-zero{color:var(--muted)}

/* ── SIGNAL CARDS ── */
.sig-card{background:var(--surface);border-radius:var(--r-sm);margin:0 20px 8px;padding:14px;border:1px solid var(--border);border-left:3px solid var(--green)}
.sig-card.sig-no{border-left-color:var(--red)}
.sig-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px}
.sig-ticker{font-size:14px;font-weight:700;font-family:var(--mono)}
.sig-side-chip{padding:3px 9px;border-radius:6px;font-size:10px;font-weight:700}
.sig-reason{font-size:12px;color:var(--muted);line-height:1.45;margin-bottom:8px}
.sig-stats{display:flex;gap:10px;flex-wrap:wrap}
.sig-stat{font-size:11px;color:var(--muted2)}
.sig-stat strong{color:var(--text);font-weight:600}

/* ── WL CHART ── */
.wl-wrap{margin:0 20px 8px;background:var(--surface);border-radius:var(--r-sm);padding:14px;border:1px solid var(--border)}
.wl-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.wl-title{font-size:11px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.1em}
.wl-score{font-size:13px;font-weight:700}
.wl-bars{display:flex;align-items:flex-end;gap:3px;height:56px}
.wl-bar{flex:1;border-radius:3px 3px 0 0;min-height:4px;transition:height 0.4s}
.wl-bar.wl-win{background:var(--green);opacity:0.8}
.wl-bar.wl-loss{background:var(--red);opacity:0.8}
.wl-bar.wl-empty{background:var(--surface2)}

/* ── ACTIVITY ── */
.activity-wrap{padding:calc(var(--safe-top) + 18px) 0 0}
.filter-row{display:flex;gap:8px;padding:0 20px 14px;overflow-x:auto;scrollbar-width:none}
.filter-row::-webkit-scrollbar{display:none}
.filter-chip{display:flex;align-items:center;gap:5px;padding:7px 14px;border-radius:20px;background:var(--surface2);font-size:13px;font-weight:500;color:var(--muted);white-space:nowrap;cursor:pointer;border:1px solid transparent;font-family:var(--font);transition:all 0.15s}
.filter-chip.active{background:rgba(255,255,255,0.08);color:var(--text);border-color:var(--border)}
.tx-month{padding:6px 20px 4px;font-size:13px;font-weight:600;color:var(--muted)}
.tx-row{display:flex;align-items:center;padding:13px 20px;gap:12px;cursor:pointer;transition:background 0.1s}
.tx-row:active{background:rgba(255,255,255,0.03)}
.tx-icon{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:15px;font-weight:700}
.tx-icon-win{background:var(--green-dim);color:var(--green)}
.tx-icon-loss{background:var(--red-dim);color:var(--red)}
.tx-icon-trade{background:var(--blue-dim);color:var(--blue)}
.tx-content{flex:1;min-width:0}
.tx-title{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tx-sub{font-size:12px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tx-right{text-align:right;flex-shrink:0}
.tx-amount{font-size:15px;font-weight:700}
.tx-amount-pos{color:var(--green)}.tx-amount-neg{color:var(--red)}.tx-amount-zero{color:var(--muted)}
.tx-time{font-size:11px;color:var(--muted2);margin-top:2px}
.tx-sep{height:1px;background:var(--border2);margin:0 20px}
.empty-state{text-align:center;padding:40px 20px;color:var(--muted);font-size:14px}

/* ── PREDICT PAGE ── */
.mkt-card{background:var(--surface);border-radius:var(--r-sm);margin:0 20px 8px;padding:14px;border:1px solid var(--border)}
.mkt-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px}
.mkt-title{font-size:13px;font-weight:600;line-height:1.35;flex:1}
.mkt-exp{font-size:11px;color:var(--muted);flex-shrink:0;padding-top:2px;text-align:right}
.mkt-exp.soon{color:var(--gold)}
.mkt-prices-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.mkt-yes-price{font-size:22px;font-weight:700;color:var(--green)}
.mkt-no-price{font-size:14px;font-weight:600;color:var(--red);text-align:right}
.mkt-vol{font-size:11px;color:var(--muted2);margin-top:1px;text-align:right}
.mkt-track{height:5px;background:rgba(255,77,106,0.2);border-radius:3px;overflow:hidden}
.mkt-fill{height:100%;background:var(--green);border-radius:3px;transition:width 0.4s}
.edge-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;margin-top:8px}
.edge-high{background:var(--green-dim);color:var(--green)}
.edge-med{background:var(--gold-dim);color:var(--gold)}

/* ── SETTINGS PAGE ── */
.settings-wrap{padding:calc(var(--safe-top) + 18px) 20px 0}
.settings-title{font-size:28px;font-weight:700;letter-spacing:-0.8px;margin-bottom:20px}
.settings-section{margin-bottom:18px}
.settings-section-label{font-size:11px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.12em;margin-bottom:8px;padding:0 4px}
.settings-group{background:var(--surface);border-radius:var(--r);overflow:hidden;border:1px solid var(--border)}
.settings-row{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border2)}
.settings-row:last-child{border-bottom:none}
.settings-row-name{font-size:15px;font-weight:500;letter-spacing:-0.2px}
.settings-row-sub{font-size:11px;color:var(--muted);margin-top:2px}
.settings-val{font-size:14px;font-weight:600;color:var(--muted)}
.val-green{color:var(--green)}.val-red{color:var(--red)}.val-gold{color:var(--gold)}
.phase-block{padding:14px 16px;border-bottom:1px solid var(--border2)}
.phase-title-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.phase-name-big{font-size:18px;font-weight:700;letter-spacing:-0.4px}
.phase-desc{font-size:12px;color:var(--muted);line-height:1.4;margin-bottom:12px}
.phase-track{height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;margin-bottom:6px}
.phase-fill{height:100%;background:linear-gradient(90deg,var(--green),#00ff99);border-radius:4px;transition:width 0.8s ease}
.phase-track-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--muted)}
.log-wrap{background:var(--surface);border-radius:var(--r);padding:14px;border:1px solid var(--border);max-height:240px;overflow-y:auto;font-family:var(--mono);font-size:11px;color:rgba(240,240,245,0.5);line-height:1.65}
.log-ts{color:var(--muted2);margin-right:6px}
.log-entry{padding:1px 0}
.log-entry.err{color:rgba(255,77,106,0.7)}
.log-entry.warn{color:rgba(247,165,32,0.7)}

/* ── DRAWDOWN METER ── */
.dd-meter-wrap{padding:0 16px 14px}
.dd-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.dd-label{font-size:11px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:0.08em}
.dd-pct{font-size:13px;font-weight:700}
.dd-track{height:6px;background:var(--surface2);border-radius:3px;overflow:hidden}
.dd-fill{height:100%;background:linear-gradient(90deg,var(--green),var(--gold),var(--red));border-radius:3px;transition:width 0.8s}

.section-gap{height:12px}
</style>
</head>
<body>
<div class="app">

  <!-- ── HOME ── -->
  <div id="page-home" class="page active">

    <div class="home-header">
      <div class="home-greeting">KalshiBot</div>
      <div id="modePill" class="live-pill paper-pill">
        <div class="live-dot" style="background:var(--gold)"></div>
        <span id="modeText">PAPER</span>
      </div>
    </div>

    <div class="hero-section">
      <div class="hero-label">Portfolio Value</div>
      <div class="hero-amount" id="heroBalance">$—</div>
      <div class="hero-change-wrap">
        <div class="hero-change neu" id="heroChange">
          <span id="heroChangeArr">↑</span>
          <span id="heroChangeText">loading…</span>
        </div>
      </div>
      <div class="hero-meta">
        <div class="hero-meta-item">
          <div class="hm-label">Real</div>
          <div class="hm-val" id="heroReal">$—</div>
        </div>
        <div class="hero-meta-item">
          <div class="hm-label">Peak</div>
          <div class="hm-val" id="heroPeak">$—</div>
        </div>
        <div class="hero-meta-item">
          <div class="hm-label">All-time</div>
          <div class="hm-val" id="heroTotal" style="color:var(--green)">$—</div>
        </div>
      </div>
    </div>

    <div class="chart-wrap">
      <div class="chart-timeframes">
        <button class="tf-btn" onclick="setTF('1H',this)">1H</button>
        <button class="tf-btn active" onclick="setTF('1D',this)">1D</button>
        <button class="tf-btn" onclick="setTF('1W',this)">1W</button>
        <button class="tf-btn" onclick="setTF('ALL',this)">ALL</button>
      </div>
      <div class="chart-svg-wrap">
        <svg class="main-chart" id="mainChart" viewBox="0 0 430 170" preserveAspectRatio="none"></svg>
      </div>
    </div>

    <div class="stats-strip">
      <div class="stat-card green-top">
        <div class="stat-label">Win Rate</div>
        <div class="stat-val green" id="statWR">—</div>
      </div>
      <div class="stat-card" id="statTodayCard">
        <div class="stat-label">Today P&L</div>
        <div class="stat-val" id="statToday">$0.00</div>
      </div>
      <div class="stat-card blue-top">
        <div class="stat-label">Positions</div>
        <div class="stat-val" id="statPos">0</div>
      </div>
    </div>

    <div class="action-row">
      <button class="btn-main btn-start" id="startBtn" onclick="toggleBot()">▶ Start</button>
      <button class="btn-main btn-stop" id="stopBtn" onclick="toggleBot()" style="display:none">■ Stop</button>
      <button class="btn-main btn-icon" onclick="loadState()">↻</button>
    </div>

    <!-- Engine Status -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">Trading Engine</div>
        <div class="card-badge badge-muted" id="modeBadge">PAPER</div>
      </div>
      <div class="engine-body">
        <div class="engine-dot" id="engineDot"></div>
        <div class="engine-info">
          <div class="engine-name" id="engineName">Stopped</div>
          <div class="engine-sub" id="engineSub">Tap Start to begin trading</div>
        </div>
      </div>
    </div>

    <!-- Journey to $500K -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">🏁 Road to $500K</div>
        <div class="card-badge badge-gold" id="homePhaseLabel">—</div>
      </div>
      <div class="journey-body">
        <div class="journey-phase-row">
          <div>
            <div class="journey-phase-name" id="journeyPhaseName">—</div>
            <div class="journey-phase-desc" id="journeyPhaseDesc">—</div>
          </div>
          <div class="journey-target-box">
            <div class="journey-target-label">Next target</div>
            <div class="journey-target-val" id="homeNextTarget">$—</div>
          </div>
        </div>
        <div class="journey-progress-track">
          <div class="journey-progress-fill" id="homeProgressBar" style="width:0%"></div>
        </div>
        <div class="journey-meta-row">
          <div class="journey-pct" id="homeProgressPct">0%</div>
          <div class="journey-left" id="homeDoublingsLeft">— doublings to $500K</div>
        </div>
        <!-- Doubling milestone pips -->
        <div class="journey-milestones" id="milestonePips"></div>
      </div>
    </div>

    <!-- AI Brain -->
    <div class="card" style="margin-bottom:0">
      <div class="card-header">
        <div class="card-title">AI Brain · Web Search</div>
        <div class="card-badge badge-muted" id="brainCount">Signal #—</div>
      </div>
      <div class="brain-body">
        <div class="brain-text" id="brainText">Waiting for first signal…</div>
      </div>
    </div>

    <div class="section-gap"></div>
  </div>

  <!-- ── TRADE ── -->
  <div id="page-trade" class="page">
    <div class="page-header">
      <div>
        <div class="page-title">Positions</div>
        <div class="page-subtitle" id="tradeSubtitle">0 open</div>
      </div>
    </div>

    <div id="positionsList"><div class="empty-state">No open positions</div></div>

    <div class="section-label">Recent Signals</div>
    <div id="signalsList"><div class="empty-state" style="padding:16px 20px">No signals yet</div></div>

    <div class="section-label">Win / Loss · 24h</div>
    <div class="wl-wrap">
      <div class="wl-header">
        <div class="wl-title">Trade Outcomes</div>
        <div class="wl-score" id="wlSummary">—W / —L</div>
      </div>
      <div class="wl-bars" id="wlBars"></div>
    </div>
    <div class="section-gap"></div>
  </div>

  <!-- ── ACTIVITY ── -->
  <div id="page-activity" class="page">
    <div class="activity-wrap">
      <div class="page-header">
        <div class="page-title">Activity</div>
      </div>
      <div class="filter-row">
        <button class="filter-chip active" onclick="filterTx('all',this)">⊞ All</button>
        <button class="filter-chip" onclick="filterTx('win',this)">✓ Wins</button>
        <button class="filter-chip" onclick="filterTx('loss',this)">✗ Losses</button>
        <button class="filter-chip" onclick="filterTx('trade',this)">↕ Open</button>
      </div>
      <div id="txFeed"></div>
    </div>
  </div>

  <!-- ── PREDICT / MARKETS ── -->
  <div id="page-predict" class="page">
    <div class="page-header">
      <div>
        <div class="page-title">Markets</div>
        <div class="page-subtitle">Ranked by edge · Short-duration priority</div>
      </div>
    </div>
    <div id="marketsList"><div class="empty-state">Loading…</div></div>
    <div class="section-gap"></div>
  </div>

  <!-- ── SETTINGS ── -->
  <div id="page-settings" class="page">
    <div class="settings-wrap">
      <div class="settings-title">Settings</div>

      <!-- Journey -->
      <div class="settings-section">
        <div class="settings-section-label">🏁 Journey to $500K</div>
        <div class="settings-group">
          <div class="phase-block">
            <div class="phase-title-row">
              <div class="phase-name-big" id="cfgPhase">—</div>
              <div class="settings-val val-gold" id="cfgProgressPct">0%</div>
            </div>
            <div class="phase-desc" id="cfgPhaseDesc">—</div>
            <div class="phase-track">
              <div class="phase-fill" id="cfgProgressBar" style="width:0%"></div>
            </div>
            <div class="phase-track-labels">
              <span id="cfgCurBal">$—</span>
              <span id="cfgNextTarget">→ $—</span>
            </div>
          </div>
          <div class="settings-row"><div><div class="settings-row-name">Doublings Completed</div></div><div class="settings-val val-green" id="cfgDoublings">—</div></div>
          <div class="settings-row"><div><div class="settings-row-name">Doublings Left to $500K</div></div><div class="settings-val" id="cfgNeeded">—</div></div>
          <div class="settings-row"><div><div class="settings-row-name">Starting Bankroll</div></div><div class="settings-val" id="cfgBankroll">$—</div></div>
        </div>
      </div>

      <!-- Portfolio -->
      <div class="settings-section">
        <div class="settings-section-label">Portfolio</div>
        <div class="settings-group">
          <div class="settings-row"><div><div class="settings-row-name">Real Balance</div></div><div class="settings-val val-green" id="cfgReal">$—</div></div>
          <div class="settings-row"><div><div class="settings-row-name">Available Cash</div></div><div class="settings-val val-green" id="cfgAvail">$—</div></div>
          <div class="settings-row"><div><div class="settings-row-name">All-time P&L</div></div><div class="settings-val" id="cfgTotalPnl">$0.00</div></div>
          <div class="settings-row"><div><div class="settings-row-name">Today P&L</div></div><div class="settings-val" id="cfgTodayPnl">$0.00</div></div>
          <div class="settings-row"><div><div class="settings-row-name">Peak Balance</div></div><div class="settings-val" id="cfgPeak">$—</div></div>
          <div>
            <div class="settings-row" style="border-bottom:none;padding-bottom:6px"><div><div class="settings-row-name">Drawdown from Peak</div></div><div class="settings-val val-red" id="cfgDD">0%</div></div>
            <div class="dd-meter-wrap">
              <div class="dd-track"><div class="dd-fill" id="cfgDDFill" style="width:0%"></div></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Bot Config -->
      <div class="settings-section">
        <div class="settings-section-label">Bot Configuration</div>
        <div class="settings-group">
          <div class="settings-row"><div><div class="settings-row-name">Mode</div></div><div class="settings-val" id="cfgMode">—</div></div>
          <div class="settings-row"><div><div class="settings-row-name">Current Phase</div><div class="settings-row-sub">Kelly · Edge · Prob thresholds</div></div><div class="settings-val val-green" id="cfgPhaseShort">—</div></div>
          <div class="settings-row"><div><div class="settings-row-name">Max Positions</div></div><div class="settings-val" id="cfgMaxPos">—</div></div>
          <div class="settings-row"><div><div class="settings-row-name">Brain Interval</div></div><div class="settings-val" id="cfgBrainInt">—</div></div>
          <div class="settings-row"><div><div class="settings-row-name">Total Scans</div></div><div class="settings-val" id="cfgScans">—</div></div>
          <div class="settings-row"><div><div class="settings-row-name">Win / Loss Record</div></div><div class="settings-val val-green" id="cfgWL">—</div></div>
        </div>
      </div>

      <!-- Live Log -->
      <div class="settings-section">
        <div class="settings-section-label">Live Log</div>
        <div class="log-wrap" id="logWrap"><span style="color:var(--muted2)">Loading…</span></div>
      </div>
      <div class="section-gap"></div>
    </div>
  </div>

  <!-- ── BOTTOM NAV ── -->
  <nav class="nav">
    <div class="nav-item active" onclick="goPage('home',this)">
      <div class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 12L5 10M5 10L12 3L19 10M5 10V20C5 20.6 5.4 21 6 21H9M19 10L21 12M19 10V20C19 20.6 18.6 21 18 21H15M9 21V15C9 14.4 9.4 14 10 14H14C14.6 14 15 14.4 15 15V21M9 21H15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="nav-label">Home</div>
    </div>
    <div class="nav-item" onclick="goPage('trade',this)">
      <div class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><polyline points="16 7 22 7 22 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="nav-label">Trade</div>
    </div>
    <div class="nav-item" onclick="goPage('activity',this)">
      <div class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.8"/><line x1="8" y1="9" x2="16" y2="9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="8" y1="13" x2="16" y2="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="8" y1="17" x2="12" y2="17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
      <div class="nav-label">Activity</div>
    </div>
    <div class="nav-item" onclick="goPage('predict',this)">
      <div class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z" stroke="currentColor" stroke-width="1.8"/><path d="M2 12h4M18 12h4M12 2v4M12 18v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
      <div class="nav-label">Predict</div>
    </div>
    <div class="nav-item" onclick="goPage('settings',this)">
      <div class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="1.8"/></svg></div>
      <div class="nav-label">Settings</div>
    </div>
  </nav>
</div>

<script>
const API='';
const POLL=12000;
let state=null;
let chartData=[];
let allTx=[];
let currentTF='1D';

// ── NAV ──
function goPage(id,el){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  el.classList.add('active');
  if(id==='activity') renderTxFeed(allTx,'all');
  if(id==='predict') renderMarkets();
}

// ── CHART ──
function setTF(tf,el){
  currentTF=tf;
  document.querySelectorAll('.tf-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  drawChart();
}
function pushChartPoint(val){
  chartData.push({t:Date.now(),v:val});
  if(chartData.length>600) chartData.shift();
  drawChart();
}
function drawChart(){
  const svg=document.getElementById('mainChart');
  if(chartData.length<2){svg.innerHTML='';return;}
  const now=Date.now();
  const cuts={'1H':3600000,'1D':86400000,'1W':604800000,'ALL':Infinity};
  const cut=cuts[currentTF]||Infinity;
  const d=chartData.filter(p=>now-p.t<cut);
  const data=d.length>1?d:chartData;
  if(data.length<2){svg.innerHTML='';return;}
  const W=430,H=170,pad=10;
  const vals=data.map(p=>p.v);
  const mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||0.01;
  const tx=i=>pad+(i/(data.length-1))*(W-pad*2);
  const ty=v=>H-pad-((v-mn)/rng)*(H-pad*2-16);
  const isUp=data[data.length-1].v>=data[0].v;
  const col=isUp?'#00e5a0':'#ff4d6a';
  const areaD='M '+pad+','+(H+4)+' L '+pad+','+ty(data[0].v)+' '+data.map((p,i)=>'L '+tx(i)+','+ty(p.v)).join(' ')+' L '+(W-pad)+','+(H+4)+' Z';
  const lineD='M '+data.map((p,i)=>tx(i)+','+ty(p.v)).join(' L ');
  const lastX=tx(data.length-1),lastY=ty(data[data.length-1].v);
  svg.innerHTML='<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+col+'" stop-opacity="0.2"/><stop offset="85%" stop-color="'+col+'" stop-opacity="0"/></linearGradient></defs><path d="'+areaD+'" fill="url(#cg)"/><path d="'+lineD+'" fill="none" stroke="'+col+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="'+lastX+'" cy="'+lastY+'" r="4.5" fill="'+col+'" opacity="0.9"/><circle cx="'+lastX+'" cy="'+lastY+'" r="8" fill="'+col+'" opacity="0.15"/>';
}

// ── WL BARS ──
function renderWLBars(trades){
  const wrap=document.getElementById('wlBars');
  const now=Date.now();
  const buckets=Array(24).fill(null).map(()=>({w:0,l:0}));
  (trades||[]).forEach(t=>{
    const hr=Math.floor((now-(t.resolvedAt||t.openedAt||now))/3600000);
    if(hr<24){const b=buckets[23-hr];if(t.won||t.pnl>0)b.w++;else b.l++;}
  });
  const mx=Math.max(...buckets.map(b=>b.w+b.l),1);
  wrap.innerHTML=buckets.map(b=>{
    if(!b.w&&!b.l) return '<div class="wl-bar wl-empty" style="height:6px"></div>';
    const h=Math.max(8,((b.w+b.l)/mx)*52);
    return '<div class="wl-bar '+(b.w>=b.l?'wl-win':'wl-loss')+'" style="height:'+h+'px"></div>';
  }).join('');
  const wins=(trades||[]).filter(t=>t.won||t.pnl>0).length;
  const losses=(trades||[]).filter(t=>!t.won&&t.pnl<=0).length;
  const wlEl=document.getElementById('wlSummary');
  wlEl.textContent=wins+'W / '+losses+'L';
  wlEl.style.color=wins>=losses?'var(--green)':'var(--red)';
}

// ── POSITIONS ──
function renderPositions(positions){
  const wrap=document.getElementById('positionsList');
  const sub=document.getElementById('tradeSubtitle');
  if(!positions||!positions.length){wrap.innerHTML='<div class="empty-state">No open positions</div>';if(sub)sub.textContent='0 open';return;}
  if(sub)sub.textContent=positions.length+' open';
  const icons={BTC:'₿',ETH:'Ξ',NBA:'🏀',NFL:'🏈',NBA:'🏀',CPI:'📊',FED:'🏛'};
  function iconFor(t){const k=Object.keys(icons).find(k=>t.includes(k));return k?icons[k]:'📈';}
  wrap.innerHTML=positions.map(p=>{
    const isYes=(p.side||'YES').toUpperCase()==='YES';
    const pnl=p.pnl||0;
    const cost=p.cost||((p.entryPrice||50)*p.contracts/100);
    const hoursOpen=p.openedAt?Math.round((Date.now()-p.openedAt)/3600000):0;
    return '<div class="pos-card">' +
      '<div class="pos-icon-wrap">'+iconFor(p.ticker)+'</div>' +
      '<div class="pos-info">' +
        '<div class="pos-ticker">'+p.ticker+'</div>' +
        '<div class="pos-meta">' +
          '<span class="side-chip '+(isYes?'chip-yes':'chip-no')+'">'+(isYes?'YES':'NO')+'</span>' +
          '<span class="pos-contracts">'+(p.contracts||1)+' contract'+(p.contracts>1?'s':'')+' · '+hoursOpen+'h open</span>' +
        '</div>' +
      '</div>' +
      '<div class="pos-right">' +
        '<div class="pos-price-tag">'+(p.entryPrice||50)+'¢</div>' +
        '<div class="pos-cost">Cost $'+cost.toFixed(2)+'</div>' +
        '<div class="pos-pnl '+(pnl>0?'pnl-pos':pnl<0?'pnl-neg':'pnl-zero')+'">'+(pnl>=0?'+':'')+'$'+Math.abs(pnl).toFixed(2)+'</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── SIGNALS ──
function renderSignals(signals){
  const wrap=document.getElementById('signalsList');
  if(!signals||!signals.length){wrap.innerHTML='<div class="empty-state" style="padding:16px 20px">No signals yet</div>';return;}
  wrap.innerHTML=signals.slice(0,5).map(s=>{
    const isYes=(s.side||'YES').toUpperCase()==='YES';
    const col=isYes?'#00e5a0':'#ff4d6a';
    return '<div class="sig-card '+(isYes?'':'sig-no')+'">' +
      '<div class="sig-top">' +
        '<div class="sig-ticker">'+s.ticker+'</div>' +
        '<span class="sig-side-chip '+(isYes?'chip-yes':'chip-no')+'">'+s.side+'</span>' +
      '</div>' +
      '<div class="sig-reason">'+(s.reasoning||'—')+'</div>' +
      '<div class="sig-stats">' +
        '<div class="sig-stat">Conf <strong>'+Math.round((s.confidence||0)*100)+'%</strong></div>' +
        '<div class="sig-stat">Edge <strong>'+Math.round((s.edge||0)*100)+'%</strong></div>' +
        '<div class="sig-stat">Size <strong>$'+(s.kellySize||0).toFixed(2)+'</strong></div>' +
        (s.hoursToClose?'<div class="sig-stat">Closes <strong>'+s.hoursToClose+'h</strong></div>':'') +
      '</div>' +
    '</div>';
  }).join('');
}

// ── TX FEED ──
function buildTxFromTrades(trades){
  return (trades||[]).map(t=>({
    type:t.status==='open'?'trade':(t.won?'win':'loss'),
    ticker:t.ticker||'—',
    pnl:t.pnl||0,
    cost:t.cost||0,
    ts:t.resolvedAt||t.openedAt||Date.now(),
    side:t.side||'YES',
    contracts:t.contracts||1,
    won:t.won,
    status:t.status
  }));
}
let txFilter='all';
function renderTxFeed(txList,filter){
  txFilter=filter||txFilter;
  const wrap=document.getElementById('txFeed');
  let fl=txList;
  if(txFilter==='win') fl=txList.filter(t=>t.type==='win');
  else if(txFilter==='loss') fl=txList.filter(t=>t.type==='loss');
  else if(txFilter==='trade') fl=txList.filter(t=>t.type==='trade');
  if(!fl.length){wrap.innerHTML='<div class="empty-state">No transactions yet</div>';return;}
  const groups={};
  fl.forEach(tx=>{
    const k=new Date(tx.ts).toLocaleString('en-US',{month:'long',year:'numeric'});
    if(!groups[k]) groups[k]=[];
    groups[k].push(tx);
  });
  const icons={BTC:'₿',ETH:'Ξ',NBA:'🏀',NFL:'🏈',CPI:'📊',FED:'🏛'};
  function iconFor(t){const k=Object.keys(icons).find(k=>t.includes(k));return k?icons[k]:'📈';}
  wrap.innerHTML=Object.entries(groups).map(([month,txs])=>
    '<div class="tx-month">'+month+'</div>'+
    txs.map((tx,i)=>{
      const typeLabel=tx.type==='win'?'Win':tx.type==='loss'?'Loss':'Trade';
      const iconClass='tx-icon-'+tx.type;
      const icon=tx.type==='win'?'✓':tx.type==='loss'?'✗':iconFor(tx.ticker);
      const pnlClass=tx.pnl>0?'tx-amount-pos':tx.pnl<0?'tx-amount-neg':'tx-amount-zero';
      const pnlStr=tx.pnl===0?('−$'+Math.abs(tx.cost).toFixed(2)):(tx.pnl>0?'+':'')+'$'+Math.abs(tx.pnl).toFixed(2);
      return (
        '<div class="tx-row">'+
          '<div class="tx-icon '+iconClass+'">'+icon+'</div>'+
          '<div class="tx-content">'+
            '<div class="tx-title">'+typeLabel+' · '+tx.ticker+'</div>'+
            '<div class="tx-sub">'+tx.side+' · '+(tx.contracts||1)+' contract · '+new Date(tx.ts).toLocaleDateString('en-US',{month:'short',day:'numeric'})+'</div>'+
          '</div>'+
          '<div class="tx-right">'+
            '<div class="tx-amount '+pnlClass+'">'+pnlStr+'</div>'+
            '<div class="tx-time">'+new Date(tx.ts).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})+'</div>'+
          '</div>'+
        '</div>'+
        (i<txs.length-1?'<div class="tx-sep"></div>':'')
      );
    }).join('')
  ).join('');
}
function filterTx(type,el){
  document.querySelectorAll('.filter-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  renderTxFeed(allTx,type);
}

// ── MARKETS ──
function renderMarkets(){
  const wrap=document.getElementById('marketsList');
  if(!state||!state.topMarkets||!state.topMarkets.length){wrap.innerHTML='<div class="empty-state">No markets loaded</div>';return;}
  wrap.innerHTML=state.topMarkets.slice(0,15).map(m=>{
    const yp=Math.round((m.yesAsk||0)*100);
    const np=100-yp;
    const hl=m.hoursLeft||999;
    const soon=hl<24;
    const edge=m.edge||0;
    const edgeClass=edge>0.08?'edge-high':'edge-med';
    const edgeLabel=edge>0?'Edge '+(edge*100).toFixed(0)+'%':'';
    return '<div class="mkt-card">'+
      '<div class="mkt-top">'+
        '<div class="mkt-title">'+(m.title||m.ticker)+'</div>'+
        '<div class="mkt-exp'+(soon?' soon':'')+'">⏱ '+(hl<999?(hl<1?'<1h':hl.toFixed(0)+'h'):'—')+'</div>'+
      '</div>'+
      '<div class="mkt-prices-row">'+
        '<div class="mkt-yes-price">'+yp+'¢ YES</div>'+
        '<div><div class="mkt-no-price">'+np+'¢ NO</div><div class="mkt-vol">vol '+(m.volume||0).toLocaleString()+'</div></div>'+
      '</div>'+
      '<div class="mkt-track"><div class="mkt-fill" style="width:'+yp+'%"></div></div>'+
      (edgeLabel?'<span class="edge-badge '+edgeClass+'">⚡ '+edgeLabel+'</span>':'')+
    '</div>';
  }).join('');
}

// ── MILESTONE PIPS ──
function renderMilestonePips(doublingsMade,doublingsNeeded,bankroll){
  const wrap=document.getElementById('milestonePips');
  if(!wrap) return;
  const total=Math.max(doublingsMade+(doublingsNeeded||16),1);
  const show=Math.min(total,16);
  let html='';
  for(let i=0;i<show;i++){
    const amt=bankroll*Math.pow(2,i+1);
    const label=amt>=1000?'$'+(amt/1000).toFixed(0)+'K':'$'+amt.toFixed(0);
    const done=i<doublingsMade;
    const current=i===doublingsMade;
    html+='<div class="milestone-pip">'+
      '<div class="pip-dot '+(done?'done':current?'current':'')+'"></div>'+
      '<div class="pip-label '+(done?'done':current?'current':'')+'">'+label+'</div>'+
    '</div>';
  }
  wrap.innerHTML=html;
}

// ── MAIN STATE ──
async function loadState(){
  try{
    const r=await fetch(API+'/api/state');
    const s=await r.json();
    state=s;
    applyState(s);
  }catch(e){console.error(e);}
}

function applyState(s){
  const real=s.realBalance||0;
  const bal=real>0?real:(s.balance||0);
  const avail=s.availableCash||0;
  const today=s.todayPnl||0;
  const total=s.totalPnl||0;
  const peak=s.peakBalance||bal;
  const w=s.wins||0,l=s.losses||0;

  // ── HERO ──
  document.getElementById('heroBalance').textContent='$'+bal.toFixed(2);
  document.getElementById('heroReal').textContent='$'+real.toFixed(2);
  document.getElementById('heroPeak').textContent='$'+peak.toFixed(2);
  const totEl=document.getElementById('heroTotal');
  totEl.textContent=(total>=0?'+':'')+'$'+Math.abs(total).toFixed(2);
  totEl.style.color=total>=0?'var(--green)':'var(--red)';

  const hc=document.getElementById('heroChange');
  const absToday=Math.abs(today).toFixed(2);
  document.getElementById('heroChangeArr').textContent=today>=0?'▲':'▼';
  document.getElementById('heroChangeText').textContent=(today>=0?'+':'-')+'$'+absToday+' today';
  hc.className='hero-change '+(today>0?'pos':today<0?'neg':'neu');

  pushChartPoint(bal);

  // ── MODE PILL ──
  const dryRun=s.dryRun!==false;
  const pill=document.getElementById('modePill');
  const modeText=document.getElementById('modeText');
  if(dryRun){
    pill.className='live-pill paper-pill';
    pill.querySelector('.live-dot').style.background='var(--gold)';
    modeText.textContent='PAPER';
  } else {
    pill.className='live-pill';
    pill.querySelector('.live-dot').style.background='var(--green)';
    modeText.textContent='LIVE';
  }

  // ── STATS ──
  const wrEl=document.getElementById('statWR');
  const wr=w+l>0?Math.round(w/(w+l)*100):null;
  wrEl.textContent=wr!==null?wr+'%':'—';
  wrEl.className='stat-val '+(wr>=60?'green':wr>=50?'gold':wr!==null?'red':'green');
  const td=document.getElementById('statToday');
  td.textContent=(today>=0?'+':'')+'$'+Math.abs(today).toFixed(2);
  td.className='stat-val '+(today>0?'green':today<0?'red':'');
  const todayCard=document.getElementById('statTodayCard');
  if(todayCard) todayCard.className='stat-card '+(today>0?'green-top':today<0?'red-top':'');
  const mp=s.maxPos||5;
  const openCnt=(s.openPositions||[]).length;
  document.getElementById('statPos').textContent=openCnt+'/'+mp;

  // ── ENGINE ──
  const running=s.isRunning;
  document.getElementById('engineDot').className='engine-dot'+(running?' running':'');
  document.getElementById('engineName').textContent=running?'Engine Running':'Engine Stopped';
  document.getElementById('engineSub').textContent=running?
    'Scan #'+(s.scanCount||0)+' · '+openCnt+' open · $'+avail.toFixed(2)+' avail':
    'Tap Start to begin trading';
  document.getElementById('startBtn').style.display=running?'none':'flex';
  document.getElementById('stopBtn').style.display=running?'flex':'none';
  const badge=document.getElementById('modeBadge');
  badge.textContent=dryRun?'PAPER':'LIVE';
  badge.className='card-badge '+(dryRun?'badge-gold':'badge-green');

  // ── BRAIN ──
  const sig0=s.signals&&s.signals[0];
  if(sig0) document.getElementById('brainText').textContent=sig0.reasoning||'Analyzing markets…';
  else if(s.lastBrainReason) document.getElementById('brainText').textContent=s.lastBrainReason;
  document.getElementById('brainCount').textContent='Signal #'+(s.brainCount||0);

  // ── JOURNEY ──
  if(s.phaseLabel){
    document.getElementById('homePhaseLabel').textContent=s.phaseLabel;
    document.getElementById('journeyPhaseName').textContent=s.phaseLabel;
    document.getElementById('journeyPhaseDesc').textContent=s.phaseDesc||'';
    const nextT=parseFloat(s.nextTarget||0);
    document.getElementById('homeNextTarget').textContent='$'+nextT.toLocaleString('en-US',{maximumFractionDigits:0});
    const pct=parseFloat(s.doublingProgress||0);
    document.getElementById('homeProgressBar').style.width=Math.min(100,pct)+'%';
    document.getElementById('homeProgressPct').textContent=pct.toFixed(1)+'%';
    document.getElementById('homeDoublingsLeft').textContent=(s.doublingsNeeded||'?')+' doublings left to $500K';
    // Render milestones
    renderMilestonePips(s.doublingsMade||0,s.doublingsNeeded||16,50);
  }

  // ── TRADE TAB ──
  renderPositions(s.openPositions||[]);
  renderSignals(s.signals||[]);
  renderWLBars(s.trades||[]);

  // ── ACTIVITY ──
  allTx=buildTxFromTrades(s.trades||[]);

  // ── MARKETS ──
  renderMarkets();

  // ── SETTINGS ──
  document.getElementById('cfgReal').textContent='$'+real.toFixed(2);
  document.getElementById('cfgAvail').textContent='$'+avail.toFixed(2);
  const tpEl=document.getElementById('cfgTotalPnl');
  tpEl.textContent=(total>=0?'+':'')+'$'+Math.abs(total).toFixed(2);
  tpEl.className='settings-val '+(total>=0?'val-green':'val-red');
  const todayPnlEl=document.getElementById('cfgTodayPnl');
  todayPnlEl.textContent=(today>=0?'+':'')+'$'+Math.abs(today).toFixed(2);
  todayPnlEl.className='settings-val '+(today>=0?'val-green':'val-red');
  document.getElementById('cfgPeak').textContent='$'+peak.toFixed(2);
  document.getElementById('cfgMode').textContent=dryRun?'📝 Paper':'🔴 Live';
  document.getElementById('cfgMaxPos').textContent=mp;
  document.getElementById('cfgBrainInt').textContent=s.cfg?((s.cfg.brainInterval||90000)/60000)+'min':'1.5min';
  document.getElementById('cfgScans').textContent=s.scanCount||0;
  document.getElementById('cfgWL').textContent=w+'W / '+l+'L';
  document.getElementById('cfgPhaseShort').textContent=s.phaseLabel||'—';

  // Drawdown
  const dd=s.drawdown||0;
  document.getElementById('cfgDD').textContent=dd+'%';
  document.getElementById('cfgDDFill').style.width=Math.min(100,parseFloat(dd))+'%';

  // Phase block
  if(s.phaseLabel){
    document.getElementById('cfgPhase').textContent=s.phaseLabel;
    document.getElementById('cfgPhaseDesc').textContent=s.phaseDesc||'';
    const pct=parseFloat(s.doublingProgress||0);
    document.getElementById('cfgProgressBar').style.width=Math.min(100,pct)+'%';
    document.getElementById('cfgProgressPct').textContent=pct.toFixed(1)+'%';
    document.getElementById('cfgCurBal').textContent='$'+bal.toFixed(2);
    const nxt=parseFloat(s.nextTarget||0);
    document.getElementById('cfgNextTarget').textContent='→ $'+nxt.toLocaleString('en-US',{maximumFractionDigits:0});
    document.getElementById('cfgDoublings').textContent=(s.doublingsMade||0)+'× done';
    document.getElementById('cfgNeeded').textContent=(s.doublingsNeeded||'?')+' left';
    document.getElementById('cfgBankroll').textContent='$50.00';
  }

  // Logs
  if(s.logs&&s.logs.length){
    const lw=document.getElementById('logWrap');
    lw.innerHTML=s.logs.slice(0,60).map(l=>{
      const lvl=(l.level||'').toLowerCase();
      const cls=lvl==='error'||lvl==='err'?'log-entry err':lvl==='warn'?'log-entry warn':'log-entry';
      return '<div class="'+cls+'"><span class="log-ts">'+(l.ts||'')+'</span>'+(l.msg||l)+'</div>';
    }).join('');
  }
}

async function toggleBot(){
  const running=state&&state.isRunning;
  try{await fetch(API+'/api/toggle',{method:'POST'});setTimeout(loadState,600);}catch(e){}
}

// Seed chart
(function(){for(let i=15;i>=0;i--) chartData.push({t:Date.now()-i*300000,v:12});drawChart();})();

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

  if (url.pathname === '/' || url.pathname === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(DASHBOARD);
  }

  if (url.pathname === '/api/state') {
    const total = S.wins + S.losses;
    const winRate = total > 0 ? (S.wins / total * 100).toFixed(1) : null;
    const drawdown = S.peakBalance > 0
      ? ((S.peakBalance - S.balance) / S.peakBalance * 100).toFixed(1) : '0.0';
    const phase = getPhase();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ...S, dryRun: CFG.dryRun, maxPos: dynamicMaxPos(), maxPosBase: CFG.maxPos,
      winRate, drawdown, openCount: S.openPositions.length,
      phase: phase.name, phaseLabel: phase.label, phaseDesc: phase.desc,
      doublingsMade: doublingsMade(), doublingsNeeded: doublingsNeeded(),
      nextTarget: nextTarget(), doublingProgress: doublingProgress().toFixed(1),
      availableCash: S.availableCash, restingOrderCount: S.restingOrders.length,
    }));
  }

  if (url.pathname === '/api/toggle' && req.method === 'POST') {
    if (S.isRunning) stopBot(); else startBot();
    res.writeHead(200, { 'Content-Type': 'application/json' });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
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
