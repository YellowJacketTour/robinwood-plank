// Presentation only: never changes the native simulation or backing resolution.
const canvas=document.getElementById('canvas');
const header=document.querySelector('header');
const panel=document.createElement('details');
panel.innerHTML='<summary>Display</summary><label>Game size <input aria-label="Game size" type="range" min="50" max="200" step="10" value="100"></label><output>100%</output><button type="button">Fit</button><button type="button">Fullscreen</button><label><input type="checkbox" aria-label="Whole pixel scaling"> Whole-pixel scaling</label><p>Fullscreen fills your display with the game. This source quest shows one native camera view; zoom does not reveal additional land.</p>';
header.append(panel);
const style=document.createElement('style');
style.textContent=`header{flex-wrap:wrap;gap:8px;z-index:10001}header details{background:black;max-width:min(560px,95vw)}header summary,header button{min-height:36px}header input{vertical-align:middle}.charm-pad-mapping{display:grid;gap:8px}#canvas{touch-action:none;image-rendering:pixelated;flex-shrink:0;width:var(--charm-width)!important;height:var(--charm-height)!important;max-width:none!important;max-height:none!important}.content{overflow:auto;max-width:100vw;justify-content:safe center}.touch-inputs{flex-shrink:0}@media(hover:none){.touch-inputs{margin:8px;min-width:100px}.dpad .touch-input{min-width:34px;min-height:34px}}@media(hover:none) and (max-width:600px){.content{flex-wrap:wrap}#canvas{order:0}.touch-inputs{order:1;flex:1 0 40%;height:170px}.touch-inputs .flex{margin:5px 0!important}.touch-input{min-height:36px;padding:5px 4px}}`;
document.head.append(style);
const cinema=document.createElement('div');cinema.className='charm-cinema-tools';cinema.innerHTML='<button type="button">Menu</button><button type="button">Exit fullscreen</button>';document.body.append(cinema);
cinema.children[0].onclick=()=>{document.body.classList.toggle('charm-cinema-menu');fit();};
cinema.children[1].onclick=()=>document.exitFullscreen();
let zoom=1;
try{zoom=Math.max(.5,Math.min(2,Number(localStorage.getItem('charmville-display-zoom'))||1));}catch{/* Storage is optional. */}
const slider=panel.querySelector('input[type=range]'),output=panel.querySelector('output');
const pixels=panel.querySelector('input[type=checkbox]');
try{pixels.checked=localStorage.getItem('charmville-whole-pixels')==='true';}catch{/* Optional preference. */}
pixels.onchange=()=>{try{localStorage.setItem('charmville-whole-pixels',String(pixels.checked));}catch{/* Optional preference. */}fit();};
function fit(){
 const w=canvas.width||256,h=canvas.height||224;
 const mobile=matchMedia('(hover:none)').matches;
 const portrait=mobile&&innerWidth<=600;
 const availableWidth=Math.max(128,innerWidth-(mobile&&!portrait?220:16));
 const availableHeight=Math.max(112,innerHeight-header.getBoundingClientRect().height-(portrait?200:(document.fullscreenElement?48:20)));
 let scale=Math.min(availableWidth/w,availableHeight/h)*zoom;
 if(document.fullscreenElement)scale=Math.min(scale,availableWidth/w,availableHeight/h);
 if(pixels.checked&&scale>=1)scale=Math.floor(scale);
 canvas.style.setProperty('--charm-width',`${Math.round(w*scale)}px`);
 canvas.style.setProperty('--charm-height',`${Math.round(h*scale)}px`);
 slider.value=String(Math.round(zoom*100));output.textContent=`${slider.value}%`;
}
function setZoom(value){zoom=Math.max(.5,Math.min(2,value));try{localStorage.setItem('charmville-display-zoom',String(zoom));}catch{/* Optional preference. */}fit();}
slider.addEventListener('input',()=>setZoom(Number(slider.value)/100));
// BEGIN native display navigation
function bindDisplayNavigation(surface,host,root,readZoom,writeZoom,ready=()=>true){
 const blocked=()=>!ready()||Boolean(root.querySelector('dialog[open], [aria-modal="true"]'));
 surface.addEventListener('wheel',event=>{
  if(blocked()||event.altKey||event.metaKey)return;
  const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?surface.clientHeight:1);
  if(!Number.isFinite(delta)||delta===0)return;
  event.preventDefault();event.stopImmediatePropagation();
  writeZoom(readZoom()*Math.exp(-Math.max(-500,Math.min(500,delta))*.002));
 },{passive:false,capture:true});
 const zoomKeys=new Set(['+','=','-','_','0','PageUp','PageDown']);
 const ownedKeys=new Set();
 const handle=event=>{
  if(event.type==='keyup'){
   if(ownedKeys.delete(event.key)){event.preventDefault();event.stopImmediatePropagation();}
   return;
  }
  if(blocked()||root.hidden||event.ctrlKey||event.metaKey||event.altKey||!zoomKeys.has(event.key))return;
  if(event.target!==surface&&root.activeElement!==surface)return;
  if(event.target?.tagName&&['INPUT','TEXTAREA','SELECT','BUTTON'].includes(event.target.tagName))return;
  event.preventDefault();event.stopImmediatePropagation();
  ownedKeys.add(event.key);
  writeZoom(event.key==='0'?1:readZoom()*(['+','=','PageUp'].includes(event.key)?1.1:1/1.1));
 };
 host.addEventListener('keydown',handle,true);host.addEventListener('keyup',handle,true);
 host.addEventListener('blur',()=>ownedKeys.clear());
 let pinch=null,pinchOwned=false;
 const distance=touches=>Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY);
 surface.addEventListener('touchstart',event=>{
  if(pinchOwned){event.preventDefault();event.stopImmediatePropagation();}
  if(blocked()||event.touches.length!==2){pinch=null;return;}
  // Release any native one-finger interaction before taking over both fingers.
  // If cancellation cannot be represented, retain the native gesture instead.
  if(typeof TouchEvent!=='function')return;
  try{surface.dispatchEvent(new TouchEvent('touchcancel',{bubbles:true,cancelable:true,touches:[],targetTouches:[],changedTouches:event.touches}));}catch{return;}
  pinchOwned=true;
  pinch={distance:distance(event.touches),zoom:readZoom()};
  event.preventDefault();event.stopImmediatePropagation();
 },{passive:false,capture:true});
 surface.addEventListener('touchmove',event=>{
  if(pinchOwned){event.preventDefault();event.stopImmediatePropagation();}
  if(blocked()||!pinch||event.touches.length!==2)return;
  const current=distance(event.touches);
  if(pinch.distance>0&&Number.isFinite(current))writeZoom(pinch.zoom*current/pinch.distance);
  event.preventDefault();event.stopImmediatePropagation();
 },{passive:false,capture:true});
 for(const type of ['touchend','touchcancel'])surface.addEventListener(type,event=>{
  pinch=null;
  if(pinchOwned){event.preventDefault();event.stopImmediatePropagation();if(!event.touches?.length)pinchOwned=false;}
 },{passive:false,capture:true});
}
// END native display navigation
// Camera gestures never write CSS size. Only a capable native frame may accept
// a request; legacy runtimes keep these controls hidden and gestures untouched.
const camera=document.createElement('fieldset');camera.hidden=true;
camera.innerHTML='<legend>World camera</legend><label>View distance <input aria-label="World camera zoom" type="range" min="50" max="100" step="5" value="100"></label><output aria-live="polite">100%</output><button type="button">Wide view</button><button type="button">Follow view</button><p>Wheel or pinch to see more land. + / − zoom; 0 resets. Window size stays fixed.</p>';
panel.append(camera);
const mapButton=document.createElement('button');mapButton.type='button';mapButton.hidden=true;mapButton.textContent='Map overview';panel.append(mapButton);
const mapHelp=document.createElement('span');mapHelp.hidden=true;mapHelp.textContent='Arrows: pan · Z / X: zoom · Return to world: close';
mapButton.onclick=()=>{if(window.charmvilleMapReady===true){if(window.charmvilleMapOpen===true)window.charmvilleCloseMap=true;else window.charmvilleOpenMap=true;for(const detail of header.querySelectorAll('details[open]'))detail.open=false;canvas.focus();}};
const cameraSlider=camera.querySelector('input'),cameraOutput=camera.querySelector('output');
const cameraReady=()=>window.charmvilleCameraReady===true&&window.charmvilleMapOpen!==true;
const readCamera=()=>Number.isFinite(window.charmvilleCameraZoom)?window.charmvilleCameraZoom:1;
function requestCamera(value){
 if(!cameraReady()||!Number.isFinite(value))return;
 window.charmvilleCameraZoom=Math.max(.5,Math.min(1,value));
 cameraSlider.value=String(Math.round(window.charmvilleCameraZoom*100));
}
cameraSlider.addEventListener('input',()=>requestCamera(Number(cameraSlider.value)/100));
camera.querySelectorAll('button')[0].onclick=()=>requestCamera(.5);
camera.querySelectorAll('button')[1].onclick=()=>requestCamera(1);
bindDisplayNavigation(canvas,window,document,readCamera,requestCamera,cameraReady);
const refreshCameraStatus=()=>{
 mapButton.hidden=window.charmvilleMapReady!==true;
 if(!mapButton.hidden&&mapButton.parentElement!==header)header.append(mapButton);
 mapHelp.hidden=window.charmvilleMapOpen!==true;if(!mapHelp.hidden&&mapHelp.parentElement!==header)header.append(mapHelp);
 mapButton.textContent=window.charmvilleMapOpen===true?'Return to world':'Map overview';
 camera.hidden=!cameraReady();
 if(camera.hidden)return;
 const actual=window.charmvilleCameraActualZoom;
 cameraOutput.textContent=Number.isFinite(actual)?`${Math.round(actual*100)}%`: 'Applying…';
 panel.querySelector('p').textContent='Game size scales the display. World camera changes how much land you see.';
};
let cameraStatus=setInterval(refreshCameraStatus,250);
addEventListener('pagehide',()=>{clearInterval(cameraStatus);cameraStatus=null;});
addEventListener('pageshow',()=>{if(cameraStatus===null)cameraStatus=setInterval(refreshCameraStatus,250);refreshCameraStatus();});
panel.querySelectorAll('button')[0].onclick=()=>setZoom(1);
panel.querySelectorAll('button')[1].onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{output.textContent='Fullscreen unavailable in this browser';}};
new MutationObserver(fit).observe(canvas,{attributes:true,attributeFilter:['width','height']});
new ResizeObserver(fit).observe(header);
addEventListener('resize',fit);document.addEventListener('fullscreenchange',()=>{document.body.classList.toggle('charm-cinema',Boolean(document.fullscreenElement));document.body.classList.remove('charm-cinema-menu');fit();});
// Presentation size remains available explicitly in Display, not as map zoom.
fit();
