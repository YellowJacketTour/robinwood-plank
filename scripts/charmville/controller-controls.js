// One input adapter owns controller events, avoiding duplicate SDL + keyboard input.
const readPads=navigator.getGamepads?.bind(navigator)||(()=>[]);
const menu=document.createElement('details');
menu.innerHTML='<summary>Controller</summary><p role="status">Press a controller button to connect.</p><label>Stick dead zone <input aria-label="Stick dead zone" type="range" min="10" max="50" value="22"></label><div class="charm-pad-mapping"></div><p>D-pad or left stick: move. Start: inventory. LB/RB: items. Mapping uses the default native keyboard controls.</p>';
document.querySelector('header').append(menu);
const touchActions=document.createElement('div');touchActions.className='flex justify-evenly';
for(const [action,label] of [['Ex3','Interact'],['Ex4','Aura']]){const button=document.createElement('div');button.className='touch-input';button.dataset.action=action;button.textContent=label;touchActions.append(button);}
document.querySelectorAll('.touch-inputs')[1]?.firstElementChild?.append(touchActions);
const defaults={Sword:0,Item:1,Interact:2,Aura:3};
let mapping={...defaults},deadzone=.22;
try{const saved=JSON.parse(localStorage.getItem('charmville-controller')||'null');if(saved){for(const action of Object.keys(mapping))if(Number.isInteger(saved.mapping?.[action])&&saved.mapping[action]>=0&&saved.mapping[action]<16)mapping[action]=saved.mapping[action];if(saved.deadzone>=.1&&saved.deadzone<=.5)deadzone=saved.deadzone;}}catch{/* Optional settings. */}
function save(){try{localStorage.setItem('charmville-controller',JSON.stringify({mapping,deadzone}));}catch{/* Optional settings. */}}
const dz=menu.querySelector('input');dz.value=String(deadzone*100);dz.oninput=()=>{deadzone=Number(dz.value)/100;save();};
for(const action of Object.keys(mapping)){const label=document.createElement('label');label.textContent=action+' ';const select=document.createElement('select');select.setAttribute('aria-label',action+' controller button');for(let i=0;i<16;i++){const option=document.createElement('option');option.value=String(i);option.textContent=['South / A / Cross','East / B / Circle','West / X / Square','North / Y / Triangle'][i]||'Button '+i;select.append(option);}select.value=String(mapping[action]);select.onchange=()=>{mapping[action]=Number(select.value);save();};label.append(select);menu.querySelector('.charm-pad-mapping').append(label);}
const keys={ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,z:90,x:88,d:68,c:67,Enter:13,q:81,w:87};
let held=new Set();
function emit(key,down){document.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{key,code:key.length===1?'Key'+key.toUpperCase():key,keyCode:keys[key],which:keys[key],bubbles:true}));}
function release(){for(const key of held)emit(key,false);held.clear();}
// SDL must not process the same hardware a second time. Other input stays native.
navigator.getGamepads=()=>[];
function poll(){
 const pad=[...readPads()].find(p=>p?.connected&&p.mapping==='standard');const next=new Set();
 const active=!document.querySelector('dialog[open]')&&!document.hidden&&document.hasFocus()&&!menu.open&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName);
 menu.querySelector('[role=status]').textContent=pad?'Connected: '+pad.id:'Press a controller button to connect.';
 if(pad&&active){const pressed=i=>Boolean(pad.buttons[i]?.pressed);if(pressed(12)||(pad.axes[1]||0)<-deadzone)next.add('ArrowUp');if(pressed(13)||(pad.axes[1]||0)>deadzone)next.add('ArrowDown');if(pressed(14)||(pad.axes[0]||0)<-deadzone)next.add('ArrowLeft');if(pressed(15)||(pad.axes[0]||0)>deadzone)next.add('ArrowRight');for(const [action,key] of Object.entries({Sword:'z',Item:'x',Interact:'d',Aura:'c'}))if(pressed(mapping[action]))next.add(key);if(pressed(9))next.add('Enter');if(pressed(4))next.add('q');if(pressed(5))next.add('w');}
 for(const key of held)if(!next.has(key))emit(key,false);for(const key of next)if(!held.has(key))emit(key,true);held=next;requestAnimationFrame(poll);
}
addEventListener('blur',release);addEventListener('gamepaddisconnected',release);document.addEventListener('visibilitychange',release);requestAnimationFrame(poll);
