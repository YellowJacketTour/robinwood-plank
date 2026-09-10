// Free simulated balances only. The gateway independently enforces the chain and guest capabilities.
export function mountInvitePlay({connect}) {
  const note=document.createElement('p');note.textContent='Simulated crew fills otherwise empty test rounds and follows the same payout rules.';document.querySelector('.console-rules')?.append(note);
  const auto=document.getElementById('autoToggle');
  const bar=document.createElement('div');bar.className='invite-player';
  bar.innerHTML='<output aria-label="Simulated ETH balance">Joining…</output><button type="button" class="invite-repeat" aria-label="Start automatic play" disabled>↻ Repeat</button><button type="button" class="invite-copy" aria-label="Copy friend invite link" title="Copy invite link">↗ Invite</button>';
  document.querySelector('.deck').prepend(bar);
  const balance=bar.querySelector('output'),repeat=bar.querySelector('.invite-repeat'),copy=bar.querySelector('.invite-copy');
  const refill=document.createElement('button');refill.type='button';refill.className='console-economy';refill.textContent='Refill test ETH';document.querySelector('.console-drawer').append(refill);
  let connection=null,invite='',busy=false,joining=false,hydrated=false;
  function paintRepeat(){const playing=auto.classList.contains('active');repeat.textContent=playing?'⏸ Pause':'↻ Repeat';repeat.setAttribute('aria-label',playing?'Pause automatic play':'Start automatic play');repeat.setAttribute('aria-pressed',String(playing));}
  new MutationObserver(()=>{paintRepeat();if(hydrated)localStorage.setItem('plank:invite:auto',auto.classList.contains('active')?'playing':'paused');}).observe(auto,{attributes:true,attributeFilter:['class']});
  repeat.onclick=()=>{auto.click();paintRepeat();};
  copy.onclick=async()=>{
    if(!invite)return;
    const link=new URL('/',location.origin);link.hash=new URLSearchParams({invite}).toString();
    try{await navigator.clipboard.writeText(link.href);copy.textContent='✓ Copied';setTimeout(()=>copy.textContent='↗ Invite',2000);}
    catch{const input=document.createElement('input');input.value=link.href;input.readOnly=true;input.setAttribute('aria-label','Friend invite link');bar.append(input);input.select();}
  };
  async function updateBalance(){if(!connection||busy)return;busy=true;try{
    const value=await connection.provider.getBalance(connection.address);
    const formatted=Number(window.ethers.formatEther(value)).toLocaleString('en-US',{minimumFractionDigits:4,maximumFractionDigits:6});
    balance.textContent=`Ξ ${formatted}`;balance.title='Your simulated ETH · no cash value';balance.dataset.address=connection.address;
    refill.disabled=value>window.ethers.parseEther('0.005');
  }catch{balance.textContent='Reconnecting…';}finally{busy=false;}}
  refill.onclick=async()=>{refill.disabled=true;try{const r=await fetch('/api/invite/refill',{method:'POST'});const result=await r.json();if(!r.ok)throw Error(result.error);await updateBalance();}catch(error){refill.textContent=error.message;setTimeout(()=>refill.textContent='Refill test ETH',4000);}finally{refill.disabled=false;}};
  async function join(){
    if(joining||connection)return;joining=true;balance.textContent='Joining…';
    try{
      const r=await fetch('/api/invite/session',{cache:'no-store'});
      if(r.status===401){location.replace('/');return;}
      if(!r.ok)throw Error('Test unavailable');const session=await r.json();
      if(session.simulated!==true)throw Error('Free test unavailable');
      invite=session.invite;connection=await connect(session.key);repeat.disabled=false;
      // Joining observes the independent round clock. A wager requires Play,
      // or an explicit repeat opt-in in this session; never spend on reconnect.
      if(auto.classList.contains('active'))auto.click();
      localStorage.setItem('plank:invite:auto','paused');hydrated=true;paintRepeat();await updateBalance();
    }catch{balance.textContent='Tap to retry';balance.onclick=join;balance.style.cursor='pointer';}
    finally{joining=false;}
  }
  document.addEventListener('plank:join-invite',join);
  void join();setInterval(updateBalance,5000);
}
