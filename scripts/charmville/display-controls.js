// Presentation only: never changes the native simulation or backing resolution.
const canvas=document.getElementById('canvas');
const header=document.querySelector('header');
const panel=document.createElement('details');
panel.innerHTML='<summary>Display</summary><label>Game size <input aria-label="Game size" type="range" min="50" max="200" step="10" value="100"></label><output>100%</output><button type="button">Fit</button><button type="button">Fullscreen</button><p>Zoom changes the view, not movement speed. Larger views can be scrolled. Button mapping is available in Controller.</p>';
header.append(panel);
const style=document.createElement('style');
style.textContent=`header{flex-wrap:wrap;gap:8px;z-index:10001}header details{background:black;max-width:min(560px,95vw)}header summary,header button{min-height:36px}header input{vertical-align:middle}.charm-pad-mapping{display:grid;gap:8px}#canvas{touch-action:none;image-rendering:pixelated;flex-shrink:0;width:var(--charm-width)!important;height:var(--charm-height)!important;max-width:none!important;max-height:none!important}.content{overflow:auto;max-width:100vw;justify-content:safe center}.touch-inputs{flex-shrink:0}@media(hover:none){.touch-inputs{margin:8px;min-width:100px}.dpad .touch-input{min-width:34px;min-height:34px}}@media(hover:none) and (max-width:600px){.content{flex-wrap:wrap}#canvas{order:0}.touch-inputs{order:1;flex:1 0 40%;height:170px}.touch-inputs .flex{margin:5px 0!important}.touch-input{min-height:36px;padding:5px 4px}}`;
document.head.append(style);
let zoom=1;
try{zoom=Math.max(.5,Math.min(2,Number(localStorage.getItem('charmville-display-zoom'))||1));}catch{/* Storage is optional. */}
const slider=panel.querySelector('input'),output=panel.querySelector('output');
function fit(){
 const w=canvas.width||256,h=canvas.height||224;
 const mobile=matchMedia('(hover:none)').matches;
 const portrait=mobile&&innerWidth<=600;
 const availableWidth=Math.max(128,innerWidth-(mobile&&!portrait?220:16));
 const availableHeight=Math.max(112,innerHeight-header.getBoundingClientRect().height-(portrait?200:20));
 const scale=Math.min(availableWidth/w,availableHeight/h)*zoom;
 canvas.style.setProperty('--charm-width',`${Math.round(w*scale)}px`);
 canvas.style.setProperty('--charm-height',`${Math.round(h*scale)}px`);
 slider.value=String(Math.round(zoom*100));output.textContent=`${slider.value}%`;
}
function setZoom(value){zoom=Math.max(.5,Math.min(2,value));try{localStorage.setItem('charmville-display-zoom',String(zoom));}catch{/* Optional preference. */}fit();}
slider.addEventListener('input',()=>setZoom(Number(slider.value)/100));
panel.querySelectorAll('button')[0].onclick=()=>setZoom(1);
panel.querySelectorAll('button')[1].onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{output.textContent='Fullscreen unavailable in this browser';}};
new MutationObserver(fit).observe(canvas,{attributes:true,attributeFilter:['width','height']});
new ResizeObserver(fit).observe(header);
addEventListener('resize',fit);document.addEventListener('fullscreenchange',fit);
// Two-finger pinch over the game; one-finger native controls are untouched.
let pinch=0,pinchZoom=1;
canvas.addEventListener('touchstart',e=>{if(e.touches.length===2){pinch=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);pinchZoom=zoom;}},{passive:true});
canvas.addEventListener('touchmove',e=>{if(e.touches.length===2&&pinch){e.preventDefault();setZoom(pinchZoom*Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY)/pinch);}},{passive:false});
canvas.addEventListener('touchend',()=>{pinch=0;});
fit();
