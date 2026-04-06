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
  maxPos:     5,
  kellyFrac:  0.25,       // quarter-kelly for safety
  minEdge:    0.04,       // minimum 4% edge to trade
  minProb:    0.55,       // minimum 55% confidence
  scanInterval:  45000,  // math scanner: every 45s
  brainInterval: 300000, // claude brain: every 5min (saves credits)
  heartbeatInterval: 1800000, // telegram heartbeat: every 30min
};

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
  newsCache: [],
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
  S.isRunning = false; // always reset on boot
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
  const fullPath = '/trade-api/v2' + endpoint + qstr;
  const headers = signRequest(method, fullPath);
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

// ─── BALANCE SYNC ──────────────────────────────────────────────────────────
async function syncBalance() {
  try {
    const r = await kalshi('GET', '/portfolio/balance');
    const bal = (r.balance || 0) / 100;
    S.realBalance = bal;
    if (!CFG.dryRun) {
      // Live mode: always track real balance
      S.balance = bal;
      if (bal > S.peakBalance) S.peakBalance = bal;
    } else if (S.balance === CFG.bankroll && bal > 0) {
      // Paper mode first boot: seed sim balance from real balance, not env var
      S.balance = bal;
      S.peakBalance = bal;
      log(`Paper balance seeded from real Kalshi balance: $${bal.toFixed(2)}`);
    }
    log(`Balance synced: real=$${bal.toFixed(2)} sim=$${S.balance.toFixed(2)}`);
  } catch(e) {
    log('Balance sync failed: ' + e.message, 'WARN');
  }
}

// ─── PRICE PARSER (handles both old cents and new dollar string formats) ─────
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
    const r = await kalshi('GET', '/portfolio/positions', null, { limit: '50', status: 'open' });
    const positions = r.market_positions || r.positions || [];
    if (positions.length === 0) { log('No open positions on Kalshi'); return; }

    // Rebuild openPositions from Kalshi's live data
    const livePositions = positions
      .filter(p => (parseFloat(p.position) || parseInt(p.position_fp) || 0) !== 0)
      .map(p => {
        const qty = Math.abs(parseFloat(p.position_fp || p.position || 0));
        const side = (parseFloat(p.position_fp || p.position || 0)) > 0 ? 'YES' : 'NO';
        const avgPrice = parsePrice(p.realized_pnl_dollars) || 0;
        return {
          ticker: p.ticker,
          side,
          contracts: qty,
          entryPrice: Math.round(parsePrice(p.market_exposure_dollars || '0.5') * 100),
          cost: qty * parsePrice(p.market_exposure_dollars || '0.5'),
          currentPrice: Math.round(parsePrice(p.market_exposure_dollars || '0.5') * 100),
          openedAt: Date.now(),
          status: 'open',
          reasoning: 'Restored from Kalshi on boot',
          fromKalshi: true,
        };
      });

    if (livePositions.length > 0) {
      // Merge with existing — don't duplicate
      const existing = new Set(S.openPositions.map(p => p.ticker));
      const newOnes = livePositions.filter(p => !existing.has(p.ticker));
      S.openPositions.push(...newOnes);
      log(`Synced ${livePositions.length} live positions from Kalshi (${newOnes.length} new)`);
      tg(`📋 <b>Positions synced from Kalshi</b>\n${livePositions.map(p => `${p.ticker} ${p.side} x${p.contracts}`).join('\n')}`);
      saveState();
    }
  } catch(e) {
    log('Position sync failed: ' + e.message, 'WARN');
  }
}

