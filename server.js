// ═══════════════════════════════════════════════════════════════
//  KALSHI EDGE v8-final  —  Complete clean rewrite
//  All fixes consolidated: null-safe dashboard, peak reset,
//  halt cleared on boot, field-flexible scan, brain auto-scan
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
  scanSec:parseInt(process.env.SCAN_SEC||'30'),
  brainSec:parseInt(process.env.BRAIN_SEC||'90'),
};

const SF=(()=>{const v=process.env.RAILWAY_VOLUME_MOUNT_PATH;return v?path.join(v,'ke8.json'):path.join(__dirname,'ke8.json');})();

function fresh(){
  const b=Math.round(C.startBal*100);
  return{on:false,bal:b,paperBal:b,peak:b,dayPnl:0,totPnl:0,wins:0,losses:0,positions:[],trades:[],signals:[],signalTs:0,notes:[],pnlHist:[],cands:[],calls:0,authFails:0,day:'',startedAt:null,scanAt:null,brainAt:null,lastErr:null,haltMsg:null,_ph:{}};
}

let S=fresh();
try{Object.assign(S,JSON.parse(fs.readFileSync(SF,'utf8')));}catch(_){}
if(!S.paperBal)S.paperBal=S.bal;
if(!S.signalTs)S.signalTs=0;
// Always clear stale halt/authFails on fresh boot
S.haltMsg=null;S.authFails=0;S.on=false;

const save=()=>{try{fs.writeFileSync(SF,JSON.stringify(S));}catch(_){}};
const LOGS=[];
const log=msg=>{const l='['+new Date().toISOString()+'] '+msg;console.log(l);LOGS.unshift(l);if(LOGS.length>500)LOGS.length=500;};
const usd=()=>(C.paper?S.paperBal:S.bal)/100;
const realUsd=()=>S.bal/100;
const fmt=n=>(n>=0?'+':'')+'\$'+Math.abs(n).toFixed(2);

function tg(text){
  if(!C.tgTok||!C.tgChat){log('[TG skip] '+text.slice(0,60));return Promise.resolve();}
  log('[TG] '+text.slice(0,80).replace(/\n/g,' '));
  const body=JSON.stringify({chat_id:C.tgChat,text,parse_mode:'HTML'});
  return new Promise(res=>{
    const req=https.request({hostname:'api.telegram.org',path:'/bot'+C.tgTok+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},r=>{
      let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);if(!j.ok)log('[TG] err:'+JSON.stringify(j).slice(0,80));else log('[TG] OK');}catch(_){}res();});
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
  S.authFails=(S.authFails||0)+1;log('Auth fail #'+S.authFails+' ('+status+') '+where);
  if(S.authFails>=3){const m='Auth failed 3x ('+status+'). Check keys + clock.';S.haltMsg=m;stopBot();await tg('🔴 <b>HALTED</b>\n'+m);}
}
const authOk=()=>{S.authFails=0;};

async function validate(){
  log('Validating Kalshi...');
  if(!C.keyId||C.pem.length<50){const m='Missing credentials';log('ABORT: '+m);await tg('🔴 <b>Abort</b>\n'+m);return false;}
  try{
    const r=await kalshi('GET','/portfolio/balance');
    if(r.status===200){
      const b=r.data.balance||0;
      if(b>0){
        S.bal=b;
        S.peak=b; // always reset peak to real balance — prevents false drawdown on boot
        if(!S.paperBal||S.paperBal===Math.round(C.startBal*100))S.paperBal=b;
        log('Peak reset to real balance: $'+(b/100).toFixed(2));
      }
      authOk();log('Auth OK — $'+(S.bal/100).toFixed(2));return true;
    }
    log('Auth failed '+r.status);await tg('🔴 <b>Auth failed ('+r.status+')</b>\nCheck keys and system clock.');return false;
  }catch(e){log('Auth err: '+e.message);await tg('🔴 <b>Connection error</b>\n'+e.message);return false;}
}

async function syncBal(){
  try{
    const r=await kalshi('GET','/portfolio/balance');
    if(r.status===200&&r.data.balance!==undefined){
      const prev=S.bal;S.bal=r.data.balance;S.peak=Math.max(S.peak,S.bal);authOk();
      if(Math.abs(S.bal-prev)>5)log('Bal: $'+(prev/100).toFixed(2)+' → $'+(S.bal/100).toFixed(2));
    }else if(r.status===401||r.status===403)await onAuthFail(r.status,'syncBal');
  }catch(e){log('syncBal: '+e.message);}
}

function breakers(){
  if(S.dayPnl<=-C.dailyStop){const m='Daily loss -$'+Math.abs(S.dayPnl).toFixed(2)+' >= $'+C.dailyStop;log('BREAKER: '+m);S.haltMsg=m;stopBot();tg('⚡ <b>Circuit breaker — Daily loss</b>\n'+m);return false;}
  if(S.peak>0){const dd=(S.peak-S.bal)/S.peak;if(dd>=C.ddLimit){const m='Drawdown '+(dd*100).toFixed(1)+'% from $'+(S.peak/100).toFixed(2);log('BREAKER: '+m);S.haltMsg=m;stopBot();tg('⚡ <b>Circuit breaker — Drawdown</b>\n'+m);return false;}}
  return true;
}

function midnight(){
  const today=new Date().toDateString();if(S.day===today)return;
  log('Midnight reset');S.dayPnl=0;S.day=today;S.haltMsg=null;save();
  tg('🌅 <b>New Day</b>\nReal: $'+realUsd().toFixed(2)+' | All-time: '+fmt(S.totPnl));
}

function kellySz(p,mkt){
  if(mkt<=0||mkt>=1)return 0;
  const b=1/mkt-1,f=Math.max(0,(p*(b+1)-1)/b)*C.kelly;
  return Math.min(f*usd(),C.maxBet,usd()*0.10);
}

