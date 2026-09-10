import './voice-notes.js';
import './charmdex.js';
import './follower-bridge.js';
import './action-event-bridge.js';
import './position-observer.js';
import './account-peers.js';
import './world-encounter.js';
import './capture-bridge.js';
import './resource-bridge.js';
let accountOrigin=null,captureAvailable=false;
async function returnToAccountMenus(panel='inventory'){
  if(!['inventory','companions','exchange','friends'].includes(panel))return;
  if(window.parent===window){window.open('http://localhost:3017/charmville/world?panel='+panel,'_blank','noopener');return;}
  if(document.fullscreenElement)try{await document.exitFullscreen();}catch{/* The parent also checks its iframe fullscreen state. */}
  if(accountOrigin)window.parent.postMessage({type:'charmville:account-menu',panel},accountOrigin);
}
let unifiedMenu=null,forwarding=false,nativeEquipment=false;
const suppressedKeys=new Set();
function nativeKey(key,code,down){forwarding=true;try{document.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{key,code:key,keyCode:code,which:code,bubbles:true}));}finally{forwarding=false;}}
function moveUnifiedFocus(action){
  const choices=[...unifiedMenu.querySelectorAll('button:not(:disabled)')].filter(button=>button.getClientRects().length);
  const current=document.activeElement;if(!choices.includes(current)){choices[0]?.focus();return;}
  const from=current.getBoundingClientRect(),horizontal=action==='left'||action==='right',sign=action==='left'||action==='up'?-1:1;
  const cx=(from.left+from.right)/2,cy=(from.top+from.bottom)/2;
  const candidates=choices.filter(button=>button!==current).map(button=>{const rect=button.getBoundingClientRect(),dx=(rect.left+rect.right)/2-cx,dy=(rect.top+rect.bottom)/2-cy;return {button,rect,primary:(horizontal?dx:dy)*sign,orthogonal:horizontal?Math.abs(dy):Math.abs(dx)};}).filter(item=>item.primary>1&&(!horizontal||(item.rect.top<from.bottom&&item.rect.bottom>from.top)));
  candidates.sort((a,b)=>(a.orthogonal*4+a.primary)-(b.orthogonal*4+b.primary));candidates[0]?.button.focus();
}
if(typeof document!=='undefined')document.addEventListener('charm-menu-action',event=>{
  if(event.detail?.dialog!==unifiedMenu||!unifiedMenu?.open)return;
  if(['up','down','left','right'].includes(event.detail.action)){event.preventDefault();moveUnifiedFocus(event.detail.action);}
});
function openUnifiedMenu(){
  if(!unifiedMenu||document.querySelector('dialog[open]'))return;
  unifiedMenu.querySelector('[data-destination="capture"]').disabled=!captureAvailable;
  unifiedMenu.querySelector('[data-destination="gear"]').disabled=Boolean(document.querySelector('button.charm-runtime-enter'));
  for(const [key,code] of [['ArrowUp',38],['ArrowDown',40],['ArrowLeft',37],['ArrowRight',39],['z',90],['x',88],['d',68],['c',67],['Enter',13]])nativeKey(key,code,false);
  unifiedMenu.showModal();unifiedMenu.querySelector('button:not(:disabled)').focus();
}
function mountUnifiedMenu(root){
  unifiedMenu=root.createElement('dialog');unifiedMenu.className='charm-game-menu';unifiedMenu.setAttribute('aria-label','Game menu');
  Object.assign(unifiedMenu.style,{boxSizing:'border-box',width:'min(92vw,540px)',maxHeight:'85vh',overflow:'auto',padding:'20px',border:'1px solid var(--color-line)',borderRadius:'12px',background:'var(--color-wood-950)',color:'var(--color-cream)'});
  unifiedMenu.innerHTML='<strong>Game menu</strong><p>Choose where to go. Gear controls the adventure; the other pages use your account or catalogue.</p><div data-menu-choices style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px"><button type="button" data-destination="companions">Party</button><button type="button" data-destination="gear">Gear</button><button type="button" data-destination="inventory">Inventory</button><button type="button" data-destination="charmdex">Charmdex</button><button type="button" data-destination="exchange">Exchange</button><button type="button" data-destination="friends">Friends</button><button type="button" data-destination="voice">Voice notes</button><button type="button" data-destination="capture" disabled>Throw ball</button></div><p>Enter opens this menu. Arrow keys choose · Enter confirms · Escape returns.</p><button type="button" data-menu-close>Back to game</button>';
  root.body.append(unifiedMenu);
  unifiedMenu.querySelector('[data-menu-close]').onclick=()=>unifiedMenu.close();
  unifiedMenu.addEventListener('close',()=>root.querySelector('canvas')?.focus());
  for(const button of unifiedMenu.querySelectorAll('[data-destination]'))button.onclick=()=>{
    const destination=button.dataset.destination;unifiedMenu.close();
    if(destination==='capture'){if(captureAvailable&&accountOrigin){captureAvailable=false;button.disabled=true;window.parent.postMessage({type:'charmville:capture-request'},accountOrigin);}return;}
    if(destination==='gear'){
      if(nativeEquipment)return;
      nativeEquipment=true;nativeKey('Enter',13,true);setTimeout(()=>nativeKey('Enter',13,false),100);
    }else if(destination==='charmdex')root.querySelector('[data-charmdex-open]')?.click();
    else if(destination==='voice')root.querySelector('[data-voice-notes-open]')?.click();
    else void returnToAccountMenus(destination);
  };
}
if(typeof window!=='undefined')for(const type of ['keydown','keyup'])window.addEventListener(type,event=>{
  if(forwarding)return;
  if(type==='keyup'&&suppressedKeys.has(event.key)){suppressedKeys.delete(event.key);event.preventDefault();event.stopImmediatePropagation();return;}
  if(unifiedMenu?.open){
    event.stopImmediatePropagation();
    if(type==='keydown'){
      suppressedKeys.add(event.key);
      if(event.key==='Escape'){event.preventDefault();unifiedMenu.close();}
      else if(event.key==='Enter'){event.preventDefault();if(!event.repeat)document.activeElement?.click();}
      else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)){
        event.preventDefault();moveUnifiedFocus(event.key.slice(5).toLowerCase());
      }
    }
    return;
  }
  if(type!=='keydown'||event.key!=='Enter'||event.repeat||document.querySelector('dialog[open]'))return;
  if(event.target instanceof Element&&event.target.closest('input,select,textarea,button,a,summary,[contenteditable="true"]'))return;
  if(nativeEquipment){nativeEquipment=false;return;}
  event.preventDefault();event.stopImmediatePropagation();suppressedKeys.add('Enter');openUnifiedMenu();
},true);
/* Presentation adapter only. All native controls and their event hooks survive. */
export function mountRuntimeShell(root = document) {
  const header = root.querySelector('header');
  const buttons = header?.querySelector('.panel-buttons');
  if (!header || !buttons || header.dataset.charmShell) return;
  header.dataset.charmShell = 'true';
  root.body.classList.add('charm-runtime');
  mountUnifiedMenu(root);
  const brand = root.createElement('div');
  brand.className = 'charm-runtime-brand';
  brand.innerHTML = window.parent===window
    ? '<strong>Charmville</strong><span>Local adventure · progress is temporary</span>'
    : '<strong>Charmville</strong><span>Explore, grow and play together</span>';
  header.prepend(brand);
  const accountMenu=root.createElement('button');accountMenu.type='button';accountMenu.textContent='Game menus';accountMenu.title='Account inventory, companions, exchange and friends';
  accountMenu.style.background='var(--color-gold-500)';accountMenu.style.color='var(--color-on-gold)';accountMenu.onclick=openUnifiedMenu;
  brand.after(accountMenu);
  const fullscreenMenu=accountMenu.cloneNode(true);fullscreenMenu.onclick=openUnifiedMenu;root.querySelector('.charm-cinema-tools')?.prepend(fullscreenMenu);
  const more = root.createElement('details');
  more.className = 'charm-runtime-more';
  more.innerHTML = '<summary>More options</summary><div class="charm-runtime-options"></div>';
  const options = more.lastElementChild;
  buttons.append(more);
  for (const button of [...buttons.children]) {
    if (button === more) continue;
    if (button.matches('[data-panel],.button--copyurl,.button--open-testmode')) options.append(button);
    else button.classList.add('charm-runtime-enter');
  }
  const labels = { '.about': 'About & credits', '.settings': 'Sound & save settings', '.quest-list': 'Source quests', '.testmode': 'About this playtest' };
  for (const button of options.querySelectorAll('[data-panel]')) button.textContent = labels[button.dataset.panel] || button.textContent;
  const copy = options.querySelector('.button--copyurl');
  if (copy) { copy.textContent = 'Copy local play link'; copy.title = 'This localhost link only opens on this computer.'; }
  const existingHelp = [...header.querySelectorAll(':scope > details')].find(el => el.querySelector('summary')?.textContent.includes('weapon tests'));
  if (existingHelp) {
    existingHelp.querySelector('summary').textContent = 'Equipment test rooms';
    const instructions = existingHelp.querySelector('p');
    if (instructions) instructions.textContent = 'These test rooms reset your current adventure and change your equipment. Bow shots fire immediately in this source quest.';
    options.append(existingHelp);
  }
  const help = root.createElement('details');
  help.className = 'charm-runtime-help';
  help.innerHTML = '<summary>How to play</summary><div class="charm-runtime-controls"><p>Default keyboard controls. Use the game’s native menu to change keys.</p><dl><div data-kind="move"><dt>Explore</dt><dd><kbd>Arrow keys</kbd> Move</dd></div><div data-kind="combat"><dt>Adventure</dt><dd><kbd>Z</kbd> Sword · hold and release to spin<br><kbd>X</kbd> Equipped item</dd></div><div data-kind="grow"><dt>Homestead</dt><dd><kbd>D</kbd> Work the garden when nearby</dd></div><div data-kind="power"><dt>Power</dt><dd><kbd>C</kbd> Toggle aura</dd></div><div><dt>Equipment</dt><dd><kbd>Enter</kbd> Game menu · Gear opens adventure equipment<br><kbd>Q</kbd> / <kbd>W</kbd> Cycle items</dd></div></dl><p>On touchscreens, use the on-screen buttons. Display adjusts zoom; Controller changes gamepad buttons.</p><p>The town includes NPCs. The in-game Guests count shows other connected guests on your screen; it is not a public player count.</p></div>';
  header.append(help);
  header.querySelector('button.charm-runtime-enter')?.addEventListener('click',()=>{for(const detail of header.querySelectorAll('details[open]'))detail.open=false;});
  header.addEventListener('toggle', event => {
    const opened = event.target;
    if (!(opened instanceof HTMLDetailsElement) || !opened.open || !header.contains(opened)) return;
    for (const detail of header.querySelectorAll('details[open]')) {
      if (detail !== opened && !detail.contains(opened) && !opened.contains(detail)) detail.open = false;
    }
  }, true);
  header.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = [...header.querySelectorAll('details[open]')].pop();
    if (open) { open.open = false; open.querySelector('summary').focus(); event.stopPropagation(); }
  });
}
if (typeof document !== 'undefined') mountRuntimeShell();
// UI-only bridge from the local account shell. No account credentials, inventory
// mutations, arbitrary selectors or gameplay input are accepted by the quest.
if (typeof window !== 'undefined') window.addEventListener('message', event => {
  if (event.source !== window.parent || !['http://localhost:3017', 'http://127.0.0.1:3017'].includes(event.origin)) return;
  const request = event.data;
  if (!request) return;
  if(request.type==='charmville:capture-availability'&&typeof request.available==='boolean'){accountOrigin=event.origin;captureAvailable=request.available;const button=unifiedMenu?.querySelector('[data-destination="capture"]');if(button){const hadFocus=document.activeElement===button;button.disabled=!captureAvailable;if(button.disabled&&hadFocus)unifiedMenu.querySelector('[data-menu-close]')?.focus();}return;}
  if(request.type==='charmville:host-ready'){accountOrigin=event.origin;return;}
  if(request.type !== 'charmville:open-panel') return;
  accountOrigin=event.origin;
  if (!['charmdex', 'voice'].includes(request.panel)) return;
  if(unifiedMenu?.open)unifiedMenu.close();
  const selected = request.panel === 'voice' ? 'dialog.voice-notes' : 'dialog.charmdex:not(.voice-notes)';
  for (const dialog of document.querySelectorAll('dialog.charmdex[open]')) {
    if (!dialog.matches(selected)) dialog.close();
  }
  if (request.panel === 'charmdex') document.querySelector('[data-charmdex-open]')?.click();
  else document.querySelector('[data-voice-notes-open]')?.click();
});
