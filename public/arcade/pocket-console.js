// Presentation only: move existing controls without replacing their listeners,
// transaction state, exact amounts, receipts, or authoritative game commands.
import { mountGumballMachine } from './gumball-machine.js';
const app = document.getElementById('app');
const topbar = app.querySelector('.topbar');
const tools = document.createElement('details');
tools.className = 'console-tools';
tools.innerHTML = `<summary class="console-menu" aria-label="Open game tools and table controls" title="Game tools">☰</summary>
  <section class="console-drawer" aria-label="Game tools"><h2>Game tools</h2><div class="console-icons"></div></section>`;
topbar.append(tools);
const drawer = tools.querySelector('.console-drawer');
const icons = tools.querySelector('.console-icons');
const rules=document.createElement('details');rules.className='console-rules';
rules.innerHTML='<summary>How payouts work</summary>';
for(const el of document.querySelectorAll('.deck > .payout-note,#payoutFloorHeadline'))rules.append(el);
for(const id of ['liveBoard','scoreboard']){const el=document.getElementById(id);if(el)drawer.append(el);}
drawer.append(rules);
if(document.body.dataset.inviteTest==='true'){
 const testNote=document.createElement('p');testNote.textContent='Free invite tests use simulated ETH. An automated test seat fills otherwise empty rounds and follows the same payout rules.';rules.append(testNote);
}
const stats = topbar.querySelector('.stats');
if (stats) drawer.append(stats);
for (const id of ['verifyBtn','statsBtn','gearBtn','adminLinkBtn']) {
  const element = document.getElementById(id);
  if (element) icons.append(element);
}
document.getElementById('sfxBtn')?.setAttribute('tabindex','0');
const autoRow = document.getElementById('autoRow');
drawer.append(autoRow);
const target = document.getElementById('autoTargetInput').parentElement;
target.classList.add('console-target');
target.firstChild.textContent = 'TARGET ';
document.getElementById('primaryBtn').before(target);
const warning = document.createElement('p');
warning.className = 'console-auto-warning';
warning.textContent = 'Auto repeats your stake each round until switched off. The target is not a guaranteed payout.';
drawer.append(warning);
const stopAuto = document.createElement('button');
stopAuto.type = 'button';
stopAuto.className = 'console-stop-auto';
stopAuto.textContent = '■ Stop auto-play';
stopAuto.hidden = true;
document.getElementById('primaryBtn').after(stopAuto);
const autoToggle = document.getElementById('autoToggle');
const syncAuto = () => {
  const active = autoToggle.classList.contains('active');
  stopAuto.hidden = !active;
  autoToggle.setAttribute('aria-pressed', String(active));
};
stopAuto.addEventListener('click', () => { if (autoToggle.classList.contains('active')) autoToggle.click(); });
new MutationObserver(syncAuto).observe(autoToggle,{attributes:true,attributeFilter:['class']});
syncAuto();
for (const id of ['bankPanel','fuelPanel']) {
  const element = document.getElementById(id);
  if (element) drawer.append(element);
}
const stakeLabel = document.createElement('div');
stakeLabel.className = 'console-stake-label';
stakeLabel.textContent = new URLSearchParams(location.search).get('playtest') === '1' ? 'STAKE · TEST CREDITS' : 'STAKE · ETH';
document.getElementById('stakeRow').before(stakeLabel);
document.getElementById('stakeRow').setAttribute('aria-label','Choose stake');
for (const chip of document.querySelectorAll('#stakeRow button')) {
  const syncSelected = () => chip.setAttribute('aria-pressed',String(chip.classList.contains('active')));
  new MutationObserver(syncSelected).observe(chip,{attributes:true,attributeFilter:['class']});
  syncSelected();
}
document.getElementById('autoTargetInput').setAttribute('aria-label','Pre-launch target multiplier');
document.getElementById('autoTargetInput').setAttribute('aria-describedby','targetRiskHelp');
const targetRisk=document.createElement('p');targetRisk.id='targetRiskHelp';targetRisk.textContent='Choose your target before launch. If the crash is lower, you lose your stake. Reaching the target qualifies for a funded payout; the target is a ceiling, not a guaranteed return. Lottery odds are separate. Gas is extra.';rules.append(targetRisk);
const migratePrivateControls = () => {
  for (const id of ['privateHud','privateTablePanel','privateJourney']) {
    const element = document.getElementById(id);
    if (element && element.parentElement !== drawer) drawer.append(element);
  }
  const launch = document.getElementById('privateLaunch');
  const deck = app.querySelector('.deck');
  if (launch && launch.parentElement !== deck) deck.append(launch);
};
// Private controls are constructed asynchronously after the session loads.
new MutationObserver(migratePrivateControls).observe(document.body,{childList:true});
migratePrivateControls();
tools.addEventListener('toggle', () => window.dispatchEvent(new Event('resize')));
for (const id of ['verifyBtn','statsBtn','gearBtn','pbStat','rankStat']) {
  document.getElementById(id)?.addEventListener('click', () => { tools.open = false; });
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && tools.open) {
    tools.open = false;
    tools.querySelector('summary').focus();
  }
});
document.addEventListener('pointerdown', event => {
  if (tools.open && !tools.contains(event.target)) tools.open = false;
});
// Native stake buttons already handle keyboard activation and disabled states.
// Arrow navigation selects focus only; Enter/Space explicitly selects the stake.
document.getElementById('stakeRow').addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
  const chips = [...document.querySelectorAll('#stakeRow button:not(:disabled)')];
  const current = chips.indexOf(document.activeElement);
  if (current < 0) return;
  event.preventDefault();
  chips[(current + (event.key === 'ArrowRight' ? 1 : chips.length - 1)) % chips.length].focus();
});

