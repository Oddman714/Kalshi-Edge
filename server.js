// ═══════════════════════════════════════════════════════════════
//  KALSHI EDGE v4 — Three-Layer Quant Architecture
//  Layer 1: Fast Scanner (every 30s, no AI, just math)
//  Layer 2: Claude Brain (every 5min, only top candidates)
//  Layer 3: Execution + Position Management (continuous)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const uuid = () => crypto.randomUUID();

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
  edgeMin:       parseFloat(process.env.CLAUDE_EDGE || '0.05'),
  maxPos:        parseFloat(process.env.MAX_POSITION || '5'),
  maxLoss:       parseFloat(process.env.MAX_DAILY_LOSS || '8'),
  maxOpen:       parseInt(process.env.MAX_CONCURRENT || '5'),
  scanInterval:  30,   // Layer 1: fast scan every 30s (free, no Claude)
  brainInterval: 300,  // Layer 2: Claude analysis every 5min
  tgToken:       process.env.TELEGRAM_TOKEN || '',
  tgChat:        process.env.TELEGRAM_CHAT_ID || '',
};

// ─── LOGGING ────────────────────────────────────────────────

const logs = [];
function log(m) {
  const e = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(e);
  logs.unshift(e);
  if (logs.length > 600) logs.length = 600;
}

// ─── STATE ──────────────────────────────────────────────────

const DB = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'ke4.json');

const S = {
  // Core
  trades: [], positions: [], signals: [], resolved: [],
  balance: C.bankroll * 100, dailyPnL: 0, dailyDate: '',
  totalPnL: 0, wins: 0, losses: 0, paperWins: 0, paperLosses: 0,
  isRunning: false, botStarted: null, lastError: null,
  // Counters
  scanCount: 0, brainCount: 0, totalClaude: 0,
  // Layer 1: Price tracker (ticker -> price history)
  priceHistory: {},    // { ticker: [{time, yes, no, vol}, ...] }
  candidates: [],      // top markets from scanner
  // Layer 2: Claude signals
  lastBrain: null,
  // Performance DB
  perfByCategory: {},  // { cat: {w,l} }
  perfByConfidence: { high: {w:0,l:0}, medium: {w:0,l:0}, low: {w:0,l:0} },
  perfBySide: { yes: {w:0,l:0}, no: {w:0,l:0} },
  // Market metadata cache
  marketMeta: {},      // ticker -> {title, category, close_time}
  news: [],
};

function loadDB() {
  try {
    if (fs.existsSync(DB)) {
      const d = JSON.parse(fs.readFileSync(DB, 'utf8'));
      Object.assign(S, d);
      log('📂 Loaded ' + S.trades.length + ' trades, ' + Object.keys(S.priceHistory).length + ' tracked markets');
    } else { log('📂 Fresh state'); }
  } catch (e) { log('DB load err: ' + e.message); }
}
function saveDB() {
  try {
    // Trim price history to last 30 entries per ticker
    for (const t in S.priceHistory) {
      if (S.priceHistory[t].length > 30) S.priceHistory[t] = S.priceHistory[t].slice(-30);
    }
    fs.writeFileSync(DB, JSON.stringify(S));
  } catch (e) {}
}

loadDB();
setInterval(saveDB, 20000);

// ─── HTTP ───────────────────────────────────────────────────

function req(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, ...opts }, res => {
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
  } catch (e) { return ''; }
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

// ─── DATA FETCHERS ──────────────────────────────────────────

async function fetchBalance() {
  try { const r = await api('GET', '/portfolio/balance'); if (r.status === 200) { S.balance = r.data.balance; return S.balance; } } catch (e) {}
  return S.balance;
}

async function fetchMarkets() {
  let all = [], cursor = null;
  for (let i = 0; i < 3; i++) {
    try {
      let ep = '/markets?status=open&limit=200';
      if (cursor) ep += '&cursor=' + cursor;
      const r = await api('GET', ep);
      if (r.status === 200 && r.data.markets) { all = all.concat(r.data.markets); cursor = r.data.cursor; }
      if (!cursor) break;
    } catch (e) { break; }
  }
  return all;
}

async function fetchPositions() {
  try { const r = await api('GET', '/portfolio/positions'); if (r.status === 200) { S.positions = r.data.market_positions || []; } } catch (e) {}
  return S.positions;
}

async function fetchOrderbook(ticker) {
  try { const r = await api('GET', `/markets/${ticker}/orderbook`); if (r.status === 200) return r.data; } catch (e) {}
  return null;
}

async function fetchMarket(ticker) {
  try { const r = await api('GET', `/markets/${ticker}`); if (r.status === 200) return r.data.market || r.data; } catch (e) {}
  return null;
}

async function fetchSettlements() {
  try { const r = await api('GET', '/portfolio/settlements?limit=50'); if (r.status === 200) return r.data.settlements || []; } catch (e) {}
  return [];
}

// ─── TELEGRAM ───────────────────────────────────────────────

