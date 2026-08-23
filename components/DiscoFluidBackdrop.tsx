"use client";

import { useEffect, useRef } from "react";

const VERTEX = `
attribute vec2 p;
void main(){gl_Position=vec4(p,0.,1.);}
`;

// Background-only iridescent metaballs. This is deliberately procedural:
// no collection art or market data is filtered, tinted, or covered.
const FRAGMENT = `
precision highp float;
uniform vec2 r;
uniform float t,e,b,m,h,bias,accent,sat,impulse;
uniform vec4 pointer;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p=mat2(1.6,-1.2,1.2,1.6)*p;a*=.5;}return v;}
vec3 hsl(float hue,float s,float l){
  vec3 k=mod(vec3(0.,8.,4.)+hue*12.,12.);
  return l-s*min(l,1.-l)*max(-1.,min(min(k-3.,9.-k),1.));
}

void main(){
  vec2 uv=(2.*gl_FragCoord.xy-r.xy)/min(r.x,r.y);
  vec2 mouse=(2.*pointer.xy-r.xy)/min(r.x,r.y); mouse.y=-mouse.y;
  vec2 wakeVelocity=pointer.zw/min(r.x,r.y);
  float q=fbm(uv*1.15+vec2(t*.035,-t*.025));
  vec2 w=uv+vec2(fbm(uv*1.7+q+t*.03),fbm(uv*1.55-q-t*.026))*.42;
  float wake=exp(-5.5*length(w-mouse));
  w-=wakeVelocity*(2.2+.9*impulse)*wake;
  float field=0.;
  for(int i=0;i<7;i++){
    float fi=float(i);
    vec2 c=vec2(sin(t*(.08+.011*fi)+fi*2.13),cos(t*(.065+.009*fi)+fi*1.71));
    c*=vec2(.72,.58); c.y+=sin(t*.13+fi)*.12;
    field+=(.075+b*.025)/max(.018,dot(w-c,w-c));
  }
  field+=(.035+.055*impulse)/max(.025,dot(w-mouse,w-mouse));
  float liquid=smoothstep(.55,1.85,field+q*.7);
  float scales=.5+.5*cos(26.*length(w)*1.3-atan(w.y,w.x)*7.+q*8.-t*.28);
  float film=.5+.5*cos(11.*field+8.*q+t*.11+h*2.);
  vec3 primary=hsl(accent,sat,.34+.18*film);
  vec3 complement=hsl(fract(accent+.5),sat*.72,.28+.20*scales);
  vec3 split=hsl(fract(accent+.42),sat*.55,.22+.14*q);
  vec3 metal=mix(primary,complement,smoothstep(.58,.96,scales)*(.18+.18*(1.-bias)));
  metal=mix(metal,split,smoothstep(.82,1.,film)*.16);
  float spec=pow(max(0.,.5+.5*cos(field*9.-q*5.)),18.);
  vec3 koi=mix(metal,vec3(.025,.018,.03),smoothstep(.45,1.7,field)*.34)+vec3(spec)*(.22+.18*impulse);
  float edge=smoothstep(.03,.0,abs(field-1.05));
  vec3 col=koi+mix(primary,complement,.35)*edge*(.24+h*.18)+primary*pow(scales,12.)*(.08+h*.08);
  float vignette=1.-smoothstep(.45,1.45,length(uv));
  float alpha=(.12+.13*liquid+.08*edge+e*.10)*(.55+.45*vignette)*(1.-bias*.18);
  gl_FragColor=vec4(col,alpha);
}`;

type Spectrum = { energy: number; bass: number; mid: number; treble: number };

