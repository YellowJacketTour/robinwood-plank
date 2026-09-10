import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {JsonRpcProvider} from 'ethers';
// One epoch calibration for all simulated guests. Never a production clock.
export async function writePracticeClock(provider:JsonRpcProvider,root:string,crash:string){
 if((await provider.getNetwork()).chainId!==31337n)throw Error('Local clock only');
 const counts=new Map<number,number>();
 for(let i=0;i<12;i++){
  const before=Date.now(),block=await provider.send('eth_getBlockByNumber',['latest',false]),after=Date.now();
  const offset=Number(BigInt(block.timestamp))-Math.floor((before+after)/2000);
  counts.set(offset,(counts.get(offset)||0)+1);await new Promise(r=>setTimeout(r,100));
 }
 const offsetMs=[...counts].sort((a,b)=>b[1]-a[1])[0][0]*1000;
 await writeFile(resolve(root,'arcade/practice-clock.js'),`export default ${JSON.stringify({chainId:31337,crash,offsetMs})};\n`);
 return offsetMs;
}
