// ─────────────────────────────────────────────────────────────
//  KALSHI EDGE — AI-Powered Prediction Market Trading Bot
//  Stack: Node.js + Express + Claude AI + RSA-PSS Auth
//  Deploy: Railway (auto-deploy from GitHub)
// ─────────────────────────────────────────────────────────────

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ─── CONFIGURATION ──────────────────────────────────────────

const CFG = {
  // Kalshi API
  apiKeyId:    process.env.KALSHI_API_KEY_ID || '',
  privateKey:  (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  baseUrl:     process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com',
  basePath:    '/trade-api/v2',

  // Claude AI
  claudeKey:   process.env.CLAUDE_API_KEY || '',
  claudeModel: 'claude-sonnet-4-20250514',

  // Trading parameters
  dryRun:        process.env.DRY_RUN !== 'false',
  bankroll:      parseFloat(process.env.BANKROLL || '50'),
  kellyFraction: parseFloat(process.env.KELLY_FRACTION || '0.35'),
  claudeEdge:    parseFloat(process.env.CLAUDE_EDGE || '0.07'),
  maxPosition:   parseFloat(process.env.MAX_POSITION || '5'),
  maxDailyLoss:  parseFloat(process.env.MAX_DAILY_LOSS || '8'),
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '5'),
  pollInterval:  parseInt(process.env.POLL_INTERVAL || '45'),
  minVolume:     parseInt(process.env.MIN_VOLUME || '3000'),
  targetCategories: (process.env.TARGET_CATEGORIES || '').split(',').filter(Boolean),

  // Telegram
  telegramToken: process.env.TELEGRAM_TOKEN || '',
  telegramChat:  process.env.TELEGRAM_CHAT_ID || '',
};

// ─── STATE ──────────────────────────────────────────────────

const STATE_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'state.json')
  : path.join(__dirname, 'state.json');

let state = {
  trades: [],
  positions: [],
  signals: [],
  balance: CFG.bankroll * 100, // cents
  dailyPnL: 0,
  dailyDate: new Date().toISOString().slice(0, 10),
  totalPnL: 0,
  wins: 0,
  losses: 0,
  botStarted: new Date().toISOString(),
  lastPoll: null,
  lastError: null,
  isRunning: false,
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = { ...state, ...saved };
    }
  } catch (e) { console.error('loadState error:', e.message); }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error('saveState error:', e.message); }
}

loadState();

// ─── KALSHI API CLIENT ──────────────────────────────────────

function signRequest(timestamp, method, pathStr) {
  const message = `${timestamp}${method}${pathStr}`;
  const privateKey = crypto.createPrivateKey({
    key: CFG.privateKey,
    format: 'pem',
  });
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString('base64');
}

