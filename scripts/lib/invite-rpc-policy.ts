import { Interface, Transaction, getAddress, parseEther } from 'ethers';

// A capability boundary for worthless, local-chain guest balances. Never a generic RPC proxy.
export function invitePolicy(manifest: Record<string,string>) {
  const addresses = new Set(Object.values(manifest).filter(v => /^0x[0-9a-fA-F]{40}$/.test(v)).map(v=>v.toLowerCase()));
  const crash = new Interface(['function placeBetInRound(uint256,uint256) payable','function withdraw()']);
  const lottery = new Interface(['function withdraw()']);
  const fuel = new Interface(['function burnFuel(uint256,uint256,uint256,uint256)']);
  const token = new Interface(['function approve(address,uint256)']);
  function transaction(to: string, data: string, value: bigint) {
    const destination = to.toLowerCase();
    if(value < 0n || value > parseEther('0.001')) throw new Error('Test stake limit exceeded');
    const iface = destination === manifest.crash.toLowerCase() ? crash
      : destination === manifest.lottery.toLowerCase() ? lottery
      : destination === manifest.communityFuel.toLowerCase() ? fuel
      : destination === manifest.plank.toLowerCase() ? token : null;
    const call = iface?.parseTransaction({data,value});
    if(!call || (call.name !== 'placeBetInRound' && value !== 0n)) throw new Error('Game action unavailable');
    if(call.name === 'approve' && (call.args[0].toLowerCase() !== manifest.communityFuel.toLowerCase() || call.args[1] > parseEther('5000'))) throw new Error('Fuel approval only');
  }
  function validate(method: string, params: unknown[], guest: string, latestBlock: number) {
    const p = params as any[];
    if(!Array.isArray(params) || params.length > 2) throw new Error('Invalid parameters');
    const own = (a: string) => getAddress(a) === getAddress(guest);
    const target = (a: string) => typeof a === 'string' && addresses.has(a.toLowerCase());
    switch(method) {
      case 'eth_chainId': case 'eth_blockNumber': case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas':
        if(p.length) throw new Error('Invalid parameters'); return;
      case 'eth_getBalance': case 'eth_getTransactionCount':
        if(!own(p[0])) throw new Error('Own balance only'); return;
      case 'eth_getCode': if(!target(p[0])) throw new Error('Game contracts only'); return;
      case 'eth_getTransactionReceipt': case 'eth_getTransactionByHash':
        if(!/^0x[0-9a-fA-F]{64}$/.test(p[0])) throw new Error('Invalid hash'); return;
      case 'eth_getBlockByNumber':
        if(p[1] !== false || !/^(latest|pending|0x[0-9a-f]+)$/.test(p[0])) throw new Error('Header only'); return;
      case 'eth_call':
        if(!p[0] || !target(p[0].to) || Object.keys(p[0]).some(k=>!['to','from','data','gas'].includes(k))) throw new Error('Game view only');
        if(typeof p[0].data !== 'string' || p[0].data.length>16000) throw new Error('Invalid call');
        p[0].gas='0x1e8480'; return;
      case 'eth_estimateGas':
        if(!p[0] || !own(p[0].from) || Object.keys(p[0]).some(k=>!['to','from','data','value','nonce','type','gasPrice','maxFeePerGas','maxPriorityFeePerGas'].includes(k))) throw new Error('Own game action only');
        transaction(p[0].to,p[0].data,BigInt(p[0].value||0)); return;
      case 'eth_sendRawTransaction': {
        if(typeof p[0] !== 'string' || p[0].length>16000) throw new Error('Invalid transaction');
        const tx=Transaction.from(p[0]);
        if(!tx.from || !own(tx.from) || tx.chainId !== 31337n || !tx.to || tx.gasLimit>2000000n || tx.authorizationList?.length || tx.blobs?.length) throw new Error('Guest game transaction only');
        if((tx.maxFeePerGas||tx.gasPrice||0n)>100000000000n) throw new Error('Gas price too high');
        transaction(tx.to,tx.data,tx.value); return;
      }
      case 'eth_getLogs': {
        const f=p[0];
        if(!f || Object.keys(f).some(k=>!['address','topics','fromBlock','toBlock','blockHash'].includes(k))) throw new Error('Invalid log query');
        if(!(Array.isArray(f.address)?f.address:[f.address]).every(target)) throw new Error('Game events only');
        if(!f.blockHash && f.fromBlock===undefined) throw new Error('Explicit log range required');
        const block=(v: string|undefined)=>v===undefined||v==='latest'?latestBlock:Number(BigInt(v));
        if(!f.blockHash && (block(f.toBlock)-block(f.fromBlock)>4096 || block(f.fromBlock)<0)) throw new Error('Log range too large');
        if(JSON.stringify(f.topics||[]).length>2000) throw new Error('Too many topics'); return;
      }
      default: throw new Error('RPC method unavailable');
    }
  }
  return { validate };
}