// ─── MARKET SCANNER (pure math, no Claude calls) ───────────────────────────
async function getTopMarkets() {
  try {
    // Use /markets with series_ticker filter — the correct way per Kalshi docs
    // Fetch in parallel across high-volume series
    const seriesList = [
      'INXD','INXW','NASDAQ100D','NASDAQ100W',   // S&P/Nasdaq
      'KXBTCD','KXBTCW','KXETHUSD',              // Crypto
      'KXNBAGAME','KXNFLGAME','KXMLBGAME',       // Sports
      'HIGHNY','HIGHMIA','HIGHCHI',              // Weather
      'FED','FEDRATE','INFL',                    // Macro
      'KXPREZ','KXSENATE',                       // Politics
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
      if (yesAsk <= 0.005 || yesAsk >= 0.995) return false;
      return true;
    });

    log(`After filter: ${markets.length} tradeable markets`);

    const scored = markets.map(m => {
      const yesAsk  = parsePrice(m.yes_ask_dollars  || m.yes_ask);
      const yesBid  = parsePrice(m.yes_bid_dollars  || m.yes_bid);
      const spread  = Math.max(0, yesAsk - yesBid);
      // volume_fp is now a string like "1234.00"
      const vol     = parseFloat(m.volume_fp || m.volume || 0);

      const spreadScore = Math.max(0, 1 - spread / 0.10);
      const volScore    = Math.min(1, Math.log10(vol + 1) / 5);
      const probScore   = 1 - Math.abs(yesAsk - 0.5) * 2;
      const totalScore  = spreadScore * 0.4 + volScore * 0.4 + probScore * 0.2;

      return {
        ticker: m.ticker,
        title: m.title,
        yesAsk, yesBid, spread, volume: vol,
        score: totalScore,
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


// ─── KALSHI LEADERBOARD (copy top traders) ─────────────────────────────────
async function getTopTraders() {
  try {
    const r = await kalshi('GET', '/portfolio/leaderboard', null, { limit: '10' });
    const traders = r.leaderboard || r.members || [];
    if (traders.length > 0) {
      log(`Top traders fetched: ${traders.length} entries`);
      return traders.slice(0, 5);
    }
    return [];
  } catch(e) {
    log('Leaderboard fetch failed: ' + e.message, 'WARN');
    return [];
  }
}

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

  const prompt = `CRITICAL INSTRUCTION: You must respond with ONLY a valid JSON object. No preamble, no explanation, no "Based on my research", no text before or after the JSON. Start your response with { and end with }. Any text outside the JSON will break the trading system.

You are KalshiBot, an expert prediction market trader. Your ONLY goal: double the portfolio as quickly and safely as possible using Kelly criterion sizing.

PORTFOLIO STATUS:
- Balance: $${S.balance.toFixed(2)} (paper mode: ${CFG.dryRun})
- Peak: $${S.peakBalance.toFixed(2)}
- P&L today: $${S.todayPnl.toFixed(2)} | All-time: $${S.totalPnl.toFixed(2)}
- Win/Loss: ${S.wins}W/${S.losses}L
- Open positions: ${S.openPositions.length}/${CFG.maxPos}
- Available to trade: ${CFG.maxPos - S.openPositions.length} slots

RECENT TRADE MEMORY:
${memSummary}

TOP MARKETS (math-scored by volume, spread, liquidity):
${marketList}

OPEN POSITIONS:
${S.openPositions.length === 0 ? 'None' : S.openPositions.map(p => `- ${p.ticker}: ${p.side} @ ${p.entryPrice}¢, current P&L: $${((p.currentPrice||p.entryPrice) - p.entryPrice).toFixed(2)}`).join('\n')}

YOUR TASK:
1. Use your web search to find breaking news for ANY of these market tickers
2. Identify which markets have pricing that doesn't reflect current information
3. Find the BEST 1-3 trade opportunities with genuine edge (>4% mispricing)
4. For each trade, provide Kelly-optimal sizing

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "signals": [
    {
      "ticker": "MARKET-TICKER",
      "side": "YES" or "NO",
      "confidence": 0.65,
      "edge": 0.08,
      "reasoning": "brief reason with news/data cited",
      "kellySize": 5.00,
      "newsFound": true
    }
  ],
  "marketSummary": "one sentence on current market conditions",
  "skipReason": "only if no trades found, explain why"
}`;

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
        model: 'claude-opus-4-5',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'You are a JSON-only trading signal generator. NEVER output any text before or after the JSON object. Your entire response must be parseable by JSON.parse(). Start with { and end with }.',
        messages: [{ role: 'user', content: prompt }],
      },
    }, 120000);

    if (r.status !== 200) {
      log(`Brain API error ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`, 'WARN');
      return;
    }

    const textBlock = (r.body.content || []).find(b => b.type === 'text');
    if (!textBlock) { log('Brain: no text response', 'WARN'); return; }

    let parsed;
    try {
      const raw = textBlock.text;
      // Extract JSON object from anywhere in the response - handles web search preamble
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log('Brain: no JSON found in response, raw: ' + raw.slice(0, 100), 'WARN');
        return;
      }
      const clean = jsonMatch[0];
      parsed = JSON.parse(clean);
    } catch(e) {
      log('Brain parse error: ' + e.message + ' | text: ' + textBlock.text.slice(0, 80), 'WARN');
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

// ─── KELLY SIZING ──────────────────────────────────────────────────────────
function kellySize(prob, price) {
  const q = 1 - prob;
  const b = (1 - price) / price; // net odds
  const kelly = (b * prob - q) / b;
  const fracKelly = Math.max(0, kelly * CFG.kellyFrac);
  const maxBet = S.balance * 0.10; // never more than 10% per trade
  const minBet = 1.00;
  return Math.min(maxBet, Math.max(minBet, S.balance * fracKelly));
}

// ─── TRADE EXECUTION ───────────────────────────────────────────────────────
async function executeTrade(sig) {
  if (S.openPositions.length >= CFG.maxPos) {
    log(`Skip ${sig.ticker}: max positions reached`);
    return;
  }
  if (S.openPositions.find(p => p.ticker === sig.ticker)) {
    log(`Skip ${sig.ticker}: already have position`);
    return;
  }

  // Price as cents integer for Kelly math, dollar string for API
  const priceCents = sig.side === 'YES'
    ? Math.round(sig.confidence * 100)
    : Math.round((1 - sig.confidence) * 100);
  const priceFloat = priceCents / 100; // e.g. 0.65

  const size = kellySize(sig.confidence, priceFloat);
  const contracts = Math.max(1, Math.floor(size / priceFloat));
  const price = priceCents; // keep as cents alias for rest of function

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

  for (const pos of [...S.openPositions]) {
    try {
      // Check if market is settled
      const m = await kalshi('GET', `/markets/${pos.ticker}`);
      const market = m.market || m;

      // Update current price
      const currentYes = (market.yes_ask || 0) / 100;
      pos.currentPrice = pos.side === 'YES' ? Math.round(currentYes * 100) : Math.round((1 - currentYes) * 100);

      // Check if resolved
      if (market.status === 'finalized' || market.result) {
        const result = market.result; // 'yes' or 'no'
        const won = (pos.side === 'YES' && result === 'yes') || (pos.side === 'NO' && result === 'no');
        const payout = won ? pos.contracts * 1.00 : 0;
        const pnl = payout - pos.cost;

        S.balance += payout;
        S.totalPnl += pnl;
        S.todayPnl += pnl;
        if (pnl > 0) S.wins++; else S.losses++;
        if (S.balance > S.peakBalance) S.peakBalance = S.balance;

        // Update brain memory
        const memEntry = S.brainMemory.find(m => m.ticker === pos.ticker);
        if (memEntry) memEntry.outcome = won ? `WON +$${pnl.toFixed(2)}` : `LOST -$${Math.abs(pnl).toFixed(2)}`;

        S.openPositions = S.openPositions.filter(p => p.ticker !== pos.ticker);
        S.trades.push({ ...pos, resolvedAt: Date.now(), won, pnl, result });

        log(`${won ? '🟢 WIN' : '🔴 LOSS'}: ${pos.ticker} ${pos.side} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
        tg(`${won ? '🟢 <b>WIN</b>' : '🔴 <b>LOSS</b>'}\n${pos.ticker} ${pos.side}\nPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\nBalance: $${S.balance.toFixed(2)}`);
        saveState();
      }
    } catch(e) {
      log(`Resolve check failed ${pos.ticker}: ${e.message}`, 'WARN');
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
    // On first scan, sync live positions from Kalshi to recover after redeploy
    if (S.scanCount === 1) await syncPositions();
    const markets = await getTopMarkets();
    await resolvePositions();

    // Only fire brain if: credits available, enough time passed, and we have open slots
    const brainReady = (Date.now() - S.lastBrainAt) >= CFG.brainInterval;
    const hasSlots = S.openPositions.length < CFG.maxPos;
    const hasMarkets = markets.length > 0;

    if (brainReady && hasSlots && hasMarkets) {
      await runBrain(markets);
    }

    saveState();
  } catch(e) {
    log('Scan error: ' + e.message, 'ERROR');
    S.lastErr = e.message;
  }

  if (S.isRunning) scanTimer = setTimeout(scan, CFG.scanInterval);
}

function sendHeartbeat() {
  const drawdown = S.peakBalance > 0
    ? ((S.peakBalance - S.balance) / S.peakBalance * 100).toFixed(1)
    : '0.0';
  const sigAge = S.lastBrainAt > 0
    ? Math.floor((Date.now() - S.lastBrainAt) / 60000)
    : '—';
  const mode = CFG.dryRun ? '📝 Paper' : '🔴 LIVE';

  tg(`📊 <b>Heartbeat</b>
Mode: ${mode}
Real: $${S.realBalance.toFixed(2)} | Sim: $${S.balance.toFixed(2)}
Today: ${S.todayPnl >= 0 ? '+' : ''}$${S.todayPnl.toFixed(2)} | All-time: ${S.totalPnl >= 0 ? '+' : ''}$${S.totalPnl.toFixed(2)}
Win: ${S.wins > 0 || S.losses > 0 ? `${((S.wins/(S.wins+S.losses||1))*100).toFixed(0)}%` : '—'} (${S.wins}W/${S.losses}L) | Open: ${S.openPositions.length}/${CFG.maxPos}
Brain: #${S.brainCount} | Drawdown: ${drawdown}% | Sig age: ${sigAge}min
Scans: ${S.scanCount} | Markets: ${S.topMarkets.length}`);
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
        model: 'claude-opus-4-5',
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
function startBot() {
  if (S.isRunning || _botStarted) { log('Already running — ignoring duplicate start'); return; }
  _botStarted = true;
  S.isRunning = true;
  log('🚀 KalshiBot v9 started');
  tg(`🚀 <b>KalshiBot v9 Online</b>
Mode: ${CFG.dryRun ? '📝 Paper' : '🔴 LIVE'}
Real: $${S.realBalance > 0 ? S.realBalance.toFixed(2) : '...syncing'}
Max positions: ${CFG.maxPos}
Brain interval: ${CFG.brainInterval/60000}min
Scan interval: ${CFG.scanInterval/1000}s`);

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
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Sora:wght@300;400;600;700&display=swap');
  :root {
    --bg: #0a0a0f;
    --surface: rgba(255,255,255,0.04);
    --surface2: rgba(255,255,255,0.08);
    --border: rgba(255,255,255,0.08);
    --text: #f0f0f8;
    --muted: rgba(240,240,248,0.45);
    --green: #00e676;
    --red: #ff5252;
    --blue: #448aff;
    --gold: #ffd740;
    --accent: #7c4dff;
    --font: 'Sora', sans-serif;
    --mono: 'DM Mono', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100dvh; overflow-x: hidden; }
  body::before {
    content: '';
    position: fixed; inset: 0;
    background: radial-gradient(ellipse 80% 50% at 50% -20%, rgba(124,77,255,0.15) 0%, transparent 60%),
                radial-gradient(ellipse 50% 30% at 80% 80%, rgba(0,230,118,0.08) 0%, transparent 50%);
    pointer-events: none; z-index: 0;
  }

  .app { position: relative; z-index: 1; max-width: 430px; margin: 0 auto; padding-bottom: 90px; }

  /* Header */
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 56px 20px 16px;
    background: linear-gradient(180deg, rgba(10,10,15,0.95) 0%, transparent 100%);
    position: sticky; top: 0; z-index: 100;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  }
  .logo { font-size: 18px; font-weight: 700; letter-spacing: -0.5px; }
  .logo span { color: var(--accent); }
  .status-pill {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 12px; border-radius: 100px;
    font-size: 12px; font-weight: 600; letter-spacing: 0.3px;
    background: var(--surface2); border: 1px solid var(--border);
  }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .status-dot.live { background: var(--green); box-shadow: 0 0 8px var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Balance Card */
  .balance-card {
    margin: 8px 16px 0;
    padding: 24px;
    background: linear-gradient(135deg, rgba(124,77,255,0.2) 0%, rgba(68,138,255,0.1) 100%);
    border: 1px solid rgba(124,77,255,0.3);
    border-radius: 20px;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  }
  .bal-label { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .bal-amount { font-size: 40px; font-weight: 700; letter-spacing: -2px; line-height: 1; }
  .bal-amount.up { color: var(--green); }
  .bal-amount.down { color: var(--red); }
  .bal-sub { display: flex; gap: 16px; margin-top: 12px; }
  .bal-sub-item { font-size: 13px; color: var(--muted); }
  .bal-sub-item span { color: var(--text); font-weight: 600; }

  /* Stats Row */
  .stats-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin: 12px 16px 0; }
  .stat-card {
    padding: 14px 12px; border-radius: 14px;
    background: var(--surface); border: 1px solid var(--border);
    text-align: center;
  }
  .stat-val { font-size: 18px; font-weight: 700; font-family: var(--mono); }
  .stat-val.green { color: var(--green); }
  .stat-val.red { color: var(--red); }
  .stat-val.blue { color: var(--blue); }
  .stat-label { font-size: 10px; color: var(--muted); margin-top: 3px; text-transform: uppercase; letter-spacing: 0.5px; }

  /* Section */
  .section { margin: 16px 16px 0; }
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .section-title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .section-badge { font-size: 11px; font-family: var(--mono); color: var(--accent); }

  /* Control Card */
  .control-card {
    padding: 16px; border-radius: 16px;
    background: var(--surface); border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
  }
  .control-info { flex: 1; }
  .control-name { font-size: 15px; font-weight: 600; }
  .control-desc { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .toggle-btn {
    width: 56px; height: 30px; border-radius: 15px; border: none; cursor: pointer;
    position: relative; transition: all 0.3s ease;
    background: rgba(255,255,255,0.1);
  }
  .toggle-btn.active { background: var(--accent); }
  .toggle-btn::after {
    content: ''; position: absolute; top: 3px; left: 3px;
    width: 24px; height: 24px; border-radius: 50%; background: white;
    transition: transform 0.3s ease; box-shadow: 0 2px 4px rgba(0,0,0,0.3);
  }
  .toggle-btn.active::after { transform: translateX(26px); }

  /* Signal Cards */
  .signal-card {
    padding: 14px; border-radius: 14px; margin-bottom: 8px;
    background: var(--surface); border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
  }
  .signal-card.yes { border-left-color: var(--green); }
  .signal-card.no { border-left-color: var(--red); }
  .signal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .signal-ticker { font-family: var(--mono); font-size: 13px; font-weight: 500; }
  .signal-side { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; }
  .signal-side.yes { background: rgba(0,230,118,0.15); color: var(--green); }
  .signal-side.no { background: rgba(255,82,82,0.15); color: var(--red); }
  .signal-reason { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .signal-meta { display: flex; gap: 12px; margin-top: 8px; }
  .signal-meta-item { font-size: 11px; color: var(--muted); font-family: var(--mono); }
  .signal-meta-item span { color: var(--text); }

  /* Position Cards */
  .position-card {
    padding: 14px; border-radius: 14px; margin-bottom: 8px;
    background: var(--surface); border: 1px solid var(--border);
  }
  .pos-header { display: flex; justify-content: space-between; align-items: center; }
  .pos-ticker { font-family: var(--mono); font-size: 14px; font-weight: 500; }
  .pos-pnl { font-family: var(--mono); font-size: 14px; font-weight: 700; }
  .pos-pnl.pos { color: var(--green); }
  .pos-pnl.neg { color: var(--red); }
  .pos-detail { font-size: 12px; color: var(--muted); margin-top: 4px; }

  /* Log */
  .log-list { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
  .log-item { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; gap: 10px; align-items: flex-start; }
  .log-item:last-child { border-bottom: none; }
  .log-ts { font-family: var(--mono); font-size: 11px; color: var(--muted); white-space: nowrap; flex-shrink: 0; }
  .log-msg { font-size: 12px; line-height: 1.4; }
  .log-item.ERROR .log-msg { color: var(--red); }
  .log-item.WARN .log-msg { color: var(--gold); }

  /* Tab Bar */
  .tabbar {
    position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
    width: 100%; max-width: 430px;
    background: rgba(10,10,15,0.85);
    backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px);
    border-top: 1px solid var(--border);
    display: flex; padding: 8px 0 28px;
    z-index: 200;
  }
  .tab { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 0; cursor: pointer; }
  .tab-icon { font-size: 20px; }
  .tab-label { font-size: 10px; font-weight: 500; color: var(--muted); }
  .tab.active .tab-label { color: var(--accent); }

  /* Market Cards */
  .market-card {
    padding: 12px 14px; border-radius: 12px; margin-bottom: 8px;
    background: var(--surface); border: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center;
  }
  .market-title { font-size: 12px; line-height: 1.3; flex: 1; margin-right: 10px; }
  .market-price { text-align: right; flex-shrink: 0; }
  .market-yes { font-family: var(--mono); font-size: 15px; font-weight: 700; color: var(--green); }
  .market-vol { font-size: 10px; color: var(--muted); margin-top: 2px; }

  /* Empty state */
  .empty { text-align: center; padding: 32px 20px; color: var(--muted); font-size: 14px; }
  .empty-icon { font-size: 36px; margin-bottom: 8px; }

  /* Refresh btn */
  .refresh-btn {
    display: block; width: calc(100% - 32px); margin: 12px 16px 0;
    padding: 14px; border-radius: 14px; border: 1px solid var(--border);
    background: var(--surface2); color: var(--text); font-family: var(--font);
    font-size: 14px; font-weight: 600; cursor: pointer; text-align: center;
  }
  .refresh-btn:active { opacity: 0.7; }

  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <div class="logo">Kalshi<span>Bot</span></div>
    <div class="status-pill">
      <div class="status-dot" id="statusDot"></div>
      <span id="statusText">Loading…</span>
    </div>
  </div>

  <!-- HOME TAB -->
  <div id="tab-home">
    <div class="balance-card">
      <div class="bal-label" id="balLabel">Balance</div>
      <div class="bal-amount" id="mainBal">$—</div>
      <div class="bal-sub">
        <div class="bal-sub-item">Real <span id="realBal">$—</span></div>
        <div class="bal-sub-item">Today <span id="todayPnl">+$0.00</span></div>
        <div class="bal-sub-item">All-time <span id="totalPnl">+$0.00</span></div>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-val blue" id="scanCount">—</div>
        <div class="stat-label">Scans</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" id="winRate">—</div>
        <div class="stat-label">Win Rate</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" id="openCount">—</div>
        <div class="stat-label">Open/Max</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">Engine</div>
        <div class="section-badge" id="modeLabel">PAPER</div>
      </div>
      <div class="control-card">
        <div class="control-info">
          <div class="control-name">Trading Engine</div>
          <div class="control-desc" id="engineDesc">Tap to start</div>
        </div>
        <button class="toggle-btn" id="toggleBtn" onclick="toggleBot()"></button>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">Brain Status</div>
        <div class="section-badge" id="brainBadge">—</div>
      </div>
      <div class="control-card">
        <div class="control-info">
          <div class="control-name" id="brainStatus">Waiting…</div>
          <div class="control-desc" id="brainDesc">Last signal age</div>
        </div>
        <div style="font-size:24px" id="brainIcon">🧠</div>
      </div>
    </div>
  </div>

  <!-- MARKETS TAB -->
  <div id="tab-markets" class="hidden">
    <div class="section" style="margin-top:16px">
      <div class="section-header">
        <div class="section-title">Top Markets</div>
        <div class="section-badge" id="marketCount">—</div>
      </div>
      <div id="marketList"></div>
    </div>
  </div>

  <!-- POSITIONS TAB -->
  <div id="tab-positions" class="hidden">
    <div class="section" style="margin-top:16px">
      <div class="section-header">
        <div class="section-title">Open Positions</div>
        <div class="section-badge" id="posCount">—</div>
      </div>
      <div id="positionList"></div>
    </div>
    <div class="section">
      <div class="section-header">
        <div class="section-title">Signals</div>
      </div>
      <div id="signalList"></div>
    </div>
  </div>

  <!-- LOGS TAB -->
  <div id="tab-logs" class="hidden">
    <div class="section" style="margin-top:16px">
      <div class="section-header">
        <div class="section-title">System Log</div>
        <div class="section-badge" id="logCount">—</div>
      </div>
      <div class="log-list" id="logList"></div>
    </div>
    <button class="refresh-btn" onclick="resetState()">🔄 Reset State</button>
  </div>
</div>

<!-- TAB BAR -->
<div class="tabbar">
  <div class="tab active" onclick="switchTab('home',this)">
    <div class="tab-icon">📊</div>
    <div class="tab-label">Home</div>
  </div>
  <div class="tab" onclick="switchTab('markets',this)">
    <div class="tab-icon">🔍</div>
    <div class="tab-label">Markets</div>
  </div>
  <div class="tab" onclick="switchTab('positions',this)">
    <div class="tab-icon">💼</div>
    <div class="tab-label">Positions</div>
  </div>
  <div class="tab" onclick="switchTab('logs',this)">
    <div class="tab-icon">📋</div>
    <div class="tab-label">Logs</div>
  </div>
</div>

<script>
let currentTab = 'home';
let state = {};

function switchTab(tab, el) {
  document.querySelectorAll('[id^="tab-"]').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.remove('hidden');
  el.classList.add('active');
  currentTab = tab;
}

function fmt(n, sign=true) {
  const s = Math.abs(n).toFixed(2);
  return (n >= 0 ? (sign?'+':'') : '-') + '$' + s;
}

function timeAgo(ms) {
  const m = Math.floor((Date.now()-ms)/60000);
  if(m < 1) return 'just now';
  if(m < 60) return m + 'min ago';
  return Math.floor(m/60) + 'h ago';
}

function render(s) {
  state = s;
  // Status
  const running = s.isRunning;
  document.getElementById('statusDot').className = 'status-dot' + (running?' live':'');
  document.getElementById('statusText').textContent = running ? (s.dryRun?'Paper':'LIVE') : 'Stopped';
  document.getElementById('balLabel').textContent = s.dryRun ? 'Sim Balance' : 'Live Balance';
  document.getElementById('toggleBtn').className = 'toggle-btn' + (running?' active':'');
  document.getElementById('engineDesc').textContent = running
    ? 'Scan #'+s.scanCount+' · Brain #'+s.brainCount
    : 'Tap to start';
  document.getElementById('modeLabel').textContent = s.dryRun ? 'PAPER' : 'LIVE';

  // Balance
  document.getElementById('mainBal').textContent = '$'+s.balance.toFixed(2);
  document.getElementById('realBal').textContent = '$'+s.realBalance.toFixed(2);
  document.getElementById('todayPnl').textContent = fmt(s.todayPnl);
  document.getElementById('todayPnl').style.color = s.todayPnl >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('totalPnl').textContent = fmt(s.totalPnl);
  document.getElementById('totalPnl').style.color = s.totalPnl >= 0 ? 'var(--green)' : 'var(--red)';

  // Stats
  document.getElementById('scanCount').textContent = s.scanCount||0;
  const total = (s.wins||0)+(s.losses||0);
  document.getElementById('winRate').textContent = total > 0 ? Math.round(s.wins/total*100)+'%' : '—';
  document.getElementById('winRate').className = 'stat-val ' + (s.wins>s.losses?'green':total>0?'red':'');
  document.getElementById('openCount').textContent = (s.openPositions?.length||0)+'/'+5;

  // Brain
  const sigAge = s.lastBrainAt > 0 ? Math.floor((Date.now()-s.lastBrainAt)/60000) : null;
  document.getElementById('brainBadge').textContent = sigAge !== null ? sigAge+'min ago' : 'never';
  document.getElementById('brainStatus').textContent = s.brainCount > 0
    ? 'Brain #'+s.brainCount+' fired'
    : 'Awaiting first scan';
  document.getElementById('brainDesc').textContent = s.signals?.length > 0
    ? s.signals.length+' active signals'
    : (s.lastErr || 'No signals yet');
  document.getElementById('brainIcon').textContent = sigAge !== null && sigAge < 10 ? '🔥' : '🧠';

  // Markets
  const markets = s.topMarkets || [];
  document.getElementById('marketCount').textContent = markets.length;
  document.getElementById('marketList').innerHTML = markets.length === 0
    ? '<div class="empty"><div class="empty-icon">🔍</div>No markets loaded yet</div>'
    : markets.slice(0,15).map(m => \`
      <div class="market-card">
        <div class="market-title">\${m.title||m.ticker}</div>
        <div class="market-price">
          <div class="market-yes">\${Math.round(m.yesAsk*100)}¢</div>
          <div class="market-vol">Vol \${(m.volume||0).toLocaleString()}</div>
        </div>
      </div>
    \`).join('');

  // Positions — show bot-tracked OR live Kalshi positions
  const positions = s.openPositions || [];
  const kalshiPos = s._kalshiPositions || [];
  const totalCount = Math.max(positions.length, kalshiPos.length > 0 ? kalshiPos.length : 0);
  document.getElementById('posCount').textContent = totalCount;

  if (positions.length > 0) {
    // Show bot-tracked positions with P&L
    document.getElementById('positionList').innerHTML = positions.map(p => {
      const pnl = ((p.currentPrice||p.entryPrice) - p.entryPrice) * p.contracts / 100;
      return \`
      <div class="position-card">
        <div class="pos-header">
          <div class="pos-ticker">\${p.ticker}</div>
          <div class="pos-pnl \${pnl>=0?'pos':'neg'}">\${fmt(pnl)}</div>
        </div>
        <div class="pos-detail">\${p.side} · \${p.contracts} contracts @ \${p.entryPrice}¢ · \${timeAgo(p.openedAt)}</div>
        <div class="pos-detail" style="margin-top:3px;font-size:11px">\${p.reasoning||''}</div>
      </div>\`;
    }).join('');
  } else if (kalshiPos.length > 0) {
    // Fallback: show raw Kalshi positions
    document.getElementById('positionList').innerHTML = kalshiPos.map(p => {
      const qty = parseFloat(p.position_fp || p.position || 0);
      const side = qty > 0 ? 'YES' : 'NO';
      const exposure = parseFloat(p.market_exposure_dollars || 0).toFixed(2);
      return \`
      <div class="position-card">
        <div class="pos-header">
          <div class="pos-ticker">\${p.ticker}</div>
          <div class="pos-pnl" style="color:var(--blue)">$\${exposure}</div>
        </div>
        <div class="pos-detail">\${side} · \${Math.abs(qty)} contracts · Live on Kalshi</div>
      </div>\`;
    }).join('');
  } else {
    document.getElementById('positionList').innerHTML = '<div class="empty"><div class="empty-icon">💼</div>No open positions</div>';
  }

  // Signals
  const signals = s.signals || [];
  document.getElementById('signalList').innerHTML = signals.length === 0
    ? '<div class="empty"><div class="empty-icon">📡</div>No signals yet</div>'
    : signals.map(sig => \`
      <div class="signal-card \${(sig.side||'').toLowerCase()}">
        <div class="signal-header">
          <div class="signal-ticker">\${sig.ticker}</div>
          <div class="signal-side \${(sig.side||'').toLowerCase()}">\${sig.side}</div>
        </div>
        <div class="signal-reason">\${sig.reasoning||''}</div>
        <div class="signal-meta">
          <div class="signal-meta-item">Conf <span>\${Math.round((sig.confidence||0)*100)}%</span></div>
          <div class="signal-meta-item">Edge <span>\${Math.round((sig.edge||0)*100)}%</span></div>
          <div class="signal-meta-item">Size <span>\$\${(sig.kellySize||0).toFixed(2)}</span></div>
        </div>
      </div>
    \`).join('');

  // Logs
  const logs = s.logs || [];
  document.getElementById('logCount').textContent = logs.length;
  document.getElementById('logList').innerHTML = logs.slice(0,50).map(l => \`
    <div class="log-item \${l.level||''}">
      <div class="log-ts">\${l.ts}</div>
      <div class="log-msg">\${l.msg}</div>
    </div>
  \`).join('');
}

async function fetchState() {
  try {
    const [stateRes, posRes] = await Promise.all([
      fetch('/api/state'),
      fetch('/api/kalshi-positions'),
    ]);
    const s = await stateRes.json();
    const p = await posRes.json().catch(() => ({ positions: [] }));
    // Merge live Kalshi positions into state for display
    s._kalshiPositions = p.positions || [];
    render(s);
  } catch(e) { console.error(e); }
}

async function toggleBot() {
  const btn = document.getElementById('toggleBtn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/toggle', { method: 'POST' });
    const s = await r.json();
    render(s);
  } catch(e) {}
  btn.disabled = false;
}

async function resetState() {
  if(!confirm('Reset all state? This clears trades, positions, and logs.')) return;
  await fetch('/api/reset');
  await fetchState();
}

fetchState();
setInterval(fetchState, 8000);
</script>
</body>
</html>`;

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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...S, dryRun: CFG.dryRun }));
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
  // Auto-start after 3 seconds
  setTimeout(() => {
    log('Auto-starting bot...');
    startBot();
  }, 3000);
});