function kalshiHeaders(method, apiPath) {
  const timestamp = Date.now().toString();
  const signPath = `${CFG.basePath}${apiPath.split('?')[0]}`;
  const signature = signRequest(timestamp, method, signPath);
  return {
    'KALSHI-ACCESS-KEY': CFG.apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function kalshiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CFG.basePath}${apiPath}`, CFG.baseUrl);
    const headers = kalshiHeaders(method, apiPath);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data || '{}') });
        } catch (e) {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Kalshi timeout')); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Convenience wrappers
async function kalshiGet(path) { return kalshiRequest('GET', path); }
async function kalshiPost(path, body) { return kalshiRequest('POST', path, body); }
async function kalshiDelete(path) { return kalshiRequest('DELETE', path); }

// ─── MARKET DATA ────────────────────────────────────────────

async function getBalance() {
  try {
    const res = await kalshiGet('/portfolio/balance');
    if (res.status === 200 && res.data.balance !== undefined) {
      state.balance = res.data.balance; // cents
      return res.data.balance;
    }
  } catch (e) { log('getBalance error: ' + e.message); }
  return state.balance;
}

async function getOpenMarkets() {
  try {
    const res = await kalshiGet('/markets?status=open&limit=100');
    if (res.status === 200 && res.data.markets) {
      return res.data.markets;
    }
  } catch (e) { log('getOpenMarkets error: ' + e.message); }
  return [];
}

async function getOrderbook(ticker) {
  try {
    const res = await kalshiGet(`/markets/${ticker}/orderbook`);
    if (res.status === 200) return res.data;
  } catch (e) { /* silent */ }
  return null;
}

async function getPositions() {
  try {
    const res = await kalshiGet('/portfolio/positions');
    if (res.status === 200) {
      state.positions = res.data.market_positions || [];
      return state.positions;
    }
  } catch (e) { log('getPositions error: ' + e.message); }
  return state.positions;
}

// ─── CLAUDE AI SIGNAL ENGINE ────────────────────────────────

async function claudeAnalyze(markets) {
  if (!CFG.claudeKey || !markets.length) return [];

  // Filter to liquid markets
  const liquid = markets
    .filter(m => (m.volume || 0) >= CFG.minVolume)
    .slice(0, 12);

  if (!liquid.length) {
    log('No liquid markets above min volume threshold');
    return [];
  }

  const marketSummary = liquid.map((m, i) => {
    const yesPrice = m.yes_bid !== undefined ? m.yes_bid : (m.last_price || 50);
    const vol = m.volume || 0;
    const closeTime = m.close_time || m.expected_expiration_time || 'unknown';
    return `${i + 1}. "${m.title}" [${m.ticker}] — YES price: ${yesPrice}¢ — Volume: $${(vol / 100).toFixed(0)} — Closes: ${closeTime}`;
  }).join('\n');

  const systemPrompt = `You are a quantitative prediction market analyst for Kalshi. Binary contracts pay $1 if YES, $0 if NO. Prices are in cents (1-99). Your job: estimate TRUE probability vs market price, flag mispriced markets.

IMPORTANT: Only flag markets where your estimated true probability differs from market price by ${(CFG.claudeEdge * 100).toFixed(0)}%+ (${(CFG.claudeEdge * 100).toFixed(0)} cents or more). Be conservative — when uncertain, do NOT signal.

Respond ONLY with valid JSON array. No preamble, no markdown. Each element:
{"ticker":"TICKER","title":"short title","side":"yes"|"no","marketPrice":0.XX,"trueProb":0.XX,"edge":0.XX,"confidence":"low"|"medium"|"high","reasoning":"1 sentence"}

If no markets have edge, return empty array: []`;

  const userPrompt = `Current date: ${new Date().toISOString().slice(0, 10)}

Active Kalshi markets:
${marketSummary}

Analyze each market. Estimate true probability using your knowledge. Flag any with ${(CFG.claudeEdge * 100).toFixed(0)}%+ edge.`;

  try {
    const payload = JSON.stringify({
      model: CFG.claudeModel,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const data = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CFG.claudeKey,
          'anthropic-version': '2023-06-01',
        },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      });
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Claude timeout')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    const text = (data.content || []).map(c => c.text || '').join('');
    const cleaned = text.replace(/```json|```/g, '').trim();
    const signals = JSON.parse(cleaned);
    return Array.isArray(signals) ? signals : [];
  } catch (e) {
    log('Claude analysis error: ' + e.message);
    return [];
  }
}

// ─── KELLY CRITERION SIZING ────────────────────────────────

function kellySize(edge, marketPrice, side) {
  // edge = |trueProb - marketPrice|
  // For YES: pay marketPrice, win (1-marketPrice)
  // For NO:  pay (1-marketPrice), win marketPrice
  const cost = side === 'yes' ? marketPrice : (1 - marketPrice);
  const payout = 1 - cost;
  if (payout <= 0 || edge <= 0) return 0;

  const odds = payout / cost;
  const winProb = side === 'yes'
    ? marketPrice + edge
    : (1 - marketPrice) + edge;

  const kelly = (winProb * odds - (1 - winProb)) / odds;
  const fractional = kelly * CFG.kellyFraction;
  const bankrollDollars = state.balance / 100;
  const dollarSize = Math.min(
    CFG.maxPosition,
    Math.max(1, fractional * bankrollDollars)
  );

  // Convert to number of contracts
  const contracts = Math.floor(dollarSize / cost);
  return Math.max(1, Math.min(contracts, 100));
}

// ─── ORDER EXECUTION ────────────────────────────────────────

async function placeOrder(signal) {
  const { ticker, side, marketPrice, edge, trueProb, confidence, reasoning } = signal;

  // Calculate sizing
  const contracts = kellySize(edge, marketPrice, side);
  const priceCents = side === 'yes'
    ? Math.round(marketPrice * 100)
    : Math.round((1 - marketPrice) * 100);

  const order = {
    ticker,
    action: 'buy',
    side,
    count: contracts,
    type: 'limit',
    yes_price: side === 'yes' ? priceCents : undefined,
    no_price: side === 'no' ? priceCents : undefined,
    client_order_id: uuidv4(),
  };

  // Clean undefined fields
  Object.keys(order).forEach(k => order[k] === undefined && delete order[k]);

  const tradeRecord = {
    id: uuidv4(),
    ticker,
    side,
    contracts,
    priceCents,
    edge: (edge * 100).toFixed(1) + '%',
    confidence,
    reasoning,
    timestamp: new Date().toISOString(),
    status: 'pending',
    dryRun: CFG.dryRun,
  };

  if (CFG.dryRun) {
    tradeRecord.status = 'simulated';
    state.trades.unshift(tradeRecord);
    if (state.trades.length > 200) state.trades = state.trades.slice(0, 200);
    saveState();
    log(`[DRY RUN] ${side.toUpperCase()} ${contracts}x ${ticker} @ ${priceCents}¢ | Edge: ${tradeRecord.edge}`);
    await sendTelegram(`🧪 PAPER TRADE\n${side.toUpperCase()} ${contracts}x ${ticker}\n@ ${priceCents}¢ | Edge: ${tradeRecord.edge}\n${reasoning}`);
    return tradeRecord;
  }

  try {
    const res = await kalshiPost('/portfolio/orders', order);
    if (res.status === 201 || res.status === 200) {
      tradeRecord.status = 'placed';
      tradeRecord.orderId = res.data.order?.order_id;
      log(`ORDER PLACED: ${side.toUpperCase()} ${contracts}x ${ticker} @ ${priceCents}¢`);
      await sendTelegram(`✅ LIVE ORDER\n${side.toUpperCase()} ${contracts}x ${ticker}\n@ ${priceCents}¢ | Edge: ${tradeRecord.edge}\n${reasoning}`);
    } else {
      tradeRecord.status = 'error';
      tradeRecord.error = JSON.stringify(res.data);
      log(`ORDER ERROR: ${res.status} — ${JSON.stringify(res.data)}`);
      await sendTelegram(`❌ ORDER FAILED\n${ticker}: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
  } catch (e) {
    tradeRecord.status = 'error';
    tradeRecord.error = e.message;
    log('placeOrder error: ' + e.message);
  }

  state.trades.unshift(tradeRecord);
  if (state.trades.length > 200) state.trades = state.trades.slice(0, 200);
  saveState();
  return tradeRecord;
}

