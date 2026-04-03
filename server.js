// ═══════════════════════════════════════════════════════════════
//  KALSHI EDGE v8  —  Production. Launch ready.
// ═══════════════════════════════════════════════════════════════
'use strict';
const express=require('express'),crypto=require('crypto'),https=require('https'),fs=require('fs'),path=require('path');
const app=express();app.use(express.json());

const C={
  keyId:process.env.KALSHI_API_KEY_ID||'',
  pem:(process.env.KALSHI_PRIVATE_KEY||'').replace(/\\n/g,'\n'),
  base:process.env.KALSHI_BASE_URL||'https://api.elections.kalshi.com',
  v2:'/trade-api/v2',
  claude:process.env.CLAUDE_API_KEY||'',
  model:'claude-sonnet-4-20250514',
  tgTok:process.env.TELEGRAM_TOKEN||'',
  tgChat:process.env.TELEGRAM_CHAT_ID||'',
  paper:process.env.DRY_RUN!=='false',
  startBal:parseFloat(process.env.BANKROLL||'50'),
  kelly:parseFloat(process.env.KELLY||'0.35'),
  edgeLive:parseFloat(process.env.EDGE_LIVE||'0.07'),
  edgePaper:parseFloat(process.env.EDGE_PAPER||'0.03'),
  maxBet:parseFloat(process.env.MAX_BET||'5'),
  maxPos:parseInt(process.env.MAX_POS||'5'),
  dailyStop:parseFloat(process.env.DAILY_STOP||'8'),
  ddLimit:parseFloat(process.env.DD_LIMIT||'0.20'),
  minVol:parseInt(process.env.MIN_VOL||'2000'),
  scanSec:parseInt(process.env.SCAN_SEC||'30'),
  brainSec:parseInt(process.env.BRAIN_SEC||'90'),
};

const SF=(()=>{const v=process.env.RAILWAY_VOLUME_MOUNT_PATH;return v?path.join(v,'ke8.json'):path.join(__dirname,'ke8.json');})();
function fresh(){const b=Math.round(C.startBal*100);return{on:false,bal:b,paperBal:b,peak:b,dayPnl:0,totPnl:0,wins:0,losses:0,positions:[],trades:[],signals:[],signalTs:0,notes:[],pnlHist:[],cands:[],calls:0,authFails:0,day:'',startedAt:null,scanAt:null,brainAt:null,lastErr:null,haltMsg:null,_ph:{}};}
let S=fresh();
try{Object.assign(S,JSON.parse(fs.readFileSync(SF,'utf8')));}catch(_){}
if(!S.paperBal)S.paperBal=S.bal;if(!S.signalTs)S.signalTs=0;S.haltMsg=null;S.authFails=0;S.on=false;
const save=()=>{try{fs.writeFileSync(SF,JSON.stringify(S));}catch(_){}};

const LOGS=[];
const log=msg=>{const l=`[${new Date().toISOString()}] ${msg}`;console.log(l);LOGS.unshift(l);if(LOGS.length>500)LOGS.length=500;};

const usd=()=>(C.paper?S.paperBal:S.bal)/100;
const realUsd=()=>S.bal/100;
const fmt=n=>(n>=0?'+':'')+'\$'+Math.abs(n).toFixed(2);

function tg(text){
  if(!C.tgTok||!C.tgChat){log('[TG skip] '+text.slice(0,60));return Promise.resolve();}
  log('[TG] '+text.slice(0,80));
  const body=JSON.stringify({chat_id:C.tgChat,text,parse_mode:'HTML'});
  return new Promise(res=>{
    const req=https.request({hostname:'api.telegram.org',path:`/bot${C.tgTok}/sendMessage`,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},r=>{
      let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);if(!j.ok)log('[TG] err:'+JSON.stringify(j).slice(0,80));else log('[TG] OK');}catch(_){log('[TG] parse err');}res();});
    });
    req.on('error',e=>{log('[TG] '+e.message);res();});req.write(body);req.end();
  });
}

function post(url,body,headers){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:'POST',headers:{'Content-Length':Buffer.byteLength(body),...headers}},r=>{
      let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve({status:r.statusCode,data:JSON.parse(d)});}catch(_){resolve({status:r.statusCode,data:d});}});
    });
    req.on('error',reject);req.write(body);req.end();
  });
}

function sign(method,ep){
  const ts=Date.now().toString();
  const sig=crypto.sign('sha256',Buffer.from(ts+method.toUpperCase()+ep),{key:C.pem,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST});
  return{ts,sig:sig.toString('base64')};
}
function kalshi(method,ep,body=null){
  const fp=C.v2+ep;const{ts,sig}=sign(method,fp);const host=new URL(C.base).hostname;
  let rp=fp;if(method==='GET'&&body){rp+='?'+new URLSearchParams(body);body=null;}
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:host,path:rp,method,headers:{'Content-Type':'application/json','KALSHI-ACCESS-KEY':C.keyId,'KALSHI-ACCESS-TIMESTAMP':ts,'KALSHI-ACCESS-SIGNATURE':sig}},r=>{
      let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve({status:r.statusCode,data:JSON.parse(d)});}catch(_){resolve({status:r.statusCode,data:d});}});
    });
    req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
  });
}

async function onAuthFail(status,where){
  S.authFails=(S.authFails||0)+1;log(`Auth fail #${S.authFails} (${status}) ${where}`);
  if(S.authFails>=3){const m=`Auth failed 3x (${status}). Check keys + clock.`;S.haltMsg=m;stopBot();await tg(`🔴 <b>HALTED</b>\n${m}`);}
}
const authOk=()=>{S.authFails=0;};

async function validate(){
  log('Validating...');
  if(!C.keyId||C.pem.length<50){const m='Missing KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY';log('ABORT: '+m);await tg('🔴 <b>Abort</b>\n'+m);return false;}
  try{
    const r=await kalshi('GET','/portfolio/balance');
    if(r.status===200){
      const b=r.data.balance||0;
      if(b>0){S.bal=b;if(!S.paperBal||S.paperBal===Math.round(C.startBal*100))S.paperBal=b;S.peak=b;log(`Peak reset to real balance: ${(b/100).toFixed(2)}`);}
      authOk();log(`Auth OK — $${(S.bal/100).toFixed(2)}`);return true;
    }
    log(`Auth failed ${r.status}`);await tg(`🔴 <b>Auth failed (${r.status})</b>\nCheck keys and system clock.`);return false;
  }catch(e){log('Auth err: '+e.message);await tg('🔴 <b>Connection error</b>\n'+e.message);return false;}
}

async function syncBal(){
  try{
    const r=await kalshi('GET','/portfolio/balance');
    if(r.status===200&&r.data.balance!==undefined){
      const prev=S.bal;S.bal=r.data.balance;S.peak=Math.max(S.peak,S.bal);authOk();
      if(Math.abs(S.bal-prev)>5)log(`Bal: $${(prev/100).toFixed(2)} → $${(S.bal/100).toFixed(2)}`);
    }else if(r.status===401||r.status===403)await onAuthFail(r.status,'syncBal');
  }catch(e){log('syncBal: '+e.message);}
}

function breakers(){
  if(S.dayPnl<=-C.dailyStop){const m=`Daily loss -$${Math.abs(S.dayPnl).toFixed(2)} ≥ $${C.dailyStop}`;log('BREAKER: '+m);S.haltMsg=m;stopBot();tg(`⚡ <b>Circuit — Daily loss</b>\n${m}`);return false;}
  if(S.peak>0){const dd=(S.peak-S.bal)/S.peak;if(dd>=C.ddLimit){const m=`Drawdown ${(dd*100).toFixed(1)}% from $${(S.peak/100).toFixed(2)}`;log('BREAKER: '+m);S.haltMsg=m;stopBot();tg(`⚡ <b>Circuit — Drawdown</b>\n${m}`);return false;}}
  return true;
}

