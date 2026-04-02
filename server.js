// ═══════════════════════════════════════════════════════════════
//  KALSHI EDGE v5 — Definitive Production Bot
//  Three-layer quant + heartbeat + aggressive paper + memory
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
  apiKeyId: process.env.KALSHI_API_KEY_ID || '',
  privateKey: (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  baseUrl: process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com',
  basePath: '/trade-api/v2',
  claudeKey: process.env.CLAUDE_API_KEY || '',
  claudeModel: 'claude-sonnet-4-20250514',
  dryRun: process.env.DRY_RUN !== 'false',
  bankroll: parseFloat(process.env.BANKROLL || '50'),
  kelly: parseFloat(process.env.KELLY_FRACTION || '0.35'),
  edgeMin: parseFloat(process.env.CLAUDE_EDGE || '0.05'),
  maxPos: parseFloat(process.env.MAX_POSITION || '5'),
  maxLoss: parseFloat(process.env.MAX_DAILY_LOSS || '8'),
  maxOpen: parseInt(process.env.MAX_CONCURRENT || '8'),
  tgToken: process.env.TELEGRAM_TOKEN || '',
  tgChat: process.env.TELEGRAM_CHAT_ID || '',
};

// Timing
const SCAN_SEC = 30;        // Layer 1 every 30s (free)
const BRAIN_SEC = 300;      // Layer 2 every 5min (Claude)
const HEARTBEAT_SEC = 1800; // Telegram heartbeat every 30min

// ─── LOGGING ────────────────────────────────────────────────

const logs = [];
function log(m) {
  const e = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(e);
  logs.unshift(e);
  if (logs.length > 800) logs.length = 800;
}

// ─── STATE ──────────────────────────────────────────────────

const DB = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'ke5.json');

let S = {
  trades: [], positions: [], signals: [], candidates: [],
  resolved: [], news: [], priceHistory: {}, marketMeta: {},
  balance: C.bankroll * 100, dailyPnL: 0, dailyDate: '',
  totalPnL: 0, wins: 0, losses: 0, paperWins: 0, paperLosses: 0,
  isRunning: false, botStarted: null, lastError: null,
  scanCount: 0, brainCount: 0, totalClaude: 0, lastScan: null, lastBrain: null,
  perfCat: {}, perfConf: { high: {w:0,l:0}, medium: {w:0,l:0}, low: {w:0,l:0} },
  perfSide: { yes: {w:0,l:0}, no: {w:0,l:0} },
  claudeDown: false, lastCreditCheck: 0,
};

function load() {
  try {
    if (fs.existsSync(DB)) {
      const d = JSON.parse(fs.readFileSync(DB, 'utf8'));
      S = { ...S, ...d };
      // Trim bloated state
      let trimCount = 0;
      for (const t in S.priceHistory) {
        if (S.priceHistory[t].length > 20) { S.priceHistory[t] = S.priceHistory[t].slice(-20); trimCount++; }
      }
      const tks = Object.keys(S.priceHistory);
      if (tks.length > 500) { tks.slice(0, tks.length - 500).forEach(t => delete S.priceHistory[t]); trimCount += tks.length - 500; }
      if (S.trades.length > 200) S.trades.length = 200;
      if (trimCount) log('Trimmed ' + trimCount + ' history entries');
      log('📂 Loaded: ' + S.trades.length + ' trades, ' + (S.paperWins + S.wins) + 'W/' + (S.paperLosses + S.losses) + 'L');
    } else { log('📂 Fresh start'); }
  } catch (e) { log('Load err: ' + e.message); }
}

function save() {
  try {
    // Trim price history
    for (const t in S.priceHistory) {
      if (S.priceHistory[t].length > 40) S.priceHistory[t] = S.priceHistory[t].slice(-40);
    }
    if (S.trades.length > 500) S.trades.length = 500;
    if (S.resolved.length > 200) S.resolved.length = 200;
    fs.writeFileSync(DB, JSON.stringify(S));
  } catch (e) {}
}

load();
setInterval(save, 15000);

// ─── HTTP ───────────────────────────────────────────────────

