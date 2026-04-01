// ═══════════════════════════════════════════════════════════════
//  KALSHI EDGE v3 — Production Trading Bot
//  Persistence / News Feed / Exit Logic / Resolution Tracking
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ─── CONFIG ─────────────────────────────────────────────────

const C = {
  apiKeyId:    process.env.KALSHI_API_KEY_ID || '',
  privateKey:  (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  baseUrl:     process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com',
  basePath:    '/trade-api/v2',
  claudeKey:   process.env.CLAUDE_API_KEY || '',
  claudeModel: 'claude-sonnet-4-20250514',
  dryRun:        process.env.DRY_RUN !== 'false',
  bankroll:      parseFloat(process.env.BANKROLL || '50'),
  kelly:         parseFloat(process.env.KELLY_FRACTION || '0.35'),
  edgeMin:       parseFloat(process.env.CLAUDE_EDGE || '0.07'),
  maxPos:        parseFloat(process.env.MAX_POSITION || '5'),
  maxLoss:       parseFloat(process.env.MAX_DAILY_LOSS || '8'),
  maxOpen:       parseInt(process.env.MAX_CONCURRENT || '5'),
  poll:          parseInt(process.env.POLL_INTERVAL || '60'),
  minVol:        parseInt(process.env.MIN_VOLUME || '0'),
  tgToken:       process.env.TELEGRAM_TOKEN || '',
  tgChat:        process.env.TELEGRAM_CHAT_ID || '',
};

// ─── PERSISTENT STATE (survives restarts) ───────────────────

const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp';
const DB_FILE = path.join(DB_DIR, 'kalshi-edge-db.json');
const BACKUP_FILE = path.join(DB_DIR, 'kalshi-edge-db.bak.json');

const DEFAULT_STATE = {
  trades: [],         // all trade records
  positions: [],      // current open positions from Kalshi
  signals: [],        // latest Claude signals
  resolved: [],       // paper trades that have been graded
  balance: C.bankroll * 100,
  dailyPnL: 0,
  dailyDate: '',
  totalPnL: 0,
  wins: 0,
  losses: 0,
  paperWins: 0,
  paperLosses: 0,
  botStarted: null,
  lastPoll: null,
  lastError: null,
  isRunning: false,
  cycleCount: 0,
  totalClaude: 0,     // total Claude API calls (for credit tracking)
  news: [],
  marketCache: {},     // ticker -> last known market data
};

let S = { ...DEFAULT_STATE };

function loadDB() {
  for (const f of [DB_FILE, BACKUP_FILE]) {
    try {
      if (fs.existsSync(f)) {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        S = { ...DEFAULT_STATE, ...d };
        log('📂 State loaded from ' + path.basename(f) + ' (' + S.trades.length + ' trades)');
        return;
      }
    } catch (e) { log('DB load err: ' + e.message); }
  }
  log('📂 Fresh state initialized');
}

function saveDB() {
  try {
    // Backup before write
    if (fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, BACKUP_FILE);
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(S));
  } catch (e) { /* ephemeral fs ok */ }
}

// Auto-save every 30s
setInterval(saveDB, 30000);
loadDB();

// ─── LOGGING ────────────────────────────────────────────────

const logs = [];
function log(m) {
  const e = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(e);
  logs.unshift(e);
  if (logs.length > 500) logs.length = 500;
}

// ─── HTTP HELPER ────────────────────────────────────────────

