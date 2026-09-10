// The candidate is enabled only in the loopback practice deployment.
const local=document.querySelector('meta[name="plank-invite"]')?.content==='simulated'||['127.0.0.1','localhost'].includes(location.hostname);
if(local)document.addEventListener('plank:connected',async event=>{
  const {signer,provider}=event.detail;
  if((await provider.getNetwork()).chainId!==31337n)return;
  const m=await(await fetch('deploy-addresses.local.json',{cache:'no-store'})).json();
  if(!m.communityFuel)return;
  const {ethers}=window;
  const fuel=new ethers.Contract(m.communityFuel,['function quote(uint256) view returns(uint256 roundId,uint256 boost,bool available)','function burnFuel(uint256,uint256,uint256,uint256)','function totalBurned() view returns(uint256)'],signer);
  const token=new ethers.Contract(m.plank,['function approve(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)','function balanceOf(address) view returns(uint256)'],signer);
  document.getElementById('communityFuelControl')?.remove();
  const details=document.createElement('details');details.id='communityFuelControl';
  details.innerHTML='<summary>Fuel · burn PLANK</summary><div><label>PLANK <input type="number" min="1" step="1" value="100" aria-label="PLANK to burn"></label><p></p><button type="button">Burn & fuel</button><small>Practice prototype. Burns test PLANK to send sponsor-backed ETH to the shared vault. No personal odds boost.</small></div>';
  document.querySelector('.deck').append(details);
  const amount=details.querySelector('input'),status=details.querySelector('p'),button=details.querySelector('button');let busy=false;
  async function quote(){
    if(busy)return;
    try{const value=ethers.parseUnits(amount.value,18);const q=await fuel.quote(value);button.disabled=!q.available;status.textContent=q.available?`Ξ ${ethers.formatEther(q.boost)} ETH to the shared vault`:'Fuel available during betting, within funded limits';}catch{button.disabled=true;status.textContent='Enter a valid amount';}
  }
  amount.addEventListener('input',quote);details.addEventListener('toggle',quote);
  const timer=setInterval(()=>{if(!details.isConnected){clearInterval(timer);return;}if(details.open)void quote();},2000);
  button.addEventListener('click',async()=>{
    if(busy)return;busy=true;button.disabled=true;amount.disabled=true;
    try{
      const value=ethers.parseUnits(amount.value,18),q=await fuel.quote(value);if(!q.available)throw new Error('Fuel window closed or backing unavailable');
      const address=await signer.getAddress();
      if(await token.allowance(address,m.communityFuel)<value){status.textContent='Approving the exact PLANK amount…';await(await token.approve(m.communityFuel,value)).wait();}
      const block=await provider.getBlock('latest');status.textContent='Confirming burn…';
      await(await fuel.burnFuel(value,q.roundId,q.boost,BigInt(block.timestamp+60))).wait();
      status.textContent=`Burned ${amount.value} PLANK · Ξ ${ethers.formatEther(q.boost)} ETH delivered`;
      details.dataset.confirmed='true';
    }catch(error){status.textContent=error.shortMessage||error.message;}
    finally{busy=false;button.disabled=false;amount.disabled=false;}
  });
  void quote();
});
