import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {JsonRpcProvider,Contract} from 'ethers';
const base=process.env.PLANK_INVITE_URL,token=(await readFile(process.env.PLANK_INVITE_TOKEN_FILE,'utf8')).trim();
const out=resolve(process.env.PLANK_INVITE_OUTPUT);
assert.equal((await fetch(`${base}/api/invite/session`)).status,401);
const joined=await fetch(`${base}/api/invite/join`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});assert.equal(joined.status,200);
const setCookie=joined.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Strict/);
const headers={Cookie:setCookie.split(';')[0],'Content-Type':'application/json'};
const session=await(await fetch(`${base}/api/invite/session`,{headers})).json();assert.equal(session.simulated,true);
const manifest=await(await fetch(`${base}/arcade/deploy-addresses.local.json`,{headers})).json();assert.equal(manifest.simulateKey,undefined);
const call=async(method,params)=>await(await fetch(`${base}/api/invite/rpc`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
assert.equal((await call('eth_chainId',[])).result,'0x7a69');
assert.equal(BigInt((await call('eth_getBalance',[session.address,'latest'])).result),50000000000000000n);
assert.match((await call('eth_getLogs',[{address:manifest.crash}])).error.message,/Explicit log range/);
assert.match((await call('hardhat_reset',[])).error.message,/unavailable/);
assert.equal((await fetch(`${base}/api/invite/refill`,{method:'POST',headers:{...headers,Origin:'https://example.com'}})).status,403);
const p=new JsonRpcProvider('http://127.0.0.1:8545');
const crash=new Contract(manifest.crash,['event Withdrawn(address indexed player,address indexed to,uint256 amount)'],p);
const proof=JSON.parse(await readFile(resolve(out,'proof.json'),'utf8'));
const withdrawals=[];
for(const player of proof.identities){const events=await crash.queryFilter(crash.filters.Withdrawn(player),manifest.inviteStartBlock);withdrawals.push({player,transactions:events.map(e=>({hash:e.transactionHash,amountWei:String(e.args.amount)}))});}
assert.ok(withdrawals.some(w=>w.transactions.length),'A simulated winner must have received a withdrawal');
for(const draw of proof.proofs[0].draws){const other=proof.proofs[1].draws.find(d=>d.roundId===draw.roundId);if(other)assert.equal(draw.drawnBall,other.drawnBall);}
await writeFile(resolve(out,'release.json'),JSON.stringify({passed:true,base,guestIsolated:true,secureSession:true,adminAndUnboundedLogsRejected:true,withdrawals},null,2));
console.log({passed:true,withdrawals:withdrawals.map(w=>({player:w.player,count:w.transactions.length}))});
