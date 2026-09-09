// Discovery only. This UI never creates balances or sends economic commands.
const trigger=document.createElement('button');trigger.type='button';trigger.textContent='Charmdex';
document.querySelector('header').append(trigger);
const dialog=document.createElement('dialog');dialog.className='charmdex';
dialog.innerHTML='<form method="dialog"><strong>Charmdex</strong><button aria-label="Close Charmdex">Close</button></form><p>Discover the Charm universe. Catalogue entries are design references, not owned items.</p><div class="charmdex-filters"><input type="search" aria-label="Search Charmdex" placeholder="Search cow, berries, tools…"><select aria-label="Charm category"><option value="">All categories</option></select></div><p role="status">Loading catalogue…</p><div class="charmdex-grid"></div><button type="button" class="charmdex-more">Show more</button>';
document.body.append(dialog);
let entries=[],limit=48,loaded=false;
const search=dialog.querySelector('input'),category=dialog.querySelector('select'),status=dialog.querySelector('[role=status]'),grid=dialog.querySelector('.charmdex-grid'),more=dialog.querySelector('.charmdex-more');
function render(){
 const term=search.value.trim().toLocaleLowerCase();const matches=entries.filter(e=>(!category.value||e.group===category.value)&&(!term||(e.name+' '+e.glyph+' '+e.subgroup).toLocaleLowerCase().includes(term)));
 grid.replaceChildren();for(const entry of matches.slice(0,limit)){
  const card=document.createElement('article'),title=document.createElement('h3'),description=document.createElement('p'),state=document.createElement('small');
  title.textContent=entry.glyph+' '+entry.name;description.textContent=entry.proposal;state.textContent=entry.group+' · Gameplay & artwork mapping pending';card.append(title,description,state);grid.append(card);
 }
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