async function scan(){
  S.scanAt=new Date().toISOString();
  try{
    const getVol=m=>parseFloat(m.volume_fp||m.volume||'0')||0;
    const getPrice=m=>{
      const raw=m.last_price_dollars||m.last_price||m.yes_ask_dollars||m.yes_bid_dollars||null;
      if(raw==null)return 50;
      const f=parseFloat(raw);
      return f>=0&&f<=1.0?Math.round(f*100):Math.round(f);
    };

    let allMarkets=[];

    // STRATEGY: Use /events endpoint to find active events,
    // then fetch markets for each event individually.
    // This bypasses the KXMV parlay routing issue.
    
    // Step 1: Get active events
    const evRes=await kalshi('GET','/events',{status:'open',limit:'100'});
    if(evRes.status===401||evRes.status===403){await onAuthFail(evRes.status,'scan-events');return;}
    
    if(evRes.status===200){
      authOk();
      const events=evRes.data.events||[];
      log('Events: '+events.length+' active events found');
      
      // Log first few event tickers to understand structure
      events.slice(0,5).forEach((e,i)=>log('EVENT'+i+': '+e.event_ticker+' "'+String(e.title||'').slice(0,40)+'"'));
      
      // Filter out KXMV composite events, keep individual game/market events
      const goodEvents=events.filter(e=>{
        const t=e.event_ticker||'';
        return !t.startsWith('KXMVESPORTSMULTIGAME');
      });
      log('Good events (non-composite): '+goodEvents.length);
      
      // Fetch markets for top events (limit to first 20 to avoid rate limits)
      const toFetch=goodEvents.slice(0,20);
      for(const ev of toFetch){
        try{
          const mRes=await kalshi('GET','/markets',{event_ticker:ev.event_ticker,status:'open',limit:'50'});
          if(mRes.status===200){
            const mkts=mRes.data.markets||[];
            allMarkets.push(...mkts);
          }
          await new Promise(r=>setTimeout(r,100)); // small delay between requests
        }catch(_){}
      }
      log('Markets from events: '+allMarkets.length);
    }
    
    // Step 2: Also try /markets with order_by volume as fallback
    const volRes=await kalshi('GET','/markets',{status:'open',limit:'200',order_by:'volume'});
    if(volRes.status===200){
      const existing=new Set(allMarkets.map(m=>m.ticker||m.ticker_name||''));
      const newOnes=(volRes.data.markets||[]).filter(m=>{
        const t=m.ticker||m.ticker_name||'';
        return t&&!existing.has(t);
      });
      allMarkets.push(...newOnes);
      log('Added '+newOnes.length+' more from volume-sorted fetch');
    }

    // Deduplicate
    const seen=new Set();
    allMarkets=allMarkets.filter(m=>{
      const t=m.ticker||m.ticker_name||'';
      if(!t||seen.has(t))return false;
      seen.add(t);return true;
    });

    log('TOTAL MARKETS: '+allMarkets.length);
    
    // Volume distribution
    const withVol=allMarkets.filter(m=>getVol(m)>0).length;
    log('With volume>0: '+withVol);
    
    // Top 5 by volume
    const byVol=[...allMarkets].sort((a,b)=>getVol(b)-getVol(a)).slice(0,5);
    byVol.forEach((m,i)=>{
      const t=m.ticker||m.ticker_name||'?';
      log('VOL'+i+': $'+getVol(m).toFixed(0)+' '+t.slice(0,35)+' price='+getPrice(m)+'¢');
    });

    const held=new Set(S.positions.map(p=>p.ticker));
    const now=Date.now();

    // Filter for tradeable markets
    const scored=allMarkets.filter(m=>{
      const ticker=m.ticker||m.ticker_name||'';
      if(!ticker||held.has(ticker))return false;
      // Skip multivariate composites
      if(ticker.startsWith('KXMVESPORTSMULTIGAME'))return false;
      // Require volume
      if(getVol(m)<100)return false;
      // Time window
      const closeRaw=m.close_time||m.expiration_time||null;
      if(!closeRaw)return false;
      const closeMs=new Date(closeRaw).getTime();
      if(isNaN(closeMs)||closeMs<=now)return false;
      const hrs=(closeMs-now)/3.6e6;
      if(hrs<0.1||hrs>720)return false;
      // Price sanity
      const y=getPrice(m);
      return y>=2&&y<=98;
    }).map(m=>{
      const ticker=m.ticker||m.ticker_name;
      const y=getPrice(m);
      const closeMs=new Date(m.close_time||m.expiration_time).getTime();
      const hrs=((closeMs-now)/3.6e6).toFixed(1);
      const vol=getVol(m);
      const ph=S._ph[ticker]||[],prev=ph.length?ph[ph.length-1]:y,mom=y>prev+2?'↑':y<prev-2?'↓':'→';
      S._ph[ticker]=ph.slice(-19).concat([y]);
      const raw=m.title||m.yes_sub_title||ticker;
      const title=raw.length>65?raw.slice(0,62)+'…':raw;
      const score=(1-Math.abs(y-50)/50)*0.35+Math.min(vol/500000,1)*0.4+Math.max(0,1-parseFloat(hrs)/48)*0.25;
      return{ticker,title,yes:y,no:100-y,vol,hrs,cat:m.event_ticker||m.category||'market',mom,score};
    });

    scored.sort((a,b)=>b.score-a.score);
    S.cands=scored.slice(0,25);
    log('Candidates: '+S.cands.length+' liquid non-composite markets');
    if(S.cands.length>0){
      const t=S.cands[0];
      log('Best: "'+t.title+'" yes='+t.yes+'¢ vol=$'+t.vol+' '+t.hrs+'h');
    }
  }catch(e){log('Scan err: '+e.message);S.lastErr=e.message;}
}


