// One input adapter owns controller events, avoiding duplicate SDL + keyboard input.
const readPads=navigator.getGamepads?.bind(navigator)||(()=>[]);
const menu=document.createElement('details');
menu.innerHTML='<summary>Controller</summary><p role="status">Press a controller button to connect.</p><label>Stick dead zone <input aria-label="Stick dead zone" type="range" min="10" max="50" value="22"></label><div class="charm-pad-mapping"></div><p>D-pad or left stick: move. View/Back: Charmdex. In menus: South confirms, East closes, D-pad changes focus; left/right changes a selected option. Start: Game menu. LB/RB: items. Face-button remapping swaps assignments; menu South/East stay fixed. Mapping uses the default native keyboard controls.</p>';
document.querySelector('header').append(menu);
const touchActions=document.createElement('div');touchActions.className='flex justify-evenly';
// These extra actions are absent from upstream's touch BUTTON_MAP. Own them
// explicitly, without touch-input/data-action hooks that could double-dispatch.
for(const [key,label] of [['d','Interact'],['c','Aura']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.style.touchAction='none';bindNativeActionButton(button,key,emit,window,document);touchActions.append(button);}
document.querySelectorAll('.touch-inputs')[1]?.firstElementChild?.append(touchActions);
const defaults={Sword:0,Item:1,Interact:2,Aura:3};
let mapping={...defaults},deadzone=.22;
try{const saved=JSON.parse(localStorage.getItem('charmville-controller')||'null');if(saved){const candidate=Object.keys(defaults).map(action=>saved.mapping?.[action]);if(candidate.every(value=>Number.isInteger(value)&&value>=0&&value<4)&&new Set(candidate).size===4)mapping=Object.fromEntries(Object.keys(defaults).map((action,index)=>[action,candidate[index]]));if(saved.deadzone>=.1&&saved.deadzone<=.5)deadzone=saved.deadzone;}}catch{/* Optional settings. */}
function save(){try{localStorage.setItem('charmville-controller',JSON.stringify({mapping,deadzone}));}catch{/* Optional settings. */}}
const dz=menu.querySelector('input');dz.value=String(deadzone*100);dz.oninput=()=>{deadzone=Number(dz.value)/100;save();};
for(const action of Object.keys(mapping)){const label=document.createElement('label');label.textContent=action+' ';const select=document.createElement('select');select.setAttribute('aria-label',action+' controller button');for(let i=0;i<4;i++){const option=document.createElement('option');option.value=String(i);option.textContent=['South / A / Cross','East / B / Circle','West / X / Square','North / Y / Triangle'][i]||'Button '+i;select.append(option);}select.value=String(mapping[action]);select.onchange=()=>{const next=Number(select.value);if(!Number.isInteger(next)||next<0||next>3)return;const old=mapping[action],other=Object.keys(mapping).find(key=>key!==action&&mapping[key]===next);mapping[action]=next;if(other)mapping[other]=old;for(const key of Object.keys(mapping))menu.querySelector('[aria-label="'+key+' controller button"]').value=String(mapping[key]);save();};label.append(select);menu.querySelector('.charm-pad-mapping').append(label);}
const keys={ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,z:90,x:88,d:68,e:69,c:67,Enter:13,q:81,w:87};
let held=new Set(),previous=new Set(),lastDialog=null,neutralRequired=false;
function emit(key,down){const event=new KeyboardEvent(down?'keydown':'keyup',{key,code:key.length===1?'Key'+key.toUpperCase():key,keyCode:keys[key],which:keys[key],bubbles:true});Object.defineProperty(event,'charmNativeController',{value:true});document.dispatchEvent(event);}
// BEGIN native action buttons
function bindNativeActionButton(button,key,send,host,root){
 let pointer=null,pressed=false;
 const down=()=>{if(!pressed){pressed=true;send(key,true);}};
 const up=()=>{if(pressed){pressed=false;send(key,false);}pointer=null;};
 button.addEventListener('pointerdown',event=>{if(pointer!==null||event.button!==0)return;event.preventDefault();pointer=event.pointerId;button.setPointerCapture?.(pointer);down();});
 const end=event=>{if(event.pointerId===pointer)up();};
 for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,end);
 button.addEventListener('keydown',event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();event.stopPropagation();down();}});
 button.addEventListener('keyup',event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();event.stopPropagation();up();}});
 button.addEventListener('blur',up);host.addEventListener('blur',up);
 root.addEventListener('visibilitychange',()=>{if(root.hidden)up();});
}
// END native action buttons
function release(){for(const key of held)emit(key,false);held.clear();}
// Native actions are sampled by the game frame. Retain only very short action
// taps; movement, menus, and long charge/release timing remain untouched.
// BEGIN action tap retention
function retainActionTaps({target,active,sendUp,now,schedule,cancel}){
 const actions=new Set(['z','x','d','e','c']),pending=new Map(),forwarded=new WeakSet();
 function finish(key){const entry=pending.get(key);if(!entry)return;cancel(entry.timer);pending.delete(key);sendUp(key,forwarded);}
 function clear(){for(const key of [...pending.keys()])finish(key);}
 target.addEventListener('keydown',event=>{
  if(forwarded.has(event))return;
  if(event.key==='Enter'||event.key==='Escape'){clear();return;}
  const key=event.key?.toLowerCase();
  if(!actions.has(key)||!active(event)||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
  const entry=pending.get(key);
  if(entry){if(entry.timer!==null){cancel(entry.timer);entry.timer=null;}return;}
  pending.set(key,{start:now(),timer:null});
 },true);
 target.addEventListener('keyup',event=>{
  if(forwarded.has(event))return;
  const key=event.key?.toLowerCase(),entry=pending.get(key);if(!entry)return;
  if(!active(event)){cancel(entry.timer);pending.delete(key);return;}
  const remaining=40-(now()-entry.start);
  if(remaining<=0){cancel(entry.timer);pending.delete(key);return;}
  event.stopImmediatePropagation();event.preventDefault();
  cancel(entry.timer);entry.timer=schedule(()=>finish(key),remaining);
 },true);
 return clear;
}
// END action tap retention
function gameplayActionTarget(event){
 const element=event?.target;
 return !document.hidden&&document.hasFocus()&&!menu.open&&!document.querySelector('dialog[open]')&&
  !element?.closest?.('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"])')&&
  (element?.tagName==='CANVAS'||document.activeElement?.tagName==='CANVAS');
}
// BEGIN canvas navigation
function bindCanvasNavigation(host,root){
 host.addEventListener('keydown',event=>{
  if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
  if(root.hidden||!root.hasFocus()||root.querySelector('dialog[open]'))return;
  if(root.activeElement?.tagName!=='CANVAS')return;
  if(event.target!==root.activeElement&&event.target!==root&&event.target!==root.body)return;
  // Cancel only browser scrolling. Native listeners still receive the original
  // key, including arrows used by the native equipment/system menus.
  event.preventDefault();
 },true);
}
// END canvas navigation
bindCanvasNavigation(window,document);
const clearActionTaps=retainActionTaps({target:window,active:gameplayActionTarget,
 now:()=>performance.now(),schedule:setTimeout,cancel:clearTimeout,
 sendUp:(key,forwarded)=>{const event=new KeyboardEvent('keyup',{key,code:'Key'+key.toUpperCase(),keyCode:keys[key],which:keys[key],bubbles:true});forwarded.add(event);document.dispatchEvent(event);}});
// SDL must not process the same hardware a second time. Other input stays native.
navigator.getGamepads=()=>[];
function modalAction(dialog,action){
 const event=new CustomEvent('charm-menu-action',{cancelable:true,detail:{action,dialog}});
 if(!document.dispatchEvent(event))return;
 if(action==='back'){dialog.close();return;}
 const controls=[...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length);
 const current=document.activeElement,index=controls.indexOf(current);
 if(action==='confirm'){if(controls.includes(current))current.click();return;}
 if(current?.tagName==='SELECT'&&(action==='left'||action==='right')){
  current.selectedIndex=Math.max(0,Math.min(current.options.length-1,current.selectedIndex+(action==='left'?-1:1)));
  current.dispatchEvent(new Event('input',{bubbles:true}));current.dispatchEvent(new Event('change',{bubbles:true}));return;
 }
 const step=action==='up'||action==='left'?-1:1;
 controls[(index+step+controls.length)%controls.length]?.focus();
}
function poll(){
 if(!gameplayActionTarget())clearActionTaps();
 const pad=[...readPads()].find(p=>p?.connected&&p.mapping==='standard');const next=new Set();
 const buttons=new Set();if(pad){pad.buttons.forEach((button,i)=>{if(button.pressed)buttons.add(i);});if((pad.axes[1]||0)<-deadzone)buttons.add(12);if((pad.axes[1]||0)>deadzone)buttons.add(13);if((pad.axes[0]||0)<-deadzone)buttons.add(14);if((pad.axes[0]||0)>deadzone)buttons.add(15);}
 const dialog=document.querySelector('dialog[open]');
 if(dialog!==lastDialog){release();neutralRequired=true;lastDialog=dialog;}
 if(!pad||document.hidden||!document.hasFocus()){release();neutralRequired=true;}
 if(pad&&!document.hidden&&document.hasFocus()&&!buttons.size)neutralRequired=false;
 const edge=i=>buttons.has(i)&&!previous.has(i);
 if(pad&&!document.hidden&&document.hasFocus()&&!neutralRequired){
  if(dialog){for(const [i,action] of [[1,'back'],[12,'up'],[13,'down'],[14,'left'],[15,'right'],[0,'confirm']])if(edge(i)){modalAction(dialog,action);break;}}
  else if(edge(8)){release();const opener=document.querySelector('[data-charmdex-open]')||[...document.querySelectorAll('header button')].find(el=>el.textContent.trim()==='Charmdex');opener?.click();neutralRequired=true;}
 }
 // A confirm can close the modal during this same polling frame. Gate native
 // input immediately, rather than waiting for the next frame's dialog change.
 if(document.querySelector('dialog[open]')!==dialog){release();neutralRequired=true;}
 const active=!document.querySelector('dialog[open]')&&!document.hidden&&document.hasFocus()&&!menu.open&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName);
 menu.querySelector('[role=status]').textContent=pad?'Connected: '+pad.id:'Press a controller button to connect.';
 if(pad&&active&&!neutralRequired&&!document.querySelector('dialog[open]')){const pressed=i=>Boolean(pad.buttons[i]?.pressed);if(pressed(12)||(pad.axes[1]||0)<-deadzone)next.add('ArrowUp');if(pressed(13)||(pad.axes[1]||0)>deadzone)next.add('ArrowDown');if(pressed(14)||(pad.axes[0]||0)<-deadzone)next.add('ArrowLeft');if(pressed(15)||(pad.axes[0]||0)>deadzone)next.add('ArrowRight');for(const [action,key] of Object.entries({Sword:'z',Item:'x',Interact:'d',Aura:'c'}))if(pressed(mapping[action]))next.add(key);if(pressed(9))next.add('Enter');if(pressed(4))next.add('q');if(pressed(5))next.add('w');}
 for(const key of held)if(!next.has(key))emit(key,false);for(const key of next)if(!held.has(key))emit(key,true);held=next;previous=buttons;requestAnimationFrame(poll);
}
function suspend(){clearActionTaps();release();neutralRequired=true;}
addEventListener('blur',suspend);addEventListener('gamepaddisconnected',suspend);document.addEventListener('visibilitychange',suspend);requestAnimationFrame(poll);
