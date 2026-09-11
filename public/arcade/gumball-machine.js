// Decorative physics only. The caller supplies the already committed draw.
export function mountGumballMachine(canvas, card, drawNumber, populationSize = 16) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const colors = ['#ff769d','#ffc955','#7fe5bd','#86c9ff','#c09aff','#ffab75'];
  const count = Math.max(2, Math.min(64, Math.trunc(Number(populationSize) || 16)));
  const active = drawNumber !== null && drawNumber !== undefined;
  if (active && (!Number.isInteger(Number(drawNumber)) || Number(drawNumber) < 1 || Number(drawNumber) > count)) throw new RangeError('Invalid committed lottery ball');
  const balls = Array.from({length:count}, (_, i) => ({n:i+1,x:150+Math.cos(i*2.4)*(25+i%5*12),y:110+Math.sin(i*2.4)*(25+i%5*12),vx:Math.cos(i)*35,vy:Math.sin(i)*35}));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let frame, previous = performance.now(), progress = 0, disposed = false;
  const circle = (x,y,r,fill) => {ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();};
  const round = (x,y,w,h,r,fill) => {ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill();};
  // One offscreen sphere per colour, drawn once and blitted thereafter. The
  // previous version built a 3-stop radial gradient AND a blurred shadow for
  // every ball on every frame: at the 64-ball ceiling that is 64 gradient
  // objects plus 64 shadow-blur passes per frame, on the main thread, while
  // the WebGL composer runs bloom, god-rays and lens-flare. shadowBlur is the
  // most expensive 2D canvas operation there is and it is unaccelerated on
  // most drivers. Sprites are keyed by colour and radius bucket so a resize
  // rebuilds them rather than smearing a stale one.
  const sprites = new Map();
  function sphere(c, r) {
    const key = `${c}@${Math.round(r)}`;
    let sprite = sprites.get(key);
    if (sprite) return sprite;
    const pad = 6, size = Math.max(2, Math.ceil((r + pad) * 2));
    sprite = document.createElement('canvas'); sprite.width = sprite.height = size;
    const c2 = sprite.getContext('2d');
    if (c2) {
      const cx = size / 2, cy = size / 2;
      const g = c2.createRadialGradient(cx - r * .32, cy - r * .4, 1, cx, cy, r);
      g.addColorStop(0, '#fff9ed'); g.addColorStop(.23, c); g.addColorStop(1, c);
      c2.save(); c2.shadowColor = '#39204855'; c2.shadowBlur = 5; c2.shadowOffsetY = 3;
      c2.beginPath(); c2.arc(cx, cy, r, 0, Math.PI * 2); c2.fillStyle = g; c2.fill(); c2.restore();
      c2.beginPath(); c2.arc(cx - r * .32, cy - r * .4, r * .2, 0, Math.PI * 2); c2.fillStyle = '#ffffffb8'; c2.fill();
      c2.beginPath(); c2.arc(cx, cy + r * .12, r * .54, 0, Math.PI * 2); c2.fillStyle = '#fff8ea'; c2.fill();
    }
    if (sprites.size > 96) sprites.clear();
    sprites.set(key, sprite);
    return sprite;
  }
  function ball(x,y,r,n) {
    const c = colors[(n-1)%colors.length];
    const sprite = sphere(c, r);
    ctx.drawImage(sprite, x - sprite.width / 2, y - sprite.height / 2);
    // The sprite already carries the body, shadow and both highlights; only
    // the number varies per ball, so it stays a live draw.
    ctx.fillStyle='#49304c';ctx.font=`900 ${r*.72}px ui-rounded,system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(n),x,y+r*.15);
  }
  function render(now) {
    if(disposed)return;
    const dt=Math.min(.035,Math.max(0,(now-previous)/1000));previous=now;
    const w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight),d=Math.min(devicePixelRatio||1,2);
    if(canvas.width!==Math.round(w*d)||canvas.height!==Math.round(h*d)){canvas.width=Math.round(w*d);canvas.height=Math.round(h*d);}
    ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,w,h);
    const scale=Math.min(w/300,h/340);ctx.translate((w-300*scale)/2,(h-340*scale)/2);ctx.scale(scale,scale);
    const reveal=active&&['drawn','ejected','world'].includes(card.dataset.reveal);
    progress=reduced.matches?(reveal?1:0):Math.min(1,progress+(reveal?dt/1.25:0));
    ctx.save();ctx.translate(150,315);ctx.scale(1,.17);circle(0,0,101,'#26182766');ctx.restore();
    const body=ctx.createLinearGradient(70,0,240,0);body.addColorStop(0,'#b84273');body.addColorStop(.42,'#ff8ca7');body.addColorStop(1,'#d7527d');
    round(68,198,164,108,28,body);round(57,286,186,24,12,'#e9b54b');round(65,288,169,7,4,'#ffe69a');
    const globe=ctx.createRadialGradient(117,74,10,150,127,103);globe.addColorStop(0,'#f2fffb55');globe.addColorStop(.8,'#a8eddb22');globe.addColorStop(1,'#fff5dd88');circle(150,121,102,globe);
    ctx.save();ctx.beginPath();ctx.arc(150,121,96,0,Math.PI*2);ctx.clip();
    const r=count>32?10:14;
    if(!reduced.matches&&!document.hidden){
      for(let i=0;i<balls.length;i++)for(let j=i+1;j<balls.length;j++){
        const a=balls[i],b=balls[j];if(reveal&&(a.n===Number(drawNumber)||b.n===Number(drawNumber)))continue;
        const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
        if(length>0&&length<r*2){const nx=dx/length,ny=dy/length,push=(r*2-length)/2;a.x-=nx*push;a.y-=ny*push;b.x+=nx*push;b.y+=ny*push;const speed=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;if(speed<0){a.vx+=speed*nx*.85;a.vy+=speed*ny*.85;b.vx-=speed*nx*.85;b.vy-=speed*ny*.85;}}
      }
    }
    for(const b of balls){
      if(!(reveal&&b.n===Number(drawNumber))){
        if(!reduced.matches&&!document.hidden){b.vy+=65*dt;b.vx+=Math.sin(now/500+b.n)*30*dt;b.x+=b.vx*dt;b.y+=b.vy*dt;const dx=b.x-150,dy=b.y-121,len=Math.hypot(dx,dy),limit=94-r;if(len>limit){const nx=dx/len,ny=dy/len;b.x=150+nx*limit;b.y=121+ny*limit;const dot=b.vx*nx+b.vy*ny;b.vx-=1.8*dot*nx;b.vy-=1.8*dot*ny;if(b.y>175)b.vy-=38;}}
        ball(b.x,b.y,r,b.n);
      }
    }
    ctx.restore();
    ctx.lineWidth=4;ctx.strokeStyle='#fff1c9aa';ctx.beginPath();ctx.arc(150,121,100,0,Math.PI*2);ctx.stroke();
    ctx.strokeStyle='#ffffffaa';ctx.lineWidth=9;ctx.lineCap='round';ctx.beginPath();ctx.arc(150,121,85,3.55,4.25);ctx.stroke();
    round(108,17,84,14,7,'#ffd979');round(129,9,42,12,6,'#ff99b0');
    circle(150,235,22,'#ffe396');circle(150,235,16,'#8b4969');
    ctx.save();ctx.translate(150,235);ctx.rotate(progress*Math.PI*2);round(-20,-5,40,10,5,'#fff0b5');ctx.restore();
    round(121,266,58,26,12,'#562849');round(127,270,46,18,8,'#251b35');
    if(reveal){const t=1-Math.pow(1-progress,3);const bounce=Math.sin(progress*Math.PI*3)*(1-progress)*16;ball(150+55*t,274+33*t-Math.sin(t*Math.PI)*40-bounce,17+4*t,Number(drawNumber));}
    frame=requestAnimationFrame(render);
  }
  frame=requestAnimationFrame(render);
  return () => {disposed=true;cancelAnimationFrame(frame);};
}