function req(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const o = { hostname: u.hostname, port: 443, path: u.pathname + u.search, ...opts };
    const r = https.request(o, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, data: { raw: d } }); }
      });
    });
    r.setTimeout(25000, () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ─── KALSHI API ─────────────────────────────────────────────

function sign(ts, method, p) {
  try {
    const pk = crypto.createPrivateKey({ key: C.privateKey, format: 'pem' });
    return crypto.sign('sha256', Buffer.from(`${ts}${method}${p}`), {
      key: pk, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
  } catch (e) { log('RSA err: ' + e.message); return ''; }
}

function api(method, ep, body) {
  const ts = Date.now().toString();
  const sp = `${C.basePath}${ep.split('?')[0]}`;
  return req(`${C.baseUrl}${C.basePath}${ep}`, {
    method,
    headers: {
      'KALSHI-ACCESS-KEY': C.apiKeyId, 'KALSHI-ACCESS-TIMESTAMP': ts,
      'KALSHI-ACCESS-SIGNATURE': sign(ts, method, sp),
      'Content-Type': 'application/json', 'Accept': 'application/json',
    },
  }, body ? JSON.stringify(body) : null);
}

// ─── DATA LAYER ─────────────────────────────────────────────

async function fetchBalance() {
  try {
    const r = await api('GET', '/portfolio/balance');
    if (r.status === 200) { S.balance = r.data.balance; return r.data.balance; }
  } catch (e) {}
  return S.balance;
}

async function fetchMarkets(cursor) {
  try {
    let ep = '/markets?status=open&limit=200';
    if (cursor) ep += '&cursor=' + cursor;
    const r = await api('GET', ep);
    if (r.status === 200) return r.data;
  } catch (e) { log('Markets err: ' + e.message); }
  return { markets: [] };
}

async function fetchAllMarkets() {
  let all = [];
  let cursor = null;
  for (let i = 0; i < 3; i++) { // max 3 pages = 600 markets
    const r = await fetchMarkets(cursor);
    if (r.markets) all = all.concat(r.markets);
    cursor = r.cursor;
    if (!cursor) break;
  }
  return all;
}

async function fetchPositions() {
  try {
    const r = await api('GET', '/portfolio/positions');
    if (r.status === 200) { S.positions = r.data.market_positions || []; return S.positions; }
  } catch (e) {}
  return S.positions;
}

async function fetchOrders() {
  try {
    const r = await api('GET', '/portfolio/orders?status=resting');
    if (r.status === 200) return r.data.orders || [];
  } catch (e) {}
  return [];
}

async function fetchSettlements() {
  try {
    const r = await api('GET', '/portfolio/settlements?limit=50');
    if (r.status === 200) return r.data.settlements || [];
  } catch (e) {}
  return [];
}

// Fetch specific market to check resolution (for paper grading)
async function fetchMarket(ticker) {
  try {
    const r = await api('GET', `/markets/${ticker}`);
    if (r.status === 200) return r.data.market || r.data;
  } catch (e) {}
  return null;
}

// ─── NEWS FEED (free, no API key) ───────────────────────────

async function fetchNews() {
  const headlines = [];

  // Try Google News RSS via a public endpoint
  try {
    const r = await req('https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en', {
      method: 'GET', headers: { 'User-Agent': 'KalshiEdge/3.0', 'Accept': 'application/rss+xml,text/xml,application/xml' },
    });
    if (r.data.raw) {
      const titles = r.data.raw.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || [];
      titles.forEach(t => {
        const clean = t.replace(/<title><!\[CDATA\[/, '').replace(/\]\]><\/title>/, '').trim();
        if (clean.length > 10 && !clean.includes('Google News')) headlines.push(clean);
      });
    }
  } catch (e) {}

  // Fallback context
  if (headlines.length < 3) {
    const d = new Date();
    headlines.push(`Today is ${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`);
    headlines.push('Use your training knowledge of current US politics, economics, Fed policy, sports, and weather to evaluate markets.');
  }

  S.news = headlines.slice(0, 12);
  return S.news;
}

// ─── CLAUDE SIGNAL ENGINE ───────────────────────────────────

async function analyzeMarkets(markets) {
  if (!C.claudeKey) { log('⚠️ No Claude API key'); return []; }
  if (!markets.length) return [];

  // Smart filtering: sort by volume, skip very low liquidity
  const sorted = markets
    .filter(m => m.status === 'open' || m.status === 'active')
    .sort((a, b) => {
      const va = a.volume || a.volume_fp || a.dollar_volume || 0;
      const vb = b.volume || b.volume_fp || b.dollar_volume || 0;
      return vb - va;
    })
    .slice(0, 15);

  if (!sorted.length) { log('No open markets to analyze'); return []; }

  const news = await fetchNews();

  const mBlock = sorted.map((m, i) => {
    const yp = m.yes_bid || m.yes_ask || m.last_price || 50;
    const np = m.no_bid || m.no_ask || (100 - (m.yes_bid || 50));
    const vol = m.volume || m.volume_fp || m.dollar_volume || 0;
    const close = m.close_time || m.expected_expiration_time || '';
    const cat = m.category || m.series_ticker || '';
    // Cache market data for resolution tracking
    S.marketCache[m.ticker] = { title: m.title, close_time: close, category: cat, last_yes: yp };
    return `${i+1}. "${m.title}" [${m.ticker}] Cat:${cat}\n   YES:${yp}¢ NO:${np}¢ | Vol:${vol} | Close:${close}`;
  }).join('\n');

  const newsBlock = news.map((h, i) => `${i+1}. ${h}`).join('\n');

  const body = JSON.stringify({
    model: C.claudeModel, max_tokens: 3000,
    system: `You are an elite quantitative analyst for Kalshi prediction markets. Your ONLY job: find mispriced markets where you have genuine informational edge.

MARKET MECHANICS:
- Binary contracts: YES pays $1.00, NO pays $0.00
- Prices in cents (1-99). YES + NO always = $1.00
- You BUY the side you think is underpriced

STRATEGY RULES:
1. ONLY signal when your estimated probability differs from market price by ${(C.edgeMin*100).toFixed(0)}+ cents
2. PREFER markets closing within 24-72 hours (shorter = more predictable)
3. PREFER high-volume markets (better liquidity, easier fills)
4. EXPLOIT favourite-longshot bias: cheap contracts (<20¢) usually overpriced, expensive (>80¢) usually underpriced
5. For YES prices >80¢, consider if NO at <20¢ is the better entry
6. SKIP markets where you genuinely don't have enough info
7. Be AGGRESSIVE on high-confidence calls — these are where money is made

RESPOND WITH VALID JSON ARRAY ONLY. No markdown, no backticks, no explanation.
Each signal: {"ticker":"TICKER","title":"short name","side":"yes"|"no","marketPrice":0.XX,"trueProb":0.XX,"edge":0.XX,"confidence":"low"|"medium"|"high","reasoning":"max 15 words"}
No signals? Return: []`,
    messages: [{ role: 'user', content: `CURRENT NEWS:\n${newsBlock}\n\nACTIVE MARKETS:\n${mBlock}\n\nFind mispriced markets. Be selective but aggressive on strong calls.` }],
  });

  try {
    S.totalClaude++;
    const r = await req('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': C.claudeKey, 'anthropic-version': '2023-06-01' },
    }, body);

    if (r.data.error) {
      const msg = r.data.error.message || JSON.stringify(r.data.error);
      log('🤖 Claude err: ' + msg);
      if (msg.includes('credit') || msg.includes('billing')) {
        await tg('🚨 <b>Claude API credits depleted!</b>\nBot pausing signals until credits are added at console.anthropic.com');
      }
      return [];
    }

    const txt = (r.data.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    const sigs = JSON.parse(txt);
    return Array.isArray(sigs) ? sigs : [];
  } catch (e) {
    log('🤖 Claude err: ' + e.message);
    return [];
  }
}

// ─── KELLY SIZING ───────────────────────────────────────────

function kellySize(edge, mktPrice, side) {
  const cost = side === 'yes' ? mktPrice : (1 - mktPrice);
  if (cost <= 0.01 || cost >= 0.99 || edge <= 0) return 0;
  const odds = (1 - cost) / cost;
  const wp = Math.min(cost + edge, 0.95); // cap win prob
  const k = (wp * odds - (1 - wp)) / odds;
  if (k <= 0) return 0;
  const frac = k * C.kelly;
  const bank = Math.max(S.balance / 100, C.bankroll);
  const dollars = Math.min(C.maxPos, Math.max(1, frac * bank));
  return Math.max(1, Math.min(Math.floor(dollars / cost), 100));
}

// ─── ORDER EXECUTION ────────────────────────────────────────

async function placeOrder(sig) {
  const { ticker, side, marketPrice, edge, confidence, reasoning } = sig;
  const contracts = kellySize(edge, marketPrice, side);
  if (contracts <= 0) { log('Kelly skip: ' + ticker); return null; }

  const pc = side === 'yes' ? Math.round(marketPrice * 100) : Math.round((1 - marketPrice) * 100);
  const cost = ((contracts * pc) / 100).toFixed(2);
  const maxPayout = ((contracts * (100 - pc)) / 100).toFixed(2);

  const rec = {
    id: uuidv4(), ticker, title: sig.title || ticker, side, contracts, priceCents: pc,
    costDollars: cost, maxPayout, edge: (edge * 100).toFixed(1) + '%',
    confidence, reasoning, marketPriceAtEntry: marketPrice,
    timestamp: new Date().toISOString(), status: 'pending', dryRun: C.dryRun,
    resolved: false, outcome: null, pnl: null,
  };

  if (C.dryRun) {
    rec.status = 'simulated';
    S.trades.unshift(rec);
    if (S.trades.length > 500) S.trades.length = 500;
    saveDB();
    log(`📋 PAPER: ${side.toUpperCase()} ${contracts}x ${ticker} @${pc}¢ ($${cost}) Edge:${rec.edge} → max payout $${maxPayout}`);
    await tg(
      `🧪 <b>PAPER TRADE</b>\n` +
      `${side.toUpperCase()} ${contracts}x <code>${ticker}</code>\n` +
      `@ ${pc}¢ ($${cost} risk → $${maxPayout} potential)\n` +
      `Edge: ${rec.edge} | ${confidence}\n` +
      `💡 ${reasoning}`
    );
    return rec;
  }

  // LIVE
  const order = { ticker, action: 'buy', side, count: contracts, type: 'limit', client_order_id: uuidv4() };
  if (side === 'yes') order.yes_price = pc; else order.no_price = pc;

  try {
    const r = await api('POST', '/portfolio/orders', order);
    if (r.status === 201 || r.status === 200) {
      rec.status = 'placed'; rec.orderId = r.data.order?.order_id;
      log(`✅ LIVE: ${side.toUpperCase()} ${contracts}x ${ticker} @${pc}¢ ($${cost})`);
      await tg(
        `✅ <b>LIVE ORDER PLACED</b>\n` +
        `${side.toUpperCase()} ${contracts}x <code>${ticker}</code>\n` +
        `@ ${pc}¢ ($${cost} → $${maxPayout})\n` +
        `Edge: ${rec.edge} | ${reasoning}`
      );
    } else {
      rec.status = 'error'; rec.error = JSON.stringify(r.data).slice(0, 300);
      log('❌ Order err ' + r.status);
      await tg(`❌ <b>ORDER FAILED</b>\n<code>${ticker}</code>\n${rec.error.slice(0, 200)}`);
    }
  } catch (e) { rec.status = 'error'; rec.error = e.message; }

  S.trades.unshift(rec);
  if (S.trades.length > 500) S.trades.length = 500;
  saveDB();
  return rec;
}

// ─── EXIT LOGIC (sell positions when edge gone) ─────────────

async function checkExits(markets, positions) {
  if (C.dryRun || !positions.length) return;

  const marketMap = {};
  markets.forEach(m => { marketMap[m.ticker] = m; });

  for (const pos of positions) {
    const ticker = pos.ticker || pos.market_ticker;
    const mkt = marketMap[ticker];
    if (!mkt) continue;

    // Find our entry trade
    const entry = S.trades.find(t => t.ticker === ticker && (t.status === 'placed' || t.status === 'filled'));
    if (!entry) continue;

    const currentYes = (mkt.yes_bid || mkt.last_price || 50) / 100;
    const entryPrice = entry.marketPriceAtEntry || 0.5;
    const ourSide = entry.side;

    // EXIT CONDITIONS:
    // 1. Price moved 15%+ in our favor → take profit
    // 2. Price moved 10%+ against us → cut loss
    // 3. Market closing within 5 min → let it settle
    const priceNow = ourSide === 'yes' ? currentYes : (1 - currentYes);
    const priceEntry = ourSide === 'yes' ? entryPrice : (1 - entryPrice);
    const move = priceNow - priceEntry;

    if (move >= 0.15) {
      log(`📈 TAKE PROFIT: ${ticker} moved +${(move * 100).toFixed(0)}¢ in our favor`);
      // Sell by placing opposite order
      const sellOrder = {
        ticker, action: 'sell', side: ourSide,
        count: Math.abs(pos.position || 1), type: 'limit',
        client_order_id: uuidv4(),
      };
      if (ourSide === 'yes') sellOrder.yes_price = Math.round(currentYes * 100);
      else sellOrder.no_price = Math.round((1 - currentYes) * 100);

      try {
        const r = await api('POST', '/portfolio/orders', sellOrder);
        if (r.status === 201 || r.status === 200) {
          await tg(`📈 <b>TAKE PROFIT</b>\n<code>${ticker}</code>\nMoved +${(move * 100).toFixed(0)}¢ in our favor`);
        }
      } catch (e) { log('Exit order err: ' + e.message); }
    }
    else if (move <= -0.10) {
      log(`📉 CUT LOSS: ${ticker} moved ${(move * 100).toFixed(0)}¢ against us`);
      const sellOrder = {
        ticker, action: 'sell', side: ourSide,
        count: Math.abs(pos.position || 1), type: 'limit',
        client_order_id: uuidv4(),
      };
      if (ourSide === 'yes') sellOrder.yes_price = Math.round(currentYes * 100);
      else sellOrder.no_price = Math.round((1 - currentYes) * 100);

      try {
        const r = await api('POST', '/portfolio/orders', sellOrder);
        if (r.status === 201 || r.status === 200) {
          await tg(`📉 <b>CUT LOSS</b>\n<code>${ticker}</code>\nMoved ${(move * 100).toFixed(0)}¢ against us`);
        }
      } catch (e) { log('Exit order err: ' + e.message); }
    }
  }
}

// ─── PAPER TRADE RESOLUTION ─────────────────────────────────

async function gradePaperTrades() {
  const unresolved = S.trades.filter(t => t.dryRun && !t.resolved && t.status === 'simulated');
  if (!unresolved.length) return;

  for (const trade of unresolved.slice(0, 5)) { // check 5 per cycle
    const mkt = await fetchMarket(trade.ticker);
    if (!mkt) continue;

    // Market must be settled/closed
    const status = mkt.status || mkt.result;
    if (status !== 'settled' && status !== 'finalized' && status !== 'closed') continue;

    const result = mkt.result || mkt.settlement_value;
    if (result === undefined || result === null) continue;

    // Determine win/loss
    const won = (trade.side === 'yes' && result === 'yes') ||
                (trade.side === 'yes' && result === 1) ||
                (trade.side === 'no' && result === 'no') ||
                (trade.side === 'no' && result === 0);

    trade.resolved = true;
    trade.outcome = won ? 'win' : 'loss';

    const costCents = trade.contracts * trade.priceCents;
    const payoutCents = won ? (trade.contracts * 100) : 0;
    trade.pnl = ((payoutCents - costCents) / 100).toFixed(2);

    if (won) { S.paperWins++; S.totalPnL += (payoutCents - costCents); }
    else { S.paperLosses++; S.totalPnL -= costCents; }

    S.dailyPnL += won ? (payoutCents - costCents) : -costCents;

    log(`📊 RESOLVED: ${trade.ticker} → ${won ? 'WIN' : 'LOSS'} (paper $${trade.pnl})`);
    await tg(
      `${won ? '🏆' : '💸'} <b>PAPER ${won ? 'WIN' : 'LOSS'}</b>\n` +
      `<code>${trade.ticker}</code>\n` +
      `${trade.side.toUpperCase()} @${trade.priceCents}¢ → ${won ? 'CORRECT' : 'WRONG'}\n` +
      `P&L: ${trade.pnl > 0 ? '+' : ''}$${trade.pnl}\n` +
      `Record: ${S.paperWins}W/${S.paperLosses}L (${S.paperWins + S.paperLosses > 0 ? ((S.paperWins / (S.paperWins + S.paperLosses)) * 100).toFixed(0) : 0}%)`
    );
  }
}

// ─── LIVE SETTLEMENT TRACKING ───────────────────────────────

async function trackSettlements() {
  if (C.dryRun) return;
  try {
    const setts = await fetchSettlements();
    const knownIds = new Set(S.resolved.map(r => r.id || r.market_id));
    for (const s of setts) {
      const id = s.market_id || s.ticker || s.id;
      if (knownIds.has(id)) continue;
      S.resolved.push({ ...s, id });
      const rev = (s.revenue || 0) / 100;
      const win = rev > 0;
      if (win) S.wins++; else S.losses++;
      S.totalPnL += (s.revenue || 0);
      S.dailyPnL += (s.revenue || 0);
      log(`💰 SETTLED: ${s.ticker || id} → ${win ? 'WIN' : 'LOSS'} $${rev.toFixed(2)}`);
      await tg(
        `${win ? '🏆' : '💸'} <b>${win ? 'WIN' : 'LOSS'}</b>\n` +
        `<code>${s.ticker || id}</code>\n` +
        `P&L: ${win ? '+' : ''}$${rev.toFixed(2)}\n` +
        `Balance: $${(S.balance / 100).toFixed(2)}`
      );
    }
    if (S.resolved.length > 200) S.resolved.length = 200;
  } catch (e) {}
}

// ─── MAIN CYCLE ─────────────────────────────────────────────

let pollTimer = null;

async function cycle() {
  try {
    S.cycleCount++;
    const today = new Date().toISOString().slice(0, 10);
    if (S.dailyDate !== today) {
      const yPnl = S.dailyPnL;
      S.dailyPnL = 0; S.dailyDate = today;
      log(`📅 New day | Yesterday P&L: $${(yPnl / 100).toFixed(2)}`);
      await tg(`📅 <b>Daily Reset</b>\nYesterday P&L: $${(yPnl / 100).toFixed(2)}\nRecord: ${S.wins + S.paperWins}W/${S.losses + S.paperLosses}L`);
    }

    if (S.dailyPnL <= -(C.maxLoss * 100)) {
      log('🛑 Daily loss limit ($' + C.maxLoss + ') — paused');
      return;
    }

    // Fetch everything
    const [bal, mkts, pos] = await Promise.all([
      fetchBalance(), fetchAllMarkets(), fetchPositions(),
    ]);

    S.lastPoll = new Date().toISOString();
    log(`🔄 #${S.cycleCount}: ${mkts.length} mkts | $${(bal / 100).toFixed(2)} | ${pos.length} pos | Claude calls: ${S.totalClaude}`);

    // Track settlements + grade paper trades
    await trackSettlements();
    await gradePaperTrades();

    // Check exits on live positions
    if (pos.length > 0) await checkExits(mkts, pos);

    // Check if we can enter new positions
    if (pos.length >= C.maxOpen) {
      log('⏸ Max positions (' + C.maxOpen + ')');
      saveDB(); return;
    }

    // Claude analysis
    const sigs = await analyzeMarkets(mkts);
    S.signals = sigs.slice(0, 20);

    if (sigs.length > 0) {
      log(`🧠 ${sigs.length} signal(s) found`);
      const held = new Set(pos.map(p => p.ticker || p.market_ticker));
      const recentTickers = new Set(S.trades.slice(0, 50).map(t => t.ticker));
      const fresh = sigs
        .filter(s => !held.has(s.ticker) && !recentTickers.has(s.ticker))
        .sort((a, b) => {
          // Prioritize: high confidence + high edge
          const scoreA = (a.edge || 0) * (a.confidence === 'high' ? 1.5 : a.confidence === 'medium' ? 1 : 0.5);
          const scoreB = (b.edge || 0) * (b.confidence === 'high' ? 1.5 : b.confidence === 'medium' ? 1 : 0.5);
          return scoreB - scoreA;
        });

      const slots = C.maxOpen - pos.length;
      for (const s of fresh.slice(0, Math.min(slots, 2))) {
        await placeOrder(s);
        await new Promise(r => setTimeout(r, 2000));
      }
    } else { log('😴 No signals'); }

    S.lastError = null;
    saveDB();
  } catch (e) {
    S.lastError = e.message;
    log('💥 Cycle err: ' + e.message);
    saveDB();
  }
}

function startBot() {
  if (S.isRunning) return;
  S.isRunning = true; S.botStarted = new Date().toISOString();
  log('🚀 Started | ' + (C.dryRun ? 'PAPER' : 'LIVE'));
  tg(
    `🚀 <b>Kalshi Edge v3 Started</b>\n` +
    `Mode: ${C.dryRun ? '📋 Paper' : '⚡ LIVE'}\n` +
    `Bank: $${C.bankroll} | Balance: $${(S.balance / 100).toFixed(2)}\n` +
    `Edge: ${C.edgeMin * 100}% | Kelly: ${C.kelly}\n` +
    `Max/trade: $${C.maxPos} | Poll: ${C.poll}s\n` +
    `Record: ${S.wins + S.paperWins}W/${S.losses + S.paperLosses}L`
  );
  cycle();
  pollTimer = setInterval(cycle, C.poll * 1000);
  saveDB();
}

function stopBot() {
  S.isRunning = false;
  if (pollTimer) clearInterval(pollTimer); pollTimer = null;
  log('⏹ Stopped');
  tg('⏹ <b>Kalshi Edge Stopped</b>');
  saveDB();
}

// ─── TELEGRAM ───────────────────────────────────────────────

async function tg(text) {
  if (!C.tgToken || !C.tgChat) return;
  try {
    await req(`https://api.telegram.org/bot${C.tgToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ chat_id: C.tgChat, text, parse_mode: 'HTML' }));
  } catch (e) {}
}

// ─── API ROUTES ─────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const tw = S.wins + S.paperWins, tl = S.losses + S.paperLosses, tot = tw + tl;
  res.json({
    isRunning: S.isRunning, dryRun: C.dryRun, balance: S.balance, bankroll: C.bankroll,
    totalPnL: S.totalPnL, dailyPnL: S.dailyPnL, wins: tw, losses: tl,
    winRate: tot > 0 ? ((tw / tot) * 100).toFixed(1) : '0.0',
    openPositions: S.positions.length, maxConcurrent: C.maxOpen,
    lastPoll: S.lastPoll, lastError: S.lastError, botStarted: S.botStarted,
    cycleCount: S.cycleCount, totalClaude: S.totalClaude, newsCount: S.news.length,
    unresolvedPaper: S.trades.filter(t => t.dryRun && !t.resolved).length,
    config: { kelly: C.kelly, edgeMin: C.edgeMin, maxPos: C.maxPos, maxLoss: C.maxLoss, poll: C.poll, minVol: C.minVol },
  });
});

app.get('/api/trades', (req, res) => res.json(S.trades.slice(0, 50)));
app.get('/api/positions', (req, res) => res.json(S.positions));
app.get('/api/signals', (req, res) => res.json(S.signals));
app.get('/api/logs', (req, res) => res.json(logs.slice(0, 150)));
app.get('/api/news', (req, res) => res.json(S.news));
app.post('/api/bot/start', (r, s) => { startBot(); s.json({ ok: true }); });
app.post('/api/bot/stop', (r, s) => { stopBot(); s.json({ ok: true }); });
app.post('/api/bot/cycle', async (r, s) => { try { await cycle(); s.json({ ok: true }); } catch (e) { s.json({ ok: false, error: e.message }); } });

app.get('/api/test-connection', async (rq, rs) => {
  try {
    const [b, m] = await Promise.all([api('GET', '/portfolio/balance'), api('GET', '/markets?status=open&limit=5')]);
    const mkts = m.data.markets || [];
    rs.json({
      auth: b.status === 200 ? 'ok' : 'failed', authStatus: b.status,
      authError: b.status !== 200 ? JSON.stringify(b.data).slice(0, 200) : null,
      balance: b.status === 200 ? b.data : null,
      markets: m.status === 200 ? `${mkts.length} markets` : 'failed',
      sampleMarket: mkts[0] ? { ticker: mkts[0].ticker, title: mkts[0].title, yes_bid: mkts[0].yes_bid, volume: mkts[0].volume } : null,
    });
  } catch (e) { rs.json({ auth: 'error', error: e.message }); }
});

app.get('/api/performance', (req, res) => {
  const resolved = S.trades.filter(t => t.resolved);
  const byConfidence = { high: { w: 0, l: 0 }, medium: { w: 0, l: 0 }, low: { w: 0, l: 0 } };
  resolved.forEach(t => {
    const c = t.confidence || 'medium';
    if (byConfidence[c]) { if (t.outcome === 'win') byConfidence[c].w++; else byConfidence[c].l++; }
  });
  res.json({
    totalResolved: resolved.length,
    byConfidence,
    totalPnLDollars: (S.totalPnL / 100).toFixed(2),
    avgEdge: resolved.length > 0 ? (resolved.reduce((a, t) => a + parseFloat(t.edge || 0), 0) / resolved.length).toFixed(1) + '%' : 'N/A',
  });
});

// ─── DASHBOARD ──────────────────────────────────────────────

app.get('/', (r, s) => { s.setHeader('Content-Type', 'text/html'); s.send(HTML()); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Kalshi Edge v3 on :${PORT}`);
  log(`${C.dryRun ? 'PAPER' : 'LIVE'} | $${C.bankroll} | Kelly:${C.kelly} | Edge:${C.edgeMin*100}% | Poll:${C.poll}s`);
  log(`TG: ${C.tgToken ? '✓' : '✗'} | Claude: ${C.claudeKey ? '✓' : '✗'} | Kalshi: ${C.apiKeyId ? '✓' : '✗'}`);
  if (C.apiKeyId && C.privateKey) { log('Auto-starting in 3s...'); setTimeout(startBot, 3000); }
  else log('⚠️ Add KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY');
});

// ─── INLINE DASHBOARD ───────────────────────────────────────

function HTML() {
return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#050505"><title>Kalshi Edge</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap" rel="stylesheet">
<style>
:root{--bg:#050505;--s1:#111113;--s2:#1a1a1e;--s3:#28282d;--bd:rgba(255,255,255,.06);--bd2:rgba(255,255,255,.12);--t:#f5f5f7;--t2:#a1a1a6;--t3:#636366;--g:#30d158;--gd:rgba(48,209,88,.12);--r:#ff453a;--rd:rgba(255,69,58,.12);--b:#0a84ff;--bld:rgba(10,132,255,.12);--o:#ff9f0a;--od:rgba(255,159,10,.12);--p:#bf5af2;--R:16px;--st:env(safe-area-inset-top,20px);--sb:env(safe-area-inset-bottom,0px)}
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',-apple-system,sans-serif;background:var(--bg);color:var(--t);-webkit-font-smoothing:antialiased;min-height:100dvh;padding-top:var(--st);padding-bottom:calc(72px + var(--sb));overflow-x:hidden}
.H{padding:12px 20px 8px;display:flex;align-items:center;justify-content:space-between}.Hb{display:flex;align-items:center;gap:10px}.Hl{width:34px;height:34px;background:linear-gradient(135deg,#30d158,#0a84ff);border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#000}.Ht{font-size:21px;font-weight:700;letter-spacing:-.4px}
.tg{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;padding:4px 10px;border-radius:20px}.td{background:var(--od);color:var(--o)}.tl{background:var(--gd);color:var(--g)}.to{background:var(--rd);color:var(--r)}
.hero{margin:8px 16px 0;padding:22px 20px;background:var(--s1);border-radius:20px;border:1px solid var(--bd);position:relative;overflow:hidden}.hero:before{content:'';position:absolute;top:-80px;right:-40px;width:180px;height:180px;background:radial-gradient(circle,rgba(48,209,88,.06),transparent 70%);pointer-events:none}
.bl{font-size:11px;color:var(--t3);font-weight:600;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px}.bv{font-size:44px;font-weight:700;letter-spacing:-2.5px;line-height:1;margin-bottom:10px;font-variant-numeric:tabular-nums}
.pr{display:flex;gap:14px;flex-wrap:wrap}.pi{display:flex;align-items:center;gap:5px;font-size:13px;font-weight:500}.pb{font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;font-variant-numeric:tabular-nums}.pu{background:var(--gd);color:var(--g)}.pd{background:var(--rd);color:var(--r)}.pn{background:var(--s3);color:var(--t3)}
.G{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 16px 0}.Gc{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:12px 8px;text-align:center}.Gv{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}.Gl{font-size:9px;color:var(--t3);font-weight:600;text-transform:uppercase;letter-spacing:.6px;margin-top:2px}
.ct{display:flex;gap:6px;margin:10px 16px 0}.bn{flex:1;padding:13px;border:none;border-radius:var(--R);font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;transition:transform .12s}.bn:active{transform:scale(.96)}.bg{background:var(--g);color:#000}.bs{background:var(--r);color:#fff}.bc{background:var(--s2);color:var(--t);border:1px solid var(--bd2);flex:.5}.bt{background:var(--bld);color:var(--b);border:1px solid rgba(10,132,255,.15);flex:.5}
.S{margin:18px 16px 0}.Sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.St{font-size:15px;font-weight:700}.Sn{font-size:11px;color:var(--t3);background:var(--s2);padding:2px 8px;border-radius:10px;font-weight:500}
.CL{display:flex;flex-direction:column;gap:5px}
.TC{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:12px 14px}.Tt{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:5px}.Tk{font-size:13px;font-weight:600;line-height:1.3;flex:1}
.Ts{font-size:10px;font-weight:700;text-transform:uppercase;padding:3px 7px;border-radius:5px;flex-shrink:0}.sy{background:var(--gd);color:var(--g)}.sn{background:var(--rd);color:var(--r)}
.Tm{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--t3)}.Tm span{display:flex;align-items:center;gap:2px}
.Tr{font-size:11px;color:var(--t2);margin-top:5px;line-height:1.4;font-style:italic}
.Tx{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;text-transform:uppercase}.xs{background:var(--od);color:var(--o)}.xp{background:var(--gd);color:var(--g)}.xe{background:var(--rd);color:var(--r)}.xw{background:var(--gd);color:var(--g)}.xl{background:var(--rd);color:var(--r)}
.PC{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center}
.LP{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:10px;max-height:320px;overflow-y:auto;font-family:'SF Mono',Menlo,monospace;font-size:10px;line-height:1.7;color:var(--t3);-webkit-overflow-scrolling:touch}
.EM{text-align:center;padding:20px 16px;color:var(--t3);font-size:12px}.Ei{font-size:26px;margin-bottom:6px;opacity:.4}
.M{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:100;display:none;align-items:flex-end;justify-content:center}.M.open{display:flex}.Ms{background:var(--s1);border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:20px;padding-bottom:calc(20px + var(--sb));animation:su .3s ease}@keyframes su{from{transform:translateY(100%)}to{transform:translateY(0)}}.Mh{width:36px;height:5px;background:var(--s3);border-radius:3px;margin:0 auto 14px}.Mt{font-size:17px;font-weight:700;margin-bottom:10px}
.TR{padding:10px;background:var(--s2);border-radius:10px;margin-bottom:6px;font-size:12px}.TR .l{color:var(--t3);font-size:10px;text-transform:uppercase;letter-spacing:.5px}.TR .v{font-weight:600;margin-top:1px}.Tok{border-left:3px solid var(--g)}.Tfl{border-left:3px solid var(--r)}
.TB{position:fixed;bottom:0;left:0;right:0;background:rgba(17,17,19,.88);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-top:1px solid var(--bd);display:flex;justify-content:space-around;padding:6px 0 calc(6px + var(--sb));z-index:50}
.tab{display:flex;flex-direction:column;align-items:center;gap:1px;font-size:9px;font-weight:600;color:var(--t3);cursor:pointer;padding:4px 10px;border:none;background:none;-webkit-tap-highlight-color:transparent}.tab.a{color:var(--g)}.tab svg{width:21px;height:21px}
.V{display:none}.V.a{display:block}
.sp{width:16px;height:16px;border:2px solid var(--s3);border-top-color:var(--t);border-radius:50%;animation:sp .5s linear infinite;display:inline-block}@keyframes sp{to{transform:rotate(360deg)}}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--s3);border-radius:2px}
</style></head><body>
<div class="H"><div class="Hb"><div class="Hl">KE</div><div class="Ht">Kalshi Edge</div></div><div id="mT" class="tg to">OFFLINE</div></div>

<div id="vD" class="V a">
<div class="hero"><div class="bl">Portfolio Balance</div><div class="bv" id="bal">$0.00</div>
<div class="pr"><div class="pi"><span style="color:var(--t3)">Total</span><span id="tP" class="pb pn">$0.00</span></div>
<div class="pi"><span style="color:var(--t3)">Today</span><span id="dP" class="pb pn">$0.00</span></div></div></div>
<div class="G">
<div class="Gc"><div class="Gv" id="wr" style="color:var(--g)">0%</div><div class="Gl">Win Rate</div></div>
<div class="Gc"><div class="Gv" id="nt">0</div><div class="Gl">Trades</div></div>
<div class="Gc"><div class="Gv" id="op" style="color:var(--b)">0</div><div class="Gl">Open</div></div>
<div class="Gc"><div class="Gv" id="cc" style="color:var(--p)">0</div><div class="Gl">Cycles</div></div>
</div>
<div class="ct"><button class="bn bg" id="bG" onclick="sB()">&#9654; Start</button><button class="bn bs" id="bS" onclick="xB()" style="display:none">&#9632; Stop</button><button class="bn bc" id="bC" onclick="cy()">&#8635; Cycle</button><button class="bn bt" onclick="tt()">&#10003; Test</button></div>
<div class="S"><div class="Sh"><div class="St">Recent Trades</div><div class="Sn" id="tC">0</div></div>
<div class="CL" id="tL"><div class="EM"><div class="Ei">&#128202;</div>Waiting for first signal...</div></div></div></div>

<div id="vP" class="V"><div class="S" style="margin-top:6px"><div class="Sh"><div class="St">Open Positions</div><div class="Sn" id="pC">0</div></div>
<div class="CL" id="pL"><div class="EM"><div class="Ei">&#128200;</div>No positions</div></div></div></div>

<div id="vI" class="V"><div class="S" style="margin-top:6px"><div class="Sh"><div class="St">Signals</div><div class="Sn" id="sC">0</div></div>
<div class="CL" id="sL"><div class="EM"><div class="Ei">&#129504;</div>Tap Cycle to scan markets</div></div></div></div>

<div id="vL" class="V"><div class="S" style="margin-top:6px"><div class="Sh"><div class="St">Logs</div><div class="Sn" id="lC">#0</div></div>
<div class="LP" id="lP"><div class="EM">Starting...</div></div></div></div>

<div class="M" id="md" onclick="if(event.target===this)this.classList.remove('open')">
<div class="Ms"><div class="Mh"></div><div class="Mt">Connection Test</div><div id="tR"><div style="text-align:center;padding:20px"><div class="sp"></div></div></div>
<button class="bn" style="background:var(--s2);color:var(--t);margin-top:10px;width:100%" onclick="document.getElementById('md').classList.remove('open')">Done</button></div></div>

<div class="TB">
<button class="tab a" onclick="sw('D',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Home</button>
<button class="tab" onclick="sw('P',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Positions</button>
<button class="tab" onclick="sw('I',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>Signals</button>
<button class="tab" onclick="sw('L',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Logs</button>
</div>

<script>
var E=s=>s?(s+'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'';
function sw(n,t){document.querySelectorAll('.V').forEach(v=>v.classList.remove('a'));document.querySelectorAll('.tab').forEach(t=>t.classList.remove('a'));document.getElementById('v'+n).classList.add('a');t.classList.add('a')}
async function sB(){await fetch('/api/bot/start',{method:'POST'});gA()}
async function xB(){await fetch('/api/bot/stop',{method:'POST'});gA()}
async function cy(){var b=document.getElementById('bC');b.innerHTML='<div class="sp"></div>';b.disabled=true;try{await fetch('/api/bot/cycle',{method:'POST'});await gA()}finally{b.innerHTML='&#8635; Cycle';b.disabled=false}}
async function tt(){var m=document.getElementById('md'),r=document.getElementById('tR');m.classList.add('open');r.innerHTML='<div style="text-align:center;padding:20px"><div class="sp"></div><div style="margin-top:6px;color:var(--t3);font-size:12px">Testing...</div></div>';try{var d=await(await fetch('/api/test-connection')).json();r.innerHTML='<div class="TR '+(d.auth==='ok'?'Tok':'Tfl')+'"><div class="l">Auth</div><div class="v">'+(d.auth==='ok'?'&#10004; Connected':'&#10006; '+E(d.authError||d.authStatus))+'</div></div>'+(d.auth==='ok'?'<div class="TR Tok"><div class="l">Balance</div><div class="v">$'+((d.balance?.balance||0)/100).toFixed(2)+'</div></div>':'')+'<div class="TR '+(d.markets&&!String(d.markets).includes('fail')?'Tok':'Tfl')+'"><div class="l">Markets</div><div class="v">'+E(d.markets)+'</div></div>'+(d.sampleMarket?'<div class="TR Tok"><div class="l">Sample</div><div class="v">'+E(d.sampleMarket.title)+' ('+E(d.sampleMarket.yes_bid)+'&#162;)</div></div>':'')}catch(x){r.innerHTML='<div class="TR Tfl"><div class="l">Error</div><div class="v">'+E(x.message)+'</div></div>'}}

function uD(d){
document.getElementById('bal').textContent='$'+(d.balance/100).toFixed(2);
var te=document.getElementById('tP'),de=document.getElementById('dP'),tv=d.totalPnL/100,dv=d.dailyPnL/100;
te.textContent=(tv>=0?'+':'')+tv.toFixed(2);te.className='pb '+(tv>0?'pu':tv<0?'pd':'pn');
de.textContent=(dv>=0?'+':'')+dv.toFixed(2);de.className='pb '+(dv>0?'pu':dv<0?'pd':'pn');
document.getElementById('wr').textContent=d.winRate+'%';document.getElementById('nt').textContent=d.wins+d.losses;
document.getElementById('op').textContent=d.openPositions;document.getElementById('cc').textContent=d.cycleCount;
var g=document.getElementById('mT');
if(!d.isRunning){g.textContent='OFFLINE';g.className='tg to'}else if(d.dryRun){g.textContent='PAPER';g.className='tg td'}else{g.textContent='LIVE';g.className='tg tl'}
document.getElementById('bG').style.display=d.isRunning?'none':'flex';document.getElementById('bS').style.display=d.isRunning?'flex':'none';
document.getElementById('lC').textContent='#'+d.cycleCount}

function rT(t){var el=document.getElementById('tL');document.getElementById('tC').textContent=t.length;
if(!t.length){el.innerHTML='<div class="EM"><div class="Ei">&#128202;</div>Waiting for first signal...</div>';return}
el.innerHTML=t.slice(0,25).map(function(x){var res=x.resolved?(x.outcome==='win'?'<span class="Tx xw">WIN $'+x.pnl+'</span>':'<span class="Tx xl">LOSS $'+x.pnl+'</span>'):'';return'<div class="TC"><div class="Tt"><div class="Tk">'+E(x.title||x.ticker)+'</div><span class="Ts '+(x.side==='yes'?'sy':'sn')+'">'+x.side+'</span></div><div class="Tm"><span>'+x.contracts+'x@'+x.priceCents+'&#162;</span><span>$'+x.costDollars+'&#8594;$'+x.maxPayout+'</span><span style="color:var(--g)">'+x.edge+'</span><span class="Tx '+(x.status==='simulated'?'xs':x.status==='placed'?'xp':'xe')+'">'+x.status+'</span>'+res+'</div>'+(x.reasoning?'<div class="Tr">'+E(x.reasoning)+'</div>':'')+'</div>'}).join('')}

function rP(p){var el=document.getElementById('pL');document.getElementById('pC').textContent=p.length;
if(!p.length){el.innerHTML='<div class="EM"><div class="Ei">&#128200;</div>No positions</div>';return}
el.innerHTML=p.map(function(x){return'<div class="PC"><div><div style="font-size:13px;font-weight:600">'+E(x.ticker||x.market_ticker)+'</div><div style="font-size:11px;color:var(--t3)">'+(x.market_outcome||'')+' | '+(x.total_traded||0)+' traded</div></div><div style="font-size:20px;font-weight:700">'+(x.position||0)+'</div></div>'}).join('')}

function rS(s){var el=document.getElementById('sL');document.getElementById('sC').textContent=s.length;
if(!s.length){el.innerHTML='<div class="EM"><div class="Ei">&#129504;</div>Tap Cycle to scan</div>';return}
el.innerHTML=s.map(function(x){return'<div class="TC"><div class="Tt"><div class="Tk">'+E(x.title||x.ticker)+'</div><span class="Ts '+(x.side==='yes'?'sy':'sn')+'">'+x.side+'</span></div><div class="Tm"><span>Mkt:'+(x.marketPrice*100).toFixed(0)+'&#162;</span><span>True:'+(x.trueProb*100).toFixed(0)+'&#162;</span><span style="color:var(--g)">+'+(x.edge*100).toFixed(1)+'%</span><span style="color:var(--o)">'+x.confidence+'</span></div>'+(x.reasoning?'<div class="Tr">'+E(x.reasoning)+'</div>':'')+'</div>'}).join('')}

function rL(l){var el=document.getElementById('lP');if(!l.length){el.innerHTML='<div class="EM">Starting...</div>';return}
el.innerHTML=l.map(function(x){return'<div style="white-space:pre-wrap;word-break:break-all">'+E(x)+'</div>'}).join('')}

async function gA(){try{var[s,t,p,si,l]=await Promise.all([fetch('/api/status').then(r=>r.json()),fetch('/api/trades').then(r=>r.json()),fetch('/api/positions').then(r=>r.json()),fetch('/api/signals').then(r=>r.json()),fetch('/api/logs').then(r=>r.json())]);uD(s);rT(t);rP(p);rS(si);rL(l)}catch(x){}}
gA();setInterval(gA,8000);
</script></body></html>`;
}
