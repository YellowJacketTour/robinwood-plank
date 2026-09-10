import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,Interface,parseEther} from 'ethers';
import {invitePolicy} from '../../scripts/lib/invite-rpc-policy.js';
const addresses=Array.from({length:6},()=>Wallet.createRandom().address);
const m={crash:addresses[0],lottery:addresses[1],communityFuel:addresses[2],plank:addresses[3],bank:addresses[4],beacon:addresses[5]};
const guest=Wallet.createRandom(),other=Wallet.createRandom(),policy=invitePolicy(m);
const crash=new Interface(['function placeBetInRound(uint256,uint256) payable','function withdraw()','function freezeAdmissions()']);
const check=(method:string,params:any[])=>policy.validate(method,params,guest.address,10000);
test('invite gateway rejects administration, impersonation, reset, mining, signing and arbitrary RPC',()=>{
  for(const method of ['hardhat_reset','hardhat_impersonateAccount','hardhat_setBalance','evm_mine','evm_setNextBlockTimestamp','eth_sendTransaction','eth_sign','personal_sign','eth_accounts','debug_traceCall','eth_getStorageAt','eth_newFilter'])assert.throws(()=>check(method,[]),method);
});
test('guest views are bounded to game contracts, own balances and limited event queries',()=>{
  check('eth_getBalance',[guest.address,'latest']);
  assert.throws(()=>check('eth_getBalance',[other.address,'latest']));
  check('eth_call',[{to:m.crash,data:'0x12345678'},'latest']);
  assert.throws(()=>check('eth_call',[{to:other.address,data:'0x12345678'},'latest']));
  assert.throws(()=>check('eth_call',[{to:m.crash,data:'0x12345678'},'latest',{}]));
  assert.throws(()=>check('eth_getBlockByNumber',['latest',true]));
  check('eth_getLogs',[{address:m.crash,fromBlock:'0x2300',toBlock:'latest'}]);
  assert.throws(()=>check('eth_getLogs',[{address:m.crash,fromBlock:'0x0',toBlock:'latest'}]));
  assert.throws(()=>check('eth_getLogs',[{fromBlock:'0x2300',toBlock:'latest'}]));
  assert.throws(()=>check('eth_getLogs',[{address:m.crash}]));
});
test('signed guests may commit round-bound bets and collect only through allowed game methods',async()=>{
  for(const data of [crash.encodeFunctionData('placeBetInRound',[1,20000]),crash.encodeFunctionData('withdraw')]){
    const raw=await guest.signTransaction({chainId:31337,to:m.crash,data,gasLimit:300000,gasPrice:1000000000});check('eth_sendRawTransaction',[raw]);
  }
});
test('signed transactions cannot change chain, sender, destination, admin selector, gas budget or stake cap',async()=>{
  const base={chainId:31337,to:m.crash,data:crash.encodeFunctionData('placeBetInRound',[1,20000]),gasLimit:300000,gasPrice:1000000000};
  for(const patch of [{chainId:4663},{to:other.address},{to:null},{data:crash.encodeFunctionData('freezeAdmissions')},{gasLimit:2000001},{value:parseEther('0.0010001')},{gasPrice:100000000001}]){
    const raw=await guest.signTransaction({...base,...patch});assert.throws(()=>check('eth_sendRawTransaction',[raw]));
  }
  assert.throws(()=>check('eth_sendRawTransaction',['0x00']));
  const raw=await other.signTransaction(base);assert.throws(()=>check('eth_sendRawTransaction',[raw]));
});
test('fuel approvals are exact destination and capped; guest cannot mint test assets through RPC',()=>{
  const token=new Interface(['function approve(address,uint256)','function mint(address,uint256)']);
  const call=(data:string)=>check('eth_estimateGas',[{from:guest.address,to:m.plank,data}]);
  call(token.encodeFunctionData('approve',[m.communityFuel,parseEther('100')]));
  assert.throws(()=>call(token.encodeFunctionData('approve',[other.address,1])));
  assert.throws(()=>call(token.encodeFunctionData('approve',[m.communityFuel,parseEther('5001')])));
  assert.throws(()=>call(token.encodeFunctionData('mint',[guest.address,1])));
});