async function brain(){
  if(!C.claude){log('No Claude key — add CLAUDE_API_KEY env var');return;}
  if(!S.cands.length){
    log('No candidates — running scan first...');
    await scan();
    if(!S.cands.length){log('Still no candidates — skipping brain');return;}
  }
  S.brainAt=new Date().toISOString();S.calls++;
  const edgeMin=C.paper?C.edgePaper:C.edgeLive;
  const held=S.positions.map(p=>p.ticker+'('+p.side+'@'+p.ep+'¢)').join(', ')||'none';
  const mem=S.notes.slice(-8).join('\n')||'No prior learnings.';
  const tot=S.wins+S.losses,wr=tot>0?((S.wins/tot)*100).toFixed(0)+'%':'no trades yet';
  const mkts=S.cands.map((c,i)=>(i+1)+'. ['+c.ticker+'] "'+c.title+'"\n   YES:'+c.yes+'¢ NO:'+c.no+'¢ | Vol:'+c.vol+' | '+c.hrs+'h | '+c.cat+' | '+c.mom).join('\n\n');

  const system=`You are Kalshi Edge — an elite autonomous AI prediction market trader.
MISSION: Double the portfolio ($${usd().toFixed(2)}) as fast as safely possible.

STATE: ${C.paper?'PAPER':'⚡ LIVE'} | Real: $${realUsd().toFixed(2)} | Today: ${fmt(S.dayPnl)} | All-time: ${fmt(S.totPnl)} | Win rate: ${wr}
Open (${S.positions.length}/${C.maxPos}): ${held}
Brain cycle #${S.calls}

MEMORY:
${mem}

THREE EDGES (priority order):
1. NEWS LAG — Search for breaking news <30min not yet priced in
2. FAVOURITE-LONGSHOT BIAS — YES >80¢ underpriced; YES <15¢ overpriced
3. RESOLUTION CERTAINTY — Outcome clear, market hasn't repriced yet

SEARCH: "[topic] latest news today" | Official sources | Note timestamps

RULES:
✓ Search before every signal — no evidence = no signal
✓ Edge min: ${(edgeMin*100).toFixed(0)}%
✓ HIGH confidence = specific timestamped evidence found today
✓ MEDIUM = strong reasoning, solid indirect evidence
✓ Limit price = market price minus 2¢ (maker, zero fees)
✓ SKIP vol=0 markets — no liquidity
✓ PREFER: Fed/rates, elections, economic data, crypto, single-event markets with REAL VOLUME
✓ TODAY IS HIGH EDGE: F-15/Iran war news, jobs beat, oil surge — look for matching markets
✓ If all 25 markets have vol=0, still note the major news events in your note for when liquid markets appear
✓ No duplicate topics

RETURN ONLY valid JSON — no markdown, no fences, nothing else:
{"signals":[{"ticker":"...","title":"...","side":"yes|no","marketPrice":0.XX,"trueProb":0.XX,"edge":0.XX,"confidence":"high|medium","limitPrice":XX,"reasoning":"Specific evidence: [source] [fact] [time]"}],"note":"one concrete learning"}`;

  const user='TIME: '+new Date().toISOString()+' | CYCLE #'+S.calls+'\n\nMARKETS:\n'+mkts+'\n\nSearch → signal where edge >= '+(edgeMin*100).toFixed(0)+'% → note. Go.';

  try{
    const body=JSON.stringify({model:C.model,max_tokens:2000,system,tools:[{type:'web_search_20250305',name:'web_search'}],messages:[{role:'user',content:user}]});
    const r=await post('https://api.anthropic.com/v1/messages',body,{'Content-Type':'application/json','x-api-key':C.claude,'anthropic-version':'2023-06-01','anthropic-beta':'web-search-2025-03-05'});
    if(r.status!==200){log('Claude '+r.status+': '+JSON.stringify(r.data).slice(0,150));S.lastErr='Claude '+r.status+': '+JSON.stringify(r.data).slice(0,80);return;}
    const text=(r.data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    if(!text){log('Brain: no text');return;}
    const s=text.indexOf('{'),e=text.lastIndexOf('}');if(s<0||e<0){log('Brain: no JSON');return;}
    let parsed;try{parsed=JSON.parse(text.slice(s,e+1));}catch(err){log('Brain parse: '+err.message);return;}
    if(parsed.note){S.notes.push('['+new Date().toISOString().slice(0,16)+'] '+parsed.note);if(S.notes.length>50)S.notes.shift();}
    S.signalTs=Date.now();
    S.signals=(parsed.signals||[]).filter(sig=>{
      if(!sig.ticker||!sig.side||typeof sig.edge!=='number')return false;
      if(sig.edge<edgeMin){log('Skip '+sig.ticker+': edge '+(sig.edge*100).toFixed(1)+'%<min');return false;}
      if(!['yes','no'].includes(sig.side))return false;
      if(sig.confidence==='low')return false;return true;
    });
    log('Brain #'+S.calls+': '+S.signals.length+' signal(s) | '+(parsed.note||'').slice(0,60));
    if(S.signals.length){
      const lines=S.signals.map(sig=>'• '+sig.ticker+' '+sig.side.toUpperCase()+' — '+(sig.edge*100).toFixed(1)+'% ('+sig.confidence+')\n  '+(sig.reasoning||'')).join('\n');
      await tg('🧠 <b>Brain #'+S.calls+' — '+S.signals.length+' signal(s)</b>\n\n'+lines);
    }
  }catch(e){log('Brain err: '+e.message);S.lastErr=e.message;}
}

async function execute(){
  if(!S.signals.length||S.positions.length>=C.maxPos||!breakers())return;
  const age=S.signalTs?(Date.now()-S.signalTs)/1000:999;
  if(age>180){log('Signals stale ('+age.toFixed(0)+'s)');return;}
  for(const sig of S.signals){
    if(S.positions.length>=C.maxPos||!breakers())break;
    if(S.positions.find(p=>p.ticker===sig.ticker))continue;
    const mktP=sig.marketPrice||0.5,sizeDol=kellySz(sig.trueProb||0.55,mktP);
    if(sizeDol<0.50){log(sig.ticker+': $'+sizeDol.toFixed(2)+' too small');continue;}
    const lp=sig.limitPrice||Math.round(mktP*100);
    const qty=Math.max(1,Math.floor((sizeDol*100)/lp));
    const cost=(qty*lp)/100;
    if(C.paper){
      const pos={id:crypto.randomUUID(),ticker:sig.ticker,title:sig.title||sig.ticker,side:sig.side,qty,ep:lp,size:cost,edge:sig.edge,reason:sig.reasoning||'',at:new Date().toISOString()};
      S.positions.push(pos);S.paperBal-=Math.round(cost*100);S.dayPnl-=cost;
      log('[PAPER] '+sig.side.toUpperCase()+' '+sig.ticker+' '+qty+'ct @'+lp+'¢ $'+cost.toFixed(2));
      await tg('📝 <b>Paper Trade</b>\n'+sig.side.toUpperCase()+' '+sig.ticker+'\n'+qty+'ct @ '+lp+'¢ = $'+cost.toFixed(2)+'\nEdge: '+(sig.edge*100).toFixed(1)+'% | '+sig.confidence+'\nPaper bal: $'+(S.paperBal/100).toFixed(2)+'\n'+(sig.reasoning||''));
    }else{
      try{
        const ob={ticker:sig.ticker,action:'buy',type:'limit',side:sig.side,count:qty,yes_price:sig.side==='yes'?lp:100-lp,no_price:sig.side==='no'?lp:100-lp,client_order_id:crypto.randomUUID()};
        const r=await kalshi('POST','/portfolio/orders',ob);
        if(r.status===200||r.status===201){
          authOk();const order=r.data.order||r.data;
          S.positions.push({id:order.order_id||crypto.randomUUID(),ticker:sig.ticker,title:sig.title||sig.ticker,side:sig.side,qty,ep:lp,size:cost,edge:sig.edge,reason:sig.reasoning||'',at:new Date().toISOString(),orderId:order.order_id});
          log('[LIVE] '+sig.side.toUpperCase()+' '+sig.ticker+' '+qty+'ct @'+lp+'¢');
          await tg('⚡ <b>LIVE Order Placed</b>\n'+sig.side.toUpperCase()+' '+sig.ticker+'\n'+qty+'ct @ '+lp+'¢ = $'+cost.toFixed(2)+'\nEdge: '+(sig.edge*100).toFixed(1)+'% | '+sig.confidence+'\nBalance: $'+realUsd().toFixed(2)+'\n'+(sig.reasoning||''));
        }else if(r.status===401||r.status===403){await onAuthFail(r.status,'order '+sig.ticker);break;}
        else{log('Rejected '+r.status+': '+JSON.stringify(r.data).slice(0,100));await tg('⚠️ <b>Order Rejected</b> '+sig.ticker+'\n'+r.status+': '+JSON.stringify(r.data).slice(0,80));}
      }catch(e){log('Order err '+sig.ticker+': '+e.message);}
    }
    await new Promise(r=>setTimeout(r,400));
  }
  save();
}

async function monitor(){
  await syncBal();
  if(!S.positions.length)return;
  if(C.paper)return;
  try{
    const r=await kalshi('GET','/portfolio/positions');
    if(r.status===401||r.status===403){await onAuthFail(r.status,'monitor');return;}
    if(r.status!==200){log('Monitor '+r.status);return;}
    authOk();
    const liveMap={};for(const p of(r.data.market_positions||[]))liveMap[p.ticker_name]=p;
    for(const pos of[...S.positions]){
      const lp=liveMap[pos.ticker];
      if(!lp||lp.position===0){
        let pnl=-pos.size;
        try{const fills=await kalshi('GET','/portfolio/fills',{ticker:pos.ticker,limit:'5'});if(fills.status===200&&fills.data.fills?.length){const fp=fills.data.fills.reduce((a,f)=>a+(f.profit_loss||0),0);if(fp!==0)pnl=fp/100;}}catch(_){}
        if(lp&&lp.realized_pnl!=null&&lp.realized_pnl!==0)pnl=lp.realized_pnl/100;
        S.positions=S.positions.filter(p=>p.id!==pos.id);
        S.totPnl+=pnl;S.dayPnl+=pnl;
        if(pnl>0)S.wins++;else S.losses++;
        S.trades.unshift({...pos,closedAt:new Date().toISOString(),pnl,won:pnl>0});
        if(S.trades.length>100)S.trades.length=100;
        const tot=S.wins+S.losses,wr=tot>0?((S.wins/tot)*100).toFixed(0)+'%':'—';
        log('Settled '+pos.ticker+': '+fmt(pnl)+' | total: '+fmt(S.totPnl));
        await tg((pnl>0?'✅':'❌')+' <b>Trade Settled: '+pos.ticker+'</b>\n'+pos.side.toUpperCase()+' '+pos.qty+'ct @ '+pos.ep+'¢\nP&L: <b>'+fmt(pnl)+'</b>\nAll-time: '+fmt(S.totPnl)+' | Win rate: '+wr+'\nBalance: $'+realUsd().toFixed(2));
      }
    }
    save();
  }catch(e){log('Monitor err: '+e.message);}
}

let _sc,_br,_hb;
function startBot(){
  if(S.on)return;S.on=true;S.haltMsg=null;S.startedAt=new Date().toISOString();
  log('Bot started — '+(C.paper?'PAPER':'LIVE'));
  scan().then(()=>{syncBal();log('Initial scan: '+S.cands.length+' candidates');});
  _sc=setInterval(async()=>{
    midnight();await syncBal();await scan();await monitor();
    if(breakers())await execute();
    S.pnlHist.push({ts:Date.now(),bal:usd(),pnl:S.totPnl});
    if(S.pnlHist.length>600)S.pnlHist.shift();
    save();
  },C.scanSec*1000);
  _br=setTimeout(()=>{brain();_br=setInterval(brain,C.brainSec*1000);},20000);
  _hb=setInterval(()=>{
    const w=S.wins,l=S.losses,tot=w+l,wr=tot>0?((w/tot)*100).toFixed(0)+'%':'—';
    const dd=S.peak>0?((S.peak-S.bal)/S.peak*100).toFixed(1):'0.0';
    const age=S.signalTs?Math.round((Date.now()-S.signalTs)/60000)+'min':'none';
    tg('📊 <b>Heartbeat</b>\nMode: '+(C.paper?'📝 Paper':'⚡ LIVE')+'\nReal: $'+realUsd().toFixed(2)+(C.paper?' | Sim: $'+(S.paperBal/100).toFixed(2):'')+'\nToday: '+fmt(S.dayPnl)+' | All-time: '+fmt(S.totPnl)+'\nWin: '+wr+' ('+w+'W/'+l+'L) | Open: '+S.positions.length+'/'+C.maxPos+'\nBrain: #'+S.calls+' | Drawdown: '+dd+'% | Sig age: '+age);
  },30*60*1000);
  save();
}
function stopBot(){S.on=false;clearInterval(_sc);clearTimeout(_br);clearInterval(_br);clearInterval(_hb);_sc=_br=_hb=null;log('Bot stopped');save();}

// ─── API ─────────────────────────────────────────────────────────
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
app.get('/health',(_,res)=>res.json({ok:true,v:'8-final',uptime:process.uptime(),cands:S.cands.length,calls:S.calls,on:S.on}));
app.post('/start',(_,res)=>{startBot();res.json({ok:true});});
app.post('/stop',(_,res)=>{stopBot();res.json({ok:true});});
app.post('/scan',async(_,res)=>{await scan();res.json({ok:true,count:S.cands.length});});
app.post('/brain',async(_,res)=>{await brain();res.json({ok:true,signals:S.signals.length});});
app.post('/restart',(_,res)=>{stopBot();S.haltMsg=null;S.authFails=0;S.peak=S.bal;save();setTimeout(()=>{startBot();tg('🔄 <b>Bot restarted</b>\nBalance: $'+realUsd().toFixed(2));},1000);res.json({ok:true});});
app.get('/test',async(_,res)=>{const ok=await validate();res.json({ok,realBal:realUsd()});});
app.get('/debug',async(_,res)=>{
  try{
    const [mRes,eRes]=await Promise.all([
      kalshi('GET','/markets',{status:'open',limit:'5'}),
      kalshi('GET','/events',{status:'open',limit:'10'}),
    ]);
    const m=mRes.data.markets||[];
    const e=eRes.data.events||[];
    const withVol=m.filter(x=>parseFloat(x.volume_fp||'0')>0).length;
    res.json({
      marketsStatus:mRes.status,marketCount:m.length,withVol,
      eventsStatus:eRes.status,eventCount:e.length,
      eventSamples:e.slice(0,5).map(x=>({ticker:x.event_ticker,title:String(x.title||'').slice(0,40)})),
      marketSample:m.slice(0,1),
      cands:S.cands.length,calls:S.calls,
      lastErr:S.lastErr?S.lastErr.slice(0,100):null
    });
  }catch(e){res.json({error:e.message});}
});
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
  tg((pnl>0?'✅':'❌')+' <b>Settled: '+p.ticker+'</b>\n'+fmt(pnl)+' | All-time: '+fmt(S.totPnl));
  res.json({ok:true,pnl,totPnl:S.totPnl});
});
app.post('/reset',(_,res)=>{stopBot();S=fresh();save();res.json({ok:true});});