// ─── MAIN TRADING LOOP ─────────────────────────────────────

let pollTimer = null;

async function tradingCycle() {
  try {
    // Reset daily P&L
    const today = new Date().toISOString().slice(0, 10);
    if (state.dailyDate !== today) {
      state.dailyPnL = 0;
      state.dailyDate = today;
    }

    // Check daily loss limit
    if (state.dailyPnL <= -(CFG.maxDailyLoss * 100)) {
      log('Daily loss limit hit. Pausing until tomorrow.');
      return;
    }

    // Fetch balance + markets + positions in parallel
    const [balance, markets, positions] = await Promise.all([
      getBalance(),
      getOpenMarkets(),
      getPositions(),
    ]);

    state.lastPoll = new Date().toISOString();
    log(`Poll: ${markets.length} markets | Balance: $${(balance / 100).toFixed(2)} | Positions: ${positions.length}`);

    // Check concurrent position limit
    if (positions.length >= CFG.maxConcurrent) {
      log(`At max concurrent positions (${CFG.maxConcurrent}). Skipping signals.`);
      saveState();
      return;
    }

    // Get Claude signals
    const signals = await claudeAnalyze(markets);
    state.signals = signals.slice(0, 20);

    if (signals.length > 0) {
      log(`Claude found ${signals.length} signal(s)`);

      // Filter out markets we already hold
      const heldTickers = new Set(positions.map(p => p.ticker));
      const newSignals = signals.filter(s => !heldTickers.has(s.ticker));

      // Sort by edge descending, take best
      const sortedSignals = newSignals.sort((a, b) => (b.edge || 0) - (a.edge || 0));
      const slotsAvailable = CFG.maxConcurrent - positions.length;
      const toTrade = sortedSignals.slice(0, slotsAvailable);

      for (const signal of toTrade) {
        await placeOrder(signal);
        // Small delay between orders
        await new Promise(r => setTimeout(r, 1000));
      }
    } else {
      log('No actionable signals this cycle.');
    }

    state.lastError = null;
    saveState();
  } catch (e) {
    state.lastError = e.message;
    log('Trading cycle error: ' + e.message);
    saveState();
  }
}