function http(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, ...opts }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }); } catch (e) { resolve({ status: res.statusCode, data: { raw: d } }); } });
    });
    r.setTimeout(12000, () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ─── KALSHI API ─────────────────────────────────────────────

function signReq(ts, method, p) {
  try {
    const pk = crypto.createPrivateKey({ key: C.privateKey, format: 'pem' });
    return crypto.sign('sha256', Buffer.from(`${ts}${method}${p}`), { key: pk, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }).toString('base64');
  } catch (e) { return ''; }
}

function api(method, ep, body) {
  const ts = Date.now().toString();
  const sp = `${C.basePath}${ep.split('?')[0]}`;
  return http(`${C.baseUrl}${C.basePath}${ep}`, { method, headers: { 'KALSHI-ACCESS-KEY': C.apiKeyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': signReq(ts, method, sp), 'Content-Type': 'application/json', 'Accept': 'application/json' } }, body ? JSON.stringify(body) : null);
}

// ─── FETCHERS ───────────────────────────────────────────────

async function getBalance() { try { const r = await api('GET', '/portfolio/balance'); if (r.status === 200) { S.balance = r.data.balance; } } catch (e) {} return S.balance; }

async function getMarkets() {
  let all = [], cursor = null;
  for (let i = 0; i < 2; i++) {
    try {
      let ep = '/markets?status=open&limit=200'; if (cursor) ep += '&cursor=' + cursor;
      const r = await api('GET', ep); if (r.status === 200 && r.data.markets) { all = all.concat(r.data.markets); cursor = r.data.cursor; } if (!cursor) break;
    } catch (e) { break; }
  }
  return all;
}

async function getPositions() { try { const r = await api('GET', '/portfolio/positions'); if (r.status === 200) S.positions = r.data.market_positions || []; } catch (e) {} return S.positions; }
async function getOrderbook(t) { try { const r = await api('GET', `/markets/${t}/orderbook`); if (r.status === 200) return r.data; } catch (e) {} return null; }
async function getMarket(t) { try { const r = await api('GET', `/markets/${t}`); if (r.status === 200) return r.data.market || r.data; } catch (e) {} return null; }
async function getSettlements() { try { const r = await api('GET', '/portfolio/settlements?limit=50'); if (r.status === 200) return r.data.settlements || []; } catch (e) {} return []; }

// ─── TELEGRAM (fire-and-forget, never blocks) ──────────────

function tg(text) {
  if (!C.tgToken || !C.tgChat) return Promise.resolve();
  // Completely non-blocking — 3s timeout, errors silently ignored
  return new Promise(resolve => {
    try {
      const body = JSON.stringify({ chat_id: C.tgChat, text, parse_mode: 'HTML' });
      const r = https.request({
        hostname: 'api.telegram.org', port: 443,
        path: `/bot${C.tgToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => { res.on('data', () => {}); res.on('end', resolve); });
      r.setTimeout(3000, () => { r.destroy(); resolve(); });
      r.on('error', () => resolve());
      r.write(body);
      r.end();
    } catch (e) { resolve(); }
  });
}

function portfolioLine() {
  const tw = S.wins + S.paperWins, tl = S.losses + S.paperLosses, tot = tw + tl;
  const wr = tot > 0 ? ((tw / tot) * 100).toFixed(0) : '0';
  return `💰 $${(S.balance / 100).toFixed(2)} | ${tw}W/${tl}L (${wr}%) | P&L: $${(S.totalPnL / 100).toFixed(2)}`;
}

// ─── HEARTBEAT (every 30min) ────────────────────────────────

async function heartbeat() {
  const uptime = S.botStarted ? Math.round((Date.now() - new Date(S.botStarted).getTime()) / 60000) : 0;
  const nextBrain = S.lastBrain ? Math.max(0, BRAIN_SEC - Math.round((Date.now() - new Date(S.lastBrain).getTime()) / 1000)) : 0;
  await tg(
    `💓 <b>Heartbeat</b>\n` +
    `${portfolioLine()}\n` +
    `Scans: ${S.scanCount} | Brain: ${S.brainCount} | Claude$: ${S.totalClaude}\n` +
    `Candidates: ${S.candidates.length} | Tracking: ${Object.keys(S.priceHistory).length} mkts\n` +
    `Next brain: ${nextBrain}s | Uptime: ${uptime}min\n` +
    `${S.claudeDown ? '🔴 Claude OFFLINE (fallback active)' : '🟢 Claude online'}`
  );
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 1: SCANNER (30s, free, pure math)
// ═══════════════════════════════════════════════════════════════

const GOOD = ['econom','fed','financ','politic','crypto','bitcoin','inflat','interest','gdp','unemploy','cpi','climat','weather','tech','ai','tariff','trade','china','trump','congress','senate'];
const MEH = ['sport','nba','nfl','mlb','nhl','soccer','entertain','culture','music','movie','parlay'];

function hoursLeft(m) {
  const ct = m.close_time || m.expected_expiration_time;
  if (!ct) return 999;
  return Math.max(0, (new Date(ct) - new Date()) / 3600000);
}

function score(m) {
  const yp = m.yes_bid || m.yes_ask || m.last_price || 50;
  const vol = m.volume || m.volume_fp || m.dollar_volume || 0;
  const cat = (m.category || m.series_ticker || m.title || '').toLowerCase();
  const hrs = hoursLeft(m);
  let s = 0;

  s += Math.min(Math.log10(Math.max(vol, 1)) * 5, 30);
  if (GOOD.some(c => cat.includes(c))) s += 25;
  else if (MEH.some(c => cat.includes(c))) s -= 5;

  // PARLAY KILLER — detect and eliminate multi-leg bets
  const title = (m.title || '').toLowerCase();
  const commas = (m.title || '').split(',').length - 1;
  if (title.includes('parlay') || title.includes('combo') || title.includes('accumulator')) s -= 100;
  if (commas >= 3) s -= 80; // 3+ items = multi-leg, almost always a parlay
  if (commas >= 1 && commas < 3) s -= 20; // might be multi-leg

  if (hrs >= 0.5 && hrs <= 6) s += 30;
  else if (hrs > 6 && hrs <= 24) s += 25;
  else if (hrs > 24 && hrs <= 72) s += 15;
  else if (hrs > 72 && hrs <= 168) s += 5;
  else if (hrs > 168) s -= 10;
  if (yp >= 30 && yp <= 70) s += 15;
  else if (yp >= 80 || yp <= 20) s += 10;

  // Momentum
  const h = S.priceHistory[m.ticker];
  if (h && h.length >= 3) {
    const move = Math.abs(h[h.length-1].y - h[h.length-3].y);
    if (move >= 5) s += 20;
    if (move >= 10) s += 15;
  }

  return Math.round(s);
}

function momentum(ticker) {
  const h = S.priceHistory[ticker];
  if (!h || h.length < 2) return 'flat';
  const d = h[h.length-1].y - h[Math.max(0, h.length-5)].y;
  if (d >= 5) return '↑' + d + '¢';
  if (d <= -5) return '↓' + Math.abs(d) + '¢';
  return 'flat';
}

async function scan() {
  S.scanCount++;
  try {
    const mkts = await getMarkets();
    if (!mkts.length) return;
    const now = Date.now();

    for (const m of mkts) {
      const yp = m.yes_bid || m.yes_ask || m.last_price || 50;
      if (!S.priceHistory[m.ticker]) S.priceHistory[m.ticker] = [];
      S.priceHistory[m.ticker].push({ t: now, y: yp });
      S.marketMeta[m.ticker] = { title: m.title, cat: m.category || m.series_ticker || '', close: m.close_time || m.expected_expiration_time || '' };
    }

    const scored = mkts.filter(m => m.status === 'open' || m.status === 'active')
      .map(m => ({ ...m, _s: score(m) })).filter(m => m._s > 0).sort((a, b) => b._s - a._s);

    S.candidates = scored.slice(0, 20).map(m => ({
      ticker: m.ticker, score: m._s, title: m.title,
      yes: m.yes_bid || m.yes_ask || m.last_price || 50,
      no: m.no_bid || m.no_ask || (100 - (m.yes_bid || 50)),
      vol: m.volume || m.volume_fp || 0,
      cat: (m.category || m.series_ticker || '').toLowerCase(),
      hrs: hoursLeft(m).toFixed(1),
      mom: momentum(m.ticker),
    }));

    S.lastScan = new Date().toISOString();
    log(`L1 #${S.scanCount}: ${mkts.length} mkts → ${S.candidates.length} candidates | top: ${S.candidates[0]?.title?.slice(0,40) || 'none'} (${S.candidates[0]?.score})`);

    // Alert on big movers
    for (const m of mkts) {
      const h = S.priceHistory[m.ticker];
      if (h && h.length >= 2) {
        const prev = h[h.length - 2].y;
        const curr = h[h.length - 1].y;
        if (Math.abs(curr - prev) >= 8) {
          log(`⚡ MOVE: ${m.title?.slice(0,40)} ${curr > prev ? '+' : ''}${curr - prev}¢`);
        }
      }
    }
  } catch (e) { log('L1 err: ' + e.message); }
}

// Clean old history
function clean() {
  const now = Date.now();
  for (const t in S.priceHistory) {
    if (S.priceHistory[t].length > 0 && now - S.priceHistory[t][S.priceHistory[t].length - 1].t > 86400000)
      delete S.priceHistory[t];
  }
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 2: CLAUDE BRAIN (5min)
// ═══════════════════════════════════════════════════════════════

function buildMemory() {
  let m = `PORTFOLIO: $${Math.max(S.balance/100, C.bankroll).toFixed(2)}`;
  const tw = S.wins+S.paperWins, tl = S.losses+S.paperLosses, tot = tw+tl;
  if (tot > 0) m += ` | ${tot} trades ${((tw/tot)*100).toFixed(0)}% WR | P&L $${(S.totalPnL/100).toFixed(2)}`;

  const recent = S.trades.slice(0, 8);
  if (recent.length) {
    m += '\nRECENT: ' + recent.map(t => `${t.side}${t.ticker.slice(0,15)}@${t.priceCents}¢→${t.resolved ? t.outcome : '?'}`).join(' | ');
  }

  // Performance insights
  const catEntries = Object.entries(S.perfCat).filter(([_,v]) => v.w+v.l >= 2);
  if (catEntries.length) {
    m += '\nCATEGORY RECORD: ' + catEntries.map(([c,{w,l}]) => `${c}:${((w/(w+l))*100).toFixed(0)}%`).join(' ');
  }

  for (const [conf,{w,l}] of Object.entries(S.perfConf)) {
    if (w+l >= 2) m += `\n${conf} conf: ${((w/(w+l))*100).toFixed(0)}% (${w}W/${l}L)`;
  }

  const skip = [...new Set(S.trades.slice(0,30).map(t=>t.ticker))];
  if (skip.length) m += `\nSKIP (already traded): ${skip.slice(0,10).join(',')}`;

  // Brain notes from previous sessions
  if (S.brainNotes && S.brainNotes.length) {
    m += '\nYOUR PREVIOUS OBSERVATIONS:\n' + S.brainNotes.join('\n');
  }

  return m;
}

async function brain() {
  if (!C.claudeKey) { log('L2: no key'); return; }
  if (!S.candidates.length) { log('L2: no candidates'); return; }

  if (S.claudeDown) {
    // Check recovery every 10min
    if (Date.now() - S.lastCreditCheck > 600000) {
      S.lastCreditCheck = Date.now();
      try {
        const r = await http('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': C.claudeKey, 'anthropic-version': '2023-06-01' } }, JSON.stringify({ model: C.claudeModel, max_tokens: 5, messages: [{role:'user',content:'hi'}] }));
        if (!r.data.error) { S.claudeDown = false; log('🟢 Claude back online!'); tg('🟢 <b>Claude back online!</b>').catch(()=>{}); }
      } catch (e) {}
    }
    if (S.claudeDown) { log('L2: Claude offline → fallback'); await fallback(); return; }
  }

  S.brainCount++; S.totalClaude++;

  // Orderbooks for top 5
  const obs = {};
  await Promise.all(S.candidates.slice(0,5).map(async c => { const o = await getOrderbook(c.ticker); if (o) obs[c.ticker] = o; }));

  const mBlock = S.candidates.map((c,i) => {
    let l = `${i+1}. "${c.title}" [${c.ticker}]\n   YES:${c.yes}¢ NO:${c.no}¢ | Vol:${c.vol} | ${c.hrs}h | Cat:${c.cat} | ${c.mom}`;
    const ob = obs[c.ticker];
    if (ob?.orderbook_fp) {
      const yb = ob.orderbook_fp.yes_dollars || ob.orderbook_fp.yes || [];
      const nb = ob.orderbook_fp.no_dollars || ob.orderbook_fp.no || [];
      l += `\n   Book: YesBid:${yb[0]?.[0]||'?'}¢(${yb.length}lvls) NoBid:${nb[0]?.[0]||'?'}¢(${nb.length}lvls)`;
    }
    return l;
  }).join('\n\n');

  const mem = buildMemory();

  // In paper mode, tell Claude to be more aggressive
  const paperBoost = C.dryRun ? '\n\nPAPER MODE: Be MORE aggressive. We need trade volume to test the system. Signal anything with 3%+ edge.' : '';

  const body = JSON.stringify({
    model: C.claudeModel, max_tokens: 4000,
    tools: [{type: 'web_search_20250305', name: 'web_search'}],
    system: `You are an autonomous AI trader on Kalshi managing $${Math.max(S.balance/100,C.bankroll).toFixed(2)}.

MISSION: Double the portfolio. Use web search to find current news, then identify mispriced markets.

WORKFLOW:
1. SEARCH for breaking news, economic data, scores, political events relevant to these markets
2. COMPARE what you learn against market prices
3. SIGNAL trades where your informed probability differs from market price by ${C.dryRun ? '3' : (C.edgeMin*100).toFixed(0)}+ cents

EDGE SOURCES:
- News not yet priced in (#1 source of alpha)
- Favourite-longshot bias: >85¢ underpriced, <15¢ overpriced
- Markets closing <48h where outcome is becoming clear
- Momentum aligned with fundamentals

AVOID: Parlays, no-info guesses, weeks-out markets, sports without edge

After analysis, include a "brainNote" — one learning for future sessions.
${paperBoost}

YOUR MEMORY:
${mem}

OUTPUT (JSON only, no other text):
{"signals":[{"ticker":"X","title":"name","side":"yes"|"no","marketPrice":0.XX,"trueProb":0.XX,"edge":0.XX,"confidence":"high"|"medium"|"low","reasoning":"max 20 words"}],"brainNote":"one sentence learning"}`,
    messages: [{role:'user',content:`TIME: ${new Date().toISOString()}\n\nCANDIDATES (top 20 of ${Object.keys(S.prices||S.priceHistory||{}).length}+):\n${mBlock}\n\nSearch news, then analyze for edge.`}],
  });

  try {
    const r = await http('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': C.claudeKey, 'anthropic-version': '2023-06-01' } }, body);

    if (r.data.error) {
      const msg = r.data.error.message || JSON.stringify(r.data.error);
      log('L2 Claude err: ' + msg);
      if (msg.includes('credit') || msg.includes('billing')) { S.claudeDown = true; tg('🚨 <b>Credits depleted</b> → fallback mode\n' + portfolioLine()).catch(()=>{}); }
      await fallback();
      return;
    }

    // Extract text blocks only (skip tool_use blocks)
    const textBlocks = (r.data.content || []).filter(c => c.type === 'text').map(c => c.text || '');
    const raw = textBlocks.join('');
    let result = null;
    let sigs = [];

    // Try parsing as {signals:[], brainNote:""}
    try { result = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch (e1) {
      const objMatch = raw.match(/\{[\s\S]*"signals"[\s\S]*\}/);
      if (objMatch) try { result = JSON.parse(objMatch[0]); } catch (e2) {}
      if (!result) {
        const arrMatch = raw.match(/\[[\s\S]*?\]/);
        if (arrMatch) try { sigs = JSON.parse(arrMatch[0]); result = { signals: sigs }; } catch (e3) {}
      }
    }

    if (result && Array.isArray(result.signals)) sigs = result.signals;
    if (!Array.isArray(sigs)) sigs = [];

    // Save brain note
    if (result && result.brainNote && result.brainNote.length > 5) {
      if (!S.brainNotes) S.brainNotes = [];
      S.brainNotes.push(`[${new Date().toISOString().slice(5,16)}] ${result.brainNote}`);
      if (S.brainNotes.length > 20) S.brainNotes = S.brainNotes.slice(-20);
      log('🧠 Note: ' + result.brainNote.slice(0, 80));
    }

    S.signals = sigs;
    S.lastBrain = new Date().toISOString();

    if (sigs.length > 0) {
      log(`L2 🧠 ${sigs.length} signal(s): ${sigs.map(s => s.ticker?.slice(0,20) + '(' + s.side + ' ' + ((s.edge||0)*100).toFixed(0) + '%)').join(', ')}`);
      await execute(sigs);
    } else {
      log('L2 🧠 0 signals → fallback');
      await fallback();
    }
  } catch (e) { log('L2 err: ' + e.message); await fallback(); }
  save();
}

// ═══════════════════════════════════════════════════════════════
//  LAYER 3: EXECUTION
// ═══════════════════════════════════════════════════════════════

function kellySize(edge, price, side, conf) {
  const cost = side === 'yes' ? price : (1 - price);
  if (cost <= 0.01 || cost >= 0.99 || edge <= 0) return 0;
  const odds = (1 - cost) / cost;
  const wp = Math.min(cost + edge, 0.95);
  const k = (wp * odds - (1 - wp)) / odds;
  if (k <= 0) return 0;
  const cm = conf === 'high' ? 1.0 : conf === 'medium' ? 0.5 : 0.25;
  const bank = Math.max(S.balance / 100, C.bankroll);
  const dollars = Math.min(C.maxPos, Math.max(0.50, k * C.kelly * cm * bank));
  return Math.max(1, Math.min(Math.floor(dollars / cost), 100));
}

async function execute(sigs) {
  const held = new Set(S.positions.map(p => p.ticker || p.market_ticker));
  const recent = new Set(S.trades.slice(0, 40).map(t => t.ticker));
  const slots = C.maxOpen - S.positions.length;
  if (slots <= 0) { log('L3: max positions'); return; }

  const fresh = sigs
    .filter(s => !held.has(s.ticker) && !recent.has(s.ticker))
    .filter(s => s.confidence !== 'low' || (s.edge && s.edge >= 0.15))
    .sort((a, b) => ((b.edge||0) * (b.confidence==='high'?2:1)) - ((a.edge||0) * (a.confidence==='high'?2:1)));

  for (const sig of fresh.slice(0, Math.min(slots, 3))) {
    await trade(sig);
    await new Promise(r => setTimeout(r, 1500));
  }
}

async function trade(sig) {
  const { ticker, side, marketPrice, edge, confidence, reasoning } = sig;
  const contracts = kellySize(edge || 0.05, marketPrice || 0.5, side, confidence);
  if (contracts <= 0) return;

  const pc = side === 'yes' ? Math.round((marketPrice||0.5) * 100) : Math.round((1 - (marketPrice||0.5)) * 100);
  const cost = ((contracts * pc) / 100).toFixed(2);
  const pay = ((contracts * (100 - pc)) / 100).toFixed(2);

  const rec = {
    id: uuid(), ticker, title: sig.title || ticker, side, contracts, priceCents: pc,
    costDollars: cost, maxPayout: pay, edge: ((edge||0) * 100).toFixed(1) + '%',
    confidence: confidence || 'medium', reasoning: reasoning || '', category: sig.category || S.marketMeta[ticker]?.cat || '',
    marketPriceAtEntry: marketPrice, timestamp: new Date().toISOString(),
    status: 'pending', dryRun: C.dryRun, resolved: false, outcome: null, pnl: null,
  };

  if (C.dryRun) {
    rec.status = 'simulated';
    S.trades.unshift(rec);
    log(`📋 ${side.toUpperCase()} ${contracts}x ${ticker} @${pc}¢ $${cost}→$${pay} edge:${rec.edge} [${confidence}]`);
    tg(`🧪 <b>PAPER</b> ${side.toUpperCase()} ${contracts}x\n<code>${ticker}</code>\n@${pc}¢ | $${cost}→$${pay} | ${rec.edge}\n${confidence} | ${reasoning}\n${portfolioLine()}`).catch(()=>{});
    save();
    return rec;
  }

  const order = { ticker, action: 'buy', side, count: contracts, type: 'limit', client_order_id: uuid() };
  if (side === 'yes') order.yes_price = pc; else order.no_price = pc;

  try {
    const r = await api('POST', '/portfolio/orders', order);
    if (r.status === 201 || r.status === 200) {
      rec.status = 'placed'; rec.orderId = r.data.order?.order_id;
      log(`✅ LIVE ${side.toUpperCase()} ${contracts}x ${ticker} @${pc}¢`);
      tg(`✅ <b>LIVE</b> ${side.toUpperCase()} ${contracts}x\n<code>${ticker}</code>\n@${pc}¢ | $${cost}→$${pay}\n${rec.edge} | ${reasoning}\n${portfolioLine()}`).catch(()=>{});
    } else { rec.status = 'error'; rec.error = JSON.stringify(r.data).slice(0,200); log('❌ ' + rec.error); }
  } catch (e) { rec.status = 'error'; rec.error = e.message; }

  S.trades.unshift(rec);
  save();
  return rec;
}

// ─── FALLBACK TRADER ────────────────────────────────────────

async function fallback() {
  if (!S.candidates.length) return;
  const held = new Set(S.positions.map(p => p.ticker || p.market_ticker));
  const recent = new Set(S.trades.slice(0, 40).map(t => t.ticker));
  const slots = C.maxOpen - S.positions.length;
  if (slots <= 0) return;

  // ONLY trade extreme prices where structural bias is proven
  // NO more 50/50 coin flips
  const plays = S.candidates
    .filter(c => !held.has(c.ticker) && !recent.has(c.ticker))
    .filter(c => {
      if (c.yes <= 10 && c.score >= 40) return true;   // extreme longshot → sell
      if (c.yes >= 90 && c.score >= 40) return true;   // extreme favourite → buy
      return false; // nothing else qualifies for fallback
    })
    .slice(0, 1); // max 1 fallback trade

  for (const c of plays) {
    const side = c.yes <= 10 ? 'no' : 'yes';
    const edge = c.yes <= 10 ? 0.07 : 0.05;
    await trade({ ticker: c.ticker, title: c.title, side, marketPrice: c.yes/100, edge, confidence: 'medium', reasoning: 'Structural: ' + (c.yes<=10?'longshot overpriced':'favourite underpriced') });
  }
}

// ─── POSITION EXITS ─────────────────────────────────────────

async function checkExits() {
  if (C.dryRun || !S.positions.length) return;
  for (const pos of S.positions) {
    const ticker = pos.ticker || pos.market_ticker;
    const entry = S.trades.find(t => t.ticker === ticker && (t.status === 'placed' || t.status === 'filled'));
    if (!entry) continue;
    const h = S.priceHistory[ticker];
    if (!h || !h.length) continue;
    const nowY = h[h.length-1].y / 100;
    const entY = entry.marketPriceAtEntry || 0.5;
    const prNow = entry.side === 'yes' ? nowY : (1-nowY);
    const prEnt = entry.side === 'yes' ? entY : (1-entY);
    const move = prNow - prEnt;
    if (move >= 0.15 || move <= -0.12) {
      const action = move > 0 ? 'PROFIT' : 'CUT';
      log(`${move>0?'📈':'📉'} ${action}: ${ticker} ${(move*100).toFixed(0)}¢`);
      tg(`${move>0?'📈':'📉'} <b>${action}</b> <code>${ticker}</code> ${(move*100).toFixed(0)}¢\n${portfolioLine()}`).catch(()=>{});
      const sell = { ticker, action:'sell', side:entry.side, count:Math.abs(pos.position||1), type:'limit', client_order_id:uuid() };
      if (entry.side==='yes') sell.yes_price=Math.round(nowY*100); else sell.no_price=Math.round((1-nowY)*100);
      try { await api('POST','/portfolio/orders',sell); } catch(e){}
    }
  }
}

// ─── GRADING + SETTLEMENTS ──────────────────────────────────

async function grade() {
  for (const t of S.trades.filter(t => t.dryRun && !t.resolved && t.status === 'simulated').slice(0, 3)) {
    const mkt = await getMarket(t.ticker);
    if (!mkt) continue;
    const st = mkt.status || mkt.result;
    if (st !== 'settled' && st !== 'finalized' && st !== 'closed') continue;
    const res = mkt.result ?? mkt.settlement_value;
    if (res === undefined || res === null) continue;

    const won = (t.side==='yes' && (res==='yes'||res===1)) || (t.side==='no' && (res==='no'||res===0));
    t.resolved = true; t.outcome = won ? 'win' : 'loss';
    const costC = t.contracts * t.priceCents;
    const payC = won ? t.contracts * 100 : 0;
    t.pnl = ((payC - costC) / 100).toFixed(2);

    if (won) { S.paperWins++; S.totalPnL += (payC-costC); } else { S.paperLosses++; S.totalPnL -= costC; }
    S.dailyPnL += won ? (payC-costC) : -costC;

    const cat = (t.category || S.marketMeta[t.ticker]?.cat || 'other').toLowerCase();
    if (!S.perfCat[cat]) S.perfCat[cat] = {w:0,l:0};
    if (won) S.perfCat[cat].w++; else S.perfCat[cat].l++;
    if (S.perfConf[t.confidence]) { if (won) S.perfConf[t.confidence].w++; else S.perfConf[t.confidence].l++; }
    if (S.perfSide[t.side]) { if (won) S.perfSide[t.side].w++; else S.perfSide[t.side].l++; }

    log(`📊 ${t.ticker} → ${won?'WIN':'LOSS'} $${t.pnl}`);
    tg(`${won?'🏆':'💸'} <b>PAPER ${won?'WIN':'LOSS'}</b>\n<code>${t.ticker}</code> ${t.side}@${t.priceCents}¢\n$${t.pnl}\n${portfolioLine()}`).catch(()=>{});
  }
}

async function settlements() {
  if (C.dryRun) return;
  try {
    const setts = await getSettlements();
    const known = new Set(S.resolved.map(r => r.id));
    for (const s of setts) {
      const id = s.market_id || s.ticker || s.id;
      if (known.has(id)) continue;
      S.resolved.push({...s, id});
      const rev = (s.revenue||0)/100; const win = rev > 0;
      if (win) S.wins++; else S.losses++;
      S.totalPnL += (s.revenue||0); S.dailyPnL += (s.revenue||0);
      tg(`${win?'🏆':'💸'} <b>${win?'WIN':'LOSS'}</b> <code>${s.ticker||id}</code> $${rev.toFixed(2)}\n${portfolioLine()}`).catch(()=>{});
    }
  } catch(e){}
}

// ═══════════════════════════════════════════════════════════════
//  ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

let scanT, brainT, heartT;

async function runScan() {
  log('L1 scan starting...');
  try {
    const today = new Date().toISOString().slice(0,10);
    if (S.dailyDate !== today) {
      S.dailyPnL = 0; S.dailyDate = today;
      tg(`📅 <b>New Day</b>\n${portfolioLine()}`).catch(()=>{});
    }
    if (S.dailyPnL <= -(C.maxLoss*100)) { log('🛑 Loss limit (-$' + (Math.abs(S.dailyPnL)/100).toFixed(2) + ' >= $' + C.maxLoss + ')'); return; }
    log('L1 fetching data...');
    await Promise.all([getBalance(), getPositions()]);
    log('L1 scanning markets...');
    await scan();
    await checkExits();
    await grade();
    await settlements();
    if (S.scanCount % 100 === 0) clean();
    S.lastError = null;
    save();
  } catch (e) { S.lastError = e.message; log('Scan err: ' + e.message); }
}

async function runBrain() {
  try { await brain(); save(); } catch (e) { log('Brain err: ' + e.message); }
}

function start() {
  if (S.isRunning) return;
  S.isRunning = true; S.botStarted = new Date().toISOString();
  log('🚀 v5 | ' + (C.dryRun ? 'PAPER' : 'LIVE'));
  tg(`🚀 <b>Kalshi Edge v5</b>\n${C.dryRun?'📋 Paper':'⚡ LIVE'}\nScan:${SCAN_SEC}s | Brain:${BRAIN_SEC}s\nEdge:${C.edgeMin*100}% | Kelly:${C.kelly} | Max:$${C.maxPos}\n${portfolioLine()}`);

  // Self-healing scan loop — if scan takes too long, skip and retry
  log('🚀 Starting loops...');

  function scanLoop() {
    if (!S.isRunning) return;
    const timeout = setTimeout(() => {
      log('⚠️ Scan timeout — skipping');
      scheduleNextScan();
    }, 20000); // 20s max per scan

    runScan()
      .catch(e => log('s: ' + e.message))
      .finally(() => { clearTimeout(timeout); scheduleNextScan(); });
  }

  function scheduleNextScan() {
    if (!S.isRunning) return;
    scanT = setTimeout(scanLoop, SCAN_SEC * 1000);
  }

  // First scan immediately
  scanLoop();

  // Brain loop — same pattern
  function brainLoop() {
    if (!S.isRunning) return;
    runBrain()
      .catch(e => log('b: ' + e.message))
      .finally(() => { if (S.isRunning) brainT = setTimeout(brainLoop, BRAIN_SEC * 1000); });
  }
  setTimeout(brainLoop, 30000); // first brain after 30s

  // Heartbeat
  heartT = setInterval(() => heartbeat().catch(() => {}), HEARTBEAT_SEC * 1000);
  setTimeout(() => heartbeat().catch(() => {}), 120000); // first HB after 2min

  save();
}

function stop() {
  S.isRunning = false;
  [scanT, brainT, heartT].forEach(t => { if (t) { clearInterval(t); clearTimeout(t); } });
  scanT = brainT = heartT = null;
  log('⏹ Stopped');
  tg('⏹ <b>Stopped</b>\n' + portfolioLine());
  save();
}

process.on('unhandledRejection', e => log('⚠️ ' + (e?.message || e)));
process.on('uncaughtException', e => log('⚠️ ' + (e?.message || e)));

// ─── API ────────────────────────────────────────────────────

app.get('/api/status', (_, r) => {
  const tw=S.wins+S.paperWins, tl=S.losses+S.paperLosses, tot=tw+tl;
  r.json({
    v: 6, isRunning: S.isRunning, dryRun: C.dryRun, balance: S.balance, bankroll: C.bankroll,
    totalPnL: S.totalPnL, dailyPnL: S.dailyPnL, wins: tw, losses: tl,
    winRate: tot > 0 ? ((tw/tot)*100).toFixed(1) : '0.0',
    openPositions: S.positions.length, maxOpen: C.maxOpen,
    scanCount: S.scanCount, brainCount: S.brainCount, totalClaude: S.totalClaude,
    candidates: S.candidates.length, tracked: Object.keys(S.priceHistory).length,
    lastScan: S.lastScan, lastBrain: S.lastBrain, lastError: S.lastError,
    botStarted: S.botStarted, claudeDown: S.claudeDown,
    brainNotes: (S.brainNotes || []).length,
    webSearch: true,
    unresolved: S.trades.filter(t=>t.dryRun&&!t.resolved).length,
  });
});

app.get('/api/trades', (_,r) => r.json(S.trades.slice(0,50)));
app.get('/api/positions', (_,r) => r.json(S.positions));
app.get('/api/signals', (_,r) => r.json(S.signals));
app.get('/api/candidates', (_,r) => r.json(S.candidates));
app.get('/api/logs', (_,r) => r.json(logs.slice(0,200)));
app.get('/api/brain', (_,r) => r.json({ notes: S.brainNotes || [], perfCat: S.perfCat, perfConf: S.perfConf, perfSide: S.perfSide, pnl: (S.totalPnL/100).toFixed(2) }));
app.get('/api/signals', (_,r) => r.json(S.signals));
app.get('/api/candidates', (_,r) => r.json(S.candidates));
app.get('/api/logs', (_,r) => r.json(logs.slice(0,200)));
app.get('/api/perf', (_,r) => r.json({ cat: S.perfCat, conf: S.perfConf, side: S.perfSide, pnl: (S.totalPnL/100).toFixed(2) }));
app.post('/api/bot/start', (_,r) => { start(); r.json({ok:true}); });
app.post('/api/bot/stop', (_,r) => { stop(); r.json({ok:true}); });
app.post('/api/bot/cycle', async (_,r) => { try { await runScan(); await runBrain(); r.json({ok:true}); } catch(e) { r.json({ok:false,error:e.message}); }});

app.get('/api/test-connection', async (_,r) => {
  try {
    const [b,m] = await Promise.all([api('GET','/portfolio/balance'), api('GET','/markets?status=open&limit=5')]);
    const mkts = m.data.markets||[];
    r.json({ auth:b.status===200?'ok':'failed', authStatus:b.status, authError:b.status!==200?JSON.stringify(b.data).slice(0,200):null, balance:b.status===200?b.data:null, markets:m.status===200?mkts.length+' markets':'failed', sample:mkts[0]?{ticker:mkts[0].ticker,title:mkts[0].title,yes:mkts[0].yes_bid,vol:mkts[0].volume}:null });
  } catch(e) { r.json({auth:'error',error:e.message}); }
});

// ─── DASHBOARD ──────────────────────────────────────────────

app.get('/', (_,r) => { r.setHeader('Content-Type','text/html'); r.send(HTML()); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`v5 on :${PORT} | ${C.dryRun?'PAPER':'LIVE'} | $${C.bankroll} | edge:${C.edgeMin*100}%`);
  log(`Scan:${SCAN_SEC}s Brain:${BRAIN_SEC}s HB:${HEARTBEAT_SEC}s | TG:${C.tgToken?'✓':'✗'} Claude:${C.claudeKey?'✓':'✗'} Kalshi:${C.apiKeyId?'✓':'✗'}`);
  if (C.apiKeyId && C.privateKey) { log('Starting in 3s...'); setTimeout(start, 3000); }
  else log('⚠️ Set API keys');
});

function HTML(){return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="theme-color" content="#050505"><title>Kalshi Edge</title><link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap" rel="stylesheet"><style>:root{--bg:#050505;--s1:#111113;--s2:#1a1a1e;--s3:#28282d;--bd:rgba(255,255,255,.06);--t:#f5f5f7;--t2:#a1a1a6;--t3:#636366;--g:#30d158;--gd:rgba(48,209,88,.12);--r:#ff453a;--rd:rgba(255,69,58,.12);--b:#0a84ff;--bl:rgba(10,132,255,.12);--o:#ff9f0a;--od:rgba(255,159,10,.12);--p:#bf5af2;--R:16px;--st:env(safe-area-inset-top,20px);--sb:env(safe-area-inset-bottom,0px)}*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',-apple-system,sans-serif;background:var(--bg);color:var(--t);-webkit-font-smoothing:antialiased;min-height:100dvh;padding-top:var(--st);padding-bottom:calc(72px + var(--sb));overflow-x:hidden}.H{padding:12px 20px 8px;display:flex;align-items:center;justify-content:space-between}.Hb{display:flex;align-items:center;gap:10px}.Hl{width:34px;height:34px;background:linear-gradient(135deg,#30d158,#0a84ff);border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#000}.Ht{font-size:21px;font-weight:700;letter-spacing:-.4px}.tg{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;padding:4px 10px;border-radius:20px}.td{background:var(--od);color:var(--o)}.tl{background:var(--gd);color:var(--g)}.to{background:var(--rd);color:var(--r)}.alive{font-size:10px;color:var(--t3);text-align:center;padding:4px}.hero{margin:8px 16px 0;padding:22px 20px;background:var(--s1);border-radius:20px;border:1px solid var(--bd)}.bl{font-size:11px;color:var(--t3);font-weight:600;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px}.bv{font-size:44px;font-weight:700;letter-spacing:-2.5px;line-height:1;margin-bottom:10px;font-variant-numeric:tabular-nums}.pr{display:flex;gap:14px;flex-wrap:wrap}.pi{display:flex;align-items:center;gap:5px;font-size:13px;font-weight:500}.pb{font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;font-variant-numeric:tabular-nums}.pu{background:var(--gd);color:var(--g)}.pd{background:var(--rd);color:var(--r)}.pn{background:var(--s3);color:var(--t3)}.G{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 16px 0}.Gc{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:12px 6px;text-align:center}.Gv{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}.Gl{font-size:8px;color:var(--t3);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}.ct{display:flex;gap:6px;margin:10px 16px 0}.bn{flex:1;padding:13px;border:none;border-radius:var(--R);font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px}.bn:active{transform:scale(.96)}.bg{background:var(--g);color:#000}.bs{background:var(--r);color:#fff}.bc{background:var(--s2);color:var(--t);border:1px solid rgba(255,255,255,.1);flex:.5}.bt{background:var(--bl);color:var(--b);border:1px solid rgba(10,132,255,.15);flex:.5}.S{margin:18px 16px 0}.Sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.St{font-size:15px;font-weight:700}.Sn{font-size:11px;color:var(--t3);background:var(--s2);padding:2px 8px;border-radius:10px}.CL{display:flex;flex-direction:column;gap:5px}.TC{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:12px 14px}.Tt{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:5px}.Tk{font-size:13px;font-weight:600;line-height:1.3;flex:1}.Ts{font-size:10px;font-weight:700;text-transform:uppercase;padding:3px 7px;border-radius:5px;flex-shrink:0}.sy{background:var(--gd);color:var(--g)}.sn{background:var(--rd);color:var(--r)}.Tm{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--t3)}.Tr{font-size:11px;color:var(--t2);margin-top:5px;line-height:1.4;font-style:italic}.Tx{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;text-transform:uppercase}.xs{background:var(--od);color:var(--o)}.xp{background:var(--gd);color:var(--g)}.xe{background:var(--rd);color:var(--r)}.xw{background:var(--gd);color:var(--g)}.xl{background:var(--rd);color:var(--r)}.LP{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:10px;max-height:350px;overflow-y:auto;font-family:'SF Mono',Menlo,monospace;font-size:10px;line-height:1.7;color:var(--t3);-webkit-overflow-scrolling:touch}.EM{text-align:center;padding:20px;color:var(--t3);font-size:12px}.M{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(8px);z-index:100;display:none;align-items:flex-end;justify-content:center}.M.open{display:flex}.Ms{background:var(--s1);border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:20px;padding-bottom:calc(20px + var(--sb));animation:su .3s ease}@keyframes su{from{transform:translateY(100%)}to{transform:translateY(0)}}.Mh{width:36px;height:5px;background:var(--s3);border-radius:3px;margin:0 auto 14px}.Mt{font-size:17px;font-weight:700;margin-bottom:10px}.TR{padding:10px;background:var(--s2);border-radius:10px;margin-bottom:6px;font-size:12px}.TR .l{color:var(--t3);font-size:10px;text-transform:uppercase}.TR .v{font-weight:600;margin-top:1px}.Tok{border-left:3px solid var(--g)}.Tfl{border-left:3px solid var(--r)}.TB{position:fixed;bottom:0;left:0;right:0;background:rgba(17,17,19,.88);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-top:1px solid var(--bd);display:flex;justify-content:space-around;padding:6px 0 calc(6px + var(--sb));z-index:50}.tab{display:flex;flex-direction:column;align-items:center;gap:1px;font-size:9px;font-weight:600;color:var(--t3);cursor:pointer;padding:4px 10px;border:none;background:none}.tab.a{color:var(--g)}.tab svg{width:21px;height:21px}.V{display:none}.V.a{display:block}.sp{width:16px;height:16px;border:2px solid var(--s3);border-top-color:var(--t);border-radius:50%;animation:sp .5s linear infinite;display:inline-block}@keyframes sp{to{transform:rotate(360deg)}}::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--s3);border-radius:2px}</style></head><body><div class="H"><div class="Hb"><div class="Hl">KE</div><div class="Ht">Kalshi Edge</div></div><div id="mT" class="tg to">OFFLINE</div></div><div id="alive" class="alive"></div><div id="vD" class="V a"><div class="hero"><div class="bl">Portfolio Balance</div><div class="bv" id="bal">$0.00</div><div class="pr"><div class="pi"><span style="color:var(--t3)">Total</span><span id="tP" class="pb pn">$0.00</span></div><div class="pi"><span style="color:var(--t3)">Today</span><span id="dP" class="pb pn">$0.00</span></div></div></div><div class="G"><div class="Gc"><div class="Gv" id="wr" style="color:var(--g)">0%</div><div class="Gl">Win Rate</div></div><div class="Gc"><div class="Gv" id="nt">0</div><div class="Gl">Trades</div></div><div class="Gc"><div class="Gv" id="op" style="color:var(--b)">0</div><div class="Gl">Open</div></div><div class="Gc"><div class="Gv" id="sc" style="color:var(--p)">0/0</div><div class="Gl">Scan/Brain</div></div></div><div class="ct"><button class="bn bg" id="bG" onclick="sB()">&#9654; Start</button><button class="bn bs" id="bS" onclick="xB()" style="display:none">&#9632; Stop</button><button class="bn bc" id="bC" onclick="cy()">&#8635; Cycle</button><button class="bn bt" onclick="tt()">&#10003; Test</button></div><div class="S"><div class="Sh"><div class="St">Trades</div><div class="Sn" id="tC">0</div></div><div class="CL" id="tL"><div class="EM">Waiting for signals...</div></div></div></div><div id="vC" class="V"><div class="S" style="margin-top:6px"><div class="Sh"><div class="St">Scanner</div><div class="Sn" id="cC">0</div></div><div class="CL" id="cL"><div class="EM">Scanning...</div></div></div></div><div id="vI" class="V"><div class="S" style="margin-top:6px"><div class="Sh"><div class="St">Signals</div><div class="Sn" id="sCC">0</div></div><div class="CL" id="sL"><div class="EM">Brain loading...</div></div></div></div><div id="vL" class="V"><div class="S" style="margin-top:6px"><div class="Sh"><div class="St">Logs</div><div class="Sn" id="lC">#0</div></div><div class="LP" id="lP"><div class="EM">...</div></div></div></div><div class="M" id="md" onclick="if(event.target===this)this.classList.remove('open')"><div class="Ms"><div class="Mh"></div><div class="Mt">Connection Test</div><div id="tR"></div><button class="bn" style="background:var(--s2);color:var(--t);margin-top:10px;width:100%" onclick="document.getElementById('md').classList.remove('open')">Done</button></div></div><div class="TB"><button class="tab a" onclick="sw('D',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Home</button><button class="tab" onclick="sw('C',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Scanner</button><button class="tab" onclick="sw('I',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>Signals</button><button class="tab" onclick="sw('L',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Logs</button></div><script>var E=s=>s?(s+'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'';function sw(n,t){document.querySelectorAll('.V').forEach(v=>v.classList.remove('a'));document.querySelectorAll('.tab').forEach(t=>t.classList.remove('a'));document.getElementById('v'+n).classList.add('a');t.classList.add('a')}async function sB(){await fetch('/api/bot/start',{method:'POST'});gA()}async function xB(){await fetch('/api/bot/stop',{method:'POST'});gA()}async function cy(){var b=document.getElementById('bC');b.innerHTML='<div class="sp"></div>';b.disabled=true;try{await fetch('/api/bot/cycle',{method:'POST'});await gA()}finally{b.innerHTML='&#8635; Cycle';b.disabled=false}}async function tt(){var m=document.getElementById('md'),r=document.getElementById('tR');m.classList.add('open');r.innerHTML='<div style="text-align:center;padding:20px"><div class="sp"></div></div>';try{var d=await(await fetch('/api/test-connection')).json();r.innerHTML='<div class="TR '+(d.auth==='ok'?'Tok':'Tfl')+'"><div class="l">Auth</div><div class="v">'+(d.auth==='ok'?'&#10004; Connected':'&#10006; '+E(d.authError||d.authStatus))+'</div></div>'+(d.auth==='ok'?'<div class="TR Tok"><div class="l">Balance</div><div class="v">$'+((d.balance?.balance||0)/100).toFixed(2)+'</div></div>':'')+'<div class="TR '+(d.markets&&!String(d.markets).includes('fail')?'Tok':'Tfl')+'"><div class="l">Markets</div><div class="v">'+E(d.markets)+'</div></div>'+(d.sample?'<div class="TR Tok"><div class="l">Sample</div><div class="v">'+E(d.sample.title)+'</div></div>':'')}catch(x){r.innerHTML='<div class="TR Tfl">'+E(x.message)+'</div>'}}function uD(d){document.getElementById('bal').textContent='$'+(d.balance/100).toFixed(2);var te=document.getElementById('tP'),de=document.getElementById('dP'),tv=d.totalPnL/100,dv=d.dailyPnL/100;te.textContent=(tv>=0?'+':'')+tv.toFixed(2);te.className='pb '+(tv>0?'pu':tv<0?'pd':'pn');de.textContent=(dv>=0?'+':'')+dv.toFixed(2);de.className='pb '+(dv>0?'pu':dv<0?'pd':'pn');document.getElementById('wr').textContent=d.winRate+'%';document.getElementById('nt').textContent=d.wins+d.losses;document.getElementById('op').textContent=d.openPositions;document.getElementById('sc').textContent=d.scanCount+'/'+d.brainCount;var g=document.getElementById('mT');if(!d.isRunning){g.textContent='OFFLINE';g.className='tg to'}else if(d.dryRun){g.textContent='PAPER';g.className='tg td'}else{g.textContent='LIVE';g.className='tg tl'}document.getElementById('bG').style.display=d.isRunning?'none':'flex';document.getElementById('bS').style.display=d.isRunning?'flex':'none';document.getElementById('lC').textContent='#'+d.scanCount;var ago=d.lastScan?Math.round((Date.now()-new Date(d.lastScan).getTime())/1000):999;document.getElementById('alive').textContent=d.isRunning?'Last scan '+ago+'s ago | '+d.tracked+' markets tracked'+(d.claudeDown?' | Claude OFFLINE':''):'Bot stopped'}function rT(t){var el=document.getElementById('tL');document.getElementById('tC').textContent=t.length;if(!t.length){el.innerHTML='<div class="EM">Waiting for signals...</div>';return}el.innerHTML=t.slice(0,25).map(function(x){var res=x.resolved?(x.outcome==='win'?'<span class="Tx xw">WIN $'+x.pnl+'</span>':'<span class="Tx xl">LOSS $'+x.pnl+'</span>'):'';return'<div class="TC"><div class="Tt"><div class="Tk">'+E(x.title||x.ticker)+'</div><span class="Ts '+(x.side==='yes'?'sy':'sn')+'">'+x.side+'</span></div><div class="Tm"><span>'+x.contracts+'x@'+x.priceCents+'c</span><span>$'+x.costDollars+'&rarr;$'+x.maxPayout+'</span><span style="color:var(--g)">'+x.edge+'</span><span class="Tx '+(x.status==='simulated'?'xs':x.status==='placed'?'xp':'xe')+'">'+x.status+'</span>'+res+'</div>'+(x.reasoning?'<div class="Tr">'+E(x.reasoning)+'</div>':'')+'</div>'}).join('')}function rC(c){var el=document.getElementById('cL');document.getElementById('cC').textContent=c.length;if(!c.length){el.innerHTML='<div class="EM">Scanning...</div>';return}el.innerHTML=c.map(function(x){return'<div class="TC"><div class="Tt"><div class="Tk">'+E(x.title)+'</div><span style="font-size:10px;color:var(--t3)">'+x.score+'pts</span></div><div class="Tm"><span>YES:'+x.yes+'c</span><span>Vol:'+x.vol+'</span><span>'+x.hrs+'h</span><span style="color:var(--o)">'+x.mom+'</span><span>'+E(x.cat)+'</span></div></div>'}).join('')}function rS(s){var el=document.getElementById('sL');document.getElementById('sCC').textContent=s.length;if(!s.length){el.innerHTML='<div class="EM">Brain loading...</div>';return}el.innerHTML=s.map(function(x){return'<div class="TC"><div class="Tt"><div class="Tk">'+E(x.title||x.ticker)+'</div><span class="Ts '+(x.side==='yes'?'sy':'sn')+'">'+x.side+'</span></div><div class="Tm"><span>Mkt:'+(x.marketPrice*100).toFixed(0)+'c</span><span>True:'+(x.trueProb*100).toFixed(0)+'c</span><span style="color:var(--g)">+'+(x.edge*100).toFixed(1)+'%</span><span style="color:var(--o)">'+x.confidence+'</span></div>'+(x.reasoning?'<div class="Tr">'+E(x.reasoning)+'</div>':'')+'</div>'}).join('')}function rL(l){var el=document.getElementById('lP');if(!l.length)return;el.innerHTML=l.map(function(x){return'<div style="white-space:pre-wrap;word-break:break-all">'+E(x)+'</div>'}).join('')}async function gA(){try{var[s,t,c,si,l]=await Promise.all([fetch('/api/status').then(r=>r.json()),fetch('/api/trades').then(r=>r.json()),fetch('/api/candidates').then(r=>r.json()),fetch('/api/signals').then(r=>r.json()),fetch('/api/logs').then(r=>r.json())]);uD(s);rT(t);rC(c);rS(si);rL(l)}catch(x){}}gA();setInterval(gA,5000);</script></body></html>`;}