export default function DiscoFluidBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl", { alpha: true, antialias: false, powerPreference: "high-performance" });
    if (!canvas || !gl) return;
    const shader = (kind: number, source: string) => {
      const s = gl.createShader(kind)!; gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
      return s;
    };
    let program: WebGLProgram;
    try {
      program = gl.createProgram()!;
      gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "shader link failed");
    } catch { return; }
    gl.useProgram(program);
    const buffer=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buffer); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const pos=gl.getAttribLocation(program,"p"); gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
    const u=(name:string)=>gl.getUniformLocation(program,name);
    const uniforms={r:u("r"),t:u("t"),e:u("e"),b:u("b"),m:u("m"),h:u("h"),bias:u("bias"),accent:u("accent"),sat:u("sat"),pointer:u("pointer"),impulse:u("impulse")};
    const spectrum: Spectrum={energy:0,bass:0,mid:0,treble:0};
    const onSpectrum=(event:Event)=>Object.assign(spectrum,(event as CustomEvent<Spectrum>).detail);
    window.addEventListener("plank:audio-spectrum",onSpectrum);
    const reduced=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const root=document.documentElement;
    const pointer={x:innerWidth*.5,y:innerHeight*.5,tx:innerWidth*.5,ty:innerHeight*.5,vx:0,vy:0,impulse:0};
    const theme={bias:.35,accent:40/360,sat:.78};
    const readTheme=()=>{const style=getComputedStyle(root);theme.bias=Number.parseFloat(style.getPropertyValue("--melt-bias"))||.35;theme.accent=(((Number.parseFloat(style.getPropertyValue("--accent-h"))||40)%360+360)%360)/360;theme.sat=Math.min(1,Math.max(.18,(Number.parseFloat(style.getPropertyValue("--accent-s"))||78)/100));};
    readTheme();
    const themeObserver=new MutationObserver(readTheme); themeObserver.observe(root,{attributes:true,attributeFilter:["class","style","data-theme"]});
    const move=(x:number,y:number,strength=1)=>{pointer.vx+=(x-pointer.tx)*strength;pointer.vy+=(y-pointer.ty)*strength;pointer.tx=x;pointer.ty=y;pointer.impulse=Math.min(1,pointer.impulse+.22*strength);};
    const onPointer=(event:PointerEvent)=>move(event.clientX,event.clientY,event.pointerType==="touch"?1.35:1);
    const onWheel=(event:WheelEvent)=>{pointer.vy+=Math.sign(event.deltaY)*Math.min(140,Math.abs(event.deltaY))*.65;pointer.impulse=Math.min(1,pointer.impulse+(event.ctrlKey ? .55 : .22));};
    const onPointerUp=(event:PointerEvent)=>{move(event.clientX,event.clientY,event.pointerType==="touch"?1.8:1.15);pointer.impulse=1;};
    const onScroll=()=>{pointer.vy+=(scrollY-(Number(canvas.dataset.scroll)||scrollY))*.7;canvas.dataset.scroll=String(scrollY);pointer.impulse=Math.min(1,pointer.impulse+.12);};
    window.addEventListener("pointermove",onPointer,{passive:true}); window.addEventListener("pointerdown",onPointer,{passive:true}); window.addEventListener("pointerup",onPointerUp,{passive:true});
    window.addEventListener("wheel",onWheel,{passive:true}); window.addEventListener("scroll",onScroll,{passive:true});
    let frame=0;
    const resize=()=>{const dpr=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.max(1,Math.floor(innerWidth*dpr));canvas.height=Math.max(1,Math.floor(innerHeight*dpr));gl.viewport(0,0,canvas.width,canvas.height);};
    resize(); window.addEventListener("resize",resize,{passive:true});
    const started=performance.now();
    const draw=()=>{
      const active=root.dataset.melt==="1";
      canvas.hidden=!active;
      if(active){
        pointer.vx+=(pointer.tx-pointer.x)*.028; pointer.vy+=(pointer.ty-pointer.y)*.028;
        pointer.vx*=.88; pointer.vy*=.88; pointer.x+=pointer.vx; pointer.y+=pointer.vy; pointer.impulse*=.955;
        gl.uniform2f(uniforms.r,canvas.width,canvas.height); gl.uniform1f(uniforms.t,reduced?0:(performance.now()-started)/1000);
        gl.uniform1f(uniforms.e,spectrum.energy); gl.uniform1f(uniforms.b,spectrum.bass); gl.uniform1f(uniforms.m,spectrum.mid); gl.uniform1f(uniforms.h,spectrum.treble); gl.uniform1f(uniforms.bias,theme.bias);
        gl.uniform1f(uniforms.accent,theme.accent); gl.uniform1f(uniforms.sat,theme.sat); gl.uniform4f(uniforms.pointer,pointer.x*(canvas.width/innerWidth),pointer.y*(canvas.height/innerHeight),pointer.vx,pointer.vy); gl.uniform1f(uniforms.impulse,reduced?0:pointer.impulse);
        gl.drawArrays(gl.TRIANGLES,0,6);
      }
      frame=requestAnimationFrame(draw);
    };
    frame=requestAnimationFrame(draw);
    return()=>{cancelAnimationFrame(frame);themeObserver.disconnect();window.removeEventListener("resize",resize);window.removeEventListener("pointermove",onPointer);window.removeEventListener("pointerdown",onPointer);window.removeEventListener("pointerup",onPointerUp);window.removeEventListener("wheel",onWheel);window.removeEventListener("scroll",onScroll);window.removeEventListener("plank:audio-spectrum",onSpectrum);gl.deleteProgram(program);};
  },[]);
  return <canvas ref={canvasRef} aria-hidden className="disco-fluid-backdrop" />;
}
