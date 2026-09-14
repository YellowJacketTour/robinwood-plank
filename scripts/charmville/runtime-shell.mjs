import './tutorial-bridge.js';
import './voice-notes.js';
import './charmdex.js';
import './follower-bridge.js';
import './action-event-bridge.js';
import './position-observer.js';
import './account-peers.js';
import './world-encounter.js';
import './capture-bridge.js';
import './resource-bridge.js';
import {mountGameplayVideo} from './gameplay-video.mjs';
import {mountCompactHud} from './compact-game-hud.mjs';
let accountOrigin=null,captureAvailable=false;
async function returnToAccountMenus(panel='inventory'){
  if(!['menu','inventory','companions','exchange','friends','social'].includes(panel))return;
  if(window.parent===window){window.open('http://localhost:3017/charmville/world?panel='+panel,'_blank','noopener');return;}
  if(document.fullscreenElement)try{await document.exitFullscreen();}catch{/* The parent also checks its iframe fullscreen state. */}
  if(accountOrigin)window.parent.postMessage({type:'charmville:account-menu',panel},accountOrigin);
}
const menuPages = [
  {id:'companions',name:'Party',art:'poke_ball',section:'Companions',title:'Your travelling team',description:'Choose a companion, inspect its progress, and decide who walks with you.',scope:'account'},
  {id:'gear',name:'Gear',art:'macho_brace',section:'Adventure',title:'Ready for the road',description:'Open the adventure equipment screen to select your tools and equipped items.',scope:'adventure'},
  {id:'inventory',name:'Inventory',art:'berry_pouch',section:'Satchel',title:'Everything you carry',description:'Browse the items and supplies saved to your account.',scope:'account'},
  {id:'charmdex',name:'Charmdex',art:'vs_seeker',section:'Discovery',title:'A world to discover',description:'Look up charms by name and category. Catalogue entries describe discoveries; they are not owned items.',scope:'catalogue'},
  {id:'exchange',name:'Exchange',art:'coin_case',section:'Market',title:'Meet at the exchange',description:'Open your account market to browse its available trading tools.',scope:'account'},
  {id:'friends',name:'Friends',art:'poke_doll',section:'Together',title:'Find your people',description:'Open the friends and travel panel to choose where to meet.',scope:'account'},
  {id:'social',name:'Social',art:'retro_mail',section:'PlankSpace',title:'A little care, shared',description:'Read public posts and pin an owned charm through your PlankSpace account.',scope:'account'},
  {id:'voice',name:'Voice notes',art:'retro_mail',section:'Messages',title:'Say it in your voice',description:'Open the recorder to make and play back a voice note.',scope:'recorder'},
  {id:'capture',name:'Throw ball',art:'poke_ball',section:'Encounter',title:'A new companion?',description:'Throw a ball at the capture target selected by your account encounter.',scope:'encounter'},
];
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
  unifiedMenu.querySelector('[data-capture-reason]').hidden=captureAvailable;
  unifiedMenu.querySelector('[data-destination="gear"]').disabled=Boolean(document.querySelector('button.charm-runtime-enter'));
  for(const [key,code] of [['ArrowUp',38],['ArrowDown',40],['ArrowLeft',37],['ArrowRight',39],['z',90],['x',88],['d',68],['c',67],['q',81],['w',87],['Enter',13]])nativeKey(key,code,false);
  if(accountOrigin&&window.parent!==window&&document.body.classList.contains('charm-hosted')){void returnToAccountMenus('menu');return;}
  const remembered=unifiedMenu.querySelector('[data-preview="true"]:not(:disabled)')||unifiedMenu.querySelector('button:not(:disabled)');
  unifiedMenu.showModal();remembered.focus();
}
function mountUnifiedMenu(root){
  unifiedMenu=root.createElement('dialog');unifiedMenu.className='charm-game-menu';unifiedMenu.setAttribute('aria-label','Game menu');
  unifiedMenu.innerHTML=`
    <div class="charm-menu-heading"><div><span>CHARMVILLE</span><h1>Adventure menu</h1></div><span class="charm-menu-device" aria-hidden="true">● ● ●</span></div>
    <div class="charm-menu-body">
      <section class="charm-menu-preview" aria-label="Selected destination">
        <div class="charm-menu-art-well"><img data-menu-art src="/menu-art/poke_ball.png" alt="" width="96" height="96"><span class="charm-menu-art-base" aria-hidden="true"></span></div>
        <div class="charm-menu-caption"><span data-menu-section>Companions</span><h2 data-menu-title>Your travelling team</h2></div>
      </section>
      <nav class="charm-menu-navigation" aria-label="Game destinations" data-menu-choices>
        ${menuPages.map(page=>`<button type="button" data-destination="${page.id}"${page.id==='capture'?' disabled':''}><span class="charm-menu-cursor" aria-hidden="true">▶</span><img src="/menu-art/${page.art}.png" alt="" width="24" height="24"><span>${page.name}</span>${page.id==='capture'?'<small data-capture-reason>Needs a target</small>':''}</button>`).join('')}
      </nav>
    </div>
    <section class="charm-menu-description" aria-label="Destination help"><p data-menu-description></p><span data-menu-scope></span></section>
    <footer class="charm-menu-footer"><p><kbd>↑ ↓</kbd> Choose <span>·</span> <kbd>Enter / A</kbd> Open</p><button type="button" data-menu-close><kbd>Esc / B</kbd> Return</button></footer>`;
  const preview=button=>{
    const page=menuPages.find(page=>page.id===button.dataset.destination);if(!page)return;
    for(const choice of unifiedMenu.querySelectorAll('[data-destination]'))choice.dataset.preview=String(choice===button);
    unifiedMenu.querySelector('[data-menu-art]').src='/menu-art/'+page.art+'.png';
    unifiedMenu.querySelector('[data-menu-section]').textContent=page.section;
    unifiedMenu.querySelector('[data-menu-title]').textContent=page.title;
    unifiedMenu.querySelector('[data-menu-description]').textContent=page.description;
    unifiedMenu.querySelector('[data-menu-scope]').textContent=page.scope==='account'?(window.parent===window?'Opens your account in a separate tab':'Opens your account panel'):page.scope==='catalogue'?'Discovery catalogue':page.scope==='adventure'?'Adventure equipment':page.scope==='recorder'?'Voice recorder':'Selected encounter';
  };
  for(const button of unifiedMenu.querySelectorAll('[data-destination]')){
    button.addEventListener('focus',()=>preview(button));
    button.addEventListener('pointerenter',()=>{if(!button.disabled)preview(button);});
  }
  preview(unifiedMenu.querySelector('[data-destination]'));
  root.body.append(unifiedMenu);
  unifiedMenu.querySelector('[data-menu-close]').onclick=()=>unifiedMenu.close();
  unifiedMenu.addEventListener('close',()=>requestAnimationFrame(()=>{
    // Dialog focus restoration can otherwise leave arrows on its opener.
    // Returning players may skip the introduction that first sets tabindex.
    if(!root.hasFocus()||root.querySelector('dialog[open]'))return;
    const canvas=root.querySelector('canvas');
    if(canvas){if(!canvas.hasAttribute('tabindex'))canvas.tabIndex=0;canvas.focus({preventScroll:true});}
  }));
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
// Authored quest names are observations only, never inventory or reward authority.
export function parseEquipmentSnapshot(raw) {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  const lines = raw.replace(/\0/g, '').replace(/\r/g, '').trimEnd().split('\n');
  if (lines.length < 1 || lines.length > 3) return null;
  const ids = lines[0].split('|');
  if (ids.length !== 2 || ids.some(id => !/^-?\d+$/.test(id))) return null;
  const values = ids.map(Number);
  if (values.some(id => !Number.isSafeInteger(id) || id < -1 || id > 65535)) return null;
  return values.map((id, index) => ({
    id,
    name: id < 0 ? 'Empty' : (lines[index + 1]?.trim().slice(0, 128) || `Unnamed item ${id}`),
  }));
}
function mountEquipmentReadout(root, settingsBody) {
  const details = root.createElement('details');
  const summary = root.createElement('summary');
  summary.textContent = 'Equipped adventure items';
  const description = root.createElement('p');
  description.textContent = 'Live names from this quest. A and B refer to the native gear slots; your controls may be remapped.';
  const slots = root.createElement('p');
  slots.textContent = 'Start the adventure to inspect your gear.';
  details.append(summary, description, slots);
  settingsBody.append(details);
  const poll = () => {
    if (!details.open || typeof FS === 'undefined') return;
    try {
      const path = FS.cwd().replace(/\/$/, '') + '/Files/Homestead/charmville/equipment-state.txt';
      const snapshot = parseEquipmentSnapshot(FS.readFile(path, { encoding: 'utf8' }));
      const text = snapshot
        ? snapshot.map((item, index) => `${index === 0 ? 'A' : 'B'} · ${item.name}`).join('   /   ')
        : 'Equipment is not available in this quest yet.';
      if (slots.textContent !== text) slots.textContent = text;
    } catch {
      slots.textContent = 'Equipment is not available in this quest yet.';
    }
  };
  details.addEventListener('toggle', poll);
  const timer = setInterval(poll, 500);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
/* Presentation adapter only. All native controls and their event hooks survive. */
/** Call only after the existing parent/origin handshake; never infer account mode
 * from iframe placement alone. Idempotent refresh avoids recurring canvas resize. */
export function compactHostedShell(root) {
  if(root.body.classList.contains('charm-hosted'))return false;
  root.body.classList.add('charm-hosted');
  const menu=root.querySelector('.charm-account-menu');
  if(menu)menu.textContent='Game menu';
  const summary=root.querySelector('.charm-runtime-settings > summary');
  if(summary)summary.textContent='Controls & settings';
  root.defaultView?.dispatchEvent(new Event('resize'));
  return true;
}
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
  accountMenu.className='charm-account-menu';
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
  help.innerHTML = '<summary>Field guide · Controls</summary><div class="charm-runtime-controls"><p>Default keyboard controls. Use the game’s native menu to change keys.</p><dl><div data-kind="move"><dt>Explore</dt><dd><kbd>Arrow keys</kbd> Move</dd></div><div data-kind="combat"><dt>Adventure</dt><dd><kbd>Z</kbd> Sword · hold and release to spin<br><kbd>X</kbd> Equipped item</dd></div><div data-kind="grow"><dt>Homestead</dt><dd><kbd>E</kbd> Work the garden when nearby</dd></div><div data-kind="power"><dt>Power</dt><dd><kbd>T</kbd> Toggle aura</dd></div><div><dt>Equipment</dt><dd><kbd>Enter</kbd> Game menu · Gear opens adventure equipment<br><kbd>Q</kbd> / <kbd>W</kbd> Cycle items</dd></div></dl><p>On touchscreens, use the on-screen buttons. Display changes how the game fits the screen; Controller changes gamepad buttons. On the live world camera, WASD pans, wheel or pinch zooms, and 0 returns to your player.</p><p>The town includes NPCs. The in-game Guests count shows other connected guests on your screen; it is not a public player count.</p></div>';
  header.append(help);
  // Keep advanced runtime controls reachable without consuming the play area.
  const settings = root.createElement('details');
  settings.className = 'charm-runtime-settings';
  const settingsSummary = root.createElement('summary');
  settingsSummary.textContent = 'Settings & help';
  const settingsBody = root.createElement('div');
  settingsBody.className = 'charm-runtime-settings-body';
  settings.append(settingsSummary, settingsBody);
  for (const control of [...header.children]) {
    if (control !== brand && control !== accountMenu) settingsBody.append(control);
  }
  mountEquipmentReadout(root, settingsBody);
  mountGameplayVideo(root, settingsBody);
  header.append(settings);
  for (const startButton of settingsBody.querySelectorAll('button.charm-runtime-enter')) header.insertBefore(startButton,settings);
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
if (typeof document !== 'undefined') {mountRuntimeShell();mountCompactHud(document,{isOverlayBlocked:()=>nativeEquipment||Boolean(document.querySelector('dialog[open]'))});}
/** Closed command vocabulary; caller has already verified parent and origin. */
export function openNativeToolPanel(panel,root,host,openGear){
  if(!['gear','map','settings'].includes(panel))return false;
  if(root.querySelector('dialog[open]'))return false;
  if(panel==='gear'){
    if(root.querySelector('button.charm-runtime-enter'))return false;
    openGear();return true;
  }
  if(panel==='map'){
    if(host.charmvilleMapReady!==true)return false;
    if(host.charmvilleMapOpen!==true)host.charmvilleOpenMap=true;
    for(const detail of root.querySelectorAll('header details[open]'))detail.open=false;
    root.querySelector('canvas')?.focus({preventScroll:true});return true;
  }
  const settings=root.querySelector('.charm-runtime-settings');
  if(!settings)return false;
  settings.open=true;settings.querySelector('summary')?.focus({preventScroll:true});return true;
}
// UI-only bridge from the local account shell. No account credentials, inventory
// mutations, arbitrary selectors or gameplay input are accepted by the quest.
if (typeof window !== 'undefined') window.addEventListener('message', event => {
  if (event.source !== window.parent || !['http://localhost:3017', 'http://127.0.0.1:3017'].includes(event.origin)) return;
  const request = event.data;
  if (!request) return;
  if(request.type==='charmville:capture-availability'&&typeof request.available==='boolean'){accountOrigin=event.origin;captureAvailable=request.available;const button=unifiedMenu?.querySelector('[data-destination="capture"]');if(button){const hadFocus=document.activeElement===button;button.disabled=!captureAvailable;const reason=button.querySelector('[data-capture-reason]');if(reason)reason.hidden=captureAvailable;if(button.disabled&&hadFocus)unifiedMenu.querySelector('[data-menu-close]')?.focus();}return;}
  if(request.type==='charmville:host-ready'){accountOrigin=event.origin;compactHostedShell(document);return;}
  if(request.type !== 'charmville:open-panel') return;
  accountOrigin=event.origin;
  if (!['charmdex', 'voice','gear','map','settings'].includes(request.panel)) return;
  if(unifiedMenu?.open)unifiedMenu.close();
  if(['gear','map','settings'].includes(request.panel)){
    openNativeToolPanel(request.panel,document,window,()=>{if(nativeEquipment)return;nativeEquipment=true;nativeKey('Enter',13,true);setTimeout(()=>nativeKey('Enter',13,false),100);});return;
  }
  const selected = request.panel === 'voice' ? 'dialog.voice-notes' : 'dialog.charmdex:not(.voice-notes)';
  for (const dialog of document.querySelectorAll('dialog.charmdex[open]')) {
    if (!dialog.matches(selected)) dialog.close();
  }
  if (request.panel === 'charmdex') document.querySelector('[data-charmdex-open]')?.click();
  else document.querySelector('[data-voice-notes-open]')?.click();
});