async function tg(text) {
  if (!C.tgToken || !C.tgChat) return;
  try { await req(`https://api.telegram.org/bot${C.tgToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ chat_id: C.tgChat, text, parse_mode: 'HTML' })); } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 1: FAST SCANNER (every 30s, no Claude, pure math)
//  Tracks prices, detects momentum, scores opportunities
// ═══════════════════════════════════════════════════════════════

const GOOD_CATS = ['economics','economy','fed','finance','politics','political','crypto','bitcoin','inflation','interest','gdp','unemployment','cpi','climate','weather','tech','ai'];
const MEH_CATS = ['sports','nba','nfl','mlb','nhl','soccer','entertainment','culture','music','movies'];

function hoursUntilClose(m) {
  const ct = m.close_time || m.expected_expiration_time;
  if (!ct) return 999;
  return Math.max(0, (new Date(ct) - new Date()) / 3600000);
}

function scanScore(m) {
  const yp = m.yes_bid || m.yes_ask || m.last_price || 50;
  const vol = m.volume || m.volume_fp || m.dollar_volume || 0;
  const cat = (m.category || m.series_ticker || m.title || '').toLowerCase();
  const hrs = hoursUntilClose(m);

  let score = 0;

  // Volume (log scale — diminishing returns past 100k)
  score += Math.min(Math.log10(Math.max(vol, 1)) * 5, 30);

  // Category
  if (GOOD_CATS.some(c => cat.includes(c))) score += 25;
  else if (MEH_CATS.some(c => cat.includes(c))) score -= 5;

  // Time to close (sweet spot: 2-48 hours)
  if (hrs >= 1 && hrs <= 6) score += 30;      // imminent — highest value
  else if (hrs > 6 && hrs <= 24) score += 25;
  else if (hrs > 24 && hrs <= 72) score += 15;
  else if (hrs > 72 && hrs <= 168) score += 5;
  else if (hrs > 168) score -= 10;              // weeks away, deprioritize

  // Price zone (mid-range most exploitable, extreme prices = favourite-longshot)
  if (yp >= 30 && yp <= 70) score += 15;        // most edge potential
  else if (yp >= 80 || yp <= 20) score += 10;   // favourite-longshot plays
  // 20-30 and 70-80 are neutral

  // MOMENTUM BONUS: if we have price history, detect movement
  const hist = S.priceHistory[m.ticker];
  if (hist && hist.length >= 3) {
    const recent = hist.slice(-3);
    const oldPrice = recent[0].yes;
    const newPrice = yp;
    const move = Math.abs(newPrice - oldPrice);
    if (move >= 5) score += 20;  // 5+ cent move = something happening
    if (move >= 10) score += 15; // big move = news event
  }

  return score;
}

async function layer1_scan() {
  S.scanCount++;
  try {
    const markets = await fetchMarkets();
    if (!markets.length) { log('L1: no markets'); return; }

    const now = Date.now();

    // Track price history for every market
    for (const m of markets) {
      const yp = m.yes_bid || m.yes_ask || m.last_price || 50;
      const vol = m.volume || m.volume_fp || 0;
      if (!S.priceHistory[m.ticker]) S.priceHistory[m.ticker] = [];
      S.priceHistory[m.ticker].push({ time: now, yes: yp, vol });

      // Cache metadata
      S.marketMeta[m.ticker] = {
        title: m.title, category: m.category || m.series_ticker || '',
        close_time: m.close_time || m.expected_expiration_time || '',
      };
    }

    // Score all markets
    const scored = markets
      .filter(m => (m.status === 'open' || m.status === 'active'))
      .map(m => ({ ticker: m.ticker, score: scanScore(m), market: m }))
      .sort((a, b) => b.score - a.score);

    // Top 20 candidates for Claude
    S.candidates = scored.slice(0, 20).map(s => ({
      ticker: s.ticker,
      score: Math.round(s.score),
      title: s.market.title,
      yes: s.market.yes_bid || s.market.yes_ask || s.market.last_price || 50,
      no: s.market.no_bid || s.market.no_ask || (100 - (s.market.yes_bid || 50)),
      vol: s.market.volume || s.market.volume_fp || 0,
      category: (s.market.category || s.market.series_ticker || '').toLowerCase(),
      hoursLeft: hoursUntilClose(s.market).toFixed(1),
      momentum: getMomentum(s.ticker),
    }));

    // Detect big movers (alert-worthy)
    for (const m of markets) {
      const hist = S.priceHistory[m.ticker];
      if (hist && hist.length >= 2) {
        const prev = hist[hist.length - 2].yes;
        const curr = m.yes_bid || m.yes_ask || m.last_price || 50;
        const move = curr - prev;
        if (Math.abs(move) >= 8) {
          log(`⚡ BIG MOVE: ${m.ticker} ${move > 0 ? '+' : ''}${move}¢ (${prev}→${curr})`);
        }
      }
    }

    log(`L1 #${S.scanCount}: ${markets.length} mkts | ${S.candidates.length} candidates | top: ${S.candidates[0]?.ticker || 'none'} (${S.candidates[0]?.score || 0}pts)`);
  } catch (e) {
    log('L1 err: ' + e.message);
  }
}

function getMomentum(ticker) {
  const hist = S.priceHistory[ticker];
  if (!hist || hist.length < 2) return 'flat';
  const recent = hist.slice(-5);
  const first = recent[0].yes;
  const last = recent[recent.length - 1].yes;
  const diff = last - first;
  if (diff >= 5) return 'rising_' + diff + 'c';
  if (diff <= -5) return 'falling_' + Math.abs(diff) + 'c';
  return 'flat';
}

// Clean up old price history for markets that closed
function cleanHistory() {
  const now = Date.now();
  for (const ticker in S.priceHistory) {
    const entries = S.priceHistory[ticker];
    if (entries.length > 0 && now - entries[entries.length - 1].time > 86400000) {
      delete S.priceHistory[ticker]; // older than 24h, market probably closed
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 2: CLAUDE BRAIN (every 5min, only top candidates)
//  Deep analysis on pre-filtered opportunities
// ═══════════════════════════════════════════════════════════════

function getPerformanceContext() {
  const total = S.paperWins + S.paperLosses + S.wins + S.losses;
  if (total < 3) return '';

  const wr = ((S.paperWins + S.wins) / total * 100).toFixed(0);
  let ctx = `\nYOUR TRACK RECORD (${total} trades, ${wr}% win rate):`;

  const cats = Object.entries(S.perfByCategory)
    .filter(([_, v]) => v.w + v.l >= 2)
    .map(([cat, { w, l }]) => ({ cat, wr: ((w / (w + l)) * 100).toFixed(0), n: w + l }))
    .sort((a, b) => b.wr - a.wr);

  if (cats.length) ctx += '\nCategories: ' + cats.map(c => `${c.cat}:${c.wr}%(${c.n})`).join(' ');

  const best = cats.find(c => parseInt(c.wr) >= 60);
  const worst = cats.find(c => parseInt(c.wr) <= 40);
  if (best) ctx += `\n→ LEAN INTO ${best.cat} (${best.wr}% win rate)`;
  if (worst) ctx += `\n→ AVOID ${worst.cat} (${worst.wr}% win rate)`;

  return ctx;
}

// ─── CLAUDE MEMORY SYSTEM ───────────────────────────────────
// Builds a compressed briefing of everything Claude needs to
// remember between calls — trade history, patterns, portfolio

function buildMemory() {
  let mem = '';

  // Portfolio state
  const bankDollars = Math.max(S.balance / 100, C.bankroll).toFixed(2);
  mem += `PORTFOLIO: $${bankDollars}`;
  const totalTrades = S.paperWins + S.paperLosses + S.wins + S.losses;
  if (totalTrades > 0) {
    const wr = ((S.paperWins + S.wins) / totalTrades * 100).toFixed(0);
    mem += ` | ${totalTrades} trades, ${wr}% win rate`;
    mem += ` | P&L: $${(S.totalPnL / 100).toFixed(2)}`;
  }

  // Recent trade history (last 10 trades compressed)
  const recent = S.trades.slice(0, 10);
  if (recent.length > 0) {
    mem += '\n\nRECENT TRADES:';
    recent.forEach(t => {
      const result = t.resolved ? (t.outcome === 'win' ? '✓WIN' : '✗LOSS') : 'pending';
      mem += `\n- ${t.side.toUpperCase()} ${t.ticker} @${t.priceCents}¢ edge:${t.edge} conf:${t.confidence} → ${result}`;
    });
  }

  // Patterns learned from resolved trades
  if (totalTrades >= 5) {
    mem += '\n\nPATTERNS LEARNED:';

    // Best/worst confidence levels
    for (const [conf, {w, l}] of Object.entries(S.perfByConfidence)) {
      if (w + l >= 2) {
        const rate = ((w / (w + l)) * 100).toFixed(0);
        mem += `\n- "${conf}" confidence: ${rate}% win rate (${w}W/${l}L)`;
        if (parseInt(rate) < 45) mem += ' ← POORLY CALIBRATED, be more selective with this level';
        if (parseInt(rate) > 65) mem += ' ← WELL CALIBRATED, trust this level';
      }
    }

    // Best/worst sides
    for (const [side, {w, l}] of Object.entries(S.perfBySide)) {
      if (w + l >= 3) {
        const rate = ((w / (w + l)) * 100).toFixed(0);
        mem += `\n- ${side.toUpperCase()} bets: ${rate}% (${w}W/${l}L)`;
      }
    }

    // Category performance
    const catEntries = Object.entries(S.perfByCategory).filter(([_, v]) => v.w + v.l >= 2);
    if (catEntries.length) {
      catEntries.sort((a, b) => {
        const wrA = a[1].w / (a[1].w + a[1].l);
        const wrB = b[1].w / (b[1].w + b[1].l);
        return wrB - wrA;
      });
      catEntries.forEach(([cat, {w, l}]) => {
        const rate = ((w / (w + l)) * 100).toFixed(0);
        mem += `\n- ${cat}: ${rate}% (${w}W/${l}L)`;
      });
    }
  }

  // Price momentum alerts from scanner
  const movers = S.candidates.filter(c => c.momentum && !c.momentum.startsWith('flat'));
  if (movers.length > 0) {
    mem += '\n\nACTIVE MOMENTUM:';
    movers.forEach(m => {
      mem += `\n- ${m.ticker}: ${m.momentum}`;
    });
  }

  // Current open positions
  if (S.positions.length > 0) {
    mem += '\n\nOPEN POSITIONS:';
    S.positions.forEach(p => {
      const ticker = p.ticker || p.market_ticker;
      const entry = S.trades.find(t => t.ticker === ticker);
      mem += `\n- ${ticker}: ${p.position} contracts`;
      if (entry) mem += ` (entered @${entry.priceCents}¢, ${entry.side})`;
    });
  }

  // Tickers to avoid (recently traded, don't double up)
  const recentTickers = [...new Set(S.trades.slice(0, 30).map(t => t.ticker))];
  if (recentTickers.length > 0) {
    mem += `\n\nALREADY TRADED (skip these): ${recentTickers.slice(0, 15).join(', ')}`;
  }

  return mem;
}

// ─── FALLBACK TRADER (no Claude needed) ─────────────────────
// Pure math-based trading when Claude credits are depleted
// Uses favourite-longshot bias + momentum signals

let claudeDown = false;
let lastCreditCheck = 0;

async function fallbackTrader() {
  if (!S.candidates.length) return;

  const pos = S.positions;
  const held = new Set(pos.map(p => p.ticker || p.market_ticker));
  const recent = new Set(S.trades.slice(0, 50).map(t => t.ticker));
  const slots = C.maxOpen - pos.length;
  if (slots <= 0) return;

  // Strategy: favourite-longshot bias on high-score candidates
  // Buy NO on cheap YES (<15¢) = sell the longshot
  // Buy YES on expensive YES (>85¢) = buy the favourite
  const plays = S.candidates
    .filter(c => !held.has(c.ticker) && !recent.has(c.ticker))
    .filter(c => {
      // Only play extreme prices with strong momentum/volume
      if (c.yes <= 12 && c.score >= 40) return true;  // longshot to sell
      if (c.yes >= 88 && c.score >= 40) return true;  // favourite to buy
      // Strong momentum + mid-price
      if (c.momentum.includes('rising') && c.yes >= 40 && c.yes <= 70 && c.score >= 50) return true;
      if (c.momentum.includes('falling') && c.yes >= 30 && c.yes <= 60 && c.score >= 50) return true;
      return false;
    })
    .map(c => {
      let side, edge;
      if (c.yes <= 12) { side = 'no'; edge = 0.08; }        // longshot bias
      else if (c.yes >= 88) { side = 'yes'; edge = 0.06; }   // favourite bias
      else if (c.momentum.includes('rising')) { side = 'yes'; edge = 0.05; }
      else { side = 'no'; edge = 0.05; }
      return { ticker: c.ticker, title: c.title, side, marketPrice: c.yes / 100, edge, confidence: 'medium', reasoning: 'Fallback: ' + (c.yes <= 12 ? 'longshot bias' : c.yes >= 88 ? 'favourite bias' : 'momentum'), trueProb: side === 'yes' ? c.yes / 100 + edge : (100 - c.yes) / 100 + edge };
    })
    .slice(0, Math.min(slots, 1)); // conservative: max 1 fallback trade per cycle

  for (const sig of plays) {
    log(`🔧 FALLBACK: ${sig.side.toUpperCase()} ${sig.ticker} (${sig.reasoning})`);
    await placeTrade(sig);
  }
}

// Credit recovery check — test Claude every 10 minutes when down
async function checkCreditRecovery() {
  if (!claudeDown) return;
  const now = Date.now();
  if (now - lastCreditCheck < 600000) return; // check every 10min
  lastCreditCheck = now;

  try {
    const r = await req('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': C.claudeKey, 'anthropic-version': '2023-06-01' },
    }, JSON.stringify({ model: C.claudeModel, max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }));

    if (!r.data.error) {
      claudeDown = false;
      log('🟢 Claude credits restored! Resuming AI analysis.');
      tg('🟢 <b>Claude back online!</b>\nResuming AI-powered analysis.').catch(() => {});
    }
  } catch (e) {}
}

async function layer2_brain() {
  if (!C.claudeKey) { log('L2: no Claude key'); return; }
  if (!S.candidates.length) { log('L2: no candidates from scanner'); return; }

  // If Claude is down, run fallback + check recovery
  if (claudeDown) {
    await checkCreditRecovery();
    if (claudeDown) {
      log('L2: Claude offline, running fallback trader');
      await fallbackTrader();
      return;
    }
  }

  S.brainCount++;
  S.totalClaude++;

  // Fetch orderbooks for top 5
  const top5 = S.candidates.slice(0, 5);
  const orderbooks = {};
  await Promise.all(top5.map(async c => {
    const ob = await fetchOrderbook(c.ticker);
    if (ob) orderbooks[c.ticker] = ob;
  }));

  // Build market descriptions with rich data
  const mBlock = S.candidates.map((c, i) => {
    let line = `${i+1}. "${c.title}" [${c.ticker}]`;
    line += `\n   YES:${c.yes}¢ NO:${c.no}¢ | Vol:${c.vol} | ${c.hoursLeft}h left | Cat:${c.category}`;
    line += `\n   Momentum: ${c.momentum} | Scanner score: ${c.score}`;

    const ob = orderbooks[c.ticker];
    if (ob?.orderbook_fp) {
      const yb = ob.orderbook_fp.yes_dollars || ob.orderbook_fp.yes || [];
      const nb = ob.orderbook_fp.no_dollars || ob.orderbook_fp.no || [];
      const yd = yb.reduce((a, b) => a + (b[1] || 0), 0);
      const nd = nb.reduce((a, b) => a + (b[1] || 0), 0);
      line += `\n   Book: YesDepth:${yd} NoDepth:${nd} Spread:${yb[0]?.[0] || '?'}-${nb[0]?.[0] || '?'}`;
    }
    return line;
  }).join('\n\n');

  const perf = getPerformanceContext();
  const memory = buildMemory();
  const bankDollars = Math.max(S.balance / 100, C.bankroll).toFixed(2);

  const body = JSON.stringify({
    model: C.claudeModel, max_tokens: 3000,
    system: `You are an autonomous prediction market portfolio manager on Kalshi. You manage $${bankDollars}.

GOAL: Double the portfolio as quickly and safely as possible. Target 55-65% win rate with Kelly sizing.

MECHANICS:
- Binary contracts: YES=$1, NO=$0. Prices 1-99 cents.
- Buy the UNDERPRICED side. Your edge = |your_probability - market_price|.
- Minimum edge to signal: ${(C.edgeMin*100).toFixed(0)} cents.

WHAT WINS:
1. Markets closing in 1-48 hours where you have strong knowledge (most predictable)
2. Favourite-longshot bias: contracts 85-95¢ win MORE than implied → buy them. Contracts 5-15¢ win LESS → sell them (buy NO).
3. Momentum + fundamentals alignment: if price is RISING and fundamentals support it, ride it
4. Orderbook imbalance: heavy depth on one side signals where smart money is positioned
5. Categories you're proven good at (see your track record below)

WHAT LOSES:
1. Multi-leg parlays (compound probability = bad math, almost always overpriced)
2. Markets weeks from close (too much uncertainty)
3. Sports bets without real informational edge (the line is already efficient)
4. Going against strong momentum without strong reason
5. Low-confidence guesses on topics you don't understand

POSITION SIZING GUIDANCE:
- "high" confidence → full Kelly (bigger bets, more concentrated)
- "medium" confidence → half Kelly
- "low" confidence → skip unless edge is enormous (15%+)

These ${S.candidates.length} markets were pre-selected by our scanner from ${Object.keys(S.priceHistory).length}+ active markets based on volume, category, time-to-close, and price momentum. They are the BEST opportunities right now.
${perf}

OUTPUT: Valid JSON array ONLY. No markdown, no text.
Each: {"ticker":"X","title":"short","side":"yes"|"no","marketPrice":0.XX,"trueProb":0.XX,"edge":0.XX,"confidence":"high"|"medium"|"low","reasoning":"max 20 words"}
No edge? Return: []`,
    messages: [{ role: 'user', content: `DATE: ${new Date().toISOString().slice(0, 16)}Z\n\n=== YOUR MEMORY ===\n${memory}\n\n=== PRE-FILTERED CANDIDATES ===\n${mBlock}\n\nAnalyze each. Use your memory to inform decisions. Signal ONLY genuine edge. Be aggressive on high-conviction.` }],
  });

  try {
    const r = await req('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': C.claudeKey, 'anthropic-version': '2023-06-01' },
    }, body);

    if (r.data.error) {
      const msg = r.data.error.message || JSON.stringify(r.data.error);
      log('L2 Claude err: ' + msg);
      if (msg.includes('credit') || msg.includes('billing')) {
        claudeDown = true;
        tg('🚨 <b>Claude credits depleted!</b>\nSwitching to fallback trader.\nconsole.anthropic.com').catch(() => {});
        await fallbackTrader();
      }
      return;
    }

    const raw = (r.data.content || []).map(c => c.text || '').join('');
    let sigs = [];

    // Robust JSON extraction — Claude sometimes wraps JSON in text
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      sigs = JSON.parse(cleaned);
    } catch (e1) {
      // Try to find JSON array in the response
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        try { sigs = JSON.parse(match[0]); } catch (e2) {}
      }
      // If Claude returned empty text or just words, treat as no signals
      if (!sigs.length) {
        log('L2 🧠 Claude returned text (no JSON): ' + raw.slice(0, 80));
      }
    }

    if (!Array.isArray(sigs)) sigs = [];
    S.signals = sigs;

    if (sigs.length > 0) {
      log(`L2 🧠 ${sigs.length} signal(s): ${sigs.map(s => s.ticker + '(' + s.side + ',' + (s.edge * 100).toFixed(0) + '%)').join(' ')}`);
      await layer3_execute(sigs);
    } else {
      log('L2 🧠 No edge in ' + S.candidates.length + ' candidates');
      // Run fallback trader when Claude finds nothing
      await fallbackTrader();
    }

    S.lastBrain = new Date().toISOString();
  } catch (e) {
    log('L2 err: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 3: EXECUTION + POSITION MANAGEMENT
//  Places orders, manages exits, tracks P&L
// ═══════════════════════════════════════════════════════════════

function kellySize(edge, mktPrice, side, confidence) {
  const cost = side === 'yes' ? mktPrice : (1 - mktPrice);
  if (cost <= 0.01 || cost >= 0.99 || edge <= 0) return 0;

  const odds = (1 - cost) / cost;
  const wp = Math.min(cost + edge, 0.95);
  const k = (wp * odds - (1 - wp)) / odds;
  if (k <= 0) return 0;

  // Confidence multiplier
  const confMult = confidence === 'high' ? 1.0 : confidence === 'medium' ? 0.5 : 0.25;
  const frac = k * C.kelly * confMult;

  // Dynamic bankroll (use actual balance, not static config)
  const bank = Math.max(S.balance / 100, C.bankroll);
  const dollars = Math.min(C.maxPos, Math.max(0.50, frac * bank));
  return Math.max(1, Math.min(Math.floor(dollars / cost), 100));
}

async function layer3_execute(signals) {
  const pos = S.positions;
  const held = new Set(pos.map(p => p.ticker || p.market_ticker));
  const recent = new Set(S.trades.slice(0, 50).map(t => t.ticker));

  const fresh = signals
    .filter(s => !held.has(s.ticker) && !recent.has(s.ticker))
    .filter(s => s.confidence !== 'low' || s.edge >= 0.15) // low conf only if huge edge
    .sort((a, b) => {
      const sa = (a.edge || 0) * (a.confidence === 'high' ? 2 : a.confidence === 'medium' ? 1 : 0.3);
      const sb = (b.edge || 0) * (b.confidence === 'high' ? 2 : b.confidence === 'medium' ? 1 : 0.3);
      return sb - sa;
    });

  const slots = C.maxOpen - pos.length;
  if (slots <= 0) { log('L3: max positions reached'); return; }

  for (const sig of fresh.slice(0, Math.min(slots, 3))) {
    await placeTrade(sig);
    await new Promise(r => setTimeout(r, 1500));
  }
}

async function placeTrade(sig) {
  const { ticker, side, marketPrice, edge, confidence, reasoning } = sig;
  const contracts = kellySize(edge, marketPrice, side, confidence);
  if (contracts <= 0) { log('L3 Kelly skip: ' + ticker); return; }

  const pc = side === 'yes' ? Math.round(marketPrice * 100) : Math.round((1 - marketPrice) * 100);
  const cost = ((contracts * pc) / 100).toFixed(2);
  const maxPay = ((contracts * (100 - pc)) / 100).toFixed(2);

  const rec = {
    id: uuid(), ticker, title: sig.title || ticker, side, contracts, priceCents: pc,
    costDollars: cost, maxPayout: maxPay, edge: (edge * 100).toFixed(1) + '%',
    confidence, reasoning, category: sig.category || S.marketMeta[ticker]?.category || '',
    marketPriceAtEntry: marketPrice, timestamp: new Date().toISOString(),
    status: 'pending', dryRun: C.dryRun, resolved: false, outcome: null, pnl: null,
  };

  if (C.dryRun) {
    rec.status = 'simulated';
    S.trades.unshift(rec);
    if (S.trades.length > 500) S.trades.length = 500;
    saveDB();
    log(`📋 PAPER: ${side.toUpperCase()} ${contracts}x ${ticker} @${pc}¢ ($${cost}→$${maxPay}) ${rec.edge} [${confidence}]`);
    tg(`🧪 <b>PAPER TRADE</b>\n${side.toUpperCase()} ${contracts}x <code>${ticker}</code>\n@${pc}¢ | $${cost} risk → $${maxPay} potential\nEdge: ${rec.edge} | ${confidence}\n💡 ${reasoning}`).catch(() => {});
    return rec;
  }

  // LIVE ORDER
  const order = { ticker, action: 'buy', side, count: contracts, type: 'limit', client_order_id: uuid() };
  if (side === 'yes') order.yes_price = pc; else order.no_price = pc;

  try {
    const r = await api('POST', '/portfolio/orders', order);
    if (r.status === 201 || r.status === 200) {
      rec.status = 'placed'; rec.orderId = r.data.order?.order_id;
      log(`✅ LIVE: ${side.toUpperCase()} ${contracts}x ${ticker} @${pc}¢`);
      tg(`✅ <b>LIVE ORDER</b>\n${side.toUpperCase()} ${contracts}x <code>${ticker}</code>\n@${pc}¢ | $${cost}→$${maxPay}\n${rec.edge} | ${reasoning}`).catch(() => {});
    } else {
      rec.status = 'error'; rec.error = JSON.stringify(r.data).slice(0, 300);
      log('❌ Order err ' + r.status);
    }
  } catch (e) { rec.status = 'error'; rec.error = e.message; }

  S.trades.unshift(rec);
  if (S.trades.length > 500) S.trades.length = 500;
  saveDB();
  return rec;
}

// ─── POSITION EXITS ─────────────────────────────────────────

async function checkExits() {
  if (C.dryRun || !S.positions.length) return;

  for (const pos of S.positions) {
    const ticker = pos.ticker || pos.market_ticker;
    const entry = S.trades.find(t => t.ticker === ticker && (t.status === 'placed' || t.status === 'filled'));
    if (!entry) continue;

    const hist = S.priceHistory[ticker];
    if (!hist || !hist.length) continue;

    const currentYes = hist[hist.length - 1].yes / 100;
    const entryPrice = entry.marketPriceAtEntry || 0.5;
    const priceNow = entry.side === 'yes' ? currentYes : (1 - currentYes);
    const priceEntry = entry.side === 'yes' ? entryPrice : (1 - entryPrice);
    const move = priceNow - priceEntry;

    if (move >= 0.15) {
      log(`📈 EXIT: ${ticker} +${(move * 100).toFixed(0)}¢ profit`);
      tg(`📈 <b>TAKE PROFIT</b> <code>${ticker}</code> +${(move * 100).toFixed(0)}¢`).catch(() => {});
      // Place sell order...
      const sellOrder = { ticker, action: 'sell', side: entry.side, count: Math.abs(pos.position || 1), type: 'limit', client_order_id: uuid() };
      if (entry.side === 'yes') sellOrder.yes_price = Math.round(currentYes * 100);
      else sellOrder.no_price = Math.round((1 - currentYes) * 100);
      try { await api('POST', '/portfolio/orders', sellOrder); } catch (e) {}
    } else if (move <= -0.12) {
      log(`📉 EXIT: ${ticker} ${(move * 100).toFixed(0)}¢ loss`);
      tg(`📉 <b>CUT LOSS</b> <code>${ticker}</code> ${(move * 100).toFixed(0)}¢`).catch(() => {});
      const sellOrder = { ticker, action: 'sell', side: entry.side, count: Math.abs(pos.position || 1), type: 'limit', client_order_id: uuid() };
      if (entry.side === 'yes') sellOrder.yes_price = Math.round(currentYes * 100);
      else sellOrder.no_price = Math.round((1 - currentYes) * 100);
      try { await api('POST', '/portfolio/orders', sellOrder); } catch (e) {}
    }
  }
}

// ─── PAPER GRADING ──────────────────────────────────────────

async function gradePaperTrades() {
  const unresolved = S.trades.filter(t => t.dryRun && !t.resolved && t.status === 'simulated');
  for (const t of unresolved.slice(0, 3)) {
    const mkt = await fetchMarket(t.ticker);
    if (!mkt) continue;
    const st = mkt.status || mkt.result;
    if (st !== 'settled' && st !== 'finalized' && st !== 'closed') continue;

    const result = mkt.result ?? mkt.settlement_value;
    if (result === undefined || result === null) continue;

    const won = (t.side === 'yes' && (result === 'yes' || result === 1)) ||
                (t.side === 'no' && (result === 'no' || result === 0));

    t.resolved = true; t.outcome = won ? 'win' : 'loss';
    const costC = t.contracts * t.priceCents;
    const payC = won ? t.contracts * 100 : 0;
    t.pnl = ((payC - costC) / 100).toFixed(2);

    if (won) { S.paperWins++; S.totalPnL += (payC - costC); }
    else { S.paperLosses++; S.totalPnL -= costC; }
    S.dailyPnL += won ? (payC - costC) : -costC;

    // Update performance DB
    const cat = (t.category || S.marketMeta[t.ticker]?.category || 'other').toLowerCase();
    if (!S.perfByCategory[cat]) S.perfByCategory[cat] = { w: 0, l: 0 };
    if (won) S.perfByCategory[cat].w++; else S.perfByCategory[cat].l++;
    const conf = t.confidence || 'medium';
    if (S.perfByConfidence[conf]) { if (won) S.perfByConfidence[conf].w++; else S.perfByConfidence[conf].l++; }
    if (S.perfBySide[t.side]) { if (won) S.perfBySide[t.side].w++; else S.perfBySide[t.side].l++; }

    log(`📊 RESOLVED: ${t.ticker} → ${won ? 'WIN' : 'LOSS'} $${t.pnl}`);
    tg(`${won ? '🏆' : '💸'} <b>PAPER ${won ? 'WIN' : 'LOSS'}</b>\n<code>${t.ticker}</code> ${t.side.toUpperCase()} @${t.priceCents}¢\nP&L: $${t.pnl}\nRecord: ${S.paperWins + S.wins}W/${S.paperLosses + S.losses}L`).catch(() => {});
  }
}

// ─── LIVE SETTLEMENTS ───────────────────────────────────────

async function trackSettlements() {
  if (C.dryRun) return;
  try {
    const setts = await fetchSettlements();
    const known = new Set(S.resolved.map(r => r.id || r.market_id));
    for (const s of setts) {
      const id = s.market_id || s.ticker || s.id;
      if (known.has(id)) continue;
      S.resolved.push({ ...s, id });
      const rev = (s.revenue || 0) / 100;
      const win = rev > 0;
      if (win) S.wins++; else S.losses++;
      S.totalPnL += (s.revenue || 0);
      S.dailyPnL += (s.revenue || 0);
      tg(`${win ? '🏆' : '💸'} <b>${win ? 'WIN' : 'LOSS'}</b>\n<code>${s.ticker || id}</code>\n$${rev.toFixed(2)} | Bal: $${(S.balance / 100).toFixed(2)}`).catch(() => {});
    }
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
//  ORCHESTRATOR — Runs the three layers on their schedules
// ═══════════════════════════════════════════════════════════════

let scanTimer = null, brainTimer = null;

async function runScan() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (S.dailyDate !== today) {
      const yp = S.dailyPnL;
      S.dailyPnL = 0; S.dailyDate = today;
      log(`📅 New day | Yesterday: $${(yp / 100).toFixed(2)}`);
      tg(`📅 <b>Daily Reset</b>\nYesterday: $${(yp / 100).toFixed(2)}\nRecord: ${S.paperWins + S.wins}W/${S.paperLosses + S.losses}L\nBalance: $${(S.balance / 100).toFixed(2)}`).catch(() => {});
    }

    if (S.dailyPnL <= -(C.maxLoss * 100)) { log('🛑 Daily loss limit'); return; }

    await Promise.all([fetchBalance(), fetchPositions()]);
    await layer1_scan();
    await checkExits();
    await gradePaperTrades();
    await trackSettlements();

    // Clean old data periodically
    if (S.scanCount % 100 === 0) cleanHistory();

    S.lastError = null;
    saveDB();
  } catch (e) {
    S.lastError = e.message;
    log('Scan err: ' + e.message);
  }
}

async function runBrain() {
  try {
    await layer2_brain();
    saveDB();
  } catch (e) {
    log('Brain err: ' + e.message);
  }
}

function startBot() {
  if (S.isRunning) return;
  S.isRunning = true; S.botStarted = new Date().toISOString();
  log('🚀 v4 Started | ' + (C.dryRun ? 'PAPER' : 'LIVE'));
  tg(`🚀 <b>Kalshi Edge v4</b>\n${C.dryRun ? '📋 Paper' : '⚡ LIVE'} | $${C.bankroll}\nScanner: ${C.scanInterval}s | Brain: ${C.brainInterval}s\nEdge: ${C.edgeMin * 100}% | Kelly: ${C.kelly}\nMax: $${C.maxPos}/trade, ${C.maxOpen} positions`).catch(() => {});

  // Layer 1: fast scan every 30s
  runScan();
  scanTimer = setInterval(() => runScan().catch(e => log('scan catch: ' + e.message)), C.scanInterval * 1000);

  // Layer 2: Claude brain every 5min (first run after 60s to let scanner populate)
  setTimeout(() => {
    runBrain().catch(e => log('brain catch: ' + e.message));
    brainTimer = setInterval(() => runBrain().catch(e => log('brain catch: ' + e.message)), C.brainInterval * 1000);
  }, 60000);

  saveDB();
}

function stopBot() {
  S.isRunning = false;
  if (scanTimer) clearInterval(scanTimer); scanTimer = null;
  if (brainTimer) clearInterval(brainTimer); brainTimer = null;
  log('⏹ Stopped');
  tg('⏹ <b>Kalshi Edge Stopped</b>').catch(() => {});
  saveDB();
}

// Process safety
process.on('unhandledRejection', e => log('⚠️ unhandled: ' + (e?.message || e)));
process.on('uncaughtException', e => log('⚠️ uncaught: ' + (e?.message || e)));

// ─── API ROUTES ─────────────────────────────────────────────

app.get('/api/status', (_, res) => {
  const tw = S.wins + S.paperWins, tl = S.losses + S.paperLosses, tot = tw + tl;
  res.json({
    isRunning: S.isRunning, dryRun: C.dryRun, balance: S.balance, bankroll: C.bankroll,
    totalPnL: S.totalPnL, dailyPnL: S.dailyPnL, wins: tw, losses: tl,
    winRate: tot > 0 ? ((tw / tot) * 100).toFixed(1) : '0.0',
    openPositions: S.positions.length, maxConcurrent: C.maxOpen,
    lastBrain: S.lastBrain, lastError: S.lastError, botStarted: S.botStarted,
    scanCount: S.scanCount, brainCount: S.brainCount, totalClaude: S.totalClaude,
    candidates: S.candidates.length, trackedMarkets: Object.keys(S.priceHistory).length,
    config: { kelly: C.kelly, edgeMin: C.edgeMin, maxPos: C.maxPos, maxLoss: C.maxLoss, scanInt: C.scanInterval, brainInt: C.brainInterval },
  });
});

app.get('/api/trades', (_, res) => res.json(S.trades.slice(0, 50)));
app.get('/api/positions', (_, res) => res.json(S.positions));
app.get('/api/signals', (_, res) => res.json(S.signals));
app.get('/api/candidates', (_, res) => res.json(S.candidates));
app.get('/api/logs', (_, res) => res.json(logs.slice(0, 200)));
app.get('/api/performance', (_, res) => res.json({ byCategory: S.perfByCategory, byConfidence: S.perfByConfidence, bySide: S.perfBySide, totalPnL: (S.totalPnL / 100).toFixed(2) }));
app.post('/api/bot/start', (_, res) => { startBot(); res.json({ ok: true }); });
app.post('/api/bot/stop', (_, res) => { stopBot(); res.json({ ok: true }); });
app.post('/api/bot/cycle', async (_, res) => { try { await runScan(); await runBrain(); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); } });

app.get('/api/test-connection', async (_, res) => {
  try {
    const [b, m] = await Promise.all([api('GET', '/portfolio/balance'), api('GET', '/markets?status=open&limit=5')]);
    const mkts = m.data.markets || [];
    res.json({
      auth: b.status === 200 ? 'ok' : 'failed', authStatus: b.status,
      authError: b.status !== 200 ? JSON.stringify(b.data).slice(0, 200) : null,
      balance: b.status === 200 ? b.data : null,
      markets: m.status === 200 ? `${mkts.length} markets` : 'failed',
      sampleMarket: mkts[0] ? { ticker: mkts[0].ticker, title: mkts[0].title, yes_bid: mkts[0].yes_bid, volume: mkts[0].volume } : null,
    });
  } catch (e) { res.json({ auth: 'error', error: e.message }); }
});

// ─── DASHBOARD ──────────────────────────────────────────────

app.get('/', (_, res) => { res.setHeader('Content-Type', 'text/html'); res.send(HTML()); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Kalshi Edge v4 on :${PORT}`);
  log(`${C.dryRun ? 'PAPER' : 'LIVE'} | $${C.bankroll} | Kelly:${C.kelly} | Edge:${C.edgeMin*100}%`);
  log(`Scanner:${C.scanInterval}s | Brain:${C.brainInterval}s | TG:${C.tgToken ? '✓' : '✗'} | Claude:${C.claudeKey ? '✓' : '✗'}`);
  if (C.apiKeyId && C.privateKey) { log('Starting in 3s...'); setTimeout(startBot, 3000); }
  else log('⚠️ Set KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY');
});

function HTML() {
return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#050505"><title>Kalshi Edge</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap" rel="stylesheet">
<style>
:root{--bg:#050505;--s1:#111113;--s2:#1a1a1e;--s3:#28282d;--bd:rgba(255,255,255,.06);--bd2:rgba(255,255,255,.12);--t:#f5f5f7;--t2:#a1a1a6;--t3:#636366;--g:#30d158;--gd:rgba(48,209,88,.12);--r:#ff453a;--rd:rgba(255,69,58,.12);--b:#0a84ff;--bld:rgba(10,132,255,.12);--o:#ff9f0a;--od:rgba(255,159,10,.12);--p:#bf5af2;--R:16px;--st:env(safe-area-inset-top,20px);--sb:env(safe-area-inset-bottom,0px)}
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',-apple-system,sans-serif;background:var(--bg);color:var(--t);-webkit-font-smoothing:antialiased;min-height:100dvh;padding-top:var(--st);padding-bottom:calc(72px + var(--sb));overflow-x:hidden}
.H{padding:12px 20px 8px;display:flex;align-items:center;justify-content:space-between}.Hb{display:flex;align-items:center;gap:10px}.Hl{width:34px;height:34px;background:linear-gradient(135deg,#30d158,#0a84ff);border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#000}.Ht{font-size:21px;font-weight:700;letter-spacing:-.4px}
.tg{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;padding:4px 10px;border-radius:20px}.td{background:var(--od);color:var(--o)}.tl{background:var(--gd);color:var(--g)}.to{background:var(--rd);color:var(--r)}
.hero{margin:8px 16px 0;padding:22px 20px;background:var(--s1);border-radius:20px;border:1px solid var(--bd);position:relative;overflow:hidden}
.bl{font-size:11px;color:var(--t3);font-weight:600;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px}.bv{font-size:44px;font-weight:700;letter-spacing:-2.5px;line-height:1;margin-bottom:10px;font-variant-numeric:tabular-nums}
.pr{display:flex;gap:14px;flex-wrap:wrap}.pi{display:flex;align-items:center;gap:5px;font-size:13px;font-weight:500}.pb{font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;font-variant-numeric:tabular-nums}.pu{background:var(--gd);color:var(--g)}.pd{background:var(--rd);color:var(--r)}.pn{background:var(--s3);color:var(--t3)}
.G{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 16px 0}.Gc{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:12px 6px;text-align:center}.Gv{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}.Gl{font-size:8px;color:var(--t3);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
.ct{display:flex;gap:6px;margin:10px 16px 0}.bn{flex:1;padding:13px;border:none;border-radius:var(--R);font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px}.bn:active{transform:scale(.96)}.bg{background:var(--g);color:#000}.bs{background:var(--r);color:#fff}.bc{background:var(--s2);color:var(--t);border:1px solid var(--bd2);flex:.5}.bt{background:var(--bld);color:var(--b);border:1px solid rgba(10,132,255,.15);flex:.5}
.S{margin:18px 16px 0}.Sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.St{font-size:15px;font-weight:700}.Sn{font-size:11px;color:var(--t3);background:var(--s2);padding:2px 8px;border-radius:10px}
.CL{display:flex;flex-direction:column;gap:5px}
.TC{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:12px 14px}.Tt{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:5px}.Tk{font-size:13px;font-weight:600;line-height:1.3;flex:1}
.Ts{font-size:10px;font-weight:700;text-transform:uppercase;padding:3px 7px;border-radius:5px;flex-shrink:0}.sy{background:var(--gd);color:var(--g)}.sn{background:var(--rd);color:var(--r)}
.Tm{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--t3)}.Tm span{display:flex;align-items:center;gap:2px}
.Tr{font-size:11px;color:var(--t2);margin-top:5px;line-height:1.4;font-style:italic}
.Tx{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;text-transform:uppercase}.xs{background:var(--od);color:var(--o)}.xp{background:var(--gd);color:var(--g)}.xe{background:var(--rd);color:var(--r)}.xw{background:var(--gd);color:var(--g)}.xl{background:var(--rd);color:var(--r)}
.LP{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:10px;max-height:350px;overflow-y:auto;font-family:'SF Mono',Menlo,monospace;font-size:10px;line-height:1.7;color:var(--t3);-webkit-overflow-scrolling:touch}
.EM{text-align:center;padding:20px 16px;color:var(--t3);font-size:12px}
.M{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:100;display:none;align-items:flex-end;justify-content:center}.M.open{display:flex}.Ms{background:var(--s1);border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:20px;padding-bottom:calc(20px + var(--sb));animation:su .3s ease}@keyframes su{from{transform:translateY(100%)}to{transform:translateY(0)}}.Mh{width:36px;height:5px;background:var(--s3);border-radius:3px;margin:0 auto 14px}.Mt{font-size:17px;font-weight:700;margin-bottom:10px}
.TR{padding:10px;background:var(--s2);border-radius:10px;margin-bottom:6px;font-size:12px}.TR .l{color:var(--t3);font-size:10px;text-transform:uppercase}.TR .v{font-weight:600;margin-top:1px}.Tok{border-left:3px solid var(--g)}.Tfl{border-left:3px solid var(--r)}
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
<div class="Gc"><div class="Gv" id="sc" style="color:var(--p)">0/0</div><div class="Gl">Scan/Brain</div></div>
</div>
<div class="ct"><button class="bn bg" id="bG" onclick="sB()">&#9654; Start</button><button class="bn bs" id="bS" onclick="xB()" style="display:none">&#9632; Stop</button><button class="bn bc" id="bC" onclick="cy()">&#8635; Cycle</button><button class="bn bt" onclick="tt()">&#10003; Test</button></div>
<div class="S"><div class="Sh"><div class="St">Trades</div><div class="Sn" id="tC">0</div></div>
<div class="CL" id="tL"><div class="EM">Waiting for signals...</div></div></div></div>

<div id="vC" class="V"><div class="S" style="margin-top:6px"><div class="Sh"><div class="St">Scanner Candidates</div><div class="Sn" id="cC">0</div></div>
<div class="CL" id="cL"><div class="EM">Scanner populating...</div></div></div></div>

<div id="vI" class="V"><div class="S" style="margin-top:6px"><div class="Sh"><div class="St">Claude Signals</div><div class="Sn" id="sCC">0</div></div>
<div class="CL" id="sL"><div class="EM">Waiting for brain cycle...</div></div></div></div>

<div id="vL" class="V"><div class="S" style="margin-top:6px"><div class="Sh"><div class="St">Logs</div><div class="Sn" id="lC">#0</div></div>
<div class="LP" id="lP"><div class="EM">Starting...</div></div></div></div>

<div class="M" id="md" onclick="if(event.target===this)this.classList.remove('open')">
<div class="Ms"><div class="Mh"></div><div class="Mt">Connection Test</div><div id="tR"><div style="text-align:center;padding:20px"><div class="sp"></div></div></div>
<button class="bn" style="background:var(--s2);color:var(--t);margin-top:10px;width:100%" onclick="document.getElementById('md').classList.remove('open')">Done</button></div></div>

<div class="TB">
<button class="tab a" onclick="sw('D',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Home</button>
<button class="tab" onclick="sw('C',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Scanner</button>
<button class="tab" onclick="sw('I',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>Signals</button>
<button class="tab" onclick="sw('L',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Logs</button>
</div>

<script>
var E=s=>s?(s+'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'';
function sw(n,t){document.querySelectorAll('.V').forEach(v=>v.classList.remove('a'));document.querySelectorAll('.tab').forEach(t=>t.classList.remove('a'));document.getElementById('v'+n).classList.add('a');t.classList.add('a')}
async function sB(){await fetch('/api/bot/start',{method:'POST'});gA()}
async function xB(){await fetch('/api/bot/stop',{method:'POST'});gA()}
async function cy(){var b=document.getElementById('bC');b.innerHTML='<div class="sp"></div>';b.disabled=true;try{await fetch('/api/bot/cycle',{method:'POST'});await gA()}finally{b.innerHTML='&#8635; Cycle';b.disabled=false}}
async function tt(){var m=document.getElementById('md'),r=document.getElementById('tR');m.classList.add('open');r.innerHTML='<div style="text-align:center;padding:20px"><div class="sp"></div></div>';try{var d=await(await fetch('/api/test-connection')).json();r.innerHTML='<div class="TR '+(d.auth==='ok'?'Tok':'Tfl')+'"><div class="l">Auth</div><div class="v">'+(d.auth==='ok'?'&#10004; Connected':'&#10006; '+E(d.authError||d.authStatus))+'</div></div>'+(d.auth==='ok'?'<div class="TR Tok"><div class="l">Balance</div><div class="v">$'+((d.balance?.balance||0)/100).toFixed(2)+'</div></div>':'')+'<div class="TR '+(d.markets&&!String(d.markets).includes('fail')?'Tok':'Tfl')+'"><div class="l">Markets</div><div class="v">'+E(d.markets)+'</div></div>'+(d.sampleMarket?'<div class="TR Tok"><div class="l">Sample</div><div class="v">'+E(d.sampleMarket.title)+'</div></div>':'')}catch(x){r.innerHTML='<div class="TR Tfl"><div class="l">Error</div><div class="v">'+E(x.message)+'</div></div>'}}

function uD(d){
document.getElementById('bal').textContent='$'+(d.balance/100).toFixed(2);
var te=document.getElementById('tP'),de=document.getElementById('dP'),tv=d.totalPnL/100,dv=d.dailyPnL/100;
te.textContent=(tv>=0?'+':'')+tv.toFixed(2);te.className='pb '+(tv>0?'pu':tv<0?'pd':'pn');
de.textContent=(dv>=0?'+':'')+dv.toFixed(2);de.className='pb '+(dv>0?'pu':dv<0?'pd':'pn');
document.getElementById('wr').textContent=d.winRate+'%';document.getElementById('nt').textContent=d.wins+d.losses;
document.getElementById('op').textContent=d.openPositions;document.getElementById('sc').textContent=d.scanCount+'/'+d.brainCount;
var g=document.getElementById('mT');
if(!d.isRunning){g.textContent='OFFLINE';g.className='tg to'}else if(d.dryRun){g.textContent='PAPER';g.className='tg td'}else{g.textContent='LIVE';g.className='tg tl'}
document.getElementById('bG').style.display=d.isRunning?'none':'flex';document.getElementById('bS').style.display=d.isRunning?'flex':'none';
document.getElementById('lC').textContent='#'+d.scanCount}

function rT(t){var el=document.getElementById('tL');document.getElementById('tC').textContent=t.length;
if(!t.length){el.innerHTML='<div class="EM">Waiting for signals...</div>';return}
el.innerHTML=t.slice(0,25).map(function(x){var res=x.resolved?(x.outcome==='win'?'<span class="Tx xw">WIN $'+x.pnl+'</span>':'<span class="Tx xl">LOSS $'+x.pnl+'</span>'):'';return'<div class="TC"><div class="Tt"><div class="Tk">'+E(x.title||x.ticker)+'</div><span class="Ts '+(x.side==='yes'?'sy':'sn')+'">'+x.side+'</span></div><div class="Tm"><span>'+x.contracts+'x@'+x.priceCents+'c</span><span>$'+x.costDollars+'&rarr;$'+x.maxPayout+'</span><span style="color:var(--g)">'+x.edge+'</span><span class="Tx '+(x.status==='simulated'?'xs':x.status==='placed'?'xp':'xe')+'">'+x.status+'</span>'+res+'</div>'+(x.reasoning?'<div class="Tr">'+E(x.reasoning)+'</div>':'')+'</div>'}).join('')}

function rC(c){var el=document.getElementById('cL');document.getElementById('cC').textContent=c.length;
if(!c.length){el.innerHTML='<div class="EM">Scanner populating...</div>';return}
el.innerHTML=c.map(function(x){return'<div class="TC"><div class="Tt"><div class="Tk">'+E(x.title)+'</div><span style="font-size:10px;color:var(--t3)">'+x.score+'pts</span></div><div class="Tm"><span>YES:'+x.yes+'c</span><span>Vol:'+x.vol+'</span><span>'+x.hoursLeft+'h</span><span style="color:var(--o)">'+x.momentum+'</span><span>'+E(x.category)+'</span></div></div>'}).join('')}

function rS(s){var el=document.getElementById('sL');document.getElementById('sCC').textContent=s.length;
if(!s.length){el.innerHTML='<div class="EM">Waiting for brain cycle...</div>';return}
el.innerHTML=s.map(function(x){return'<div class="TC"><div class="Tt"><div class="Tk">'+E(x.title||x.ticker)+'</div><span class="Ts '+(x.side==='yes'?'sy':'sn')+'">'+x.side+'</span></div><div class="Tm"><span>Mkt:'+(x.marketPrice*100).toFixed(0)+'c</span><span>True:'+(x.trueProb*100).toFixed(0)+'c</span><span style="color:var(--g)">+'+(x.edge*100).toFixed(1)+'%</span><span style="color:var(--o)">'+x.confidence+'</span></div>'+(x.reasoning?'<div class="Tr">'+E(x.reasoning)+'</div>':'')+'</div>'}).join('')}

function rL(l){var el=document.getElementById('lP');if(!l.length){el.innerHTML='<div class="EM">Starting...</div>';return}
el.innerHTML=l.map(function(x){return'<div style="white-space:pre-wrap;word-break:break-all">'+E(x)+'</div>'}).join('')}

async function gA(){try{var[s,t,c,si,l]=await Promise.all([fetch('/api/status').then(r=>r.json()),fetch('/api/trades').then(r=>r.json()),fetch('/api/candidates').then(r=>r.json()),fetch('/api/signals').then(r=>r.json()),fetch('/api/logs').then(r=>r.json())]);uD(s);rT(t);rC(c);rS(si);rL(l)}catch(x){}}
gA();setInterval(gA,6000);
</script></body></html>`;
}
