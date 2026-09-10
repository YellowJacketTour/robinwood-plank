// No privileged key is stored here. Buttons prepare multisig calls; a connected
// contract-account provider may submit only when its account has the exact role.
const $=id=>document.getElementById(id),local=['127.0.0.1','localhost'].includes(location.hostname);
let provider,contract,address,chainId,busy=false;
const abi=['function guardian() view returns(address)','function safetyGovernance() view returns(address)','function admissionsPaused() view returns(bool)','function reopenAt() view returns(uint256)','function recoveryPending() view returns(bool)','function freeze()','function requestReopen()','function executeReopen()'];
async function refresh(){
 const [frozen,at,block,pending]=await Promise.all([contract.admissionsPaused(),contract.reopenAt(),provider.getBlock('latest'),contract.recoveryPending()]);
 $('state').textContent=pending?'Frozen · waiting for the original result':!frozen?'New bets open':at===0n?'New bets frozen':Number(at)>block.timestamp?`Frozen · reopening available in ${Math.ceil((Number(at)-block.timestamp)/60)} min`:'Frozen · approved reopening ready';
 $('freeze').disabled=busy; $('reopen').disabled=busy||!frozen||pending;
 return {frozen,at,pending,now:BigInt(block.timestamp)};
}
async function action(freeze){
 if(busy)return;busy=true;$('result').textContent='';
 try{
  const state=await refresh();
  if(!freeze&&state.pending)throw Error('The original round must settle before reopening.');
  const method=freeze?'freeze':state.at===0n?'requestReopen':'executeReopen';
  if(method==='executeReopen'&&state.now<state.at)throw Error('The on-chain reopening delay has not elapsed.');
  const tx={to:address,value:'0',data:contract.interface.encodeFunctionData(method)};
  $('transaction').textContent=JSON.stringify({version:'1.0',chainId:chainId.toString(),meta:{name:`PlankCrash ${method}`},transactions:[tx]},null,2);
  if(!window.ethereum){$('result').textContent='Transaction prepared for your multisig.';return;}
  const wallet=new ethers.BrowserProvider(window.ethereum);await wallet.send('eth_requestAccounts',[]);
  if((await wallet.getNetwork()).chainId!==chainId)throw Error('Connect the wallet to the displayed chain.');
  const signer=await wallet.getSigner(),who=(await signer.getAddress()).toLowerCase();
  const [guardian,governance]=await Promise.all([contract.guardian(),contract.safetyGovernance()]);
  const allowed=method==='executeReopen'||who===governance.toLowerCase()||(method==='freeze'&&who===guardian.toLowerCase());
  if(!allowed){$('result').textContent='Transaction prepared. Approval must come from the authorized multisig.';return;}
  await (await signer.sendTransaction(tx)).wait(1,60000);$('result').textContent='Confirmed on chain.';
 }catch(error){$('result').textContent=error.shortMessage||error.message||'Unable to confirm. Check the chain before retrying.';}
 finally{busy=false;await refresh().catch(()=>{$('freeze').disabled=true;$('reopen').disabled=true;});}
}
$('freeze').onclick=()=>action(true);$('reopen').onclick=()=>action(false);
try{
 const response=await fetch(local?'deploy-addresses.local.json':'deploy-addresses.mainnet.json',{cache:'no-store'});
 if(!response.ok)throw Error('Safety deployment is not configured.');
 const manifest=await response.json();address=ethers.getAddress(manifest.crash);chainId=local?31337n:4663n;
 provider=local?new ethers.JsonRpcProvider('http://127.0.0.1:8545'):new ethers.BrowserProvider(window.ethereum);
 if((await provider.getNetwork()).chainId!==chainId)throw Error('Wrong chain. No safety transaction can be prepared.');
 contract=new ethers.Contract(address,abi,provider);$('identity').textContent=`Chain ${chainId} · ${address}`;
 await refresh();setInterval(()=>{if(!busy)refresh().catch(()=>{$('state').textContent='Connection unavailable';$('freeze').disabled=true;$('reopen').disabled=true;});},3000);
}catch(error){$('state').textContent=error.message;$('freeze').disabled=true;$('reopen').disabled=true;}
