// A closing dialog must not steal focus from a newly opened one. Cinema may
// hide header triggers, so return to the world when the opener is not visible.
function restoreModalFocus(preferred){
 requestAnimationFrame(()=>{
  if(!document.hasFocus()||document.querySelector('dialog[open]'))return;
  const target=preferred?.isConnected&&preferred.tabIndex>=0&&preferred.getClientRects().length&&!preferred.disabled?preferred:document.querySelector('canvas');
  if(!target)return;
  if(target.tagName==='CANVAS'&&!target.hasAttribute('tabindex'))target.tabIndex=0;
  target.focus({preventScroll:true});
 });
}
// Discovery only. This UI never creates balances or sends economic commands.
const trigger=document.createElement('button');trigger.type='button';trigger.dataset.charmdexOpen='';trigger.textContent='Charmdex';
document.querySelector('header').append(trigger);
const dialog=document.createElement('dialog');dialog.className='charmdex charmdex-device';
dialog.innerHTML=`<form method="dialog" class="charmdex-device-heading"><img src="/menu-art/vs_seeker.png" alt="" width="48" height="48"><div><span>CHARMVILLE FIELD CATALOGUE</span><strong>Charmdex</strong></div><button aria-label="Close Charmdex">Return</button></form>
<div class="charmdex-filters"><label><span>Find a charm</span><input type="search" aria-label="Search Charmdex" placeholder="Name, creature, tool…" disabled></label><label><span>Collection</span><select aria-label="Charm category" disabled><option value="">All categories</option></select></label></div>
<div class="charmdex-catalogue-status"><p role="status" aria-live="polite">Loading catalogue…</p><button type="button" data-catalogue-retry hidden>Try again</button></div>
<div class="charmdex-grid"></div><div class="charmdex-page-actions"><button type="button" class="charmdex-more" hidden>Show more entries</button><button type="button" data-clear-filters hidden>Clear filters</button></div>
<footer class="charmdex-device-footer"><p><kbd>Arrows / D-pad</kbd> Browse <span>·</span> <kbd>Esc / B</kbd> Return</p><span data-voice-slot></span></footer>`;
document.body.append(dialog);
dialog.setAttribute('aria-label','Charmdex catalogue');
const layout=document.createElement('div');layout.className='charmdex-layout';
const detail=document.createElement('section');detail.className='charmdex-detail';detail.setAttribute('aria-label','Selected charm');
const existingGrid=dialog.querySelector('.charmdex-grid');existingGrid.before(layout);layout.append(existingGrid,detail);
let selectedName=null,returnFocus=null;
function showCatalogueHint(title,description){
 detail.replaceChildren();
 const art=document.createElement('div');art.className='charmdex-portrait charmdex-empty-art';
 const icon=document.createElement('img');icon.src='/menu-art/vs_seeker.png';icon.alt='';icon.width=72;icon.height=72;art.append(icon);
 const heading=document.createElement('h2');heading.textContent=title;
 const copy=document.createElement('p');copy.textContent=description;
 detail.append(art,heading,copy);
}
showCatalogueHint('Discover your world','Choose a charm to see its category and proposed uses.');
function selectEntry(entry,button){
 selectedName=entry.name;
 for(const item of grid.querySelectorAll('button')){item.setAttribute('aria-pressed',String(item===button));item.tabIndex=item===button?0:-1;}
 detail.replaceChildren();
 const art=document.createElement('div');art.className='charmdex-portrait';art.textContent=entry.glyph;art.setAttribute('aria-hidden','true');
 const title=document.createElement('h2');title.textContent=entry.name;
 const group=document.createElement('p');group.className='charmdex-class';group.textContent=entry.group+' / '+entry.subgroup;
 const description=document.createElement('p');description.textContent=entry.proposal;
 const state=document.createElement('p');state.className='charmdex-reference';state.textContent='Reference entry · Not owned inventory. Gameplay and source artwork mapping is still pending.';
 detail.append(art,title,group,description,state);
}
const close=dialog.querySelector('[aria-label="Close Charmdex"]');close.type='button';close.onclick=()=>dialog.close();
const voice=document.createElement('button');voice.type='button';voice.textContent='Voice note';voice.onclick=()=>{dialog.close();document.querySelector('[data-voice-notes-open]').click();};dialog.querySelector('[data-voice-slot]').append(voice);
let entries=[],limit=48,loaded=false,loading=false;
const search=dialog.querySelector('input'),category=dialog.querySelector('select'),status=dialog.querySelector('[role=status]'),grid=dialog.querySelector('.charmdex-grid'),more=dialog.querySelector('.charmdex-more');
function render(){
 if(!loaded)return;
 const previousScroll=grid.scrollTop;
 const term=search.value.trim().toLocaleLowerCase();const matches=entries.filter(e=>(!category.value||e.group===category.value)&&(!term||(e.name+' '+e.glyph+' '+e.subgroup).toLocaleLowerCase().includes(term)));
 grid.replaceChildren();for(const entry of matches.slice(0,limit)){
  const card=document.createElement('button'),art=document.createElement('span'),title=document.createElement('span');
  card.type='button';card.tabIndex=-1;card.className='charmdex-entry';card.title=entry.name;card.setAttribute('aria-pressed','false');
  art.className='charmdex-entry-art';art.textContent=entry.glyph;art.setAttribute('aria-hidden','true');title.textContent=entry.name;
  card.append(art,title);card.onclick=()=>selectEntry(entry,card);grid.append(card);
  card.addEventListener('focus',()=>selectEntry(entry,card));
 }
 const selected=matches.slice(0,limit).findIndex(entry=>entry.name===selectedName);
 if(grid.children.length){const index=selected<0?0:selected;selectEntry(matches[index],grid.children[index]);}
 if(!matches.length)showCatalogueHint('No matching charms','Try a shorter name or choose another collection.');
 status.textContent=matches.length?`${matches.length.toLocaleString()} entries · ${Math.min(limit,matches.length)} shown · Unicode 17.0`:'No entries match these filters.';
 more.hidden=matches.length<=limit;
 dialog.querySelector('[data-clear-filters]').hidden=Boolean(matches.length)||(!search.value&&!category.value);
 grid.scrollTop=previousScroll;
}
trigger.onclick=async()=>{
 if(dialog.open)return;returnFocus=document.activeElement;
 // Release native movement before the modal takes input focus.
 for(const [key,keyCode] of [['ArrowUp',38],['ArrowDown',40],['ArrowLeft',37],['ArrowRight',39],['z',90],['x',88],['d',68],['c',67],['Enter',13],['q',81],['w',87]])document.dispatchEvent(new KeyboardEvent('keyup',{key,keyCode,which:keyCode,bubbles:true}));
 dialog.showModal();search.focus();
 if(!loaded)await loadCatalogue();
};
async function loadCatalogue(){
 if(loading)return;loading=true;
 const retry=dialog.querySelector('[data-catalogue-retry]');retry.hidden=true;
 status.textContent='Loading catalogue…';
 try{
  const response=await fetch('/charmdex-catalog.json');if(!response.ok)throw Error('Catalogue unavailable');
  const data=await response.json();
  if(!Array.isArray(data.entries)||!data.entries.every(entry=>entry&&['name','glyph','group','subgroup','proposal'].every(key=>typeof entry[key]==='string')))throw Error('Invalid catalogue');
  entries=data.entries;
  for(const group of [...new Set(entries.map(entry=>entry.group))]){const option=document.createElement('option');option.value=group;option.textContent=group;category.append(option);}
  loaded=true;search.disabled=false;category.disabled=false;render();
  if(dialog.open&&document.activeElement===dialog)search.focus();
 }catch{
  status.textContent='The catalogue is unavailable. Your game progress is unchanged.';
  showCatalogueHint('Unable to load','Try again when the catalogue is available. You can return to your adventure at any time.');
  retry.hidden=false;
 }finally{loading=false;}
}
dialog.querySelector('[data-catalogue-retry]').onclick=()=>void loadCatalogue();
dialog.querySelector('[data-clear-filters]').onclick=()=>{search.value='';category.value='';limit=48;grid.scrollTop=0;render();search.focus();};
for(const element of [search,category])element.addEventListener('input',()=>{limit=48;grid.scrollTop=0;render();});
more.onclick=()=>{limit+=48;render();};
dialog.addEventListener('close',()=>restoreModalFocus(returnFocus));
for(const type of ['keydown','keyup'])window.addEventListener(type,event=>{if(dialog.open){event.stopImmediatePropagation();const direction={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right'}[event.key];if(type==='keydown'&&direction&&grid.contains(event.target)){event.preventDefault();if(!moveCatalogueCursor(direction)){if(direction==='up')category.focus();else if(direction==='down')(more.hidden?voice:more).focus();}}if(type==='keydown'&&event.key==='Escape'){event.preventDefault();dialog.close();}}},true);

// One selection drives the artwork, description and controller cursor.
function moveCatalogueCursor(action){
 const cards=[...grid.querySelectorAll('button')];if(!cards.length)return false;
 const current=cards.includes(document.activeElement)?document.activeElement:cards.find(card=>card.getAttribute('aria-pressed')==='true')||cards[0];
 const rect=current.getBoundingClientRect(),horizontal=action==='left'||action==='right',sign=action==='left'||action==='up'?-1:1;
 const candidates=cards.filter(card=>card!==current).map(card=>{const r=card.getBoundingClientRect();return {card,along:(horizontal?r.left-rect.left:r.top-rect.top)*sign,across:Math.abs(horizontal?r.top-rect.top:r.left-rect.left)};}).filter(item=>item.along>1);
 candidates.sort((a,b)=>a.across*4+a.along-(b.across*4+b.along));
 const next=candidates[0]?.card;if(!next)return false;next.focus({preventScroll:true});next.scrollIntoView({block:'nearest'});return true;
}
document.addEventListener('charm-menu-action',event=>{
 if(event.detail?.dialog!==dialog||!dialog.open)return;
 if(grid.contains(document.activeElement)&&['up','down','left','right'].includes(event.detail.action)&&moveCatalogueCursor(event.detail.action))event.preventDefault();
});