// Quotes are approximate display data, never an input to the wager.
let quote = null;
const privateMode = new URLSearchParams(location.search).get('playtest') === '1';
const localMode = (document.querySelector('meta[name="plank-invite"]')?.content==='simulated'||['127.0.0.1','localhost'].includes(location.hostname)) && !privateMode;
if(localMode) {
  stakeLabel.textContent = 'Stake · test ETH';
  document.getElementById('simBtn').textContent = '▶ Start practice';
}
function paintQuotes() {
  const fresh = quote && Date.now()-quote.at < 120000;
  for(const chip of document.querySelectorAll('#stakeRow button[data-amt]')) {
    const eth = Number(chip.dataset.amt);
    const label = `Ξ ${chip.dataset.amt} ETH`;
    const usd = fresh ? `≈ ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:eth*quote.price<.01?4:2}).format(eth*quote.price)}` : 'USD unavailable';
    const text = `${label}\n${usd}`;
    if(chip.textContent !== text)chip.textContent=text;
    chip.setAttribute('aria-label',`${label}, ${usd}${localMode?', test funds with no cash value':''}`);
  }
  if(!privateMode) {
    const chip=document.querySelector('#stakeRow .active');
    document.getElementById('stakeValueQuote').textContent = localMode ? 'Test funds · no cash value' : 'USD estimates exclude gas fees';
  }
}
async function refreshQuote() {
  try {
    const r=await fetch('/api/market/eth-price',{signal:AbortSignal.timeout(5000)});
    if(r.ok){const p=await r.json();if(Number.isFinite(p.ethUsd)&&p.ethUsd>0&&Number.isFinite(p.ageMs)&&p.ageMs<120000)quote={price:p.ethUsd,at:Date.now()-p.ageMs};}
  } catch { /* Missing price stays visibly unavailable. */ }
  paintQuotes();
}
new MutationObserver(paintQuotes).observe(document.getElementById('stakeRow'),{childList:true,subtree:true,attributes:true,attributeFilter:['class','data-amt']});
void refreshQuote();setInterval(refreshQuote,30000);

