// Loopback-only practice server and keeper. Never accepts real-chain settings.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { JsonRpcProvider,Contract } from 'ethers';
import { tick } from './casino-keeper.js';
import { getEthUsdPrice } from '../lib/eth-price.js';
import {writePracticeClock} from './lib/practice-clock.js';

const root = resolve('public');
const provider = new JsonRpcProvider('http://127.0.0.1:8545');
if ((await provider.getNetwork()).chainId !== 31337n) throw new Error('Practice requires chain 31337');
const manifest = JSON.parse(await readFile(resolve(root, 'arcade/deploy-addresses.local.json'), 'utf8'));
await writePracticeClock(provider,root,manifest.crash);
// Dedicated keeper account avoids nonce races with the free-play wallet.
const signer = await provider.getSigner(7);
const testSeat=await provider.getSigner(9);
const game=new Contract(manifest.crash,JSON.parse(await readFile(resolve(root,'arcade/abi/PlankGuardedCrash.json'),'utf8')),testSeat);
const minimumStake=await game.minStakeWei();
const types: Record<string,string> = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
createServer(async (req,res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1:8765');
    res.setHeader('Cache-Control','no-store');
    if(url.pathname === '/api/market/eth-price') {
      const p=await getEthUsdPrice();res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ethUsd:p.usd||null,source:p.source,ageMs:Number.isFinite(p.ageMs)?p.ageMs:null}));return;
    }
    const path=resolve(root,'.'+decodeURIComponent(url.pathname === '/'?'/arcade/crash.html':url.pathname));
    if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}
    const data=await readFile(path);res.setHeader('Content-Type',types[extname(path)]||'application/octet-stream');res.end(data);
  } catch {res.writeHead(404).end('Not found');}
}).listen(8765,'127.0.0.1',()=>console.log('Practice: http://127.0.0.1:8765/arcade/crash.html (test funds only)'));
for (;;) {
  try {
    // A disclosed simulated seat keeps the unattended free-test show running.
    // It follows the real contract rules and is never enabled on a real chain.
    const id=await game.currentRoundId(),round=await game.rounds(id),now=BigInt((await provider.getBlock('latest'))!.timestamp);
    if(manifest.testRig&&Number(round.phase)===0&&now<round.bettingEndsAt&&now>=round.bettingEndsAt-10n&&await game.seatCount(id)===0n){
      await(await game.placeBetInRound(id,20000n,{value:minimumStake})).wait();
    }
    const actions=await tick(provider,signer,{...manifest,router:manifest.rakeRouter,mockBeacon:true,mockImmediateAfterClose:true});for(const a of actions)console.log(a.step);}
  catch(err){console.error('Practice keeper:',err instanceof Error?err.message:String(err));}
  // The contract closes betting 8s before the scheduled liftoff and the
  // browser needs the RoundSettled event BEFORE that liftoff to play the
  // countdown and the 1400ms ignition burn. Measured, the margin between
  // settlement and liftoff is often only tens of milliseconds, so a 1000ms
  // tick straddles the boundary: rounds settle a few hundred ms LATE and the
  // stage jumps straight to 'flight' with no countdown and no ignition --
  // the rocket never appears to launch. Ticking at 250ms keeps settlement
  // comfortably inside the lead. These are cheap local reads, not txs.
  await new Promise(resolve=>setTimeout(resolve,250));
}
