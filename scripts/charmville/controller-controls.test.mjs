import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./controller-controls.js',import.meta.url),'utf8');
const code=source.split('// BEGIN action tap retention')[1].split('// END action tap retention')[0];
test('canvas arrows cancel browser scrolling without suppressing native keys or other controls',()=>{
 const context={};vm.runInNewContext(source.split('// BEGIN canvas navigation')[1].split('// END canvas navigation')[0],context);
 let keydown,dialog=null,focused=true;
 const canvas={tagName:'CANVAS'},body={},root={body,activeElement:canvas,hidden:false,hasFocus:()=>focused,querySelector:()=>dialog};
 context.bindCanvasNavigation({addEventListener:(type,fn)=>{keydown=fn;}},root);
 const press=(key,target=canvas,extra={})=>{const event={key,target,prevented:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){assert.fail('native event propagation must remain intact');},...extra};keydown(event);return event.prevented;};
 for(const key of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'])assert.equal(press(key),true);
 assert.equal(press('ArrowUp',root),true);assert.equal(press('ArrowUp',body),true);
 for(const key of ['Enter','Escape','z','Tab',' '])assert.equal(press(key),false);
 for(const modifier of ['ctrlKey','altKey','metaKey','shiftKey'])assert.equal(press('ArrowUp',canvas,{[modifier]:true}),false);
 for(const tagName of ['INPUT','SELECT','TEXTAREA','BUTTON','SUMMARY','DIV']){const control={tagName};assert.equal(press('ArrowDown',control),false);root.activeElement=control;assert.equal(press('ArrowDown',control),false);root.activeElement=canvas;}
 dialog={};assert.equal(press('ArrowUp'),false);dialog=null;
 focused=false;assert.equal(press('ArrowUp'),false);focused=true;
 root.hidden=true;assert.equal(press('ArrowUp'),false);
});
test('extra native action buttons hold once and release on pointer cancellation, keyboard and blur',()=>{
 const context={};vm.runInNewContext(source.split('// BEGIN native action buttons')[1].split('// END native action buttons')[0],context);
 const surface=()=>{const handlers={};return {handlers,addEventListener:(kind,fn)=>{handlers[kind]=fn;}};};
 const button=surface(),host=surface(),root=surface(),events=[];
 button.setPointerCapture=()=>{};
 context.bindNativeActionButton(button,'d',(key,down)=>events.push([key,down]),host,root);
 const pointer={button:0,pointerId:1,preventDefault(){}};
 button.handlers.pointerdown(pointer);button.handlers.pointerdown({...pointer,pointerId:2});
 button.handlers.pointerup({pointerId:2});assert.deepEqual(events,[['d',true]]);
 button.handlers.pointercancel(pointer);button.handlers.lostpointercapture(pointer);
 assert.deepEqual(events,[['d',true],['d',false]]);
 const keyboard={key:'Enter',preventDefault(){},stopPropagation(){}};
 button.handlers.keydown(keyboard);button.handlers.keydown(keyboard);button.handlers.keyup(keyboard);
 button.handlers.pointerdown(pointer);host.handlers.blur();
 assert.deepEqual(events,[['d',true],['d',false],['d',true],['d',false],['d',true],['d',false]]);
 button.handlers.pointerdown(pointer);root.hidden=true;root.handlers.visibilitychange();assert.equal(events.at(-1)[1],false);
});
function fixture(){
 let time=0,enabled=true,id=0;const handlers={},timers=new Map(),released=[];
 const context={Set,Map,WeakSet};vm.runInNewContext(code,context);
 const clear=context.retainActionTaps({target:{addEventListener:(kind,fn)=>{handlers[kind]=fn;}},active:()=>enabled,
  now:()=>time,schedule:(fn,delay)=>{timers.set(++id,{fn,at:time+delay});return id;},cancel:key=>timers.delete(key),sendUp:key=>released.push([key,time])});
 const event=(kind,key,extra={})=>{const value={key,blocked:false,stopImmediatePropagation(){this.blocked=true;},preventDefault(){},...extra};handlers[kind](value);return value;};
 return {event,clear,released,enable:value=>{enabled=value;},advance:value=>{time+=value;for(const [key,timer] of [...timers])if(timer.at<=time){timers.delete(key);timer.fn();}}};
}
test('subframe action is released after 40ms, without synthesizing another press',()=>{
 const f=fixture();f.event('keydown','d');f.advance(2);assert(f.event('keyup','d').blocked);f.advance(37);assert.deepEqual(f.released,[]);f.advance(1);assert.deepEqual(f.released,[['d',40]]);
});
test('long held charge release and movement/menu keys are not delayed',()=>{
 const f=fixture();f.event('keydown','z');f.advance(900);assert.equal(f.event('keyup','z').blocked,false);
 for(const key of ['ArrowLeft','Enter','q','w']){f.event('keydown',key);assert.equal(f.event('keyup',key).blocked,false);}f.advance(100);assert.deepEqual(f.released,[]);
});
test('repeat preserves initial hold and rapid repress cancels pending release',()=>{
 const f=fixture();f.event('keydown','x');f.advance(5);f.event('keyup','x');f.advance(5);f.event('keydown','x');f.advance(50);assert.deepEqual(f.released,[]);assert.equal(f.event('keyup','x').blocked,false);
});
test('suspension and menu entry release once and cancel delayed release',()=>{
 const f=fixture();f.event('keydown','c');f.event('keyup','c');f.clear();f.advance(100);assert.deepEqual(f.released,[['c',0]]);
 f.event('keydown','z');f.event('keydown','Enter');assert.deepEqual(f.released,[['c',0],['z',100]]);
});
test('inactive and modified shortcuts never acquire retained state',()=>{
 const f=fixture();f.enable(false);f.event('keydown','d');assert.equal(f.event('keyup','d').blocked,false);f.enable(true);
 for(const modifier of ['ctrlKey','altKey','metaKey','shiftKey']){f.event('keydown','z',{[modifier]:true});assert.equal(f.event('keyup','z').blocked,false);}f.clear();assert.deepEqual(f.released,[]);
});