function midnight(){
  const today=new Date().toDateString();if(S.day===today)return;
  log('Midnight reset');S.dayPnl=0;S.day=today;S.haltMsg=null;save();
  tg(`🌅 <b>New Day</b>\nReal balance: $${realUsd().toFixed(2)} | All-time: ${fmt(S.totPnl)}`);
}

function kellySz(p,mkt){
  if(mkt<=0||mkt>=1)return 0;
  const b=1/mkt-1,f=Math.max(0,(p*(b+1)-1)/b)*C.kelly;
  return Math.min(f*usd(),C.maxBet,usd()*0.10);
}

async function scan(){
  S.scanAt=new Date().toISOString();
  try{
    const r=await kalshi('GET','/markets',{status:'open',limit:'200'});
    if(r.status===401||r.status===403){await onAuthFail(r.status,'scan');return;}
    if(r.status!==200){log(`Scan HTTP ${r.status}: ${JSON.stringify(r.data).slice(0,80)}`);return;}
    authOk();
    const markets=r.data.markets||[];
    if(markets.length===0){log('Scan: API returned 0 markets — check endpoint');return;}
    
    // Log first market structure once to debug field names
    if(!S._fieldLogged&&markets.length>0){
      const m0=markets[0];
      log('Market fields: '+Object.keys(m0).join(', '));
      log('Sample: ticker='+m0.ticker_name+' last='+m0.last_price+' vol='+m0.volume+' close='+m0.close_time);
      S._fieldLogged=true;
    }
    
    const held=new Set(S.positions.map(p=>p.ticker));
    const now=Date.now();
    const scored=markets.filter(m=>{
      // Support both ticker_name and ticker field names
      const ticker=m.ticker_name||m.ticker||'';
      if(!ticker)return false;
      if(held.has(ticker))return false;
      
      // Volume filter — relaxed to 500 to capture more markets
      if((m.volume||0)<500)return false;
      
      // Time window: must have a close time, must be 1h-7d away
      if(!m.close_time)return false;
      const closeMs=new Date(m.close_time).getTime();
      if(isNaN(closeMs))return false;
      const hrs=(closeMs-now)/3.6e6;
      if(hrs<0.5||hrs>336)return false; // 30min to 14 days
      
      // Price: Kalshi last_price is 0-100 (cents). Accept if we have any price data.
      // yes_ask/yes_bid may also be present
      const y=m.last_price||m.yes_ask||m.yes_bid||50;
      return y>=2&&y<=98;
    }).map(m=>{
      const ticker=m.ticker_name||m.ticker;
      const y=Math.round(m.last_price||m.yes_ask||m.yes_bid||50);
      const closeMs=new Date(m.close_time).getTime();
      const hrs=((closeMs-now)/3.6e6).toFixed(1);
      const ph=S._ph[ticker]||[];
      const prev=ph.length?ph[ph.length-1]:y;
      const mom=y>prev+2?'↑':y<prev-2?'↓':'→';
      S._ph[ticker]=[...ph.slice(-19),y];
      const urgency=Math.max(0,1-parseFloat(hrs)/48);
      const midScore=1-Math.abs(y-50)/50;
      const volScore=Math.min((m.volume||0)/5000,1);
      const score=midScore*0.4+volScore*0.3+urgency*0.3;
      return{
        ticker,
        title:m.title||ticker,
        yes:y,no:100-y,
        vol:m.volume||0,
        hrs,
        cat:m.category||m.event_category||'market',
        mom,score
      };
    });
    
    scored.sort((a,b)=>b.score-a.score);
    S.cands=scored.slice(0,25);
    log(`Scan: ${markets.length} total → ${scored.length} pass filters → ${S.cands.length} candidates`);
    if(S.cands.length>0)log(`Top candidate: ${S.cands[0].ticker} "${S.cands[0].title.slice(0,40)}" yes=${S.cands[0].yes}¢ ${S.cands[0].hrs}h vol=${S.cands[0].vol}`);
  }catch(e){log('Scan err: '+e.message);S.lastErr=e.message;}
}

