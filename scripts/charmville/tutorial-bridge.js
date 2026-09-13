// The host retains authentication; this bridge carries presentation only.
const origins=['http://localhost:3017','http://127.0.0.1:3017'];
let state=null,run=null,sequence=0,pending=null,page=null,button=null;
const nonce=()=>crypto.getRandomValues(new Uint32Array(1))[0]%100000+1;
// Standalone native play needs the same accessible introduction controls.
// This local presentation context never grants an account or inventory rights.
if(parent===window)state={context:'local',nonce:nonce(),completed:false};
const root=()=>FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/';
const read=name=>FS.analyzePath(root()+name).exists?FS.readFile(root()+name,{encoding:'utf8'}).replace(/\0/g,'').trim():'';
// Returning players skip the two introduction buttons that normally transfer
// keyboard focus. Remember their explicit Enter action until native arrival.
let enterFocusRequested=false,enterButton=null;
document.addEventListener('click',event=>{
 const target=event.target?.closest?.('button.charm-runtime-enter');
 if(target){enterFocusRequested=true;enterButton=target;}
},true);
function reset(){sequence=0;pending=null;page=null;if(button)button.hidden=true;}
window.addEventListener('message',event=>{
 if(event.source!==parent||!origins.includes(event.origin))return;
 const value=event.data;
 if(value?.type==='charmville:tutorial-reset'&&value.context===state?.context){state=null;reset();return;}
 if(value?.type!=='charmville:tutorial-state'||typeof value.context!=='string'||typeof value.completed!=='boolean')return;
 if(!state||state.context!==value.context){reset();state={context:value.context,nonce:nonce()};}
 Object.assign(state,{completed:value.completed,origin:event.origin});
 if(state.completed&&button)button.hidden=true;
});
function mount(){
 if(button?.isConnected)return;
 const header=document.querySelector('header');if(!header)return;
 if(!header.querySelector('.charm-focus-game')){
  const focus=document.createElement('button');focus.type='button';focus.className='charm-focus-game';focus.textContent='Resume keyboard play';
  focus.addEventListener('click',()=>{if(document.querySelector('dialog[open]'))return;const canvas=document.querySelector('canvas');if(canvas){canvas.tabIndex=0;canvas.focus({preventScroll:true});}});
  header.append(focus);
 }
 button=document.createElement('button');button.type='button';button.hidden=true;
 button.className='charm-tutorial-continue';button.textContent='Continue introduction';
 button.addEventListener('click',()=>{
  if(!state||state.completed||page===null||page>=2||pending)return;
  pending={sequence:++sequence,page};button.disabled=true;
  // Retried unchanged until acknowledged; expected-page prevents double advance.
  try{FS.writeFile(root()+'tutorial-request.txt',`${state.nonce}|${pending.sequence}|${pending.page}`);}catch{pending=null;button.disabled=false;}
 });
 header.append(button);
}
const timer=setInterval(()=>{
 if(parent!==window)for(const origin of origins)parent.postMessage({type:'charmville:tutorial-ready'},origin);
 mount();
 if(!state||typeof FS==='undefined')return;
 try{
  const currentRun=read('action-run.txt');if(!currentRun)return;
  if(run!==currentRun){run=currentRun;state.nonce=nonce();reset();}
  FS.writeFile(root()+'tutorial-state.txt',`${state.completed?1:0}|${state.nonce}`);
  const progress=read('tutorial-progress.txt').split('|').map(Number);
  if(progress.length!==3||progress[0]!==state.nonce)return;
  page=progress[1];
  const finishedByButton=page>=2&&pending?.page===1&&progress[2]>=pending.sequence;
  if(pending&&progress[2]>=pending.sequence)pending=null;
  // Native canvas clicks open its system menu. Transfer keyboard focus only
  // after our final introduction request is acknowledged, without a click.
  // Do not steal focus if the player moved to another control or application.
  const returningArrival=enterFocusRequested&&state.completed&&page>=2&&!document.body.classList.contains('charm-arrival-pending');
  if((finishedByButton||returningArrival)&&(document.activeElement===button||document.activeElement===enterButton||document.activeElement===document.body)&&document.hasFocus()&&!document.querySelector('dialog[open]')){
   const canvas=document.querySelector('canvas');
   if(canvas){canvas.tabIndex=0;canvas.focus({preventScroll:true});}
  }
  // Do not later steal focus back if the player chose another control or app.
  if(finishedByButton||returningArrival){enterFocusRequested=false;enterButton=null;}
  if(pending)FS.writeFile(root()+'tutorial-request.txt',`${state.nonce}|${pending.sequence}|${pending.page}`);
  if(button){button.hidden=window.charmvilleMapOpen===true||state.completed||page>=2;button.disabled=Boolean(pending);button.textContent=page===1?'Begin exploring':'Continue introduction';}
  if(!state.completed&&page===2){if(parent!==window)parent.postMessage({type:'charmville:tutorial-completed',context:state.context},state.origin);else state.completed=true;}
 }catch{/* Runtime files are unavailable during initialization. */}
},200);
window.addEventListener('pagehide',()=>{clearInterval(timer);button?.remove();},{once:true});
