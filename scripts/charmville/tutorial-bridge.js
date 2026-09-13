// The host retains authentication; this bridge carries a presentation preference only.
const origins=['http://localhost:3017','http://127.0.0.1:3017'];
let state=null;
window.addEventListener('message',event=>{
 if(event.source!==parent||!origins.includes(event.origin))return;
 const value=event.data;
 if(value?.type!=='charmville:tutorial-state'||typeof value.context!=='string'||typeof value.completed!=='boolean')return;
 if(state&&state.context!==value.context&&typeof FS!=='undefined'){
  try{FS.writeFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/tutorial-completed.txt','0');}catch{}
 }
 state={context:value.context,completed:value.completed,origin:event.origin};
});
const timer=setInterval(()=>{
 if(parent===window)return;
 for(const origin of origins)parent.postMessage({type:'charmville:tutorial-ready'},origin);
 if(!state||typeof FS==='undefined')return;
 try{
  const root=FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/';
  if(!FS.analyzePath(root+'action-run.txt').exists)return;
  FS.writeFile(root+'tutorial-state.txt',state.completed?'1':'0');
  if(!state.completed&&FS.analyzePath(root+'tutorial-completed.txt').exists&&FS.readFile(root+'tutorial-completed.txt',{encoding:'utf8'}).replace(/\0/g,'').trim()==='1')parent.postMessage({type:'charmville:tutorial-completed',context:state.context},state.origin);
 }catch{/* Runtime files are unavailable during initialization. */}
},1000);
window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
