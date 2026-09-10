// One input adapter owns controller events, avoiding duplicate SDL + keyboard input.
const readPads=navigator.getGamepads?.bind(navigator)||(()=>[]);
const menu=document.createElement('details');
menu.innerHTML='<summary>Controller</summary><p role="status">Press a controller button to connect.</p><label>Stick dead zone <input aria-label="Stick dead zone" type="range" min="10" max="50" value="22"></label><div class="charm-pad-mapping"></div><p>D-pad or left stick: move. View/Back: Charmdex. In menus: South confirms, East closes, D-pad changes focus; left/right changes a selected option. Start: Game menu. LB/RB: items. Face-button remapping swaps assignments; menu South/East stay fixed. Mapping uses the default native keyboard controls.</p>';
document.querySelector('header').append(menu);
const touchActions=document.createElement('div');touchActions.className='flex justify-evenly';
for(const [action,label] of [['Ex3','Interact'],['Ex4','Aura']]){const button=document.createElement('div');button.className='touch-input';button.dataset.action=action;button.textContent=label;touchActions.append(button);}
document.querySelectorAll('.touch-inputs')[1]?.firstElementChild?.append(touchActions);
const defaults={Sword:0,Item:1,Interact:2,Aura:3};
let mapping={...defaults},deadzone=.22;
try{const saved=JSON.parse(localStorage.getItem('charmville-controller')||'null');if(saved){const candidate=Object.keys(defaults).map(action=>saved.mapping?.[action]);if(candidate.every(value=>Number.isInteger(value)&&value>=0&&value<4)&&new Set(candidate).size===4)mapping=Object.fromEntries(Object.keys(defaults).map((action,index)=>[action,candidate[index]]));if(saved.deadzone>=.1&&saved.deadzone<=.5)deadzone=saved.deadzone;}}catch{/* Optional settings. */}
function save(){try{localStorage.setItem('charmville-controller',JSON.stringify({mapping,deadzone}));}catch{/* Optional settings. */}}
const dz=menu.querySelector('input');dz.value=String(deadzone*100);dz.oninput=()=>{deadzone=Number(dz.value)/100;save();};
for(const action of Object.keys(mapping)){const label=document.createElement('label');label.textContent=action+' ';const select=document.createElement('select');select.setAttribute('aria-label',action+' controller button');for(let i=0;i<4;i++){const option=document.createElement('option');option.value=String(i);option.textContent=['South / A / Cross','East / B / Circle','West / X / Square','North / Y / Triangle'][i]||'Button '+i;select.append(option);}select.value=String(mapping[action]);select.onchange=()=>{const next=Number(select.value);if(!Number.isInteger(next)||next<0||next>3)return;const old=mapping[action],other=Object.keys(mapping).find(key=>key!==action&&mapping[key]===next);mapping[action]=next;if(other)mapping[other]=old;for(const key of Object.keys(mapping))menu.querySelector('[aria-label="'+key+' controller button"]').value=String(mapping[key]);save();};label.append(select);menu.querySelector('.charm-pad-mapping').append(label);}
const keys={ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,z:90,x:88,d:68,c:67,Enter:13,q:81,w:87};
let held=new Set(),previous=new Set(),lastDialog=null,neutralRequired=false;
function emit(key,down){document.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{key,code:key.length===1?'Key'+key.toUpperCase():key,keyCode:keys[key],which:keys[key],bubbles:true}));}
function release(){for(const key of held)emit(key,false);held.clear();}
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
function suspend(){release();neutralRequired=true;}
addEventListener('blur',suspend);addEventListener('gamepaddisconnected',suspend);document.addEventListener('visibilitychange',suspend);requestAnimationFrame(poll);