// One focused playfield. Economic details live behind one compact button.
const economy=document.createElement('button');economy.className='console-economy';economy.textContent='Pool & prizes';
economy.addEventListener('click',()=>document.getElementById('pbStat').click());
drawer.append(economy);
const result=document.getElementById('resultDelta');
const receipt=document.createElement('div');receipt.className='console-receipt';receipt.setAttribute('aria-live','polite');
document.getElementById('btnSub').after(receipt);
new MutationObserver(()=>{receipt.textContent=result.textContent;}).observe(result,{childList:true,subtree:true});

const explore=document.createElement('button');explore.className='console-economy';explore.textContent='Explore space';
explore.addEventListener('click',()=>{tools.open=false;document.dispatchEvent(new Event('plank:explore'));});drawer.append(explore);

// Select from the contract-backed presets without introducing another money calculation.
let practiceConnected=!localMode;
document.addEventListener('plank:connected',()=>{practiceConnected=true;syncPicker();});
const stakes=document.getElementById('stakeRow');
const picker=document.createElement('div');picker.className='pocket-stake-picker';
picker.innerHTML='<button type="button" aria-label="Lower stake">−</button><output aria-live="polite"></output><button type="button" aria-label="Higher stake">+</button>';
stakes.before(picker);stakes.hidden=true;
const choices=[...stakes.querySelectorAll('button[data-amt]')];
const [lower,higher]=picker.querySelectorAll('button');
function syncPicker(){const index=Math.max(0,choices.findIndex(c=>c.classList.contains('active')));picker.querySelector('output').textContent=choices[index]?.textContent||'Loading stake…';lower.disabled=index===0||choices[index-1]?.disabled;higher.disabled=index===choices.length-1||choices[index+1]?.disabled;}
for(const [control,direction] of [[lower,-1],[higher,1]])control.addEventListener('click',()=>{const index=Math.max(0,choices.findIndex(c=>c.classList.contains('active')));choices[index+direction]?.click();syncPicker();});
new MutationObserver(syncPicker).observe(stakes,{subtree:true,childList:true,attributes:true,attributeFilter:['class','disabled','data-amt']});syncPicker();

const dock=document.createElement('div');dock.className='pocket-actions';document.querySelector('.deck').prepend(dock);dock.append(picker,target,document.getElementById('primaryBtn'));
target.firstChild.textContent='';
const targetMark=document.createElement('span');targetMark.className='target-mark';targetMark.setAttribute('aria-hidden','true');targetMark.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/></svg>';target.prepend(targetMark);
target.title='Target set before launch. Reach it to qualify; payout is limited by funding.';
const targetField=document.getElementById('autoTargetInput');
function fitTargetValue(){
  if(document.body.dataset.playtest==='true')return;
  const length=Math.max(3,targetField.value.length);
  targetField.style.setProperty('font-size',`${Math.max(16,Math.min(23,Math.floor((targetField.clientWidth-4)/(length*.64))))}px`,'important');
}
targetField.addEventListener('input',fitTargetValue);
new ResizeObserver(fitTargetValue).observe(targetField);
const history=document.getElementById('historyRibbon');if(history)drawer.append(history);
drawer.append(document.getElementById('simBtn'));
if(localMode)document.getElementById('primaryBtn').textContent='Practice';

// The invite bar and receipt change the dock height. Reserve its actual space
// instead of assuming a fixed 136px; expanded fuel controls remain scrollable.
const publicDeck=document.querySelector('.deck');
let layoutFrame=0;
function fitPublicConsole(){
  cancelAnimationFrame(layoutFrame);
  layoutFrame=requestAnimationFrame(()=>{
    if(document.body.dataset.playtest==='true')return;
    const height=Math.ceil(publicDeck.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--console-dock-height',`${height}px`);
  });
}
new ResizeObserver(fitPublicConsole).observe(publicDeck);
window.addEventListener('resize',fitPublicConsole,{passive:true});
fitPublicConsole();