function startBot() {
  if (state.isRunning) return;
  state.isRunning = true;
  log('Bot started. Dry run: ' + CFG.dryRun);
  tradingCycle(); // Run immediately
  pollTimer = setInterval(tradingCycle, CFG.pollInterval * 1000);
  saveState();
}

function stopBot() {
  state.isRunning = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  log('Bot stopped.');
  saveState();
}

// ─── TELEGRAM ALERTS ────────────────────────────────────────

async function sendTelegram(text) {
  if (!CFG.telegramToken || !CFG.telegramChat) return;
  try {
    const url = `https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`;
    const body = JSON.stringify({ chat_id: CFG.telegramChat, text, parse_mode: 'HTML' });
    await new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (e) { /* silent */ }
}

// ─── LOGGING ────────────────────────────────────────────────

const logs = [];
function log(msg) {
  const entry = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(entry);
  logs.unshift(entry);
  if (logs.length > 500) logs.length = 500;
}

// ─── API ROUTES ─────────────────────────────────────────────

// Dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Bot status
app.get('/api/status', (req, res) => {
  const winRate = (state.wins + state.losses) > 0
    ? ((state.wins / (state.wins + state.losses)) * 100).toFixed(1)
    : '0.0';

  res.json({
    isRunning: state.isRunning,
    dryRun: CFG.dryRun,
    balance: state.balance,
    bankroll: CFG.bankroll,
    totalPnL: state.totalPnL,
    dailyPnL: state.dailyPnL,
    wins: state.wins,
    losses: state.losses,
    winRate,
    openPositions: state.positions.length,
    maxConcurrent: CFG.maxConcurrent,
    lastPoll: state.lastPoll,
    lastError: state.lastError,
    botStarted: state.botStarted,
    config: {
      kellyFraction: CFG.kellyFraction,
      claudeEdge: CFG.claudeEdge,
      maxPosition: CFG.maxPosition,
      maxDailyLoss: CFG.maxDailyLoss,
      pollInterval: CFG.pollInterval,
      minVolume: CFG.minVolume,
    },
  });
});

// Recent trades
app.get('/api/trades', (req, res) => {
  res.json(state.trades.slice(0, 50));
});

// Current positions
app.get('/api/positions', (req, res) => {
  res.json(state.positions);
});

// Latest signals
app.get('/api/signals', (req, res) => {
  res.json(state.signals);
});

// Logs
app.get('/api/logs', (req, res) => {
  res.json(logs.slice(0, 100));
});

// Start/stop bot
app.post('/api/bot/start', (req, res) => {
  startBot();
  res.json({ ok: true, isRunning: true });
});

app.post('/api/bot/stop', (req, res) => {
  stopBot();
  res.json({ ok: true, isRunning: false });
});

// Test Kalshi connection
app.get('/api/test-connection', async (req, res) => {
  try {
    const balRes = await kalshiGet('/portfolio/balance');
    const mktRes = await kalshiGet('/markets?status=open&limit=3');
    res.json({
      auth: balRes.status === 200 ? 'ok' : 'failed',
      authStatus: balRes.status,
      balance: balRes.data,
      markets: mktRes.status === 200 ? (mktRes.data.markets || []).length + ' markets loaded' : 'failed',
      marketsStatus: mktRes.status,
    });
  } catch (e) {
    res.json({ auth: 'error', error: e.message });
  }
});

// Force a single trading cycle
app.post('/api/bot/cycle', async (req, res) => {
  try {
    await tradingCycle();
    res.json({ ok: true, signals: state.signals, trades: state.trades.slice(0, 5) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── START SERVER ───────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Kalshi Edge server running on port ${PORT}`);
  log(`Mode: ${CFG.dryRun ? 'DRY RUN (paper trading)' : '⚡ LIVE TRADING'}`);
  log(`Bankroll: $${CFG.bankroll} | Kelly: ${CFG.kellyFraction} | Edge threshold: ${(CFG.claudeEdge * 100)}%`);

  if (CFG.apiKeyId && CFG.privateKey) {
    log('API credentials detected. Auto-starting bot...');
    startBot();
  } else {
    log('No API credentials. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY to enable trading.');
  }
});
