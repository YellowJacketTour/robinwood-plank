// The host retains authentication; this bridge carries presentation only.
const origins=['http://localhost:3017','http://127.0.0.1:3017'];
let state=null,run=null,sequence=0,pending=null,page=null,button=null;
const nonce=()=>crypto.getRandomValues(new Uint32Array(1))[0]%100000+1;
const root=()=>FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/';
const read=name=>FS.analyzePath(root()+name).exists?FS.readFile(root()+name,{encoding:'utf8'}).replace(/\0/g,'').trim():'';
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
 if(parent===window)return;
 for(const origin of origins)parent.postMessage({type:'charmville:tutorial-ready'},origin);
 mount();
 if(!state||typeof FS==='undefined')return;
 try{
  const currentRun=read('action-run.txt');if(!currentRun)return;
  if(run!==currentRun){run=currentRun;state.nonce=nonce();reset();}
  FS.writeFile(root()+'tutorial-state.txt',`${state.completed?1:0}|${state.nonce}`);
  const progress=read('tutorial-progress.txt').split('|').map(Number);
  if(progress.length!==3||progress[0]!==state.nonce)return;
  page=progress[1];
  if(pending&&progress[2]>=pending.sequence)pending=null;
  if(pending)FS.writeFile(root()+'tutorial-request.txt',`${state.nonce}|${pending.sequence}|${pending.page}`);
  if(button){button.hidden=state.completed||page>=2;button.disabled=Boolean(pending);button.textContent=page===1?'Begin exploring':'Continue introduction';}
  if(!state.completed&&page===2)parent.postMessage({type:'charmville:tutorial-completed',context:state.context},state.origin);
 }catch{/* Runtime files are unavailable during initialization. */}
},200);
window.addEventListener('pagehide',()=>{clearInterval(timer);button?.remove();},{once:true});
