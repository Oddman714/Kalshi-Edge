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
  maxPos:     5,           // base — scales dynamically with balance (see dynamicMaxPos)
  kellyFrac:  0.30,        // slightly more aggressive kelly
  minEdge:    0.04,        // minimum 4% edge to trade
  minProb:    0.55,        // minimum 55% confidence
  scanInterval:  30000,   // math scanner: every 30s
  brainInterval: 180000,  // claude brain: every 3min
  heartbeatInterval: 1800000, // telegram heartbeat: every 30min
};

// ─── DYNAMIC POSITION SIZING ──────────────────────────────────────────────
// Scales max positions with balance to always optimize Kelly sizing.
// Goal: enough positions to diversify, few enough that each bet is meaningful.
// Thresholds calibrated so avg position = ~20-25% of balance (optimal Kelly range).
function dynamicMaxPos() {
  const bal = S.realBalance > 0 ? S.realBalance : S.balance;
  if (bal < 15)  return 3;  // $0-15:   3 positions, ~$4-5 each — concentrated, high impact
  if (bal < 25)  return 4;  // $15-25:  4 positions, ~$4-6 each
  if (bal < 50)  return 5;  // $25-50:  5 positions, ~$5-10 each
  if (bal < 100) return 6;  // $50-100: 6 positions, ~$8-16 each
  if (bal < 200) return 7;  // $100-200: 7 positions
  return 8;                 // $200+:   8 positions, fully diversified
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
  // Purge junk trades imported from fills (zero revenue + zero pnl = noise)
  if (S.trades && S.trades.length > 0) {
    const before = S.trades.length;
    S.trades = S.trades.filter(t => {
      if (!t.fromKalshi) return true; // keep bot-placed trades always
      if (t.status === 'resolved' && (t.revenue > 0 || Math.abs(t.pnl || 0) > 0)) return true;
      if (t.status !== 'resolved') return false; // drop unresolved Kalshi imports (fills noise)
      return false;
    });
    if (S.trades.length !== before) {
      // Rebuild W/L from clean data
      const resolved = S.trades.filter(t => t.status === 'resolved');
      S.wins = resolved.filter(t => t.won === true).length;
      S.losses = resolved.filter(t => t.won === false).length;
      S.totalPnl = resolved.reduce((sum, t) => sum + (t.pnl || 0), 0);
    }
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

      const revenue = parsePrice(s.revenue_dollars || s.revenue || '0');
      const cost = parsePrice(s.profit_loss_dollars
        ? String(revenue - parseFloat(s.profit_loss_dollars))
        : (s.cost_dollars || '0.5'));
      const pnl = parsePrice(s.profit_loss_dollars || String(revenue - cost));
      const won = revenue > 0 && pnl >= 0;

      // Skip zero-revenue, zero-pnl entries — likely corrupted or phantom fills
      if (revenue === 0 && pnl === 0) continue;

      const trade = {
        ticker,
        side: s.side === 'no' ? 'NO' : 'YES',
        contracts: Math.abs(parseFloat(s.contracts_count_fp || s.contracts || 1)),
        entryPrice: cost > 0 ? Math.round((cost / Math.max(1, parseFloat(s.contracts_count_fp || s.contracts || 1))) * 100) : 50,
        cost,
        revenue,
        pnl,
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
    // API returns cents — convert; guard against already-dollar values
    const rawBal = r.balance || r.balance_dollars || 0;
    const bal = rawBal > 500 ? rawBal / 100 : rawBal;
    S.realBalance = bal;
    if (!CFG.dryRun) {
      // Live mode: real Kalshi balance is always source of truth
      S.balance = bal;
      if (bal > S.peakBalance || (S.peakBalance >= CFG.bankroll && bal < CFG.bankroll * 0.6)) {
        S.peakBalance = bal;
      }
    } else if (S.balance === CFG.bankroll && bal > 0) {
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

    // Full replace of Kalshi-sourced positions; preserve bot-placed ones
    const botPositions = S.openPositions.filter(p => !p.fromKalshi);
    const botTickers = new Set(botPositions.map(p => p.ticker));
    const freshKalshi = livePositions.filter(p => !botTickers.has(p.ticker));
    S.openPositions = [...botPositions, ...freshKalshi];

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
      // Always active
      'KXBTCD','KXBTCW','KXETHUSD','KXETH',
      'KXNBAGAME','KXMLBGAME','KXNHLGAME','KXNFLGAME',
      'FED','FEDRATE','INFL',
      'KXPREZ','KXSENATE','KXHOUSE',
      // Market-hours series
      ...(isMarketHours ? ['INXD','NASDAQ100D','HIGHNY','HIGHMIA','HIGHCHI','HIGHLA'] : []),
      // Off-hours: use weekly versions
      ...(!isMarketHours ? ['INXW','NASDAQ100W','KXBTCW'] : []),
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

  const prompt = `{"task":"generate_trade_signals","rules":["respond with ONLY the JSON object below","no explanation","no preamble","start with {","end with }"],"context":{"goal":"double portfolio ASAP — prefer markets closing within 24h for quick PnL, be aggressive on high-confidence plays above 60% edge","mode":"${CFG.dryRun?'paper':'live'}","balance":${S.balance.toFixed(2)},"peak":${S.peakBalance.toFixed(2)},"todayPnl":${S.todayPnl.toFixed(2)},"totalPnl":${S.totalPnl.toFixed(2)},"wins":${S.wins},"losses":${S.losses},"openSlots":${dynamicMaxPos() - S.openPositions.length},"maxPos":${dynamicMaxPos()},"balance":${(S.realBalance||S.balance).toFixed(2)},"openPositions":${JSON.stringify(S.openPositions.map(p=>({ticker:p.ticker,side:p.side,entryPrice:p.entryPrice})))},"recentMemory":${JSON.stringify(S.brainMemory.slice(-5))}},"markets":${JSON.stringify(topMarkets.slice(0,8).map(m=>({ticker:m.ticker,title:m.title,yesAsk:Math.round(m.yesAsk*100),volume:Math.round(m.volume),score:parseFloat(m.score.toFixed(3)),closesIn:m.closeTime?Math.round((new Date(m.closeTime)-Date.now())/3600000)+'h':'unknown'})))},"instructions":"Analyze each market. Use your knowledge of sports, finance, crypto, and current events. Find mispriced markets where the true probability differs from the implied price. Apply Kelly criterion. Output required_json_format only.","topTraders":${JSON.stringify((S.topTraders||[]).slice(0,3).map(t=>({rank:t.rank||t.position,pnl:t.profit||t.total_profit,winRate:t.win_rate})))},"instructions":"1) Use web search to find breaking news for these market tickers. 2) Check if top traders have positions in these markets (copy their edge). 3) Find markets where true probability differs from implied price. 4) Apply Kelly sizing. Output required_json_format only.","required_json_format":{"signals":[{"ticker":"string","side":"YES or NO","confidence":0.65,"edge":0.08,"reasoning":"one sentence citing news or data","kellySize":5.00}],"marketSummary":"one sentence","skipReason":"if no trades"}}`;

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
        max_tokens: 1000,
        system: 'You are a JSON-only trading signal generator. You have web search available to find breaking news. Use web search FIRST to find relevant news, then output ONLY a valid JSON object. Your entire response after web search must be parseable by JSON.parse(). Start with { and end with }. No markdown, no explanation, no preamble.',
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
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

// ─── KELLY SIZING ──────────────────────────────────────────────────────────
function kellySize(prob, price) {
  const q = 1 - prob;
  const b = (1 - price) / price; // net odds
  const kelly = (b * prob - q) / b;
  const fracKelly = Math.max(0, kelly * CFG.kellyFrac);
  // Max bet scales with dynamic position count — each slot gets equal share
  // e.g. 3 slots = 33% max per trade, 6 slots = 17% max per trade
  const slots = dynamicMaxPos();
  const maxBet = S.balance * Math.min(0.33, 1 / slots);
  const minBet = 1.00;
  return Math.min(maxBet, Math.max(minBet, S.balance * fracKelly));
}

// ─── TRADE EXECUTION ───────────────────────────────────────────────────────
async function executeTrade(sig) {
  const maxPos = dynamicMaxPos();
  if (S.openPositions.length >= maxPos) {
    log(`Skip ${sig.ticker}: max positions reached (${S.openPositions.length}/${maxPos} @ $${(S.realBalance||S.balance).toFixed(2)} bal)`);
    return;
  }
  if (S.openPositions.find(p => p.ticker === sig.ticker)) {
    log(`Skip ${sig.ticker}: already have position`);
    return;
  }

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

        S.balance += revenue;
        S.totalPnl += pnl;
        S.todayPnl += pnl;
        if (won) S.wins++; else S.losses++;
        if (S.balance > S.peakBalance) S.peakBalance = S.balance;

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
    // Sync positions every 5 scans to catch manual trades + remove stale closed ones
    if (S.scanCount === 1 || S.scanCount % 5 === 0) await syncPositions();
    // Backfill Kalshi trade history on first scan and every 10 scans
    if (S.scanCount === 1 || S.scanCount % 10 === 0) await backfillKalshiHistory();

    // ── STOP-LOSS GUARD: halt trading if balance drops below $3 floor ──
    const FLOOR = 3.00;
    if (S.balance <= FLOOR && !CFG.dryRun) {
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

    // Only fire brain if: enough time passed and we have open slots and markets
    const brainReady = (Date.now() - S.lastBrainAt) >= CFG.brainInterval;
    const maxPos = dynamicMaxPos();
    const hasSlots = S.openPositions.length < maxPos;
    const hasMarkets = markets.length > 0;

    if (brainReady && hasSlots && hasMarkets) {
      await runBrain(markets);
    } else if (brainReady && !hasSlots) {
      log(`Brain skipped — positions full (${S.openPositions.length}/${maxPos})`); // maxPos=${maxPos} for $${(S.realBalance||S.balance).toFixed(2)} balance
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
  const drawdown = S.peakBalance > 0
    ? ((S.peakBalance - S.balance) / S.peakBalance * 100).toFixed(1)
    : '0.0';
  const sigAge = S.lastBrainAt > 0
    ? Math.floor((Date.now() - S.lastBrainAt) / 60000)
    : '—';
  const mode = CFG.dryRun ? '📝 Paper' : '🔴 LIVE';

  tg(`📊 <b>Heartbeat</b>
Mode: ${mode}
Balance: $${(!CFG.dryRun && S.realBalance > 0 ? S.realBalance : S.balance).toFixed(2)} | Real: $${S.realBalance.toFixed(2)}
Today: ${S.todayPnl >= 0 ? '+' : ''}$${S.todayPnl.toFixed(2)} | All-time: ${S.totalPnl >= 0 ? '+' : ''}$${S.totalPnl.toFixed(2)}
Win: ${S.wins > 0 || S.losses > 0 ? `${((S.wins/(S.wins+S.losses||1))*100).toFixed(0)}%` : '—'} (${S.wins}W/${S.losses}L) | Open: ${S.openPositions.length}/${dynamicMaxPos()}
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
@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Outfit:wght@300;400;500;600;700&display=swap');
:root {
  --bg: #080c10;
  --card: rgba(255,255,255,0.035);
  --card2: rgba(255,255,255,0.06);
  --border: rgba(255,255,255,0.07);
  --text: #eef2f7;
  --muted: rgba(238,242,247,0.4);
  --green: #0fdb8a;
  --red: #ff4d6d;
  --blue: #3b8bff;
  --gold: #f5c518;
  --accent: #6c3bff;
  --font: 'Outfit', sans-serif;
  --mono: 'Space Mono', monospace;
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden}
body{font-family:var(--font);background:var(--bg);color:var(--text);display:flex;flex-direction:column}

/* Ambient glow */
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(ellipse 70% 40% at 15% 0%, rgba(108,59,255,0.12) 0%, transparent 60%),
    radial-gradient(ellipse 50% 30% at 85% 100%, rgba(15,219,138,0.07) 0%, transparent 55%);}

.app{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;max-width:430px;margin:0 auto;width:100%;overflow:hidden}

/* ── HEADER ── */
.header{padding:52px 20px 12px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.logo{font-size:17px;font-weight:700;letter-spacing:-0.3px}
.logo em{color:var(--accent);font-style:normal}
.pill{display:flex;align-items:center;gap:5px;padding:4px 11px;border-radius:100px;font-size:11px;font-weight:600;background:var(--card2);border:1px solid var(--border);letter-spacing:.4px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--muted)}
.dot.live{background:var(--green);box-shadow:0 0 7px var(--green);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}

/* ── SCROLL AREA ── */
.scroll{flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;padding-bottom:88px}
.scroll::-webkit-scrollbar{display:none}

/* ── BALANCE SECTION ── */
.bal-wrap{padding:4px 20px 0}
.bal-main{font-size:44px;font-weight:700;letter-spacing:-2.5px;line-height:1;font-family:var(--mono)}
.bal-change{display:flex;align-items:center;gap:6px;margin-top:5px;font-size:13px;font-weight:500}
.change-up{color:var(--green)}
.change-dn{color:var(--red)}
.change-neutral{color:var(--muted)}
.bal-meta{display:flex;gap:20px;margin-top:10px}
.bal-meta-item{font-size:12px;color:var(--muted)}
.bal-meta-item span{color:var(--text);font-weight:600}

/* ── CHART ── */
.chart-wrap{margin:16px 20px 0;border-radius:16px;background:var(--card);border:1px solid var(--border);overflow:hidden}
.chart-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 0}
.chart-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px}
.chart-tabs{display:flex;gap:2px;background:rgba(255,255,255,0.05);border-radius:8px;padding:2px}
.chart-tab{font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;cursor:pointer;color:var(--muted);border:none;background:transparent;font-family:var(--font)}
.chart-tab.active{background:var(--card2);color:var(--text)}
.chart-svg-wrap{padding:10px 12px 8px;height:110px;position:relative}
canvas#pnlChart{width:100%!important;height:100%!important}

/* ── STATS GRID ── */
.stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:10px 20px 0}
.stat{padding:13px 12px;border-radius:13px;background:var(--card);border:1px solid var(--border);text-align:center}
.stat-n{font-size:20px;font-weight:700;font-family:var(--mono);line-height:1}
.stat-n.g{color:var(--green)}
.stat-n.r{color:var(--red)}
.stat-n.b{color:var(--blue)}
.stat-n.gold{color:var(--gold)}
.stat-l{font-size:10px;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:.5px}

/* ── WIN/LOSS BREAKDOWN ── */
.breakdown{margin:10px 20px 0;border-radius:16px;background:var(--card);border:1px solid var(--border);padding:14px 16px}
.bd-title{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px}
.bd-bar-wrap{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.bd-bar-bg{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,0.07);overflow:hidden}
.bd-bar-fill{height:100%;border-radius:3px;transition:width .6s cubic-bezier(.4,0,.2,1)}
.bd-bar-fill.g{background:var(--green)}
.bd-bar-fill.r{background:var(--red)}
.bd-label{font-size:12px;font-weight:600;min-width:32px;text-align:right;font-family:var(--mono)}
.bd-label.g{color:var(--green)}
.bd-label.r{color:var(--red)}
.bd-stats-row{display:flex;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
.bd-stat{text-align:center}
.bd-stat-n{font-size:14px;font-weight:700;font-family:var(--mono)}
.bd-stat-l{font-size:10px;color:var(--muted);margin-top:2px}

/* ── ENGINE CARD ── */
.section{margin:10px 20px 0}
.sec-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.sec-title{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px}
.sec-badge{font-size:11px;font-family:var(--mono);color:var(--accent)}
.engine-card{padding:14px 16px;border-radius:14px;background:var(--card);border:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.eng-info .eng-name{font-size:15px;font-weight:600}
.eng-info .eng-sub{font-size:12px;color:var(--muted);margin-top:2px}
.toggle{width:52px;height:28px;border-radius:14px;border:none;cursor:pointer;position:relative;transition:background .3s;background:rgba(255,255,255,0.1)}
.toggle.on{background:var(--accent)}
.toggle::after{content:'';position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:transform .3s;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.toggle.on::after{transform:translateX(24px)}

/* ── POSITIONS ── */
.pos-card{padding:13px 15px;border-radius:13px;background:var(--card);border:1px solid var(--border);margin-bottom:8px}
.pos-top{display:flex;justify-content:space-between;align-items:flex-start}
.pos-ticker{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--text);line-height:1.3}
.pos-pnl{font-family:var(--mono);font-size:14px;font-weight:700}
.pos-pnl.pos{color:var(--green)}
.pos-pnl.neg{color:var(--red)}
.pos-pnl.neu{color:var(--blue)}
.pos-detail{font-size:11px;color:var(--muted);margin-top:5px;line-height:1.4}
.pos-progress{height:3px;border-radius:2px;background:rgba(255,255,255,0.07);margin-top:8px;overflow:hidden}
.pos-progress-fill{height:100%;border-radius:2px;background:var(--green);transition:width .4s}

/* ── MARKETS ── */
.mkt-card{padding:11px 14px;border-radius:12px;background:var(--card);border:1px solid var(--border);margin-bottom:7px;display:flex;justify-content:space-between;align-items:center}
.mkt-title{font-size:12px;line-height:1.3;flex:1;margin-right:10px;color:var(--text)}
.mkt-right{text-align:right;flex-shrink:0}
.mkt-yes{font-family:var(--mono);font-size:14px;font-weight:700;color:var(--green)}
.mkt-vol{font-size:10px;color:var(--muted);margin-top:2px}

/* ── SIGNALS ── */
.sig-card{padding:13px 15px;border-radius:13px;background:var(--card);border:1px solid var(--border);border-left:3px solid var(--accent);margin-bottom:8px}
.sig-card.yes{border-left-color:var(--green)}
.sig-card.no{border-left-color:var(--red)}
.sig-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.sig-ticker{font-family:var(--mono);font-size:12px;font-weight:700}
.sig-badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px}
.sig-badge.yes{background:rgba(15,219,138,0.15);color:var(--green)}
.sig-badge.no{background:rgba(255,77,109,0.15);color:var(--red)}
.sig-reason{font-size:12px;color:var(--muted);line-height:1.45}
.sig-meta{display:flex;gap:14px;margin-top:8px}
.sig-m{font-size:11px;color:var(--muted);font-family:var(--mono)}
.sig-m span{color:var(--text)}

/* ── HISTORY ── */
.hist-card{padding:12px 15px;border-radius:13px;background:var(--card);border:1px solid var(--border);margin-bottom:8px}
.hist-top{display:flex;justify-content:space-between;align-items:center}
.hist-ticker{font-family:var(--mono);font-size:12px;font-weight:700}
.hist-pnl{font-family:var(--mono);font-size:14px;font-weight:700}
.hist-pnl.win{color:var(--green)}
.hist-pnl.loss{color:var(--red)}
.hist-detail{font-size:11px;color:var(--muted);margin-top:4px;line-height:1.5}
.hist-summary{display:flex;gap:12px;margin-bottom:12px;padding:12px 15px;border-radius:13px;background:var(--card);border:1px solid var(--border)}
.hist-sum-item{flex:1;text-align:center}
.hist-sum-n{font-family:var(--mono);font-size:16px;font-weight:700}
.hist-sum-l{font-size:10px;color:var(--muted);margin-top:2px;text-transform:uppercase;letter-spacing:.5px}

/* ── LOGS ── */
.log-list{background:var(--card);border:1px solid var(--border);border-radius:13px;overflow:hidden}
.log-row{padding:9px 13px;border-bottom:1px solid var(--border);display:flex;gap:9px;align-items:flex-start}
.log-row:last-child{border-bottom:none}
.log-ts{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap;flex-shrink:0;padding-top:1px}
.log-msg{font-size:12px;line-height:1.4}
.log-row.WARN .log-msg{color:var(--gold)}
.log-row.ERROR .log-msg{color:var(--red)}
.reset-btn{display:block;width:100%;margin-top:10px;padding:13px;border-radius:13px;border:1px solid var(--border);background:var(--card2);color:var(--text);font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;text-align:center}

/* ── EMPTY ── */
.empty{text-align:center;padding:28px 16px;color:var(--muted);font-size:13px}
.empty-icon{font-size:32px;margin-bottom:6px}

/* ── TAB BAR ── */
.tabbar{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:rgba(8,12,16,0.88);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);border-top:1px solid var(--border);display:flex;padding:8px 0 max(20px,env(safe-area-inset-bottom));z-index:200;flex-shrink:0}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:5px 0;cursor:pointer}
.tab-icon{font-size:19px}
.tab-lbl{font-size:10px;font-weight:500;color:var(--muted)}
.tab.active .tab-lbl{color:var(--accent)}

.hidden{display:none!important}

/* ── SYNC BUTTON ── */
.sync-btn{background:var(--card2);border:1px solid var(--border);border-radius:100px;color:var(--text);font-size:16px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s;flex-shrink:0}
.sync-btn:active{transform:scale(0.92)}
.sync-btn.spinning{animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.sync-toast{position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:var(--card2);border:1px solid var(--border);border-radius:100px;padding:8px 18px;font-size:12px;font-weight:600;color:var(--green);opacity:0;transition:opacity .3s;pointer-events:none;z-index:999;white-space:nowrap}
.sync-toast.show{opacity:1}
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <div class="logo">Kalshi<em>Bot</em></div>
    <div style="display:flex;align-items:center;gap:8px">
      <button class="sync-btn" id="syncBtn" onclick="syncNow()" title="Sync with Kalshi">⟳</button>
      <div class="pill"><div class="dot" id="statusDot"></div><span id="statusText">—</span></div>
    </div>
  </div>
  <div class="sync-toast" id="syncToast">Synced ✓</div>

  <div class="scroll">

    <!-- HOME TAB -->
    <div id="tab-home">
      <div class="bal-wrap">
        <div class="bal-label-txt" id="balLabel" style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Balance</div>
        <div class="bal-main" id="mainBal">$—</div>
        <div class="bal-change" id="balChange">—</div>
        <div class="bal-meta">
          <div class="bal-meta-item">Real <span id="realBal">$—</span></div>
          <div class="bal-meta-item">Today <span id="todayPnl">—</span></div>
          <div class="bal-meta-item">Peak <span id="peakBal">$—</span></div>
        </div>
      </div>

      <!-- P&L CHART -->
      <div class="chart-wrap">
        <div class="chart-header">
          <div class="chart-label">Portfolio P&L</div>
          <div class="chart-tabs">
            <button class="chart-tab active" onclick="setChartRange('1H',this)">1H</button>
            <button class="chart-tab" onclick="setChartRange('1D',this)">1D</button>
            <button class="chart-tab" onclick="setChartRange('ALL',this)">ALL</button>
          </div>
        </div>
        <div class="chart-svg-wrap">
          <canvas id="pnlChart"></canvas>
        </div>
      </div>

      <!-- STATS -->
      <div class="stats">
        <div class="stat">
          <div class="stat-n b" id="scanCount">—</div>
          <div class="stat-l">Scans</div>
        </div>
        <div class="stat">
          <div class="stat-n" id="winRateStat">—</div>
          <div class="stat-l">Win Rate</div>
        </div>
        <div class="stat">
          <div class="stat-n" id="openStat">—</div>
          <div class="stat-l">Open/Max</div>
        </div>
      </div>

      <!-- WIN/LOSS BREAKDOWN -->
      <div class="breakdown">
        <div class="bd-title">Performance Breakdown</div>
        <div class="bd-bar-wrap">
          <div style="font-size:11px;color:var(--green);font-weight:600;min-width:28px">W</div>
          <div class="bd-bar-bg"><div class="bd-bar-fill g" id="winBar" style="width:0%"></div></div>
          <div class="bd-label g" id="winCount">0</div>
        </div>
        <div class="bd-bar-wrap">
          <div style="font-size:11px;color:var(--red);font-weight:600;min-width:28px">L</div>
          <div class="bd-bar-bg"><div class="bd-bar-fill r" id="lossBar" style="width:0%"></div></div>
          <div class="bd-label r" id="lossCount">0</div>
        </div>
        <div class="bd-stats-row">
          <div class="bd-stat">
            <div class="bd-stat-n" id="bdWinRate">—</div>
            <div class="bd-stat-l">Win Rate</div>
          </div>
          <div class="bd-stat">
            <div class="bd-stat-n" id="bdAvgWin" style="color:var(--green)">—</div>
            <div class="bd-stat-l">Avg Win</div>
          </div>
          <div class="bd-stat">
            <div class="bd-stat-n" id="bdDrawdown" style="color:var(--red)">—</div>
            <div class="bd-stat-l">Drawdown</div>
          </div>
          <div class="bd-stat">
            <div class="bd-stat-n" id="bdBrainAge">—</div>
            <div class="bd-stat-l">Brain Age</div>
          </div>
        </div>
      </div>

      <!-- ENGINE -->
      <div class="section">
        <div class="sec-hdr">
          <div class="sec-title">Engine</div>
          <div class="sec-badge" id="modeLabel">—</div>
        </div>
        <div class="engine-card">
          <div class="eng-info">
            <div class="eng-name">Trading Engine</div>
            <div class="eng-sub" id="engineSub">—</div>
          </div>
          <button class="toggle" id="toggleBtn" onclick="toggleBot()"></button>
        </div>
      </div>
    </div>

    <!-- MARKETS TAB -->
    <div id="tab-markets" class="hidden">
      <div class="section" style="margin-top:14px">
        <div class="sec-hdr">
          <div class="sec-title">Top Markets</div>
          <div class="sec-badge" id="mktCount">—</div>
        </div>
        <div id="mktList"></div>
      </div>
    </div>

    <!-- POSITIONS TAB -->
    <div id="tab-positions" class="hidden">
      <div class="section" style="margin-top:14px">
        <div class="sec-hdr">
          <div class="sec-title">Open Positions</div>
          <div class="sec-badge" id="posCount">—</div>
        </div>
        <div id="positionList"></div>
      </div>
      <div class="section">
        <div class="sec-hdr"><div class="sec-title">Signals</div></div>
        <div id="signalList"></div>
      </div>
    </div>

    <!-- HISTORY TAB -->
    <div id="tab-history" class="hidden">
      <div class="section" style="margin-top:14px">
        <div class="sec-hdr">
          <div class="sec-title">Trade History</div>
          <div class="sec-badge" id="histCount">—</div>
        </div>
        <div id="histSummary"></div>
        <div id="histList"></div>
      </div>
    </div>

    <!-- LOGS TAB -->
    <div id="tab-logs" class="hidden">
      <div class="section" style="margin-top:14px">
        <div class="sec-hdr">
          <div class="sec-title">System Log</div>
          <div class="sec-badge" id="logCount">—</div>
        </div>
        <div class="log-list" id="logList"></div>
        <button class="reset-btn" onclick="resetState()">🔄 Reset State</button>
      </div>
    </div>

  </div><!-- end scroll -->
</div><!-- end app -->

<!-- TAB BAR -->
<div class="tabbar">
  <div class="tab active" onclick="switchTab('home',this)"><div class="tab-icon">📊</div><div class="tab-lbl">Home</div></div>
  <div class="tab" onclick="switchTab('markets',this)"><div class="tab-icon">🔍</div><div class="tab-lbl">Markets</div></div>
  <div class="tab" onclick="switchTab('positions',this)"><div class="tab-icon">💼</div><div class="tab-lbl">Positions</div></div>
  <div class="tab" onclick="switchTab('history',this)"><div class="tab-icon">📜</div><div class="tab-lbl">History</div></div>
  <div class="tab" onclick="switchTab('logs',this)"><div class="tab-icon">📋</div><div class="tab-lbl">Logs</div></div>
</div>

<script>
// ── STATE ──
let state = {};
let chartRange = '1H';
let pnlHistory = JSON.parse(localStorage.getItem('pnlHistory')||'[]');
let chartCtx = null;

// ── CHART ──
function initChart() {
  const canvas = document.getElementById('pnlChart');
  chartCtx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * window.devicePixelRatio;
  canvas.height = canvas.offsetHeight * window.devicePixelRatio;
  chartCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
}

function drawChart(points) {
  if (!chartCtx) return;
  const canvas = document.getElementById('pnlChart');
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  chartCtx.clearRect(0, 0, W, H);

  if (points.length < 2) {
    // Draw flat line
    chartCtx.strokeStyle = 'rgba(108,59,255,0.4)';
    chartCtx.lineWidth = 1.5;
    chartCtx.setLineDash([4,4]);
    chartCtx.beginPath();
    chartCtx.moveTo(0, H/2); chartCtx.lineTo(W, H/2);
    chartCtx.stroke();
    chartCtx.setLineDash([]);
    return;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const pad = 8;

  const xs = points.map((_, i) => pad + (i / (points.length - 1)) * (W - pad*2));
  const ys = points.map(v => H - pad - ((v - min) / range) * (H - pad*2));

  const isUp = points[points.length-1] >= points[0];
  const color = isUp ? '#0fdb8a' : '#ff4d6d';

  // Fill gradient
  const grad = chartCtx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, isUp ? 'rgba(15,219,138,0.25)' : 'rgba(255,77,109,0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  chartCtx.beginPath();
  chartCtx.moveTo(xs[0], ys[0]);
  for (let i = 1; i < xs.length; i++) {
    const cpx = (xs[i-1]+xs[i])/2;
    chartCtx.bezierCurveTo(cpx, ys[i-1], cpx, ys[i], xs[i], ys[i]);
  }
  chartCtx.lineTo(xs[xs.length-1], H);
  chartCtx.lineTo(xs[0], H);
  chartCtx.closePath();
  chartCtx.fillStyle = grad;
  chartCtx.fill();

  // Line
  chartCtx.beginPath();
  chartCtx.moveTo(xs[0], ys[0]);
  for (let i = 1; i < xs.length; i++) {
    const cpx = (xs[i-1]+xs[i])/2;
    chartCtx.bezierCurveTo(cpx, ys[i-1], cpx, ys[i], xs[i], ys[i]);
  }
  chartCtx.strokeStyle = color;
  chartCtx.lineWidth = 2;
  chartCtx.stroke();

  // Last point dot
  const lx = xs[xs.length-1], ly = ys[ys.length-1];
  chartCtx.beginPath();
  chartCtx.arc(lx, ly, 3.5, 0, Math.PI*2);
  chartCtx.fillStyle = color;
  chartCtx.fill();
}

function setChartRange(r, el) {
  chartRange = r;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderChart();
}

function renderChart() {
  const now = Date.now();
  let filtered = pnlHistory;
  if (chartRange === '1H') filtered = pnlHistory.filter(p => p.ts > now - 3600000);
  else if (chartRange === '1D') filtered = pnlHistory.filter(p => p.ts > now - 86400000);
  drawChart(filtered.map(p => p.val));
}

// ── HELPERS ──
function fmt(n, sign=true) {
  const s = Math.abs(n).toFixed(2);
  return (n >= 0 ? (sign?'+':'') : '-') + '$' + s;
}
function timeAgo(ms) {
  const m = Math.floor((Date.now()-ms)/60000);
  if(m<1) return 'just now';
  if(m<60) return m+'min ago';
  return Math.floor(m/60)+'h ago';
}
function switchTab(tab, el) {
  document.querySelectorAll('[id^="tab-"]').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-'+tab).classList.remove('hidden');
  el.classList.add('active');
}

// ── RENDER ──
function render(s) {
  state = s;

  // Track P&L history
  const bal = s.balance || 0;
  const lastPnl = pnlHistory.length > 0 ? pnlHistory[pnlHistory.length-1].val : bal;
  if (pnlHistory.length === 0 || Math.abs(bal - lastPnl) > 0.001) {
    pnlHistory.push({ ts: Date.now(), val: bal });
    if (pnlHistory.length > 500) pnlHistory.shift();
    try { localStorage.setItem('pnlHistory', JSON.stringify(pnlHistory)); } catch(e){}
  }
  renderChart();

  // Status
  const running = s.isRunning;
  document.getElementById('statusDot').className = 'dot' + (running?' live':'');
  document.getElementById('statusText').textContent = running ? (s.dryRun?'PAPER':'LIVE') : 'Stopped';
  document.getElementById('toggleBtn').className = 'toggle' + (running?' on':'');
  document.getElementById('modeLabel').textContent = s.dryRun ? 'PAPER' : 'LIVE';
  document.getElementById('balLabel').textContent = s.dryRun ? 'Sim Balance' : 'Live Balance';
  document.getElementById('engineSub').textContent = running
    ? 'Scan #'+s.scanCount+' · Brain #'+s.brainCount
    : 'Tap to start';

  // Balance
  const startBal = pnlHistory.length > 0 ? pnlHistory[0].val : bal;
  const totalChange = bal - startBal;
  document.getElementById('mainBal').textContent = '$' + bal.toFixed(2);
  const changeEl = document.getElementById('balChange');
  const pct = startBal > 0 ? ((totalChange/startBal)*100).toFixed(2) : '0.00';
  changeEl.className = 'bal-change ' + (totalChange >= 0 ? 'change-up' : 'change-dn');
  changeEl.textContent = (totalChange >= 0 ? '▲ +' : '▼ −') + '$' + Math.abs(totalChange).toFixed(2) + ' (' + Math.abs(parseFloat(pct)).toFixed(2) + '%)';
  document.getElementById('realBal').textContent = '$' + (s.realBalance||0).toFixed(2);
  const todayEl = document.getElementById('todayPnl');
  todayEl.textContent = fmt(s.todayPnl||0);
  todayEl.style.color = (s.todayPnl||0) >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('peakBal').textContent = '$' + (s.peakBalance||bal).toFixed(2);

  // Stats
  document.getElementById('scanCount').textContent = s.scanCount||0;
  const total = (s.wins||0)+(s.losses||0);
  const wr = total > 0 ? Math.round(s.wins/total*100) : null;
  const wrEl = document.getElementById('winRateStat');
  wrEl.textContent = wr !== null ? wr+'%' : '—';
  wrEl.className = 'stat-n ' + (wr > 50 ? 'g' : wr !== null ? 'r' : '');
  const openEl = document.getElementById('openStat');
  openEl.textContent = (s.openPositions?.length||0)+'/'+(s.maxPos||8);
  openEl.className = 'stat-n ' + ((s.openPositions?.length||0) > 0 ? 'gold' : '');

  // Breakdown
  const wins = s.wins||0, losses = s.losses||0;
  const maxWL = Math.max(wins, losses, 1);
  document.getElementById('winBar').style.width = (wins/maxWL*100)+'%';
  document.getElementById('lossBar').style.width = (losses/maxWL*100)+'%';
  document.getElementById('winCount').textContent = wins;
  document.getElementById('lossCount').textContent = losses;
  document.getElementById('bdWinRate').textContent = total > 0 ? Math.round(wins/total*100)+'%' : '—';
  // Avg win from trade history
  const closedTrades = (s.trades||[]).filter(t => t.won);
  const avgWin = closedTrades.length > 0
    ? closedTrades.reduce((a,t) => a+(t.pnl||0), 0) / closedTrades.length
    : null;
  const avgWinEl = document.getElementById('bdAvgWin');
  avgWinEl.textContent = avgWin !== null ? '+$'+avgWin.toFixed(2) : '—';
  avgWinEl.style.color = avgWin !== null ? 'var(--green)' : 'var(--muted)';
  const drawdown = s.peakBalance > 0
    ? ((s.peakBalance - s.balance) / s.peakBalance * 100)
    : 0;
  document.getElementById('bdDrawdown').textContent = drawdown.toFixed(1)+'%';
  const brainAge = s.lastBrainAt > 0 ? Math.floor((Date.now()-s.lastBrainAt)/60000) : null;
  document.getElementById('bdBrainAge').textContent = brainAge !== null ? brainAge+'m' : '—';

  // Markets
  const mkts = s.topMarkets||[];
  document.getElementById('mktCount').textContent = mkts.length;
  document.getElementById('mktList').innerHTML = mkts.length === 0
    ? '<div class="empty"><div class="empty-icon">🔍</div>No markets loaded</div>'
    : mkts.slice(0,20).map(m => \`
      <div class="mkt-card">
        <div class="mkt-title">\${m.title||m.ticker}</div>
        <div class="mkt-right">
          <div class="mkt-yes">\${Math.round((m.yesAsk||0)*100)}¢</div>
          <div class="mkt-vol">vol \${(m.volume||0).toLocaleString()}</div>
        </div>
      </div>\`).join('');

  // Positions
  const positions = s.openPositions||[];
  const kalshiPos = s._kalshiPositions||[];
  const posCount = Math.max(positions.length, kalshiPos.length);
  document.getElementById('posCount').textContent = posCount||'0';

  if (positions.length > 0) {
    document.getElementById('positionList').innerHTML = positions.map(p => {
      const pnl = ((p.currentPrice||p.entryPrice) - p.entryPrice) * p.contracts / 100;
      const prob = Math.max(0.01, Math.min(0.99, (p.currentPrice||p.entryPrice)/100));
      return \`<div class="pos-card">
        <div class="pos-top">
          <div class="pos-ticker">\${p.ticker}</div>
          <div class="pos-pnl \${pnl>0?'pos':pnl<0?'neg':'neu'}">\${fmt(pnl)}</div>
        </div>
        <div class="pos-detail">\${p.side} · \${p.contracts} contracts @ \${p.entryPrice}¢ · \${timeAgo(p.openedAt)}</div>
        \${p.reasoning ? \`<div class="pos-detail" style="margin-top:4px;font-size:10.5px;opacity:.7">\${p.reasoning}</div>\` : ''}
        <div class="pos-progress"><div class="pos-progress-fill" style="width:\${Math.round(prob*100)}%;\${p.side==='NO'?'background:var(--red)':''}"></div></div>
      </div>\`;
    }).join('');
  } else if (kalshiPos.length > 0) {
    document.getElementById('positionList').innerHTML = kalshiPos.map(p => {
      const qty = parseFloat(p.position_fp||p.position||0);
      const side = qty > 0 ? 'YES' : 'NO';
      const exp = parseFloat(p.market_exposure_dollars||0).toFixed(2);
      return \`<div class="pos-card">
        <div class="pos-top">
          <div class="pos-ticker">\${p.ticker}</div>
          <div class="pos-pnl neu">$\${exp}</div>
        </div>
        <div class="pos-detail">\${side} · \${Math.abs(qty)} contracts · Live on Kalshi</div>
        <div class="pos-progress"><div class="pos-progress-fill" style="width:50%;\${side==='NO'?'background:var(--red)':''}"></div></div>
      </div>\`;
    }).join('');
  } else {
    document.getElementById('positionList').innerHTML = '<div class="empty"><div class="empty-icon">💼</div>No open positions</div>';
  }

  // Signals
  const sigs = s.signals||[];
  document.getElementById('signalList').innerHTML = sigs.length === 0
    ? '<div class="empty"><div class="empty-icon">📡</div>No signals yet</div>'
    : sigs.map(sig => \`
      <div class="sig-card \${(sig.side||'').toLowerCase()}">
        <div class="sig-top">
          <div class="sig-ticker">\${sig.ticker}</div>
          <div class="sig-badge \${(sig.side||'').toLowerCase()}">\${sig.side}</div>
        </div>
        <div class="sig-reason">\${sig.reasoning||'—'}</div>
        <div class="sig-meta">
          <div class="sig-m">Conf <span>\${Math.round((sig.confidence||0)*100)}%</span></div>
          <div class="sig-m">Edge <span>\${Math.round((sig.edge||0)*100)}%</span></div>
          <div class="sig-m">Size <span>$\${(sig.kellySize||0).toFixed(2)}</span></div>
        </div>
      </div>\`).join('');

  // Logs
  const logs = s.logs||[];
  document.getElementById('logCount').textContent = logs.length;
  document.getElementById('logList').innerHTML = logs.slice(0,60).map(l => \`
    <div class="log-row \${l.level||''}">
      <div class="log-ts">\${l.ts}</div>
      <div class="log-msg">\${l.msg}</div>
    </div>\`).join('');
}

// ── HISTORY RENDER ──
function renderHistory(trades) {
  const list = document.getElementById('histList');
  const summary = document.getElementById('histSummary');
  const count = document.getElementById('histCount');
  if (!list) return;

  const sorted = [...(trades||[])].reverse(); // newest first
  count.textContent = sorted.length;

  const wins = sorted.filter(t => t.won);
  const losses = sorted.filter(t => !t.won);
  const totalPnl = sorted.reduce((a, t) => a + (t.pnl||0), 0);
  const winRate = sorted.length > 0 ? Math.round(wins.length/sorted.length*100) : 0;

  summary.innerHTML = sorted.length === 0 ? '' : \`
    <div class="hist-summary">
      <div class="hist-sum-item">
        <div class="hist-sum-n" style="color:var(--green)">\${wins.length}W</div>
        <div class="hist-sum-l">Wins</div>
      </div>
      <div class="hist-sum-item">
        <div class="hist-sum-n" style="color:var(--red)">\${losses.length}L</div>
        <div class="hist-sum-l">Losses</div>
      </div>
      <div class="hist-sum-item">
        <div class="hist-sum-n" style="color:\${winRate>=50?'var(--green)':'var(--red)'}">\${winRate}%</div>
        <div class="hist-sum-l">Win Rate</div>
      </div>
      <div class="hist-sum-item">
        <div class="hist-sum-n" style="color:\${totalPnl>=0?'var(--green)':'var(--red)'}">\${totalPnl>=0?'+':''}$\${Math.abs(totalPnl).toFixed(2)}</div>
        <div class="hist-sum-l">Total P&L</div>
      </div>
    </div>\`;

  list.innerHTML = sorted.length === 0
    ? '<div class="empty"><div class="empty-icon">📜</div>No trades yet</div>'
    : sorted.slice(0, 50).map(t => {
        const pnl = t.pnl || 0;
        const date = t.resolvedAt ? new Date(t.resolvedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
        return \`<div class="hist-card">
          <div class="hist-top">
            <div class="hist-ticker">\${t.ticker}</div>
            <div class="hist-pnl \${t.won?'win':'loss'}">\${pnl>=0?'+':''}$\${Math.abs(pnl).toFixed(2)}</div>
          </div>
          <div class="hist-detail">\${t.side} · \${t.contracts} contracts @ \${t.entryPrice}¢ · \${date}</div>
          \${t.reasoning ? \`<div class="hist-detail" style="opacity:.6;font-size:10.5px">\${t.reasoning}</div>\` : ''}
        </div>\`;
      }).join('');
}

async function fetchHistory() {
  try {
    const r = await fetch('/api/history');
    const h = await r.json();
    renderHistory(h.trades || []);
  } catch(e) { console.error(e); }
}

// ── SYNC ──
async function syncNow() {
  const btn = document.getElementById('syncBtn');
  const toast = document.getElementById('syncToast');
  if (!btn) return;
  btn.classList.add('spinning');
  btn.disabled = true;
  try {
    const r = await fetch('/api/sync', { method: 'POST' });
    const s = await r.json();
    if (s.error) throw new Error(s.error);
    s._kalshiPositions = s.openPositions || [];
    render(s);
    await fetchHistory();
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  } catch(e) {
    console.error('Sync failed:', e);
  }
  btn.classList.remove('spinning');
  btn.disabled = false;
}

// ── API ──
async function fetchState() {
  try {
    const [sr, pr] = await Promise.all([fetch('/api/state'), fetch('/api/kalshi-positions')]);
    const s = await sr.json();
    const p = await pr.json().catch(()=>({positions:[]}));
    s._kalshiPositions = p.positions||[];
    render(s);
  } catch(e){console.error(e)}
}
async function toggleBot() {
  document.getElementById('toggleBtn').disabled = true;
  try { const r = await fetch('/api/toggle',{method:'POST'}); const s = await r.json(); render(s); } catch(e){}
  document.getElementById('toggleBtn').disabled = false;
}
async function resetState() {
  if(!confirm('Reset all state?')) return;
  await fetch('/api/reset'); await fetchState();
}

// ── BOOT ──
window.addEventListener('load', () => {
  initChart();
  fetchState();
  fetchHistory();
  setInterval(fetchState, 7000);
  setInterval(fetchHistory, 30000); // refresh history every 30s
});
window.addEventListener('resize', () => { initChart(); renderChart(); });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ...S, dryRun: CFG.dryRun, maxPos: dynamicMaxPos(), maxPosBase: CFG.maxPos,
      winRate, drawdown, openCount: S.openPositions.length,
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
  // Auto-start after 3 seconds
  setTimeout(() => {
    log('Auto-starting bot...');
    startBot();
  }, 3000);
});
