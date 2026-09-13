// Discovery only. This UI never creates balances or sends economic commands.
const trigger=document.createElement('button');trigger.type='button';trigger.dataset.charmdexOpen='';trigger.textContent='Charmdex';
document.querySelector('header').append(trigger);
const dialog=document.createElement('dialog');dialog.className='charmdex';
dialog.innerHTML='<form method="dialog"><strong>Charmdex</strong><button aria-label="Close Charmdex">Close</button></form><p>Discover the Charm universe. Catalogue entries are design references, not owned items.</p><div class="charmdex-filters"><input type="search" aria-label="Search Charmdex" placeholder="Search cow, berries, tools…"><select aria-label="Charm category"><option value="">All categories</option></select></div><p role="status">Loading catalogue…</p><div class="charmdex-grid"></div><button type="button" class="charmdex-more">Show more</button>';
document.body.append(dialog);
dialog.setAttribute('aria-label','Charmdex catalogue');
const layout=document.createElement('div');layout.className='charmdex-layout';
const detail=document.createElement('section');detail.className='charmdex-detail';detail.setAttribute('aria-label','Selected charm');
const existingGrid=dialog.querySelector('.charmdex-grid');existingGrid.before(layout);layout.append(existingGrid,detail);
function selectEntry(entry,button){
 for(const item of grid.querySelectorAll('button'))item.setAttribute('aria-pressed',String(item===button));
 detail.replaceChildren();
 const art=document.createElement('div');art.className='charmdex-portrait';art.textContent=entry.glyph;art.setAttribute('aria-hidden','true');
 const title=document.createElement('h2');title.textContent=entry.name;
 const group=document.createElement('p');group.className='charmdex-class';group.textContent=entry.group+' / '+entry.subgroup;
 const description=document.createElement('p');description.textContent=entry.proposal;
 const state=document.createElement('p');state.className='charmdex-reference';state.textContent='Catalogue reference · Not an owned item. Gameplay and source artwork are not yet mapped.';
 detail.append(art,title,group,description,state);
}
const close=dialog.querySelector('[aria-label="Close Charmdex"]');close.type='button';close.onclick=()=>dialog.close();
const voice=document.createElement('button');voice.type='button';voice.textContent='Voice note';voice.onclick=()=>{dialog.close();document.querySelector('[data-voice-notes-open]').click();};dialog.querySelector('form').after(voice);
let entries=[],limit=48,loaded=false;
const search=dialog.querySelector('input'),category=dialog.querySelector('select'),status=dialog.querySelector('[role=status]'),grid=dialog.querySelector('.charmdex-grid'),more=dialog.querySelector('.charmdex-more');
function render(){
 const term=search.value.trim().toLocaleLowerCase();const matches=entries.filter(e=>(!category.value||e.group===category.value)&&(!term||(e.name+' '+e.glyph+' '+e.subgroup).toLocaleLowerCase().includes(term)));
 grid.replaceChildren();for(const entry of matches.slice(0,limit)){
  const card=document.createElement('button'),art=document.createElement('span'),title=document.createElement('span');
  card.type='button';card.className='charmdex-entry';card.setAttribute('aria-pressed','false');
  art.className='charmdex-entry-art';art.textContent=entry.glyph;art.setAttribute('aria-hidden','true');title.textContent=entry.name;
  card.append(art,title);card.onclick=()=>selectEntry(entry,card);grid.append(card);
  if(grid.children.length===1)selectEntry(entry,card);
 }
 if(!matches.length){detail.textContent='No matching charms. Try another name or category.';}
 status.textContent=`${matches.length.toLocaleString()} entries · Showing ${Math.min(limit,matches.length)} · Unicode 17.0`;
 more.hidden=matches.length<=limit;
}
trigger.onclick=async()=>{
 // Release native movement before the modal takes input focus.
 for(const [key,keyCode] of [['ArrowUp',38],['ArrowDown',40],['ArrowLeft',37],['ArrowRight',39],['z',90],['x',88],['d',68],['c',67],['Enter',13],['q',81],['w',87]])document.dispatchEvent(new KeyboardEvent('keyup',{key,keyCode,which:keyCode,bubbles:true}));
 dialog.showModal();search.focus();
 if(!loaded){try{const response=await fetch('/charmdex-catalog.json');if(!response.ok)throw Error('Catalogue unavailable');const data=await response.json();entries=data.entries;for(const group of [...new Set(entries.map(e=>e.group))]){const option=document.createElement('option');option.value=group;option.textContent=group;category.append(option);}loaded=true;render();}catch{status.textContent='Catalogue could not load. Close and reopen to retry.';}}
};
for(const element of [search,category])element.addEventListener('input',()=>{limit=48;render();});
more.onclick=()=>{limit+=48;render();};
dialog.addEventListener('close',()=>trigger.focus());
for(const type of ['keydown','keyup'])window.addEventListener(type,event=>{if(dialog.open){event.stopImmediatePropagation();if(type==='keydown'&&event.key==='Escape'){event.preventDefault();dialog.close();}}},true);
