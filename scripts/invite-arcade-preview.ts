// Public invite gateway. The unlocked Hardhat RPC and keeper remain loopback-only.
import {createServer, IncomingMessage} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Wallet,JsonRpcProvider,Contract,parseEther,formatEther} from 'ethers';
import {invitePolicy} from './lib/invite-rpc-policy.js';

// The chain is a parameter, not a constant. Everything below works the same
// against a dev node on loopback and against a public TEST network, because
// the gateway never actually needed a dev node -- it needed an RPC, a funded
// signer, and a manifest of test-only contracts. Defaults are unchanged, so
// the documented local workflow (FRIEND-INVITE-TEST.md) behaves exactly as
// before; the hosted deployment supplies these three.
const root=resolve('public');
const rpcUrl=process.env.PLANK_INVITE_RPC_URL?.trim()||'http://127.0.0.1:8545';
const expectedChainId=BigInt(process.env.PLANK_INVITE_CHAIN_ID?.trim()||'31337');
const manifestName=process.env.PLANK_INVITE_MANIFEST?.trim()||'deploy-addresses.local.json';
const rpc=new JsonRpcProvider(rpcUrl);
const actualChainId=(await rpc.getNetwork()).chainId;
if(actualChainId!==expectedChainId)throw new Error(`Invite test expects chain ${expectedChainId}, got ${actualChainId} from ${rpcUrl}`);
const source=JSON.parse(await readFile(resolve(root,'arcade/'+manifestName),'utf8'));
// The whole point of this gate is that nothing here has value. A manifest
// must say so out loud: either the local test rig, or a network the deploy
// script itself marked test-only. Mainnet can never satisfy this.
const localRig=source.testRig&&['30-second-window-local-mock','30-second-lottery-to-launch-local-mock'].includes(source.practiceTiming);
const declaredTestnet=source.network==='robinhood-testnet'&&source.chainId===46630;
if(!localRig&&!declaredTestnet)throw new Error('Refusing a manifest that is not a declared test deployment');
const manifest={...source,inviteTest:true};delete manifest.simulateKey;delete manifest.rpcUrl;
// Locate this deployment, not every prior audit fixture on the same dev node.
// The deploy records the answer (deployedAtBlock). The binary search below is
// the fallback for a manifest written before that field existed -- and it is
// only safe on a SHORT-LIVED node. A chain keeps blocks and receipts far
// longer than it keeps account STATE: measured on anvil, state survives about
// 3,200 blocks, which at 100ms blocks is roughly five minutes. Past that,
// getCode returns '0x' for the deployment's own early blocks -- or throws
// BlockOutOfRangeError and the gateway cannot boot at all -- so the search
// lands too high and the arcade filters out its own logs.
// A PUBLIC test network is not a fresh dev node, and the difference decides
// what this number may be. The stats scan walks inviteStartBlock -> tip in
// 4,000-block pages, which is 'genuinely fine at local/testnet scale' only
// because a dev node starts at block 0 and lives for minutes. Measured on
// Robinhood testnet: 0.158s blocks, the deployment already 208,646 blocks
// back after nine hours -- 53 sequential getLogs pages, 4.6s of blocking RPC
// on load, growing ~6,500 blocks (1.6 pages) every hour, forever.
//
// The deploy block is also unreachable: this RPC serves state for only about
// 6,200 blocks (~16 minutes), so the binary-search fallback below sees every
// deep probe THROW, treats each as 'not deployed yet', and walks to the head
// -- the arcade would then filter out its own rounds and show an empty table.
//
// So on a declared testnet we anchor to a recent block. Nothing is lost: the
// live scoreboard already anchors to the current block and walks FORWARD
// (scoreboardFromBlock), and a shared testnet's older rounds are other
// people's fixtures, not this table's history.
const anchorWindow=Number(process.env.PLANK_INVITE_ANCHOR_BLOCKS?.trim()||'5000');
if(declaredTestnet&&!Number.isSafeInteger(source.deployedAtBlock)){
  manifest.inviteStartBlock=Math.max(0,await rpc.getBlockNumber()-anchorWindow);
}else if(Number.isSafeInteger(source.deployedAtBlock)&&source.deployedAtBlock>=0){
  manifest.inviteStartBlock=source.deployedAtBlock;
}else{
  let low=0,high=await rpc.getBlockNumber();
  while(low<high){
    const mid=Math.floor((low+high)/2);
    let code='0x';
    // A pruned block is indistinguishable from 'not deployed yet' here, so
    // treat it the same way rather than crashing the whole gateway.
    try{code=await rpc.getCode(manifest.plank,mid);}catch{low=mid+1;continue;}
    if(code==='0x')low=mid+1;else high=mid;
  }
  manifest.inviteStartBlock=low;
}
const policy=invitePolicy(manifest);
const stateDir=resolve(process.env.PLANK_INVITE_STATE_DIR||'work/invite');await mkdir(stateDir,{recursive:true});
const port=Number(process.env.PLANK_INVITE_PORT||8766);
// Where a joined guest is sent. Direct/tunnel use keeps the gateway's own
// path. Behind Passenger the arcade HTML is ALSO served statically from
// public/arcade -- and that copy has no <meta name="plank-invite">, so
// landing there silently drops INVITE_TEST and the green dock never mounts.
// The proxied deployment points this at the route only the gateway answers.
const TABLE_PATH=process.env.PLANK_INVITE_TABLE_PATH?.trim()||'/arcade/crash.html';
// Where the join page (this server's '/') is reachable by the public. Behind
// the plank.love proxy that is /table; the arcade's Invite button builds the
// shareable link from it.
const JOIN_PATH=process.env.PLANK_INVITE_JOIN_PATH?.trim()||'/';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PLANK_INVITE_PORT must be a valid port');
let token='';
try{token=(await readFile(resolve(stateDir,'invite-token.txt'),'utf8')).trim();}catch{}
if(!/^[A-Za-z0-9_-]{43}$/.test(token))token=randomBytes(32).toString('base64url');
await writeFile(resolve(stateDir,'invite-token.txt'),token,{mode:0o600});
type Guest={key:string,address:string,expires:number,refilled:number,count:number,window:number,writes:number};
const sessionFile=resolve(stateDir,'invite-sessions.json');
// Guest sessions outlive the process. A restart previously dropped every
// in-memory session, so a friend mid-test was silently logged out and their
// funded wallet became unreachable. Keys already exist only in this private
// state directory alongside the token; persisting them changes durability,
// not the trust boundary.
const sessions=new Map<string,Guest>();
try{
  const saved=JSON.parse(await readFile(sessionFile,'utf8')) as Record<string,Guest>;
  for(const [id,g] of Object.entries(saved))if(g&&g.expires>Date.now())sessions.set(id,g);
}catch{}
let persisting=Promise.resolve();
// Serialized so concurrent joins cannot interleave two writes of the same file.
const persistSessions=()=>{
  persisting=persisting.then(()=>writeFile(sessionFile,JSON.stringify(Object.fromEntries(sessions)),{mode:0o600})).catch(()=>{});
  return persisting;
};
let funding=Promise.resolve();let inflight=0;let joins=0;let joinWindow=Date.now();
// A dev node hands out unlocked accounts; a public network does not. The
// funder only ever sends ETH and mints test PLANK, and a keyed Wallet does
// both identically -- the unlocked account was a convenience, never a
// requirement. PLANK_INVITE_FUNDER_PK is gas-only and testnet-only.
const funderPk=process.env.PLANK_INVITE_FUNDER_PK?.trim();
const funder=funderPk?new Wallet(funderPk,rpc):await rpc.getSigner(8);
// Grants are sized for the network. On a fake chain ETH is free; on a
// testnet it is faucet-limited, and at 0.01 gwei a 0.002 grant is ~800 bets.
const guestGrant=parseEther(process.env.PLANK_INVITE_GRANT_ETH?.trim()||'0.05');
const refillFloor=guestGrant/10n;
const plank=new Contract(manifest.plank,['function mint(address,uint256)','function balanceOf(address) view returns (uint256)'],funder);
const json=(res:any,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
async function body(req:IncomingMessage){let data='';for await(const chunk of req){data+=chunk;if(data.length>65536)throw new Error('Request too large');}return JSON.parse(data||'{}');}
const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm','.mp3':'audio/mpeg'};
// Cloudflare hands every /arcade asset a 4-hour browser TTL whatever the origin
// says, so a table-only deploy reached an open phone hours late, and half-
// updated (crash.html fresh, its css/js stale). The arcade's own entry links
// and static imports are stamped with a fingerprint of the deployed files:
// a new deploy is a new URL, the old cache is simply never asked. vendor/ and
// art/ never change with a fix and keep their cache.
const assetStamp=await (async()=>{const {createHash}=await import('node:crypto');const {readdir,stat}=await import('node:fs/promises');const h=createHash('sha256');
  for(const f of (await readdir(resolve(root,'arcade'))).filter(f=>/\.(js|css|html)$/.test(f)).sort()){const st=await stat(resolve(root,'arcade',f));h.update(f+':'+st.size+':'+Math.floor(st.mtimeMs)+';');}
  return h.digest('hex').slice(0,10);})();
const stampAssets=(html:string)=>html
  // Entry links only. Stamping the module specifiers inside crash.html loaded
  // every shared module TWICE (once as ./x.js?v=.. from crash.html, once as
  // ./x.js from lottery-theatre.js): two instances of rapier, three, and every
  // singleton -- measured 54 script requests / 6 MB decoded on one page load.
  // The no-store header on /arcade/* (verified passing Cloudflare) makes the
  // nested graph fresh on its own; the entry stamp defeats a stale HTML cache.
  .replace(/(href|src)="((?!vendor\/|art\/|https?:)[A-Za-z0-9_./-]+\.(?:js|css))"/g,(_m,attr,file)=>`${attr}="${file}?v=${assetStamp}"`);
// Every player's arcade polls the same ~20 reads at 2.5 Hz. Unshared, N players
// are N x that on anvil and the queue behind Passenger -- measured in-page RPC
// averages of 1.1 s for a hop that costs 150 ms alone. Reads that are pure
// functions of the chain head (eth_call at latest, logs, blocks, balances,
// counts) are memoised per head block and in-flight calls coalesce, so the
// whole table costs anvil one read per block per distinct call, whatever N is.
// Writes, receipts and nonces are never shared. The map is bounded by its TTL.
const SHARED_READ_METHODS=new Set(['eth_call','eth_getLogs','eth_getBlockByNumber','eth_getBalance','eth_getStorageAt','eth_getCode','eth_chainId','eth_blockNumber','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_estimateGas']);
const sharedReads=new Map<string,{head:number,at:number,value:Promise<unknown>}>();
const SHARED_READ_TTL_MS=400;
function sharedRead(method:string,params:unknown[],head:number):Promise<unknown>{
  if(!SHARED_READ_METHODS.has(method))return rpc.send(method,params);
  const key=method+' '+JSON.stringify(params);
  const now=Date.now();const hit=sharedReads.get(key);
  if(hit&&hit.head===head&&now-hit.at<SHARED_READ_TTL_MS)return hit.value;
  const value=Promise.race([rpc.send(method,params),new Promise((_r,reject)=>setTimeout(()=>reject(new Error('Chain read timed out')),6000))]);
  sharedReads.set(key,{head,at:now,value});
  value.catch(()=>{if(sharedReads.get(key)?.value===value)sharedReads.delete(key);});
  if(sharedReads.size>4000){for(const [k,v] of sharedReads)if(now-v.at>SHARED_READ_TTL_MS)sharedReads.delete(k);}
  return value;
}
// What a waiting tab cares about: round, phase, seats, the chain second and
// the pool. The head block advances every 100 ms and is deliberately excluded.
function stateSignature(body:string):string{
  try{const s=JSON.parse(body);if(!s?.ready)return 'not-ready';const r=s.round||{};return [s.roundId,r.phase,s.seatCount,s.chainNow,r.playerPool,r.crashBps,r.bettingEndsAt].join('|');}catch{return 'bad';}
}
// Keeper snapshot, shared by every /state read and every /feed stream within
// a 100 ms window so N tabs cost the keeper one HTTP read per block.
let keeperStateCache:{at:number,value:Promise<string>}|null=null;
function keeperState():Promise<string>{
  const now=Date.now();
  if(keeperStateCache&&now-keeperStateCache.at<100)return keeperStateCache.value;
  const value=fetch('http://127.0.0.1:8765/api/state',{signal:AbortSignal.timeout(2000)}).then(r=>r.text());
  keeperStateCache={at:now,value};value.catch(()=>{keeperStateCache=null;});
  return value;
}
const landing=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PlankCrash · Friend test</title><link rel="stylesheet" href="/arcade/pocket-console.css"></head><body style="display:grid;place-items:center;min-height:100svh;color:var(--ink);text-align:center"><main><h1>PLANKCRASH</h1><p id="status">Joining the launch…</p><p>Simulated ETH · no cash value</p><button id="retry" hidden>Try again</button></main><script>
async function join(){try{const token=new URLSearchParams(location.hash.slice(1)).get('invite');const r=await fetch('/api/invite/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});if(!r.ok)throw Error(r.status===403?'Open the invite link from your friend.':r.status===503?'The test chain is down. Ask the host to restart it.':'The test is busy. Try again shortly.');location.replace('${TABLE_PATH}');}catch(e){document.getElementById('status').textContent=e.message;document.getElementById('retry').hidden=false;}}document.getElementById('retry').onclick=join;join();</script></body></html>`;
createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  // base-uri is 'self', not 'none': crash.html carries <base href="/arcade/">
  // so every relative asset and module import resolves under that path. With
  // 'none' the browser BLOCKS the base tag and logs a CSP violation --
  // harmless when the gateway serves the page from /arcade/ itself, but the
  // hosted table is proxied at /arcade/table.html, where losing the base tag
  // repoints every relative URL and 404s the assets. 'self' still blocks an
  // injected base pointing at another origin, which is the real threat.
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'");
  try{
    const url=new URL(req.url||'/','http://localhost');
    const sid=/\bplank_guest=([A-Za-z0-9_-]{43})\b/.exec(req.headers.cookie||'')?.[1];
    let guest=sid?sessions.get(sid):undefined;
    if(guest&&guest.expires<Date.now()){sessions.delete(sid!);void persistSessions();guest=undefined;}
    if(req.method==='POST'){
      const origin=req.headers.origin;
      // Same-origin is still the rule; the question is what "same" means once
      // a reverse proxy is in front. Passenger rewrites Host to this
      // loopback listener while Origin stays the public site, so comparing
      // the two rejects every real request. PLANK_INVITE_PUBLIC_ORIGIN names
      // the one public origin allowed to reach us; unset, behaviour is
      // unchanged and only a direct same-host POST is accepted.
      const publicOrigin=process.env.PLANK_INVITE_PUBLIC_ORIGIN?.trim();
      const expectedHost=req.headers.host;
      if(origin){
        const originHost=new URL(origin).host;
        const allowed=originHost===expectedHost
          || (!!publicOrigin && origin===publicOrigin);
        if(!allowed){json(res,403,{error:'Origin rejected'});return;}
      }
      if(req.headers['sec-fetch-site']==='cross-site'){json(res,403,{error:'Cross-site request rejected'});return;}
    }
    if(url.pathname==='/api/invite/join'&&req.method==='POST'){
      const input=await body(req);
      if(guest){
        // A returning guest may be returning to a DIFFERENT chain: a redeploy
        // reseeds the table, and the wallet the session remembers has nothing on
        // it. Measured on plank.love: the dock read 0.0000, Repeat could not bet,
        // no result card ever showed, and a manual Refill was the only way back.
        // The invite link is the whole promise, so a rejoin below the floor is
        // funded like a first join, including the PLANK the fuel gauge burns.
        const g=guest;
        const [eth,plankBal]=await Promise.all([rpc.getBalance(g.address),plank.balanceOf(g.address).catch(()=>0n)]);
        if(eth<refillFloor||plankBal===0n){
          const topUp=funding.then(async()=>{
            if(eth<refillFloor)await(await funder.sendTransaction({to:g.address,value:guestGrant})).wait();
            if(plankBal===0n)await(await plank.mint(g.address,parseEther('5000'))).wait();
          });
          funding=topUp.catch(()=>{});
          try{await topUp;}catch{json(res,503,{error:'Test chain unavailable. Ask the host to restart it.'});return;}
          g.refilled=Date.now();void persistSessions();
        }
        json(res,200,{ok:true});return;
      }
      const proposed=Buffer.from(typeof input.token==='string'?input.token:'');const expected=Buffer.from(token);
      if(proposed.length!==expected.length||!timingSafeEqual(proposed,expected)){json(res,403,{error:'Invite required'});return;}
      let evicted=false;for(const [id,g]of sessions)if(g.expires<Date.now()){sessions.delete(id);evicted=true;}if(evicted)void persistSessions();
      if(Date.now()-joinWindow>60000){joinWindow=Date.now();joins=0;}
      if(sessions.size>=128||++joins>12){json(res,429,{error:'Test capacity reached'});return;}
      const wallet=Wallet.createRandom(),id=randomBytes(32).toString('base64url');
      guest={key:wallet.privateKey,address:wallet.address,expires:Date.now()+86400000,refilled:Date.now(),count:0,window:Date.now(),writes:0};
      const g=guest;
      const funded=funding.then(async()=>{await(await funder.sendTransaction({to:g.address,value:guestGrant})).wait();await(await plank.mint(g.address,parseEther('5000'))).wait();});
      funding=funded.catch(()=>{});
      // Funding needs the local node. When it is down the generic catch-all
      // reported an indistinguishable 400 and the guest was told the test was
      // busy, hiding a dead chain behind a retry prompt. Name that cause.
      try{await funded;}catch{json(res,503,{error:'Test chain unavailable. Ask the host to restart it.'});return;}
      sessions.set(id,g);await persistSessions();
      const secure=req.headers['x-forwarded-proto']==='https'||!/^127\.0\.0\.1:/.test(req.headers.host||'');
      res.setHeader('Set-Cookie',`plank_guest=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure?'; Secure':''}`);
      json(res,200,{ok:true});return;
    }
    if((url.pathname==='/'||url.pathname==='/arcade/crash.html')&&req.method==='GET'&&!guest){res.setHeader('Content-Type','text/html');res.end(landing);return;}
    if(!guest && url.pathname!=='/arcade/pocket-console.css'){json(res,401,{error:'Invite session required'});return;}
    if(guest&&url.pathname==='/'&&req.method==='GET'){res.writeHead(302,{Location:TABLE_PATH}).end();return;}
    if(url.pathname==='/api/invite/clock'&&req.method==='GET'){json(res,200,{nowMs:Date.now()});return;}
    // The keeper's round snapshot, one JSON per read and one SSE stream per
    // tab: a phone follows the table on a single connection instead of 2.5
    // RPC batches a second. Per-player fields (stake/target) stay on RPC.
    if(url.pathname==='/api/invite/state'&&req.method==='GET'){
      // Long-poll variant: ?wait=1&since=<signature> holds the request (up to
      // 8 s) until the round-relevant part of the snapshot changes. Measured:
      // SSE never flushes through the site's rewrite proxy (0 bytes in 12 s),
      // while a held request streams nothing and works through every proxy.
      // A tab makes ~1 request per second and sees a change within ~100 ms.
      const wait=url.searchParams.get('wait')==='1';const since=url.searchParams.get('since')||'';
      let body=await keeperState();
      void wait; void since; // never hold: see /feed above
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','X-State-Signature':stateSignature(body)});res.end(body);return;
    }
    // Held connections (SSE, long-poll) through the site's rewrite proxy filled
    // Passenger's request queue and took the whole site to 503 (2026-09-14).
    // Nothing is ever held here: /feed answers 204 (EventSource stops on 204)
    // and /state answers at once. Freshness comes from a cheap 400 ms poll.
    if(url.pathname==='/api/invite/feed'&&req.method==='GET'){res.writeHead(204,{'Cache-Control':'no-store'});res.end();return;}
    if(url.pathname==='/api/invite/session'&&req.method==='GET'&&guest){
      // The arcade reads the session on every load and only POSTs join on a
      // 401 -- so after a table rebuild a returning tab never reached the
      // rejoin top-up above and sat at 0.0000 (measured 2026-09-13). Same
      // rule here: below the floor, or no PLANK, is funded like a first join.
      const g=guest;
      try{const [eth,plankBal]=await Promise.all([rpc.getBalance(g.address),plank.balanceOf(g.address).catch(()=>0n)]);
        if(eth<refillFloor||plankBal===0n){const topUp=funding.then(async()=>{if(eth<refillFloor)await(await funder.sendTransaction({to:g.address,value:guestGrant})).wait();if(plankBal===0n)await(await plank.mint(g.address,parseEther('5000'))).wait();});funding=topUp.catch(()=>{});await topUp;g.refilled=Date.now();void persistSessions();}
      }catch{/* the session still answers; the dock's Refill remains the manual path */}
    }
    if(url.pathname==='/api/invite/session'&&req.method==='GET'){
      json(res,200,{address:guest!.address,key:guest!.key,invite:token,simulated:true});return;
    }
    if(url.pathname==='/api/invite/refill'&&req.method==='POST'){
      if(Date.now()-guest!.refilled<600000 || await rpc.getBalance(guest!.address)>refillFloor){json(res,409,{error:`Refill available below Ξ ${formatEther(refillFloor)}, once every ten minutes`});return;}
      guest!.refilled=Date.now();const to=guest!.address;
      const funded=funding.then(async()=>{await(await funder.sendTransaction({to,value:guestGrant})).wait();});funding=funded.catch(()=>{});await funded;json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/invite/rpc'&&req.method==='POST'){
      const input=await body(req),batch=Array.isArray(input)?input:[input];
      // 32 in flight was sized for one player; a 60 s anvil state dump stalled
      // every read for seconds, the counter pinned, and every other tab got 429
      // (measured: 144 x 429 in four minutes, p90 8 s). Shared reads now fail
      // fast (6 s) instead of holding a slot, and the cap fits a public table.
      if(!batch.length||batch.length>40||inflight>=256){json(res,429,{error:'Busy, retry shortly'});return;}
      const g=guest!;if(Date.now()-g.window>10000){g.window=Date.now();g.count=0;g.writes=0;}
      g.count+=batch.length;if(g.count>1600){json(res,429,{error:'Request limit'});return;}
      inflight++;
      try{
        const latest=await rpc.getBlockNumber();
        const replies=await Promise.all(batch.map(async call=>{
          const id=typeof call?.id==='number'||typeof call?.id==='string'?call.id:null;
          try{
            if(call?.jsonrpc!=='2.0')throw new Error('Invalid RPC envelope');
            if(call.method==='eth_sendRawTransaction'&&++g.writes>8)throw new Error('Action limit');
            policy.validate(call.method,call.params||[],g.address,latest);
            return {jsonrpc:'2.0',id,result:await sharedRead(call.method,call.params||[],latest)};
          }catch(error:any){return {jsonrpc:'2.0',id,error:{code:-32000,message:error.shortMessage||error.message||'Request rejected',...(error.info?.error?.data?{data:error.info.error.data}:{})}};}
        }));
        json(res,200,Array.isArray(input)?replies:replies[0]);
      }finally{inflight--;}return;
    }
    if(url.pathname==='/api/market/eth-price'&&req.method==='GET'){
      const r=await fetch('http://127.0.0.1:8765/api/market/eth-price',{signal:AbortSignal.timeout(6000)});json(res,r.status,await r.json());return;
    }
    if(url.pathname==='/arcade/deploy-addresses.local.json'&&req.method==='GET'){json(res,200,manifest);return;}
    if(req.method!=='GET'){json(res,405,{error:'Method unavailable'});return;}
    const pathname=decodeURIComponent(url.pathname==='/'?'/arcade/crash.html':url.pathname);
    const path=resolve(root,'.'+pathname);
    if(!path.startsWith(resolve(root,'arcade')+sep)||!types[extname(path)]||/\.json$/i.test(path)&&!pathname.startsWith('/arcade/abi/')||/\.html$/i.test(path)&&pathname!=='/arcade/crash.html'){json(res,404,{error:'Not found'});return;}
    let data=await readFile(path);
    if(pathname==='/arcade/crash.html')data=Buffer.from(stampAssets(data.toString().replace('<head>','<head><meta name="plank-invite" content="simulated"><meta name="plank-invite-join" content="'+JOIN_PATH+'"><link rel="stylesheet" href="invite-play.css">')));
    res.setHeader('Content-Type',types[extname(path)]);res.end(data);
  }catch{if(!res.headersSent)json(res,400,{error:'Request could not be completed'});else res.end();}
// Loopback stays mandatory; only the port is configurable, so a supervised
// service can run beside an existing gateway without stopping a live test.
}).listen(port,'127.0.0.1',()=>console.log(`Invite gateway ready on loopback :${port}. Token saved to configured state directory. Simulated ETH only.`));