async function brain(){
  if(!C.claude){log('No Claude key — set CLAUDE_API_KEY env var');return;}
  if(!S.cands.length){
    log('No candidates yet — running scan first...');
    await scan();
    if(!S.cands.length){log('Still no candidates after scan — skipping brain');return;}
  }
  S.brainAt=new Date().toISOString();S.calls++;
  const edgeMin=C.paper?C.edgePaper:C.edgeLive;
  const held=S.positions.map(p=>`${p.ticker}(${p.side}@${p.ep}¢)`).join(', ')||'none';
  const mem=S.notes.slice(-8).join('\n')||'No learnings yet.';
  const tot=S.wins+S.losses,wr=tot>0?((S.wins/tot)*100).toFixed(0)+'%':'no trades yet';
  const mkts=S.cands.map((c,i)=>`${i+1}. [${c.ticker}] "${c.title}"\n   YES:${c.yes}¢ NO:${c.no}¢ | Vol:${c.vol} | ${c.hrs}h | ${c.cat} | ${c.mom}`).join('\n\n');

  const system=`You are Kalshi Edge — an elite autonomous AI prediction market trader.
MISSION: Double the portfolio ($${usd().toFixed(2)}) as fast as safely possible.

STATE: ${C.paper?'PAPER':'⚡ LIVE'} | Real balance: $${realUsd().toFixed(2)} | Today: ${fmt(S.dayPnl)} | All-time: ${fmt(S.totPnl)} | Win rate: ${wr}
Open (${S.positions.length}/${C.maxPos}): ${held}
Brain cycle #${S.calls}

MEMORY (your accumulated learnings):
${mem}

STRATEGY — HOW TO DOUBLE:
Target 3-6 trades/day at 7%+ edge. Compound wins. Never gamble.
A 60% win rate at 8% avg edge ≈ 25% monthly return = doubles in ~3 months.

THREE EDGES (priority order):
1. NEWS LAG — Breaking news <30min old not yet priced in. Search every cycle.
2. FAVOURITE-LONGSHOT BIAS — YES >80¢ underpriced 3-8%. YES <15¢ overpriced.
3. RESOLUTION CERTAINTY — Outcome effectively determined, market hasn't repriced to 95¢+.

SEARCH PROTOCOL (every cycle, every market):
• "[market topic] latest news today"
• "[event] result [today's date]"
• Official sources: fed.gov, bls.gov, election boards, live scores
• Note timestamps — only cite evidence from TODAY

RULES:
✓ Search before every signal — no evidence = no signal
✓ Edge min: ${(edgeMin*100).toFixed(0)}%
✓ HIGH confidence = specific timestamped evidence found today
✓ MEDIUM = strong reasoning, indirect/slightly older evidence
✓ Never signal LOW — just skip
✓ Limit price = market price minus 2¢ (maker position, zero fees)
✓ No duplicate topics — already holding Fed market? Skip other Fed markets

RETURN ONLY valid JSON — no markdown, no fences, nothing else:
{"signals":[{"ticker":"...","title":"...","side":"yes|no","marketPrice":0.XX,"trueProb":0.XX,"edge":0.XX,"confidence":"high|medium","limitPrice":XX,"reasoning":"Specific evidence: [source] [fact] [time]"}],"note":"one concrete learning to improve future cycles"}`;

  const user=`TIME: ${new Date().toISOString()} | WIN RATE: ${wr} | CYCLE #${S.calls}\n\nMARKETS:\n${mkts}\n\nSearch web → assess true prob → signal where edge ≥ ${(edgeMin*100).toFixed(0)}% → write note. Go.`;

  try{
    const body=JSON.stringify({model:C.model,max_tokens:2000,system,tools:[{type:'web_search_20250305',name:'web_search'}],messages:[{role:'user',content:user}]});
    const r=await post('https://api.anthropic.com/v1/messages',body,{'Content-Type':'application/json','x-api-key':C.claude,'anthropic-version':'2023-06-01','anthropic-beta':'web-search-2025-03-05'});
    if(r.status!==200){log(`Claude ${r.status}: ${JSON.stringify(r.data).slice(0,150)}`);S.lastErr=`Claude ${r.status}`;return;}
    const text=(r.data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    if(!text){log('Brain: no text');return;}
    const s=text.indexOf('{'),e=text.lastIndexOf('}');if(s<0||e<0){log('Brain: no JSON');return;}
    let parsed;try{parsed=JSON.parse(text.slice(s,e+1));}catch(err){log('Brain parse: '+err.message);return;}
    if(parsed.note){S.notes.push(`[${new Date().toISOString().slice(0,16)}] ${parsed.note}`);if(S.notes.length>50)S.notes.shift();}
    S.signalTs=Date.now();
    S.signals=(parsed.signals||[]).filter(sig=>{
      if(!sig.ticker||!sig.side||typeof sig.edge!=='number')return false;
      if(sig.edge<edgeMin){log(`Skip ${sig.ticker}: edge ${(sig.edge*100).toFixed(1)}% < min`);return false;}
      if(!['yes','no'].includes(sig.side))return false;
      if(sig.confidence==='low')return false;return true;
    });
    log(`Brain #${S.calls}: ${S.signals.length} signal(s) | ${(parsed.note||'').slice(0,70)}`);
    if(S.signals.length){
      const lines=S.signals.map(sig=>`• ${sig.ticker} ${sig.side.toUpperCase()} — ${(sig.edge*100).toFixed(1)}% (${sig.confidence})\n  ${sig.reasoning||''}`).join('\n');
      await tg(`🧠 <b>Brain #${S.calls} — ${S.signals.length} signal(s)</b>\n\n${lines}`);
    }
  }catch(e){log('Brain err: '+e.message);S.lastErr=e.message;}
}

async function execute(){
  if(!S.signals.length||S.positions.length>=C.maxPos||!breakers())return;
  const age=S.signalTs?(Date.now()-S.signalTs)/1000:999;
  if(age>180){log(`Signals stale (${age.toFixed(0)}s)`);return;}
  for(const sig of S.signals){
    if(S.positions.length>=C.maxPos||!breakers())break;
    if(S.positions.find(p=>p.ticker===sig.ticker))continue;
    const mktP=sig.marketPrice||0.5,sizeDol=kellySz(sig.trueProb||0.55,mktP);
    if(sizeDol<0.50){log(`${sig.ticker}: $${sizeDol.toFixed(2)} too small`);continue;}
    const lp=sig.limitPrice||Math.round(mktP*100);
    const qty=Math.max(1,Math.floor((sizeDol*100)/lp));
    const cost=(qty*lp)/100;
    if(C.paper){
      const pos={id:crypto.randomUUID(),ticker:sig.ticker,title:sig.title||sig.ticker,side:sig.side,qty,ep:lp,size:cost,edge:sig.edge,reason:sig.reasoning||'',at:new Date().toISOString()};
      S.positions.push(pos);S.paperBal-=Math.round(cost*100);S.dayPnl-=cost;
      log(`[PAPER] ${sig.side.toUpperCase()} ${sig.ticker} ${qty}ct @${lp}¢ $${cost.toFixed(2)}`);
      await tg(`📝 <b>Paper Trade</b>\n${sig.side.toUpperCase()} ${sig.ticker}\n${qty}ct @ ${lp}¢ = $${cost.toFixed(2)}\nEdge: ${(sig.edge*100).toFixed(1)}% | ${sig.confidence}\nPaper bal: $${(S.paperBal/100).toFixed(2)}\n${sig.reasoning||''}`);
    }else{
      try{
        const ob={ticker:sig.ticker,action:'buy',type:'limit',side:sig.side,count:qty,yes_price:sig.side==='yes'?lp:100-lp,no_price:sig.side==='no'?lp:100-lp,client_order_id:crypto.randomUUID()};
        const r=await kalshi('POST','/portfolio/orders',ob);
        if(r.status===200||r.status===201){
          authOk();const order=r.data.order||r.data;
          S.positions.push({id:order.order_id||crypto.randomUUID(),ticker:sig.ticker,title:sig.title||sig.ticker,side:sig.side,qty,ep:lp,size:cost,edge:sig.edge,reason:sig.reasoning||'',at:new Date().toISOString(),orderId:order.order_id});
          log(`[LIVE] ${sig.side.toUpperCase()} ${sig.ticker} ${qty}ct @${lp}¢`);
          await tg(`⚡ <b>LIVE Order Placed</b>\n${sig.side.toUpperCase()} ${sig.ticker}\n${qty}ct @ ${lp}¢ = $${cost.toFixed(2)}\nEdge: ${(sig.edge*100).toFixed(1)}% | ${sig.confidence}\nReal balance: $${realUsd().toFixed(2)}\n${sig.reasoning||''}`);
        }else if(r.status===401||r.status===403){await onAuthFail(r.status,`order ${sig.ticker}`);break;}
        else{log(`Rejected ${r.status}: ${JSON.stringify(r.data).slice(0,100)}`);await tg(`⚠️ <b>Order Rejected</b> ${sig.ticker}\n${r.status}: ${JSON.stringify(r.data).slice(0,80)}`);}
      }catch(e){log(`Order err ${sig.ticker}: ${e.message}`);}
    }
    await new Promise(r=>setTimeout(r,400));
  }
  save();
}

async function monitor(){
  await syncBal();
  if(!S.positions.length)return;
  if(C.paper)return; // paper settles via /settle endpoint
  try{
    const r=await kalshi('GET','/portfolio/positions');
    if(r.status===401||r.status===403){await onAuthFail(r.status,'monitor');return;}
    if(r.status!==200){log(`Monitor ${r.status}`);return;}
    authOk();
    const liveMap={};for(const p of(r.data.market_positions||[]))liveMap[p.ticker_name]=p;
    for(const pos of[...S.positions]){
      const lp=liveMap[pos.ticker];
      if(!lp||lp.position===0){
        let pnl=-pos.size;
        try{const f=await kalshi('GET','/portfolio/fills',{ticker:pos.ticker,limit:'10'});if(f.status===200){const t=(f.data.fills||[]).reduce((a,x)=>a+(x.profit_loss||0),0);if(t!==0)pnl=t/100;}}catch(_){}
        if(lp&&lp.realized_pnl&&lp.realized_pnl!==0)pnl=lp.realized_pnl/100;
        S.positions=S.positions.filter(p=>p.id!==pos.id);
        S.totPnl+=pnl;S.dayPnl+=pnl;if(pnl>0)S.wins++;else S.losses++;
        S.trades.unshift({...pos,closedAt:new Date().toISOString(),pnl,won:pnl>0});
        if(S.trades.length>100)S.trades.length=100;
        const tot=S.wins+S.losses,wr=tot>0?((S.wins/tot)*100).toFixed(0)+'%':'—';
        log(`Settled ${pos.ticker}: ${fmt(pnl)} | total: ${fmt(S.totPnl)} W:${S.wins} L:${S.losses}`);
        await tg(`${pnl>0?'✅':'❌'} <b>Trade Settled: ${pos.ticker}</b>\n${pos.side.toUpperCase()} ${pos.qty}ct @ ${pos.ep}¢\nP&L: <b>${fmt(pnl)}</b>\nAll-time: ${fmt(S.totPnl)} | Win rate: ${wr}\nBalance: $${realUsd().toFixed(2)}`);
      }
    }
    save();
  }catch(e){log('Monitor err: '+e.message);}
}

let _sc,_br,_hb;
function startBot(){
  if(S.on)return;S.on=true;S.haltMsg=null;S.startedAt=new Date().toISOString();log('Bot started — '+new Date().toLocaleTimeString());
  // Run scan and sync immediately, log results
  scan().then(()=>{
    syncBal();
    log('Initial scan complete: '+S.cands.length+' candidates found');
    if(S.cands.length>0)log('Top market: '+S.cands[0].ticker+' '+S.cands[0].yes+'¢ '+S.cands[0].title.slice(0,40));
    else log('WARNING: 0 candidates — feed will be empty until filter criteria are met');
  });
  _sc=setInterval(async()=>{midnight();await scan();await monitor();if(breakers())await execute();S.pnlHist.push({ts:Date.now(),bal:usd(),pnl:S.totPnl});if(S.pnlHist.length>600)S.pnlHist.shift();save();},C.scanSec*1000);
  _br=setTimeout(()=>{brain();_br=setInterval(brain,C.brainSec*1000);},20000);
  _hb=setInterval(()=>{
    const w=S.wins,l=S.losses,tot=w+l,wr=tot>0?((w/tot)*100).toFixed(0)+'%':'—';
    const dd=S.peak>0?((S.peak-S.bal)/S.peak*100).toFixed(1):'0.0';
    const age=S.signalTs?(Math.round((Date.now()-S.signalTs)/60000))+'min':'none';
    tg(`📊 <b>Heartbeat</b>\nMode: ${C.paper?'📝 Paper':'⚡ LIVE'}\nReal: $${realUsd().toFixed(2)}${C.paper?` | Sim: $${(S.paperBal/100).toFixed(2)}`:''}\nToday: ${fmt(S.dayPnl)} | All-time: ${fmt(S.totPnl)}\nWin: ${wr} (${w}W/${l}L) | Open: ${S.positions.length}/${C.maxPos}\nBrain: #${S.calls} | Drawdown: ${dd}% | Sig age: ${age}`);
  },30*60*1000);
  save();
}
function stopBot(){S.on=false;clearInterval(_sc);clearTimeout(_br);clearInterval(_br);clearInterval(_hb);_sc=_br=_hb=null;log('Bot stopped');save();}

app.get('/s',(_,res)=>{
  const w=S.wins,l=S.losses,tot=w+l,dd=S.peak>0?(S.peak-S.bal)/S.peak*100:0;
  res.json({on:S.on,paper:C.paper,bal:usd(),realBal:realUsd(),paperBal:S.paperBal/100,peak:S.peak/100,dd:parseFloat(dd.toFixed(1)),dayPnl:S.dayPnl,totPnl:S.totPnl,wins:w,losses:l,total:tot,wr:tot>0?parseFloat((w/tot*100).toFixed(1)):null,open:S.positions.length,maxPos:C.maxPos,calls:S.calls,signalAge:S.signalTs?Math.round((Date.now()-S.signalTs)/1000):null,authFails:S.authFails,scanAt:S.scanAt,brainAt:S.brainAt,startedAt:S.startedAt,haltMsg:S.haltMsg,lastErr:S.lastErr,cfg:{kelly:C.kelly,edgeLive:C.edgeLive,edgePaper:C.edgePaper,maxBet:C.maxBet,dailyStop:C.dailyStop,ddLimit:C.ddLimit,maxPos:C.maxPos}});
});
app.get('/trades',(_,res)=>res.json(S.trades.slice(0,50)));
app.get('/positions',(_,res)=>res.json(S.positions));
app.get('/signals',(_,res)=>res.json(S.signals));
app.get('/cands',(_,res)=>res.json(S.cands));
app.get('/logs',(_,res)=>res.json(LOGS.slice(0,150)));
app.get('/pnl',(_,res)=>res.json(S.pnlHist.slice(-300)));
app.get('/notes',(_,res)=>res.json(S.notes));
app.get('/health',(_,res)=>res.json({ok:true,v:8,uptime:process.uptime()}));
app.post('/start',(_,res)=>{startBot();res.json({ok:true});});
app.post('/stop',(_,res)=>{stopBot();res.json({ok:true});});
app.post('/scan',async(_,res)=>{await scan();res.json({ok:true,count:S.cands.length});});
app.post('/brain',async(_,res)=>{await brain();res.json({ok:true,signals:S.signals.length});});
app.get('/test',async(_,res)=>{const ok=await validate();res.json({ok,realBal:realUsd()});});
app.post('/settle',(req,res)=>{
  const{id,won}=req.body;const p=S.positions.find(x=>x.id===id);
  if(!p)return res.status(404).json({ok:false,error:'not found'});
  const pnl=won?p.size*((100/p.ep)-1):-p.size;
  S.positions=S.positions.filter(x=>x.id!==id);S.totPnl+=pnl;S.dayPnl+=pnl;
  if(C.paper)S.paperBal=(S.paperBal||S.bal)+Math.round(pnl*100);
  S.peak=Math.max(S.peak,C.paper?S.paperBal:S.bal);
  if(pnl>0)S.wins++;else S.losses++;
  S.trades.unshift({...p,closedAt:new Date().toISOString(),pnl,won:pnl>0});
  S.pnlHist.push({ts:Date.now(),bal:usd(),pnl:S.totPnl});save();
  tg(`${pnl>0?'✅':'❌'} <b>Manual settle: ${p.ticker}</b>\n${fmt(pnl)} | All-time: ${fmt(S.totPnl)}`);
  res.json({ok:true,pnl,totPnl:S.totPnl});
});
app.post('/reset',(_,res)=>{stopBot();S=fresh();save();res.json({ok:true});});
app.get('/debug',async(_,res)=>{
  try{
    const r=await kalshi('GET','/markets',{status:'open',limit:'5'});
    const fields=r.data.markets&&r.data.markets[0]?Object.keys(r.data.markets[0]):[];
    const sample=r.data.markets?r.data.markets.slice(0,2):[];
    res.json({status:r.status,count:r.data.markets?.length||0,fields,sample,cands:S.cands.length,scanAt:S.scanAt,lastErr:S.lastErr});
  }catch(e){res.json({error:e.message});}
});

app.get('/',(_,res)=>{res.setHeader('Content-Type','text/html');res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#06060f"><title>Kalshi Edge</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{--bg:#06060f;--l1:#0c0c1a;--l2:#11111f;--l3:#171728;--l4:#1e1e30;--bd:rgba(255,255,255,.06);--bd2:rgba(255,255,255,.11);--t1:#f0f0ff;--t2:#8080a8;--t3:#404060;--g:#00e676;--ga:rgba(0,230,118,.12);--r:#ff4560;--ra:rgba(255,69,96,.11);--b:#4488ff;--ba:rgba(68,136,255,.11);--y:#ffb020;--ya:rgba(255,176,32,.11);--f:'Outfit',sans-serif;--m:'JetBrains Mono',monospace;--st:env(safe-area-inset-top,0px);--sb:env(safe-area-inset-bottom,0px)}
html,body{height:100%;background:var(--bg);color:var(--t1);font-family:var(--f);-webkit-font-smoothing:antialiased;overflow:hidden}
.app{display:flex;flex-direction:column;height:100%;padding-top:var(--st)}
.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 8px;flex-shrink:0}
.logo-row{display:flex;align-items:center;gap:10px}
.logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#00e676,#4488ff);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:12px;color:#000}
.appname{font-size:20px;font-weight:800;letter-spacing:-.5px}
.badge{font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;padding:4px 11px;border-radius:20px;border:1px solid}
.b-paper{background:var(--ya);border-color:var(--y);color:var(--y)}.b-live{background:var(--ra);border-color:var(--r);color:var(--r)}.b-on{background:var(--ga);border-color:var(--g);color:var(--g)}
.tabs{display:flex;padding:0 14px 8px;gap:4px;flex-shrink:0;overflow-x:auto}.tabs::-webkit-scrollbar{display:none}
.tab{border:none;background:var(--l2);color:var(--t3);font-family:var(--f);font-size:12px;font-weight:700;padding:8px 16px;border-radius:20px;cursor:pointer;white-space:nowrap;transition:all .15s;letter-spacing:.3px}
.tab.on{background:var(--l4);color:var(--t1);border:1px solid var(--bd2)}
.scroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 14px calc(68px + var(--sb)) 14px}.scroll::-webkit-scrollbar{display:none}
.panel{display:none}.panel.on{display:block}
.ph{margin-bottom:18px}.ph h1{font-size:28px;font-weight:900;letter-spacing:-.7px}.ph p{font-size:12px;color:var(--t2);margin-top:3px}
.halt{background:var(--ra);border:1px solid var(--r);border-radius:14px;padding:12px 15px;margin-bottom:12px;display:none}
.halt strong{display:block;color:var(--r);font-size:13px;font-weight:700;margin-bottom:2px}.halt span{color:var(--r);font-size:12px;opacity:.85}
.hero{background:var(--l1);border:1px solid var(--bd);border-radius:22px;padding:20px 18px 16px;margin-bottom:10px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-50px;right:-50px;width:150px;height:150px;background:radial-gradient(circle,rgba(0,230,118,.07),transparent 65%);border-radius:50%;pointer-events:none}
.hero-lbl{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--t3);margin-bottom:6px}
.hero-pnl{font-size:44px;font-weight:900;letter-spacing:-2px;line-height:1;margin-bottom:5px}
.hero-sub{font-size:12px;color:var(--t2);margin-bottom:16px}
.hero-stats{display:flex;border-top:1px solid var(--bd);padding-top:14px}
.hstat{flex:1;display:flex;flex-direction:column;gap:3px}.hstat+.hstat{border-left:1px solid var(--bd);padding-left:14px}
.hs-l{font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3)}.hs-v{font-size:14px;font-weight:700;letter-spacing:-.3px}
.trirow{display:flex;background:var(--l2);border:1px solid var(--bd);border-radius:16px;overflow:hidden;margin-bottom:10px}
.tristat{flex:1;padding:12px;text-align:center;display:flex;flex-direction:column;gap:3px}.tristat+.tristat{border-left:1px solid var(--bd)}
.tri-l{font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3)}.tri-v{font-size:17px;font-weight:800;letter-spacing:-.4px}
.eng{background:var(--l2);border:1px solid var(--bd);border-radius:18px;padding:14px 16px;display:flex;align-items:center;gap:12px;margin-bottom:10px}
.eng-icon{width:46px;height:46px;border-radius:13px;background:linear-gradient(135deg,var(--ga),var(--ba));display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.eng-txt{flex:1}.eng-name{font-size:15px;font-weight:700}.eng-sub{font-size:11px;color:var(--t2);margin-top:2px}
.toggle{width:48px;height:27px;border-radius:14px;border:none;cursor:pointer;transition:background .2s;position:relative;flex-shrink:0}
.toggle::after{content:'';position:absolute;top:3px;width:21px;height:21px;border-radius:11px;background:#fff;transition:left .2s}
.toggle.off{background:var(--l4)}.toggle.off::after{left:3px}.toggle.on2{background:var(--g)}.toggle.on2::after{left:24px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.sc{background:var(--l2);border:1px solid var(--bd);border-radius:14px;padding:13px}
.sc-l{font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3);margin-bottom:5px}.sc-v{font-size:22px;font-weight:800;letter-spacing:-.5px}.sc-full{grid-column:span 2}
.sec{background:var(--l1);border:1px solid var(--bd);border-radius:18px;padding:15px;margin-bottom:10px}
.sec-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.sec-title{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--t3)}
.sec-ct{font-size:10px;font-weight:700;background:var(--l3);color:var(--t2);padding:2px 8px;border-radius:6px}
.chart-box{height:140px;position:relative}canvas{display:block;width:100%!important}
.tf{display:flex;gap:6px;margin-bottom:12px}.tfb{border:1px solid var(--bd);background:none;color:var(--t3);border-radius:20px;padding:5px 13px;font-family:var(--f);font-size:12px;font-weight:700;cursor:pointer}.tfb.on{background:var(--l3);color:var(--t1);border-color:var(--bd2)}
.ring-wrap{display:flex;align-items:center;gap:18px;margin-bottom:14px}.ring-rows{flex:1;display:flex;flex-direction:column;gap:7px}
.rrow{display:flex;justify-content:space-between;font-size:13px}.rlbl{color:var(--t2)}
.gross-row{display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid var(--bd)}
.item{background:var(--l3);border-radius:13px;padding:12px 13px;margin-bottom:7px}.item:last-child{margin-bottom:0}
.ihead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:5px}
.iname{font-size:13px;font-weight:600;flex:1;line-height:1.3}
.imeta{display:flex;flex-wrap:wrap;gap:4px;font-size:10px;font-family:var(--m);color:var(--t3)}.imeta span{background:var(--l4);padding:2px 6px;border-radius:4px}
.ireason{font-size:11px;color:var(--t2);margin-top:6px;line-height:1.5;border-left:2px solid var(--bd2);padding-left:8px;font-style:italic}
.tag{font-size:9px;font-weight:700;text-transform:uppercase;padding:3px 8px;border-radius:6px;flex-shrink:0;letter-spacing:.5px}
.t-yes{background:var(--ga);color:var(--g)}.t-no{background:var(--ra);color:var(--r)}.t-won{background:var(--ga);color:var(--g)}.t-lost{background:var(--ra);color:var(--r)}
.chips{display:flex;gap:5px;margin-bottom:12px;overflow-x:auto;padding-bottom:2px}.chips::-webkit-scrollbar{display:none}
.chip{border:1px solid var(--bd);background:none;color:var(--t3);border-radius:20px;padding:5px 13px;font-family:var(--f);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
.chip.on{background:var(--b);border-color:var(--b);color:#fff}
.logline{font-size:10px;font-family:var(--m);color:var(--t3);padding:3px 0;border-bottom:1px solid var(--bd);line-height:1.45;word-break:break-all}.logline:last-child{border:none}
.note{font-size:12px;color:var(--t2);padding:6px 0;border-bottom:1px solid var(--bd);line-height:1.5}.note:last-child{border:none}
.empty{text-align:center;color:var(--t3);font-size:13px;padding:26px 0;line-height:1.7}.ei{font-size:28px;margin-bottom:6px}
.btns{display:flex;gap:8px;margin-bottom:10px}.btn{flex:1;border:1px solid var(--bd2);background:var(--l3);color:var(--t1);border-radius:13px;padding:12px 8px;font-family:var(--f);font-size:13px;font-weight:700;cursor:pointer;transition:all .15s}.btn:active{transform:scale(.97)}.btn:disabled{opacity:.35}
.btn-g{background:var(--ga);border-color:var(--g);color:var(--g)}.btn-r{background:var(--ra);border-color:var(--r);color:var(--r)}
.bnav{display:flex;background:var(--l1);border-top:1px solid var(--bd);padding-bottom:var(--sb);flex-shrink:0}
.nb{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 4px;background:none;border:none;color:var(--t3);font-family:var(--f);font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;cursor:pointer;transition:color .15s}
.nb svg{width:21px;height:21px;stroke:currentColor;fill:none;stroke-width:1.8}.nb.on{color:var(--g)}
.cg{color:var(--g)}.cr{color:var(--r)}.cy{color:var(--y)}.cb{color:var(--b)}
</style></head><body>
<div class="app">
<div class="hdr"><div class="logo-row"><div class="logo">KE</div><span class="appname">Kalshi Edge</span></div><span class="badge b-paper" id="modeBadge">PAPER</span></div>
<div class="tabs">
  <button class="tab on" onclick="goTab(0,this)">Home</button>
  <button class="tab" onclick="goTab(1,this)">Charts</button>
  <button class="tab" onclick="goTab(2,this)">Feed</button>
  <button class="tab" onclick="goTab(3,this)">Signals</button>
  <button class="tab" onclick="goTab(4,this)">Brain</button>
</div>
<div class="scroll">

<div class="panel on" id="p0">
  <div class="halt" id="haltBox"><strong>⚡ Bot Halted</strong><span id="haltMsg"></span></div>
  <div class="hero">
    <div class="hero-lbl">Total Profit / Loss</div>
    <div class="hero-pnl cg" id="heroPnl">+\$0.00</div>
    <div class="hero-sub" id="heroSub">Start bot to begin tracking</div>
    <div class="hero-stats">
      <div class="hstat"><div class="hs-l">Real Balance</div><div class="hs-v" id="hRealBal">—</div></div>
      <div class="hstat"><div class="hs-l">Today P&L</div><div class="hs-v" id="hDay">—</div></div>
      <div class="hstat"><div class="hs-l">Drawdown</div><div class="hs-v" id="hDd">—</div></div>
    </div>
  </div>
  <div class="trirow">
    <div class="tristat"><div class="tri-l">Deployed</div><div class="tri-v" id="tDeploy">\$0</div></div>
    <div class="tristat"><div class="tri-l">Trades</div><div class="tri-v" id="tTrades">0</div></div>
    <div class="tristat"><div class="tri-l">Open</div><div class="tri-v" id="tOpen">0</div></div>
  </div>
  <div class="eng">
    <div class="eng-icon">⚡</div>
    <div class="eng-txt"><div class="eng-name" id="engName">AI Trading Engine</div><div class="eng-sub" id="engSub">Tap to activate</div></div>
    <button class="toggle off" id="toggleBtn" onclick="toggleBot()"></button>
  </div>
  <div class="grid2">
    <div class="sc"><div class="sc-l">Win Rate</div><div class="sc-v" id="gWr">—</div></div>
    <div class="sc"><div class="sc-l">W / L</div><div class="sc-v" id="gWl">—</div></div>
    <div class="sc"><div class="sc-l">Scans/hr</div><div class="sc-v" id="gScans">—</div></div>
    <div class="sc"><div class="sc-l">Brain calls</div><div class="sc-v" id="gCalls">—</div></div>
    <div class="sc sc-full"><div class="sc-l">Signal freshness</div><div class="sc-v" style="font-size:15px" id="gSigAge">—</div></div>
  </div>
</div>

<div class="panel" id="p1">
  <div class="ph"><h1>Analytics</h1><p>Session performance</p></div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Equity Curve</span></div>
    <div class="tf"><button class="tfb on" onclick="setTf('1h',this)">1H</button><button class="tfb" onclick="setTf('6h',this)">6H</button><button class="tfb" onclick="setTf('all',this)">ALL</button></div>
    <div style="font-size:28px;font-weight:900;letter-spacing:-1px;margin-bottom:3px" id="chartVal">+\$0.00</div>
    <div style="font-size:11px;color:var(--t3);margin-bottom:12px" id="chartLbl">No data yet</div>
    <div class="chart-box"><canvas id="cvs" height="140"></canvas></div>
  </div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Performance</span></div>
    <div class="ring-wrap">
      <svg width="84" height="84" viewBox="0 0 84 84" style="flex-shrink:0">
        <circle cx="42" cy="42" r="33" fill="none" stroke="var(--l3)" stroke-width="9"/>
        <circle id="ringC" cx="42" cy="42" r="33" fill="none" stroke="var(--g)" stroke-width="9" stroke-dasharray="0 207" stroke-linecap="round" transform="rotate(-90 42 42)"/>
        <text x="42" y="47" text-anchor="middle" font-size="13" font-weight="800" fill="var(--t1)" font-family="Outfit,sans-serif" id="ringTx">—</text>
      </svg>
      <div class="ring-rows">
        <div class="rrow"><span class="rlbl">Wins</span><span class="cg" id="rW">0</span></div>
        <div class="rrow"><span class="rlbl">Losses</span><span class="cr" id="rL">0</span></div>
        <div class="rrow"><span class="rlbl">Brain cycles</span><span id="rBrain">0</span></div>
        <div class="rrow"><span class="rlbl">Open positions</span><span id="rOpen">0</span></div>
      </div>
    </div>
    <div class="gross-row"><span style="font-size:13px;color:var(--t2)">Gross P&L</span><span style="font-size:17px;font-weight:800" id="rGross">+\$0.00</span></div>
  </div>
  <div class="sec">
    <div class="sec-hdr"><span class="sec-title">Trade History</span><span class="sec-ct" id="trCt">0</span></div>
    <div id="tradeList"><div class="empty"><div class="ei">📊</div>No completed trades</div></div>
  </div>
</div>

<div class="panel" id="p2">
  <div class="ph" style="display:flex;align-items:flex-start;justify-content:space-between"><div><h1>Live Feed</h1><p>Monitoring markets</p></div><span class="badge b-paper" id="feedBadge" style="margin-top:6px">PAUSED</span></div>
  <div class="chips">
    <button class="chip on" onclick="setFeed('all',this)">All</button>
    <button class="chip" onclick="setFeed('signals',this)">Signals</button>
    <button class="chip" onclick="setFeed('rising',this)">Rising ↑</button>
    <button class="chip" onclick="setFeed('falling',this)">Falling ↓</button>
    <button class="chip" onclick="setFeed('urgent',this)">Urgent &lt;6h</button>
  </div>
  <div id="feedList"><div class="empty"><div class="ei">📡</div><b>Feed empty</b><br>Start bot on Home to monitor.</div></div>
</div>

<div class="panel" id="p3">
  <div class="ph"><h1>Signals</h1><p>Claude AI analysis</p></div>
  <div class="sec"><div class="sec-hdr"><span class="sec-title">Live Signals</span><span class="sec-ct" id="sigCt">0</span></div><div id="sigList"><div class="empty"><div class="ei">🧠</div>Waiting for brain cycle...</div></div></div>
  <div class="sec"><div class="sec-hdr"><span class="sec-title">Open Positions</span><span class="sec-ct" id="posCt">0</span></div><div id="posList"><div class="empty">No open positions</div></div></div>
  <div class="btns"><button class="btn btn-g" onclick="doPost('/brain')">Force Brain</button><button class="btn" onclick="doPost('/scan')">Force Scan</button><button class="btn btn-r" onclick="doPost('/restart')">↺ Restart</button></div>
</div>

<div class="panel" id="p4">
  <div class="ph"><h1>Brain</h1><p>Memory &amp; system log</p></div>
  <div class="sec"><div class="sec-hdr"><span class="sec-title">Learnings</span><span class="sec-ct" id="noteCt">0</span></div><div id="noteList"><div class="empty"><div class="ei">💡</div>No learnings yet</div></div></div>
  <div class="sec"><div class="sec-hdr"><span class="sec-title">System Log</span></div><div id="logList"><div class="empty">Starting...</div></div></div>
</div>

</div>
<nav class="bnav">
  <button class="nb on" onclick="goTab(0,this)"><svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Home</button>
  <button class="nb" onclick="goTab(1,this)"><svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Charts</button>
  <button class="nb" onclick="goTab(2,this)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48 0a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/></svg>Feed</button>
  <button class="nb" onclick="goTab(3,this)"><svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Signals</button>
  <button class="nb" onclick="goTab(4,this)"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>Brain</button>
</nav>
</div>
<script>
const $=id=>document.getElementById(id);
const esc=s=>{const d=document.createElement('div');d.textContent=String(s||'');return d.innerHTML;};
const fmtP=n=>(n>=0?'+':'')+'\$'+Math.abs(n).toFixed(2);
const fmtB=n=>'\$'+Number(n).toFixed(2);
let D={},sigs=[],pos=[],trades=[],cands=[],notes=[],logs=[],pnlData=[],tf='1h',feedFilter='all',botOn=false;
function goTab(i,btn){document.querySelectorAll('.panel').forEach((p,j)=>p.classList.toggle('on',j===i));document.querySelectorAll('.tab').forEach((b,j)=>b.classList.toggle('on',j===i));document.querySelectorAll('.nb').forEach((b,j)=>b.classList.toggle('on',j===i));}
function setTf(m,btn){tf=m;document.querySelectorAll('.tfb').forEach(b=>b.classList.remove('on'));btn.classList.add('on');drawChart();}
function setFeed(f,btn){feedFilter=f;document.querySelectorAll('.chip').forEach(b=>b.classList.remove('on'));btn.classList.add('on');renderFeed();}
function toggleBot(){doPost(botOn?'/stop':'/start');}
async function doPost(path){try{await fetch(path,{method:'POST'});setTimeout(refresh,600);}catch(e){console.error(e);}}
function drawChart(){
  const canvas=$('cvs');if(!canvas)return;
  const W=canvas.offsetWidth,H=140;canvas.width=W*devicePixelRatio;canvas.height=H*devicePixelRatio;
  const ctx=canvas.getContext('2d');ctx.scale(devicePixelRatio,devicePixelRatio);
  const now=Date.now();let sl=pnlData;
  if(tf==='1h')sl=pnlData.filter(p=>p.ts>now-3600000);else if(tf==='6h')sl=pnlData.filter(p=>p.ts>now-21600000);
  const last=sl.length?sl[sl.length-1].pnl:0;
  const cv=$('chartVal'),cl=$('chartLbl');
  cv.textContent=fmtP(last);cv.className=last>=0?'cg':'cr';cv.style.cssText='font-size:28px;font-weight:900;letter-spacing:-1px;margin-bottom:3px';
  cl.textContent=sl.length>1?sl.length+' data points':'No data yet';
  ctx.clearRect(0,0,W,H);
  if(sl.length<2){ctx.fillStyle='rgba(255,255,255,.15)';ctx.font='12px Outfit';ctx.textAlign='center';ctx.fillText('Collecting data...',W/2,H/2);return;}
  const vals=sl.map(p=>p.pnl),mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||1;
  const px=i=>8+(i/(vals.length-1))*(W-16),py=v=>H-8-((v-mn)/rng)*(H-20);
  const col=last>=0?'0,230,118':'255,69,96';
  const g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'rgba('+col+',.25)');g.addColorStop(1,'rgba('+col+',0)');
  ctx.beginPath();ctx.moveTo(px(0),py(vals[0]));
  for(let i=1;i<vals.length;i++){const cx=(px(i-1)+px(i))/2;ctx.bezierCurveTo(cx,py(vals[i-1]),cx,py(vals[i]),px(i),py(vals[i]));}
  ctx.lineTo(px(vals.length-1),H);ctx.lineTo(px(0),H);ctx.closePath();ctx.fillStyle=g;ctx.fill();
  ctx.beginPath();ctx.moveTo(px(0),py(vals[0]));
  for(let i=1;i<vals.length;i++){const cx=(px(i-1)+px(i))/2;ctx.bezierCurveTo(cx,py(vals[i-1]),cx,py(vals[i]),px(i),py(vals[i]));}
  ctx.strokeStyle='rgb('+col+')';ctx.lineWidth=2.5;ctx.stroke();
}
function renderSigs(){
  const el=$('sigList');$('sigCt').textContent=sigs.length;
  if(!sigs.length){el.innerHTML='<div class="empty"><div class="ei">🧠</div>No signals — brain scanning...</div>';return;}
  el.innerHTML=sigs.map(s=>'<div class="item"><div class="ihead"><div class="iname">'+esc(s.title||s.ticker)+'</div><span class="tag '+(s.side==='yes'?'t-yes':'t-no')+'">'+s.side.toUpperCase()+'</span></div><div class="imeta"><span>Mkt '+((s.marketPrice||0)*100).toFixed(0)+'¢</span><span>True '+((s.trueProb||0)*100).toFixed(0)+'¢</span><span class="cg">Edge '+((s.edge||0)*100).toFixed(1)+'%</span>'+(s.limitPrice?'<span>Limit '+s.limitPrice+'¢</span>':'')+'<span class="'+(s.confidence==='high'?'cy':'')+'">'+esc(s.confidence||'')+'</span></div>'+(s.reasoning?'<div class="ireason">'+esc(s.reasoning)+'</div>':'')+'</div>').join('');
}
function renderPos(){
  const el=$('posList');$('posCt').textContent=pos.length;
  if(!pos.length){el.innerHTML='<div class="empty">No open positions</div>';return;}
  el.innerHTML=pos.map(p=>'<div class="item"><div class="ihead"><div class="iname">'+esc(p.title||p.ticker)+'</div><span class="tag '+(p.side==='yes'?'t-yes':'t-no')+'">'+p.side.toUpperCase()+'</span></div><div class="imeta"><span>'+p.qty+'ct @ '+p.ep+'¢</span><span>\$'+((p.size||0).toFixed(2))+'</span><span class="cg">Edge '+((p.edge||0)*100).toFixed(1)+'%</span></div>'+(p.reason?'<div class="ireason">'+esc(p.reason)+'</div>':'')+'</div>').join('');
}
function renderTrades(){
  const el=$('tradeList');$('trCt').textContent=trades.length;
  if(!trades.length){el.innerHTML='<div class="empty"><div class="ei">📊</div>No completed trades</div>';return;}
  el.innerHTML=trades.slice(0,25).map(t=>'<div class="item"><div class="ihead"><div class="iname">'+esc(t.title||t.ticker)+'</div><span class="tag '+(t.won?'t-won':'t-lost')+'">'+(t.won?'WON':'LOST')+'</span></div><div class="imeta"><span>'+(t.side||'').toUpperCase()+' @ '+t.ep+'¢</span><span class="'+(t.pnl>=0?'cg':'cr')+'">'+fmtP(t.pnl)+'</span><span>'+new Date(t.closedAt||'').toLocaleTimeString()+'</span></div></div>').join('');
}
function renderFeed(){
  const el=$('feedList');const sigSet=new Set(sigs.map(s=>s.ticker));let list=[...cands];
  if(feedFilter==='signals')list=list.filter(c=>sigSet.has(c.ticker));
  else if(feedFilter==='rising')list=list.filter(c=>c.mom==='↑');
  else if(feedFilter==='falling')list=list.filter(c=>c.mom==='↓');
  else if(feedFilter==='urgent')list=list.filter(c=>parseFloat(c.hrs)<6);
  if(!list.length){
    const emptyMsg=cands.length===0
      ?'<div class="empty"><div class="ei">📡</div><b>Scanning markets...</b><br>Bot is running — first scan takes up to 30s.<br>Check Brain tab for scan logs.</div>'
      :'<div class="empty"><div class="ei">🔍</div>No markets match "'+feedFilter+'" filter.<br>Try "All" to see '+cands.length+' markets.</div>';
    el.innerHTML=emptyMsg;return;
  }
  el.innerHTML=list.slice(0,18).map(c=>'<div class="item"><div class="ihead"><div class="iname" style="font-size:12px">'+esc(c.title)+'</div><span style="font-size:11px;font-family:var(--m);color:var(--t3)">'+c.yes+'¢ '+c.mom+'</span></div><div class="imeta"><span>Vol '+(c.vol||0).toLocaleString()+'</span><span>'+c.hrs+'h</span><span>'+c.cat+'</span>'+(sigSet.has(c.ticker)?'<span class="cb">SIGNAL</span>':'')+'</div></div>').join('');
}
function renderNotes(){
  const el=$('noteList');$('noteCt').textContent=notes.length;
  if(!notes.length){el.innerHTML='<div class="empty"><div class="ei">💡</div>No learnings yet</div>';return;}
  el.innerHTML=[...notes].reverse().slice(0,20).map(n=>'<div class="note">'+esc(n)+'</div>').join('');
}
function renderLogs(){
  const el=$('logList');if(!logs.length){el.innerHTML='<div class="empty">No logs</div>';return;}
  el.innerHTML=logs.slice(0,80).map(l=>'<div class="logline">'+esc(l)+'</div>').join('');
}
function updateRing(wr,w,l){const circ=207,pct=wr!=null?wr/100:0;$('ringC').setAttribute('stroke-dasharray',(pct*circ).toFixed(1)+' '+circ);$('ringTx').textContent=wr!=null?wr+'%':'—';$('rW').textContent=w;$('rL').textContent=l;}
async function refresh(){
  try{
    const[st,sg,ps,tr,ca,lg,pl,nt]=await Promise.all([fetch('/s').then(r=>r.json()),fetch('/signals').then(r=>r.json()),fetch('/positions').then(r=>r.json()),fetch('/trades').then(r=>r.json()),fetch('/cands').then(r=>r.json()),fetch('/logs').then(r=>r.json()),fetch('/pnl').then(r=>r.json()),fetch('/notes').then(r=>r.json())]);
    D=st;sigs=sg;pos=ps;trades=tr;cands=ca;logs=lg;pnlData=pl;notes=nt;botOn=st.on;
    const mb=$('modeBadge');if(st.on){mb.textContent='RUNNING';mb.className='badge b-on';}else if(st.paper){mb.textContent='PAPER';mb.className='badge b-paper';}else{mb.textContent='LIVE';mb.className='badge b-live';}
    $('haltBox').style.display=st.haltMsg?'block':'none';if(st.haltMsg)$('haltMsg').textContent=st.haltMsg;
    const p=$('heroPnl');p.textContent=fmtP(st.totPnl);p.className='hero-pnl '+(st.totPnl>=0?'cg':'cr');
    $('heroSub').textContent=st.on?'Bot running — scanning every 30s':'Start bot to begin tracking';
    const rb=$('hRealBal');rb.textContent=st.paper?fmtB(st.realBal)+' real':fmtB(st.realBal);rb.className='hs-v';
    const dy=$('hDay');dy.textContent=fmtP(st.dayPnl);dy.className='hs-v '+(st.dayPnl>=0?'cg':'cr');
    const dd=$('hDd');dd.textContent=st.dd.toFixed(1)+'%';dd.className='hs-v '+(st.dd>15?'cr':st.dd>7?'cy':'cg');
    const dep=pos.reduce((a,p)=>a+(p.size||0),0);$('tDeploy').textContent='\$'+dep.toFixed(2);$('tTrades').textContent=st.total;$('tOpen').textContent=st.open;
    const tb=$('toggleBtn'),en=$('engName'),es=$('engSub');
    tb.className='toggle '+(st.on?'on2':'off');en.textContent='AI Trading Engine';
    es.textContent=st.on?('Active — brain #'+st.calls+(st.brainAt?' @ '+new Date(st.brainAt).toLocaleTimeString():'')):'Tap to activate';
    $('gWr').textContent=st.wr!=null?st.wr+'%':'—';$('gWl').textContent=st.wins+' / '+st.losses;$('gScans').textContent=st.on?'120':'0';$('gCalls').textContent=st.calls;
    const sa=$('gSigAge');
    if(st.signalAge===null){sa.textContent='No signals yet';sa.style.color='var(--t3)';}
    else if(st.signalAge<60){sa.textContent=st.signalAge+'s old — fresh ✓';sa.style.color='var(--g)';}
    else if(st.signalAge<180){sa.textContent=Math.round(st.signalAge/60)+'m old';sa.style.color='var(--y)';}
    else{sa.textContent=Math.round(st.signalAge/60)+'m old — stale (waiting for brain)';sa.style.color='var(--r)';}
    const fb=$('feedBadge');if(st.on){fb.textContent='ACTIVE';fb.className='badge b-on';}else{fb.textContent='PAUSED';fb.className='badge b-paper';}
    updateRing(st.wr,st.wins,st.losses);$('rBrain').textContent=st.calls;$('rOpen').textContent=st.open;
    const gr=$('rGross');gr.textContent=fmtP(st.totPnl);gr.className=st.totPnl>=0?'cg':'cr';gr.style.cssText='font-size:17px;font-weight:800';
    drawChart();renderSigs();renderPos();renderTrades();renderFeed();renderNotes();renderLogs();
  }catch(e){console.error('Refresh:',e);}
}
refresh();setInterval(refresh,8000);window.addEventListener('resize',drawChart);
</script></body></html>`);});

// Restart: clears halt state and restarts bot — no redeploy needed
app.post('/restart',(req,res)=>{
  log('Restart requested');
  stopBot();
  S.haltMsg=null;S.authFails=0;
  // Reset peak to current real balance to prevent false drawdown triggers
  S.peak=S.bal;
  save();
  setTimeout(()=>{
    startBot();
    tg('🔄 <b>Bot restarted</b>\nHalt cleared. Balance: $'+realUsd().toFixed(2)+'\nPeak reset to current balance.');
  },1000);
  res.json({ok:true,msg:'Restarting...'});
});

const PORT=process.env.PORT||3000;
app.listen(PORT,async()=>{
  log('══════════════════════════════════════');log('  KALSHI EDGE v8  —  Launch ready.');log('══════════════════════════════════════');
  log(` Mode:  ${C.paper?'PAPER':'⚡ LIVE'} | Kelly:${C.kelly} | Edge:${(C.edgeLive*100).toFixed(0)}%`);
  log(` Stop:  daily -$${C.dailyStop} | drawdown ${(C.ddLimit*100).toFixed(0)}% | max $${C.maxBet}/bet`);
  log(` Cadence: scan ${C.scanSec}s | brain ${C.brainSec}s | heartbeat 30min`);
  log(` TG: ${C.tgTok?'✓':'✗'} | Claude: ${C.claude?'✓':'✗'} | Kalshi: ${C.keyId?'✓':'✗'}`);
  log('══════════════════════════════════════');
  if(C.tgTok&&C.tgChat)await tg('🔧 <b>Kalshi Edge v8</b> — boot test, Telegram connected ✓');
  else log('WARNING: No Telegram — set TELEGRAM_TOKEN + TELEGRAM_CHAT_ID');
  if(!C.keyId||!C.pem){log('STANDBY — add Kalshi credentials and redeploy');await tg('⚠️ <b>Standby</b> — Kalshi credentials missing.');return;}
  const ok=await validate();
  if(!ok){log('STANDBY — fix credentials');return;}
  const checks=[`${C.keyId?'✅':'❌'} Kalshi API key`,`${C.pem.length>50?'✅':'❌'} RSA private key`,`${C.claude?'✅':'❌'} Claude API key`,`${C.tgTok?'✅':'❌'} Telegram token`,`${C.tgChat?'✅':'❌'} Telegram chat ID`,`${!C.paper?'✅':'⚠️'} Live mode ${C.paper?'(PAPER — set DRY_RUN=false to go live)':'(ACTIVE)'}`].join('\n');
  await tg(`🟢 <b>Kalshi Edge v8 — Online</b>\n\nMode: ${C.paper?'📝 Paper':'⚡ LIVE TRADING'}\nReal Kalshi balance: <b>$${realUsd().toFixed(2)}</b>\nKelly: ${C.kelly} | Edge: ${(C.edgeLive*100).toFixed(0)}%\nDaily stop: -$${C.dailyStop} | Drawdown: ${(C.ddLimit*100).toFixed(0)}%\nMax bet: $${C.maxBet} | Max positions: ${C.maxPos}\n\n<b>Checklist:</b>\n${checks}\n\nBot starts in 3 seconds. Heartbeat every 30 min.`);
  log(`Ready. Balance: $${realUsd().toFixed(2)}. Starting in 3s...`);
  setTimeout(startBot,3000);
});
