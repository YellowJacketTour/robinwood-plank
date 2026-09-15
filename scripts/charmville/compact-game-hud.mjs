const tasks=['','Prepare soil','Plant a seed','Water the seed','Roots are sprouting','Your plant is growing','Berries are flowering','Gather your crop','View this bed','Join a place to grow','Waiting for the world','Preparing your action','Move closer to this bed'];

export function parseCompactHud(text){
 const values=String(text).trim().split('|').map(Number);
 if(values.length!==14||values.some(n=>!Number.isSafeInteger(n))||values[0]!==1)return null;
 const [,welcome,task,bed,berries,xp,cuttings,guests,account,seeds,fed,canFeed,tick,farm]=values;
 if(welcome<0||welcome>2||task<0||task>=tasks.length||bed<1||bed>3||berries<0||xp< -1||cuttings<0||guests<0||seeds< -1||tick<0||[account,fed,canFeed,farm].some(n=>n!==0&&n!==1))return null;
 return {welcome,task,bed,berries,xp,cuttings,guests,account,seeds,fed,canFeed,tick,farm};
}


export function parseCropPresentation(text,run,bed){
 const v=String(text).trim().split('|').map(Number);
 if(v.length!==11||v.some(n=>!Number.isSafeInteger(n))||v[0]!==2||v[1]!==Number(run)||v[1]<1||v[2]!==bed-1||![1,2].includes(v[3])||![1,2].includes(v[4])||v[5]<0||v[5]>3||![0,1].includes(v[6])||v.slice(7).some(n=>n<0||n>200000))return null;
 return {run:v[1],bed:v[2],crop:v[3],choice:v[4],choices:v[5],busy:v[6]===1,balances:v.slice(7)};
}
const cropNames={1:'Oran',2:'Burning Heart'};

/** Read-only presentation. The lease only opts out of native footer drawing. */
export function mountCompactHud(root,{getFS=()=>globalThis.FS,isOverlayBlocked=()=>false}={}){
 const view=root.defaultView;
 const panel=root.createElement('section');panel.className='charm-compact-hud';panel.hidden=true;panel.setAttribute('aria-label','Current crop');
 panel.innerHTML='<div class="charm-compact-hud-line"><span data-task></span><button data-seed type="button" hidden>Change seed</button><button type="button" aria-expanded="false" aria-controls="charm-crop-details">Details</button></div><div id="charm-crop-details" hidden><p data-stock></p><p data-care></p></div>';
 const task=panel.querySelector('[data-task]'),button=panel.querySelector('[aria-controls="charm-crop-details"]'),details=panel.querySelector('#charm-crop-details'),stock=panel.querySelector('[data-stock]'),care=panel.querySelector('[data-care]');
 root.body.append(panel);
 const seedButton=panel.querySelector('[data-seed]');
 let cropState=null;
 seedButton?.addEventListener('click',()=>{if(!cropState||cropState.busy||cropState.choices!==3)return;const fs=getFS();if(!fs)return;fs.writeFile(fsPath+'resource-crop-choice.txt',[cropState.run,cropState.bed,cropState.choice===1?2:1].join('|'));root.querySelector('canvas')?.focus({preventScroll:true});});
 let lease=0,disposed=false,lastTick=-1,lastProgress=0,lastRun='',fsPath='';
 function place(){
  const canvas=root.querySelector('canvas'),rect=canvas?.getBoundingClientRect();
  if(!rect||rect.width<1||rect.height<1||rect.bottom<=0||rect.top>=view.innerHeight)return false;
  panel.style.left=`${Math.max(8,rect.left+8)}px`;
  panel.style.width=`${Math.max(0,Math.min(rect.width-16,view.innerWidth-16))}px`;
  panel.style.top=`${Math.max(rect.top,Math.min(rect.bottom,view.innerHeight)-panel.getBoundingClientRect().height-6)}px`;
  return true;
 }
 button.addEventListener('click',()=>{details.hidden=!details.hidden;button.setAttribute('aria-expanded',String(!details.hidden));place();});
 panel.addEventListener('keydown',event=>{if(event.key==='Escape'&&!details.hidden){details.hidden=true;button.setAttribute('aria-expanded','false');place();root.querySelector('canvas')?.focus({preventScroll:true});event.stopPropagation();}});
 function poll(){
  if(disposed)return;
  try{
   if(root.hidden||view.charmvilleMapOpen===true||isOverlayBlocked()||root.querySelector('.charm-runtime-enter')||root.body.classList.contains('charm-arrival-pending')){panel.hidden=true;return;}
   const fs=getFS();if(!fs)return;
   fsPath=fs.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/';
   const read=name=>fs.readFile(fsPath+name,{encoding:'utf8'}).replace(/\0/g,'').trim();
   const run=read('action-run.txt'),state=parseCompactHud(read('presentation-ui.txt'));
   if(!state){panel.hidden=true;return;}
   cropState=null;try{cropState=parseCropPresentation(read('presentation-crop.txt'),run,state.bed);}catch{}
   if(seedButton){seedButton.hidden=!cropState||cropState.choices!==3;seedButton.disabled=!!cropState?.busy;seedButton.textContent=cropState?'Seed: '+cropNames[cropState.choice]+' · Change':'Change seed';}
   const now=Date.now();
   if(run!==lastRun||state.tick!==lastTick){lastProgress=now;lastTick=state.tick;lastRun=run;}
   // A stalled/replaced native context cannot leave a stale task over a new map.
   if(now-lastProgress>2000||state.welcome<2||!state.farm||!state.task){panel.hidden=true;return;}
   const interact=[1,2,3,7].includes(state.task);
   const prompt=view.matchMedia('(pointer:coarse)').matches?'Interact':'E / D';
   const text=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
   text(task,`Bed ${state.bed} · ${interact?prompt+' — ':''}${cropState&&state.task===2?'Plant '+cropNames[cropState.choice]+' seed':cropState&&state.task===6?'Your plant is flowering':tasks[state.task]}`);
   text(stock,cropState?`${cropState.balances[1]} Oran · ${cropState.balances[0]} seeds / ${cropState.balances[3]} Burning Hearts · ${cropState.balances[2]} seeds`:state.account?`${state.berries} Oran · ${state.seeds} ${state.seeds===1?'seed':'seeds'} · ${state.guests} nearby`:`${state.berries} ${state.berries===1?'berry':'berries'} · ${state.xp} XP · ${state.guests} nearby`);
   text(care,state.canFeed?'D — Feed the soil with a cutting.':state.fed?'Soil fed. Your plant is growing.':`${state.cuttings} ${state.cuttings===1?'cutting':'cuttings'} · ${state.account?'Saved-world values':'Local adventure; progress is temporary'}`);
   panel.hidden=false;
   if(!place()){panel.hidden=true;return;}
   // Write only after valid, visible UI. If this module fails, native restores
   // its original footer after120 simulation frames without any gameplay change.
   fs.writeFile(fsPath+'presentation-ui-lease.txt',String(++lease));
  }catch{panel.hidden=true;}
 }
 const timer=view.setInterval(poll,250);
 view.addEventListener('resize',place);view.addEventListener('scroll',place,true);
 function dispose(){if(disposed)return;disposed=true;view.clearInterval(timer);view.removeEventListener('resize',place);view.removeEventListener('scroll',place,true);view.removeEventListener('pagehide',dispose);panel.remove();}
 view.addEventListener('pagehide',dispose,{once:true});poll();return dispose;
}
