import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import ts from 'typescript';import {readFile} from 'node:fs/promises';
const source=ts.transpileModule(await readFile(new URL('../../app/charmville/world/use-menu-gamepad.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
test('parent controller neutral latch, edge click, iframe isolation and typing suppression',()=>{
 let tick,cleanup,back=0,press=[];class Element{constructor(tag='BUTTON'){this.tagName=tag;this.tabIndex=0;this.clicks=0;}getClientRects(){return [1];}matches(){return false;}closest(){return null;}getAttribute(){return null;}dispatchEvent(event){if(this.handleArrow){event.defaultPrevented=true;b.focus();}return !event.defaultPrevented;}focus(){document.activeElement=this;}click(){this.clicks++;}}
 const a=new Element(),b=new Element(),scope={querySelector:()=>null,querySelectorAll:()=>[a,b],contains:e=>[a,b].includes(e)};
 const document={activeElement:a,hidden:false,hasFocus:()=>true,addEventListener(){},removeEventListener(){}};
 const exports={};vm.runInNewContext(source,{exports,require:()=>({useEffect:fn=>{cleanup=fn();}}),HTMLElement:Element,HTMLSelectElement:class{},document,window:{addEventListener(){},removeEventListener(){}},navigator:{getGamepads:()=>[{connected:true,mapping:'standard',buttons:Array.from({length:16},(_,i)=>({pressed:press.includes(i)})),axes:[0,0]}]},requestAnimationFrame:fn=>{tick=fn;return 1;},cancelAnimationFrame(){},KeyboardEvent:class{constructor(type,options){Object.assign(this,options);this.defaultPrevented=false;}},Event:class{}});
 exports.useMenuGamepad({current:scope},true,()=>back++);
 press=[0];tick();assert.equal(a.clicks,0);press=[];tick();press=[0];tick();tick();assert.equal(a.clicks,1);
 press=[];tick();press=[13];tick();assert.equal(document.activeElement,b);press=[];tick();press=[1];tick();assert.equal(back,1);
 document.activeElement=new Element('IFRAME');press=[];tick();press=[0];tick();assert.equal(b.clicks,0);
 document.activeElement=b;tick();assert.equal(b.clicks,0);press=[];tick();press=[0];tick();assert.equal(b.clicks,1);
 document.fullscreenElement=new Element('MAIN');document.activeElement=a;press=[];tick();press=[0];tick();assert.equal(a.clicks,2,'main fullscreen still allows parent controls');
 a.handleArrow=true;press=[];tick();press=[15];tick();assert.equal(document.activeElement,b,'handled roving arrow must not also apply fallback');
 a.handleArrow=false;document.activeElement=a;press=[];tick();press=[13];tick();assert.equal(document.activeElement,b,'unhandled down arrow falls back to next control');
 document.activeElement=new Element('INPUT');press=[];tick();press=[1];tick();assert.equal(back,1);cleanup();
});
