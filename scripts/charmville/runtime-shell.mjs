import './voice-notes.js';
import './charmdex.js';
let accountOrigin=null;
async function returnToAccountMenus(){
  if(window.parent===window){window.location.assign('http://localhost:3017/charmville/world?panel=inventory');return;}
  if(document.fullscreenElement)try{await document.exitFullscreen();}catch{/* The parent also checks its iframe fullscreen state. */}
  if(accountOrigin)window.parent.postMessage({type:'charmville:account-menu',panel:'inventory'},accountOrigin);
}
/* Presentation adapter only. All native controls and their event hooks survive. */
export function mountRuntimeShell(root = document) {
  const header = root.querySelector('header');
  const buttons = header?.querySelector('.panel-buttons');
  if (!header || !buttons || header.dataset.charmShell) return;
  header.dataset.charmShell = 'true';
  root.body.classList.add('charm-runtime');
  const brand = root.createElement('div');
  brand.className = 'charm-runtime-brand';
  brand.innerHTML = '<strong>Charmville</strong><span>Local adventure · progress is temporary</span>';
  header.prepend(brand);
  const accountMenu=root.createElement('button');accountMenu.type='button';accountMenu.textContent='Game menus';accountMenu.title='Account inventory, companions, exchange and friends';
  accountMenu.style.background='var(--color-gold-500)';accountMenu.style.color='var(--color-on-gold)';accountMenu.onclick=returnToAccountMenus;
  brand.after(accountMenu);
  const fullscreenMenu=accountMenu.cloneNode(true);fullscreenMenu.onclick=returnToAccountMenus;root.querySelector('.charm-cinema-tools')?.prepend(fullscreenMenu);
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
  help.innerHTML = '<summary>How to play</summary><div class="charm-runtime-controls"><p>Default keyboard controls. Use the game’s native menu to change keys.</p><dl><div data-kind="move"><dt>Explore</dt><dd><kbd>Arrow keys</kbd> Move</dd></div><div data-kind="combat"><dt>Adventure</dt><dd><kbd>Z</kbd> Sword · hold and release to spin<br><kbd>X</kbd> Equipped item</dd></div><div data-kind="grow"><dt>Homestead</dt><dd><kbd>D</kbd> Work the garden when nearby</dd></div><div data-kind="power"><dt>Power</dt><dd><kbd>C</kbd> Toggle aura</dd></div><div><dt>Equipment</dt><dd><kbd>Enter</kbd> Inventory<br><kbd>Q</kbd> / <kbd>W</kbd> Cycle items</dd></div></dl><p>On touchscreens, use the on-screen buttons. Display adjusts zoom; Controller changes gamepad buttons.</p><p>The town includes NPCs. The in-game Guests count shows other connected guests on your screen; it is not a public player count.</p></div>';
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
  if(request.type==='charmville:host-ready'){accountOrigin=event.origin;return;}
  if(request.type !== 'charmville:open-panel') return;
  accountOrigin=event.origin;
  if (!['charmdex', 'voice'].includes(request.panel)) return;
  const selected = request.panel === 'voice' ? 'dialog.voice-notes' : 'dialog.charmdex:not(.voice-notes)';
  for (const dialog of document.querySelectorAll('dialog.charmdex[open]')) {
    if (!dialog.matches(selected)) dialog.close();
  }
  if (request.panel === 'charmdex') document.querySelector('[data-charmdex-open]')?.click();
  else document.querySelector('[data-voice-notes-open]')?.click();
});