// ─── DASHBOARD ────────────────────────────────────────────────────
app.get('/',(_,res)=>{res.setHeader('Content-Type','text/html');res.send(DASH());});

function DASH(){return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#06060f"><title>Kalshi Edge</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{--bg:#06060f;--l1:#0c0c1a;--l2:#11111f;--l3:#171728;--l4:#1e1e30;--bd:rgba(255,255,255,.06);--bd2:rgba(255,255,255,.11);--t1:#f0f0ff;--t2:#8080a8;--t3:#404060;--g:#00e676;--ga:rgba(0,230,118,.12);--r:#ff4560;--ra:rgba(255,69,96,.11);--b:#4488ff;--y:#ffb020;--ya:rgba(255,176,32,.11);--f:'Outfit',sans-serif;--m:'JetBrains Mono',monospace;--st:env(safe-area-inset-top,0px);--sb:env(safe-area-inset-bottom,0px)}
html,body{height:100%;background:var(--bg);color:var(--t1);font-family:var(--f);-webkit-font-smoothing:antialiased;overflow:hidden}
.app{display:flex;flex-direction:column;height:100%;padding-top:var(--st)}
.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 8px;flex-shrink:0}
.lr{display:flex;align-items:center;gap:10px}
.logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#00e676,#4488ff);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:12px;color:#000}
.an{font-size:20px;font-weight:800;letter-spacing:-.5px}
.badge{font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;padding:4px 11px;border-radius:20px;border:1px solid}
.bp{background:var(--ya);border-color:var(--y);color:var(--y)}.bl{background:var(--ra);border-color:var(--r);color:var(--r)}.bon{background:var(--ga);border-color:var(--g);color:var(--g)}
.tabs{display:flex;padding:0 14px 8px;gap:4px;flex-shrink:0;overflow-x:auto}.tabs::-webkit-scrollbar{display:none}
.tab{border:none;background:var(--l2);color:var(--t3);font-family:var(--f);font-size:12px;font-weight:700;padding:8px 16px;border-radius:20px;cursor:pointer;white-space:nowrap;transition:all .15s}
.tab.on{background:var(--l4);color:var(--t1);border:1px solid var(--bd2)}
.scroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 14px calc(68px + var(--sb)) 14px}.scroll::-webkit-scrollbar{display:none}
.panel{display:none}.panel.on{display:block}
.ph{margin-bottom:16px}.ph h1{font-size:26px;font-weight:900;letter-spacing:-.7px}.ph p{font-size:12px;color:var(--t2);margin-top:3px}
.halt{background:var(--ra);border:1px solid var(--r);border-radius:14px;padding:12px 15px;margin-bottom:12px;display:none}
.halt strong{display:block;color:var(--r);font-size:13px;font-weight:700;margin-bottom:2px}.halt span{color:var(--r);font-size:12px;opacity:.85}
.hero{background:var(--l1);border:1px solid var(--bd);border-radius:22px;padding:20px 18px 16px;margin-bottom:10px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-50px;right:-50px;width:150px;height:150px;background:radial-gradient(circle,rgba(0,230,118,.07),transparent 65%);border-radius:50%;pointer-events:none}
.hl{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--t3);margin-bottom:6px}
.hp{font-size:44px;font-weight:900;letter-spacing:-2px;line-height:1;margin-bottom:5px}
.hsub{font-size:12px;color:var(--t2);margin-bottom:16px}
.hsr{display:flex;border-top:1px solid var(--bd);padding-top:14px}
.hs{flex:1;display:flex;flex-direction:column;gap:3px}.hs+.hs{border-left:1px solid var(--bd);padding-left:14px}
.hsl{font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3)}.hsv{font-size:14px;font-weight:700;letter-spacing:-.3px}
.tri{display:flex;background:var(--l2);border:1px solid var(--bd);border-radius:16px;overflow:hidden;margin-bottom:10px}
.ts{flex:1;padding:12px;text-align:center;display:flex;flex-direction:column;gap:3px}.ts+.ts{border-left:1px solid var(--bd)}
.tl{font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3)}.tv{font-size:17px;font-weight:800;letter-spacing:-.4px}
.eng{background:var(--l2);border:1px solid var(--bd);border-radius:18px;padding:14px 16px;display:flex;align-items:center;gap:12px;margin-bottom:10px}
.ei2{width:46px;height:46px;border-radius:13px;background:linear-gradient(135deg,rgba(0,230,118,.18),rgba(68,136,255,.18));display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.en{flex:1}.enn{font-size:15px;font-weight:700}.ens{font-size:11px;color:var(--t2);margin-top:2px}
.tgl{width:48px;height:27px;border-radius:14px;border:none;cursor:pointer;transition:background .2s;position:relative;flex-shrink:0}
.tgl::after{content:'';position:absolute;top:3px;width:21px;height:21px;border-radius:11px;background:#fff;transition:left .2s}
.tgl.off{background:var(--l4)}.tgl.off::after{left:3px}.tgl.on2{background:var(--g)}.tgl.on2::after{left:24px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.sc{background:var(--l2);border:1px solid var(--bd);border-radius:14px;padding:13px}
.scl{font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3);margin-bottom:5px}.scv{font-size:20px;font-weight:800;letter-spacing:-.5px}
.sf{grid-column:span 2;background:var(--l2);border:1px solid var(--bd);border-radius:14px;padding:13px}
.sec{background:var(--l1);border:1px solid var(--bd);border-radius:18px;padding:16px;margin-bottom:10px}
.sech{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.sect{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--t3)}
.secc{font-size:10px;font-weight:700;background:var(--l3);color:var(--t2);padding:3px 8px;border-radius:7px}
.chb{height:140px;position:relative}
.tf{display:flex;gap:6px;margin-bottom:12px}
.tfb{border:1px solid var(--bd);background:none;color:var(--t3);border-radius:20px;padding:5px 12px;font-family:var(--f);font-size:12px;font-weight:700;cursor:pointer}
.tfb.on{background:var(--l3);color:var(--t1);border-color:var(--bd2)}
.rw{display:flex;align-items:center;gap:18px;margin-bottom:12px}
.rrs{flex:1;display:flex;flex-direction:column;gap:7px}
.rr{display:flex;justify-content:space-between;font-size:13px}.rrl{color:var(--t2)}
.gr{display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid var(--bd)}
.item{background:var(--l3);border-radius:13px;padding:12px 13px;margin-bottom:7px}
.item:last-child{margin-bottom:0}
.ih{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:5px}
.in{font-size:13px;font-weight:600;flex:1;line-height:1.3}
.im{display:flex;flex-wrap:wrap;gap:5px;font-size:10px;font-family:var(--m);color:var(--t3)}
.im span{background:var(--l4);padding:2px 6px;border-radius:5px}
.ir{font-size:11px;color:var(--t2);margin-top:6px;line-height:1.5;border-left:2px solid var(--bd2);padding-left:8px;font-style:italic}
.tag{font-size:9px;font-weight:700;text-transform:uppercase;padding:3px 8px;border-radius:6px;flex-shrink:0;letter-spacing:.5px}
.ty{background:var(--ga);color:var(--g)}.tn{background:var(--ra);color:var(--r)}.tw{background:var(--ga);color:var(--g)}.tls{background:var(--ra);color:var(--r)}
.chips{display:flex;gap:6px;margin-bottom:12px;overflow-x:auto;padding-bottom:2px}.chips::-webkit-scrollbar{display:none}
.chip{border:1px solid var(--bd);background:none;color:var(--t3);border-radius:20px;padding:5px 12px;font-family:var(--f);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}
.chip.on{background:var(--b);border-color:var(--b);color:#fff}
.btns{display:flex;gap:7px;margin-bottom:10px}
.btn{flex:1;border:1px solid var(--bd2);background:var(--l3);color:var(--t1);border-radius:13px;padding:12px 6px;font-family:var(--f);font-size:12px;font-weight:700;cursor:pointer}
.btn:active{transform:scale(.97)}.btg{background:var(--ga);border-color:var(--g);color:var(--g)}.btr{background:var(--ra);border-color:var(--r);color:var(--r)}
.ll{font-size:10px;font-family:var(--m);color:var(--t3);padding:3px 0;border-bottom:1px solid var(--bd);line-height:1.4;word-break:break-all}
.ll:last-child{border:none}
.nt{font-size:11px;color:var(--t2);padding:6px 0;border-bottom:1px solid var(--bd);line-height:1.5}.nt:last-child{border:none}
.empty{text-align:center;color:var(--t3);font-size:12px;padding:24px 0;line-height:1.6}
.ei{font-size:28px;margin-bottom:6px}
.cg{color:var(--g)}.cr{color:var(--r)}.cy{color:var(--y)}.cb{color:var(--b)}
.nb{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 4px;background:none;border:none;color:var(--t3);font-family:var(--f);font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;cursor:pointer}
.nb svg{width:21px;height:21px;stroke:currentColor;fill:none;stroke-width:1.8}.nb.on{color:var(--g)}
.bnav{display:flex;background:var(--l1);border-top:1px solid var(--bd);padding-bottom:var(--sb);flex-shrink:0}
</style>
</head><body>
<div class="app">
<div class="hdr">
  <div class="lr"><div class="logo">KE</div><span class="an">Kalshi Edge</span></div>
  <span class="badge bp" id="MB">PAPER</span>
</div>
<div class="tabs">
  <button class="tab on" onclick="gT(0,this)">Home</button>
  <button class="tab" onclick="gT(1,this)">Charts</button>
  <button class="tab" onclick="gT(2,this)">Feed</button>
  <button class="tab" onclick="gT(3,this)">Signals</button>
  <button class="tab" onclick="gT(4,this)">Brain</button>
</div>
<div class="scroll">

<div class="panel on" id="P0">
  <div class="halt" id="HB"><strong>⚡ Halted</strong><span id="HM"></span></div>
  <div class="hero">
    <div class="hl">Total Profit / Loss</div>
    <div class="hp cg" id="HP">+\$0.00</div>
    <div class="hsub" id="HS">Start bot to begin tracking</div>
    <div class="hsr">
      <div class="hs"><div class="hsl">Real Balance</div><div class="hsv" id="HRB">—</div></div>
      <div class="hs"><div class="hsl">Today P&L</div><div class="hsv" id="HD">—</div></div>
      <div class="hs"><div class="hsl">Drawdown</div><div class="hsv" id="HDD">—</div></div>
    </div>
  </div>
  <div class="tri">
    <div class="ts"><div class="tl">Deployed</div><div class="tv" id="TD">\$0</div></div>
    <div class="ts"><div class="tl">Trades</div><div class="tv" id="TT">0</div></div>
    <div class="ts"><div class="tl">Open</div><div class="tv" id="TO">0</div></div>
  </div>
  <div class="eng">
    <div class="ei2">⚡</div>
    <div class="en"><div class="enn">AI Trading Engine</div><div class="ens" id="ES">Tap to activate</div></div>
    <button class="tgl off" id="TB" onclick="toggleBot()"></button>
  </div>
  <div class="g2">
    <div class="sc"><div class="scl">Win Rate</div><div class="scv" id="GWR">—</div></div>
    <div class="sc"><div class="scl">W / L</div><div class="scv" id="GWL">—</div></div>
    <div class="sc"><div class="scl">Scans/hr</div><div class="scv" id="GSC">—</div></div>
    <div class="sc"><div class="scl">Brain calls</div><div class="scv" id="GCC">—</div></div>
    <div class="sf"><div class="scl">Signal Freshness</div><div class="scv" style="font-size:13px" id="GSA">—</div></div>
  </div>
</div>

<div class="panel" id="P1">
  <div class="ph"><h1>Analytics</h1><p>Session performance</p></div>
  <div class="sec">
    <div class="sech"><span class="sect">Equity Curve</span></div>
    <div class="tf">
      <button class="tfb on" onclick="sTf('1h',this)">1H</button>
      <button class="tfb" onclick="sTf('6h',this)">6H</button>
      <button class="tfb" onclick="sTf('all',this)">ALL</button>
    </div>
    <div style="font-size:26px;font-weight:900;letter-spacing:-1px;margin-bottom:3px" id="CV">+\$0.00</div>
    <div style="font-size:11px;color:var(--t3);margin-bottom:12px" id="CL">No data yet</div>
    <div class="chb"><canvas id="cvs" height="140"></canvas></div>
  </div>
  <div class="sec">
    <div class="sech"><span class="sect">Performance</span></div>
    <div class="rw">
      <svg width="80" height="80" viewBox="0 0 80 80" style="flex-shrink:0">
        <circle cx="40" cy="40" r="31" fill="none" stroke="var(--l3)" stroke-width="8"/>
        <circle id="RC" cx="40" cy="40" r="31" fill="none" stroke="var(--g)" stroke-width="8"
          stroke-dasharray="0 195" stroke-linecap="round" transform="rotate(-90 40 40)"/>
        <text x="40" y="45" text-anchor="middle" font-size="11" font-weight="800" fill="var(--t1)" font-family="Outfit,sans-serif" id="RT">—</text>
      </svg>
      <div class="rrs">
        <div class="rr"><span class="rrl">Wins</span><span class="cg" id="RW">0</span></div>
        <div class="rr"><span class="rrl">Losses</span><span class="cr" id="RL">0</span></div>
        <div class="rr"><span class="rrl">Brain cycles</span><span id="RB">0</span></div>
        <div class="rr"><span class="rrl">Open positions</span><span id="RO">0</span></div>
      </div>
    </div>
    <div class="gr"><span style="color:var(--t2);font-size:13px">Gross P&L</span><span style="font-size:17px;font-weight:800" id="RG">+\$0.00</span></div>
  </div>
  <div class="sec">
    <div class="sech"><span class="sect">Recent Trades</span><span class="secc" id="TRC">0</span></div>
    <div id="TRL"><div class="empty"><div class="ei">📊</div>No trades</div></div>
  </div>
</div>

<div class="panel" id="P2">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px">
    <div><div style="font-size:24px;font-weight:900;letter-spacing:-.7px">Live Feed</div><div style="font-size:12px;color:var(--t2);margin-top:3px">Monitoring markets</div></div>
    <span class="badge bp" id="FB" style="margin-top:6px">PAUSED</span>
  </div>
  <div class="chips">
    <button class="chip on" onclick="sF('all',this)">All</button>
    <button class="chip" onclick="sF('signals',this)">Signals</button>
    <button class="chip" onclick="sF('rising',this)">Rising ↑</button>
    <button class="chip" onclick="sF('falling',this)">Falling ↓</button>
    <button class="chip" onclick="sF('urgent',this)">Urgent &lt;6h</button>
  </div>
  <div id="FL"><div class="empty"><div class="ei">📡</div><b>Feed is empty</b><br>Enable bot on Home.</div></div>
</div>

<div class="panel" id="P3">
  <div class="ph"><h1>Signals</h1><p>Claude AI analysis</p></div>
  <div class="sec">
    <div class="sech"><span class="sect">Live Signals</span><span class="secc" id="SIC">0</span></div>
    <div id="SIL"><div class="empty"><div class="ei">🧠</div>Waiting for brain...</div></div>
  </div>
  <div class="sec">
    <div class="sech"><span class="sect">Open Positions</span><span class="secc" id="POC">0</span></div>
    <div id="POL"><div class="empty">No open positions</div></div>
  </div>
  <div class="btns">
    <button class="btn btg" onclick="dP('/start')">Start Bot</button>
    <button class="btn btr" onclick="dP('/stop')">Stop</button>
    <button class="btn" onclick="dP('/restart')">↺ Restart</button>
  </div>
  <div class="btns">
    <button class="btn" onclick="dP('/brain')">Force Brain</button>
    <button class="btn" onclick="dP('/scan')">Force Scan</button>
  </div>
</div>

<div class="panel" id="P4">
  <div class="ph"><h1>Brain</h1><p>Memory &amp; system log</p></div>
  <div class="sec">
    <div class="sech"><span class="sect">Learnings</span><span class="secc" id="NTC">0</span></div>
    <div id="NTL"><div class="empty"><div class="ei">💡</div>No learnings yet</div></div>
  </div>
  <div class="sec">
    <div class="sech"><span class="sect">System Log</span></div>
    <div id="LOG"><div class="empty">Starting...</div></div>
  </div>
</div>

</div>
<nav class="bnav">
  <button class="nb on" onclick="gT(0,this)"><svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Home</button>
  <button class="nb" onclick="gT(1,this)"><svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Charts</button>
  <button class="nb" onclick="gT(2,this)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48 0a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/></svg>Feed</button>
  <button class="nb" onclick="gT(3,this)"><svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Signals</button>
  <button class="nb" onclick="gT(4,this)"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>Brain</button>
</nav>
</div>
<script>
const g=id=>document.getElementById(id);
const esc=s=>{const d=document.createElement('div');d.textContent=String(s||'');return d.innerHTML;};
const fp=n=>(n>=0?'+':'')+'\$'+Math.abs(n).toFixed(2);
const fb=n=>'\$'+Number(n).toFixed(2);
const nv=v=>v!=null?Number(v):0;
const sv=v=>v!=null?String(v):'—';
const set=(id,v)=>{const e=g(id);if(e)e.textContent=v;};
const cls=(id,c)=>{const e=g(id);if(e)e.className=c;};

let D={},sigs=[],pos=[],trades=[],cands=[],notes=[],logs=[],pnl=[];
let tf='1h',ff='all',botOn=false;

function gT(i,btn){
  document.querySelectorAll('.panel').forEach((p,j)=>p.classList.toggle('on',j===i));
  document.querySelectorAll('.tab').forEach((b,j)=>b.classList.toggle('on',j===i));
  document.querySelectorAll('.nb').forEach((b,j)=>b.classList.toggle('on',j===i));
}
function sTf(m,btn){tf=m;document.querySelectorAll('.tfb').forEach(b=>b.classList.remove('on'));btn.classList.add('on');dC();}
function sF(f,btn){ff=f;document.querySelectorAll('.chip').forEach(b=>b.classList.remove('on'));btn.classList.add('on');rFeed();}
function toggleBot(){dP(botOn?'/stop':'/start');}
async function dP(path){try{await fetch(path,{method:'POST'});setTimeout(ref,700);}catch(e){console.error(e);}}

function dC(){
  const canvas=g('cvs');if(!canvas)return;
  const W=canvas.offsetWidth||300,H=140;
  canvas.width=W*devicePixelRatio;canvas.height=H*devicePixelRatio;
  const ctx=canvas.getContext('2d');ctx.scale(devicePixelRatio,devicePixelRatio);
  const now=Date.now();
  let sl=pnl;
  if(tf==='1h')sl=pnl.filter(p=>p.ts>now-3600000);
  else if(tf==='6h')sl=pnl.filter(p=>p.ts>now-21600000);
  const last=sl.length?nv(sl[sl.length-1].pnl):0;
  const cv=g('CV'),cl=g('CL');
  if(cv){cv.textContent=fp(last);cv.className=last>=0?'cg':'cr';cv.style.cssText='font-size:26px;font-weight:900;letter-spacing:-1px;margin-bottom:3px';}
  if(cl)cl.textContent=sl.length>1?sl.length+' data points':'No data yet';
  ctx.clearRect(0,0,W,H);
  if(sl.length<2){ctx.fillStyle='rgba(255,255,255,.15)';ctx.font='12px Outfit';ctx.textAlign='center';ctx.fillText('Collecting data...',W/2,H/2);return;}
  const vals=sl.map(p=>nv(p.pnl)),mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||1;
  const px=i=>8+(i/(vals.length-1))*(W-16),py=v=>H-8-((v-mn)/rng)*(H-20);
  const col=last>=0?'0,230,118':'255,69,96';
  const grad=ctx.createLinearGradient(0,0,0,H);grad.addColorStop(0,'rgba('+col+',.25)');grad.addColorStop(1,'rgba('+col+',0)');
  ctx.beginPath();ctx.moveTo(px(0),py(vals[0]));
  for(let i=1;i<vals.length;i++){const cx=(px(i-1)+px(i))/2;ctx.bezierCurveTo(cx,py(vals[i-1]),cx,py(vals[i]),px(i),py(vals[i]));}
  ctx.lineTo(px(vals.length-1),H);ctx.lineTo(px(0),H);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
  ctx.beginPath();ctx.moveTo(px(0),py(vals[0]));
  for(let i=1;i<vals.length;i++){const cx=(px(i-1)+px(i))/2;ctx.bezierCurveTo(cx,py(vals[i-1]),cx,py(vals[i]),px(i),py(vals[i]));}
  ctx.strokeStyle='rgb('+col+')';ctx.lineWidth=2.5;ctx.stroke();
}

function rSigs(){
  const el=g('SIL');if(!el)return;set('SIC',sigs.length);
  if(!sigs.length){el.innerHTML='<div class="empty"><div class="ei">🧠</div>No signals — brain scanning...</div>';return;}
  el.innerHTML=sigs.map(s=>'<div class="item"><div class="ih"><div class="in">'+esc(s.title||s.ticker)+'</div><span class="tag '+(s.side==='yes'?'ty':'tn')+'">'+s.side.toUpperCase()+'</span></div><div class="im"><span>Mkt '+(nv(s.marketPrice)*100).toFixed(0)+'¢</span><span>True '+(nv(s.trueProb)*100).toFixed(0)+'¢</span><span class="cg">Edge '+(nv(s.edge)*100).toFixed(1)+'%</span>'+(s.limitPrice?'<span>Limit '+s.limitPrice+'¢</span>':'')+' <span>'+esc(s.confidence||'')+'</span></div>'+(s.reasoning?'<div class="ir">'+esc(s.reasoning)+'</div>':'')+'</div>').join('');
}

function rPos(){
  const el=g('POL');if(!el)return;set('POC',pos.length);
  if(!pos.length){el.innerHTML='<div class="empty">No open positions</div>';return;}
  el.innerHTML=pos.map(p=>'<div class="item"><div class="ih"><div class="in">'+esc(p.title||p.ticker)+'</div><span class="tag '+(p.side==='yes'?'ty':'tn')+'">'+p.side.toUpperCase()+'</span></div><div class="im"><span>'+p.qty+'ct @ '+p.ep+'¢</span><span>\$'+nv(p.size).toFixed(2)+'</span><span class="cg">Edge '+(nv(p.edge)*100).toFixed(1)+'%</span></div>'+(p.reason?'<div class="ir">'+esc(p.reason)+'</div>':'')+'</div>').join('');
}

function rTrades(){
  const el=g('TRL');if(!el)return;set('TRC',trades.length);
  if(!trades.length){el.innerHTML='<div class="empty"><div class="ei">📊</div>No trades</div>';return;}
  el.innerHTML=trades.slice(0,25).map(t=>'<div class="item"><div class="ih"><div class="in">'+esc(t.title||t.ticker)+'</div><span class="tag '+(t.won?'tw':'tls')+'">'+(t.won?'WON':'LOST')+'</span></div><div class="im"><span>'+(t.side||'').toUpperCase()+' @ '+t.ep+'¢</span><span class="'+(nv(t.pnl)>=0?'cg':'cr')+'">'+fp(nv(t.pnl))+'</span><span>'+new Date(t.closedAt||Date.now()).toLocaleTimeString()+'</span></div></div>').join('');
}

function rFeed(){
  const el=g('FL');if(!el)return;
  const ss=new Set(sigs.map(s=>s.ticker));
  let list=[...cands];
  if(ff==='signals')list=list.filter(c=>ss.has(c.ticker));
  else if(ff==='rising')list=list.filter(c=>c.mom==='↑');
  else if(ff==='falling')list=list.filter(c=>c.mom==='↓');
  else if(ff==='urgent')list=list.filter(c=>parseFloat(c.hrs)<6);
  if(!list.length){el.innerHTML=cands.length===0?'<div class="empty"><div class="ei">📡</div><b>Scanning...</b><br>First scan takes ~30s.</div>':'<div class="empty"><div class="ei">🔍</div>No "'+ff+'" markets.<br>Try All — '+cands.length+' available.</div>';return;}
  el.innerHTML=list.slice(0,18).map(c=>'<div class="item"><div class="ih"><div class="in" style="font-size:12px">'+esc(c.title)+'</div><span style="font-size:11px;font-family:var(--m);color:var(--t3)">'+c.yes+'¢ '+c.mom+'</span></div><div class="im">'+(c.vol===0?'<span style="color:var(--r)">No liquidity</span>':'<span>Vol '+(c.vol||0).toLocaleString()+'</span>')+'<span>'+c.hrs+'h</span><span>'+esc(c.cat)+'</span>'+(ss.has(c.ticker)?'<span class="cb">SIGNAL</span>':'')+'</div></div>').join('');
}

function rNotes(){
  const el=g('NTL');if(!el)return;set('NTC',notes.length);
  if(!notes.length){el.innerHTML='<div class="empty"><div class="ei">💡</div>No learnings yet</div>';return;}
  el.innerHTML=[...notes].reverse().slice(0,20).map(n=>'<div class="nt">'+esc(n)+'</div>').join('');
}

function rLogs(){
  const el=g('LOG');if(!el)return;
  if(!logs.length){el.innerHTML='<div class="empty">No logs</div>';return;}
  el.innerHTML=logs.slice(0,80).map(l=>'<div class="ll">'+esc(l)+'</div>').join('');
}

async function ref(){
  try{
    const rs=await Promise.allSettled([
      fetch('/s').then(r=>r.json()),
      fetch('/signals').then(r=>r.json()),
      fetch('/positions').then(r=>r.json()),
      fetch('/trades').then(r=>r.json()),
      fetch('/cands').then(r=>r.json()),
      fetch('/logs').then(r=>r.json()),
      fetch('/pnl').then(r=>r.json()),
      fetch('/notes').then(r=>r.json()),
    ]);
    const ok=r=>r.status==='fulfilled'&&r.value;
    const st=ok(rs[0])?rs[0].value:D;
    if(!st||typeof st!=='object')return;
    D=st;botOn=!!st.on;
    if(ok(rs[1]))sigs=rs[1].value||[];
    if(ok(rs[2]))pos=rs[2].value||[];
    if(ok(rs[3]))trades=rs[3].value||[];
    if(ok(rs[4]))cands=rs[4].value||[];
    if(ok(rs[5]))logs=rs[5].value||[];
    if(ok(rs[6]))pnl=rs[6].value||[];
    if(ok(rs[7]))notes=rs[7].value||[];

    // Mode badge
    const mb=g('MB');
    if(mb){if(st.on){mb.textContent='RUNNING';mb.className='badge bon';}else if(st.paper){mb.textContent='PAPER';mb.className='badge bp';}else{mb.textContent='LIVE';mb.className='badge bl';}}

    // Halt
    const hb=g('HB');if(hb){hb.style.display=st.haltMsg?'block':'none';if(st.haltMsg){const hm=g('HM');if(hm)hm.textContent=st.haltMsg;}}

    // Hero
    const hp=g('HP');if(hp){hp.textContent=fp(nv(st.totPnl));hp.className='hp '+(nv(st.totPnl)>=0?'cg':'cr');}
    set('HS',st.on?'Bot running — scanning every 30s':'Start bot to begin tracking');

    const rb=g('HRB');if(rb){rb.textContent=(st.realBal!=null?fb(st.realBal):'—')+(st.paper?' real':'');rb.className='hsv';}
    const hd=g('HD');if(hd){hd.textContent=st.dayPnl!=null?fp(st.dayPnl):'—';hd.className='hsv '+(nv(st.dayPnl)>=0?'cg':'cr');}
    const hdd=g('HDD');if(hdd){hdd.textContent=st.dd!=null?st.dd.toFixed(1)+'%':'—';hdd.className='hsv '+(nv(st.dd)>15?'cr':nv(st.dd)>7?'cy':'cg');}

    // Tri
    const dep=pos.reduce((a,p)=>a+nv(p.size),0);
    set('TD','\$'+dep.toFixed(2));set('TT',sv(st.total));set('TO',sv(st.open));

    // Engine
    const tb=g('TB');if(tb)tb.className='tgl '+(st.on?'on2':'off');
    set('ES',st.on?'Active — brain #'+nv(st.calls)+(st.brainAt?' @ '+new Date(st.brainAt).toLocaleTimeString():''):'Tap to activate');

    // Stats
    set('GWR',st.wr!=null?st.wr+'%':'—');
    set('GWL',nv(st.wins)+' / '+nv(st.losses));
    set('GSC',st.on?'120':'0');
    set('GCC',sv(st.calls));

    // Signal age
    const sa=g('GSA');
    if(sa){
      if(st.signalAge==null){sa.textContent='No signals yet';sa.style.color='var(--t3)';}
      else if(st.signalAge<60){sa.textContent=st.signalAge+'s ago — fresh ✓';sa.style.color='var(--g)';}
      else if(st.signalAge<180){sa.textContent=Math.round(st.signalAge/60)+'m ago';sa.style.color='var(--y)';}
      else{sa.textContent=Math.round(st.signalAge/60)+'m ago — stale';sa.style.color='var(--r)';}
    }

    // Feed badge
    const fb2=g('FB');if(fb2){if(st.on){fb2.textContent='ACTIVE';fb2.className='badge bon';}else{fb2.textContent='PAUSED';fb2.className='badge bp';}}

    // Ring
    const circ=195,pct=st.wr!=null?st.wr/100:0;
    const rc=g('RC');if(rc)rc.setAttribute('stroke-dasharray',(pct*circ).toFixed(1)+' '+circ);
    const rt=g('RT');if(rt)rt.textContent=st.wr!=null?st.wr+'%':'—';
    set('RW',sv(st.wins));set('RL',sv(st.losses));set('RB',sv(st.calls));set('RO',sv(st.open));
    const rg=g('RG');if(rg){rg.textContent=fp(nv(st.totPnl));rg.className=nv(st.totPnl)>=0?'cg':'cr';rg.style.cssText='font-size:17px;font-weight:800';}

    dC();rSigs();rPos();rTrades();rFeed();rNotes();rLogs();
  }catch(e){console.error('ref error:',e);}
}

ref();setInterval(ref,8000);window.addEventListener('resize',dC);
</script>
</body></html>`;}

// ─── BOOT ────────────────────────────────────────────────────────
const PORT=process.env.PORT||3000;
app.listen(PORT,async()=>{
  log('══════════════════════════════════════');
  log('  KALSHI EDGE v8-final');
  log('  Mode: '+(C.paper?'PAPER':'⚡ LIVE')+' | Kelly:'+C.kelly+' | Edge:'+(C.edgeLive*100).toFixed(0)+'%');
  log('  TG: '+(C.tgTok?'✓':'✗')+' | Claude: '+(C.claude?'✓':'✗')+' | Kalshi: '+(C.keyId?'✓':'✗'));
  log('══════════════════════════════════════');

  if(C.tgTok&&C.tgChat)await tg('🔧 <b>Kalshi Edge v8-final</b> — boot test, Telegram ✓');
  else log('WARNING: No Telegram credentials');

  if(!C.keyId||!C.pem){log('STANDBY — add Kalshi credentials');await tg('⚠️ <b>Standby</b> — Kalshi credentials missing.');return;}

  const ok=await validate();
  if(!ok){log('STANDBY — fix credentials');return;}

  const checks=[
    (C.keyId?'✅':'❌')+' Kalshi API key',
    (C.pem.length>50?'✅':'❌')+' RSA private key',
    (C.claude?'✅':'❌')+' Claude API key',
    (C.tgTok?'✅':'❌')+' Telegram token',
    (C.tgChat?'✅':'❌')+' Telegram chat ID',
    (!C.paper?'✅':'⚠️')+' Live mode '+(C.paper?'(PAPER — set DRY_RUN=false to go live)':'(ACTIVE)'),
  ].join('\n');

  await tg('🟢 <b>Kalshi Edge v8-final — Online</b>\n\nMode: '+(C.paper?'📝 Paper':'⚡ LIVE TRADING')+'\nReal Kalshi balance: <b>$'+realUsd().toFixed(2)+'</b>\nKelly: '+C.kelly+' | Edge: '+(C.edgeLive*100).toFixed(0)+'%\nDaily stop: -$'+C.dailyStop+' | Drawdown: '+(C.ddLimit*100).toFixed(0)+'%\nMax bet: $'+C.maxBet+' | Max pos: '+C.maxPos+'\n\n<b>Checklist:</b>\n'+checks+'\n\nBot starts in 3s. Heartbeat every 30min.');
  log('Ready. $'+realUsd().toFixed(2)+'. Starting in 3s...');
  setTimeout(startBot,3000);
});
