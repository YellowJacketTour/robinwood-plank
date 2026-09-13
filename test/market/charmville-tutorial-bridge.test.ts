import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('resume and returning arrival focus the canvas without a native click or stealing control focus',()=>{
 const files=new Map<string,string>([['action-run.txt','1']]);
 const listeners:Record<string,(event:any)=>void>={};
 const children:any[]=[];let tick=()=>{},dialog=false,focusCount=0;
 const body={classList:{contains:()=>false}};
 const canvas={tabIndex:-1,focus(options:unknown){assert.deepEqual(JSON.parse(JSON.stringify(options)),{preventScroll:true});focusCount++;document.activeElement=canvas;},click(){assert.fail('canvas clicks open the native menu');}};
 const header={querySelector:()=>children.find(child=>child.className==='charm-focus-game'),append:(child:any)=>{children.push(child);child.isConnected=true;}};
 const document={body,activeElement:body as any,hasFocus:()=>true,addEventListener:(name:string,fn:(event:any)=>void)=>{listeners['document:'+name]=fn;},querySelector:(selector:string)=>selector==='header'?header:selector==='canvas'?canvas:dialog?{}:null,createElement:()=>({events:{} as Record<string,()=>void>,isConnected:false,addEventListener(name:string,fn:()=>void){this.events[name]=fn;}})};
 const parent={postMessage(){}};
 const filename=(path:string)=>path.split('/').pop()!;
 runInNewContext(readFileSync('scripts/charmville/tutorial-bridge.js','utf8'),{
  parent,document,Uint32Array,crypto:{getRandomValues:(values:Uint32Array)=>values.fill(10)},
  window:{addEventListener:(name:string,fn:(event:any)=>void)=>{listeners[name]=fn;}},setInterval:(fn:()=>void)=>{tick=fn;return 1;},clearInterval(){},
  FS:{cwd:()=>'/x',analyzePath:(path:string)=>({exists:files.has(filename(path))}),readFile:(path:string)=>files.get(filename(path)),writeFile:(path:string,value:string)=>files.set(filename(path),value)}
 });
 tick();const resume=children.find(child=>child.className==='charm-focus-game');
 resume.events.click();assert.equal(focusCount,1);assert.equal(canvas.tabIndex,0);
 dialog=true;resume.events.click();assert.equal(focusCount,1);dialog=false;
 listeners.message({source:parent,origin:'http://localhost:3017',data:{type:'charmville:tutorial-state',context:'a',completed:true}});tick();
 const nonce=files.get('tutorial-state.txt')!.split('|')[1];
 const enter={};listeners['document:click']({target:{closest:()=>enter}});document.activeElement=enter;
 files.set('tutorial-progress.txt',`${nonce}|2|0`);tick();assert.equal(focusCount,2);
 listeners['document:click']({target:{closest:()=>enter}});document.activeElement={tagName:'INPUT'};tick();assert.equal(focusCount,2);
 document.activeElement=body;tick();assert.equal(focusCount,2,'arrival focus request is consumed when the player chooses a control');
});

test('introduction requests advance once and reject stale context progress',()=>{
 const files=new Map<string,string>([['action-run.txt','1']]);
 const events:Record<string,(event?:unknown)=>void>={};
 const sent:Array<{type:string;context?:string}>=[];
 let tick=()=>{},random=100;
 const button={hidden:true,disabled:false,textContent:'',isConnected:false,addEventListener:(name:string,fn:()=>void)=>{events[name]=fn;},remove(){}};
 const parent={postMessage:(message:{type:string;context?:string})=>sent.push(message)};
 const filename=(path:string)=>path.split('/').pop()!;
 const body={classList:{contains:()=>false}};
 const document={activeElement:body,body,hasFocus:()=>true,addEventListener(){},querySelector:(selector:string)=>selector==='header'?{querySelector:()=>true,append:()=>{button.isConnected=true;}}:null,createElement:()=>button};
 runInNewContext(readFileSync('scripts/charmville/tutorial-bridge.js','utf8'),{
  parent,Uint32Array,crypto:{getRandomValues:(values:Uint32Array)=>{values[0]=++random;return values;}},
  document,
  window:{addEventListener:(name:string,fn:(event?:unknown)=>void)=>{events[name]=fn;}},
  setInterval:(fn:()=>void)=>{tick=fn;return 1;},clearInterval(){},
  FS:{cwd:()=>'/x',analyzePath:(path:string)=>({exists:files.has(filename(path))}),readFile:(path:string)=>files.get(filename(path)),writeFile:(path:string,value:string)=>files.set(filename(path),value)}
 });
 const message=(data:unknown,origin='http://localhost:3017')=>events.message({source:parent,origin,data});
 message({type:'charmville:tutorial-state',context:'a',completed:false},'https://untrusted.example');tick();
 assert.equal(files.has('tutorial-state.txt'),false,'untrusted hosts cannot set the introduction state');
 message({type:'charmville:tutorial-state',context:'a',completed:false});tick();
 const nonce=files.get('tutorial-state.txt')!.split('|')[1];
 files.set('tutorial-progress.txt',`${nonce}|0|0`);tick();assert.equal(button.hidden,false);
 events.click();assert.equal(files.get('tutorial-request.txt'),`${nonce}|1|0`);assert.equal(button.disabled,true);
 events.click();assert.equal(files.get('tutorial-request.txt'),`${nonce}|1|0`,'double clicks cannot queue another page');
 files.set('tutorial-progress.txt',`${nonce}|1|1`);tick();assert.equal(button.textContent,'Begin exploring');assert.equal(button.disabled,false);
 events.click();assert.equal(files.get('tutorial-request.txt'),`${nonce}|2|1`);
 files.set('tutorial-progress.txt',`${nonce}|2|2`);tick();assert.equal(button.hidden,true);
 assert(sent.some(message=>message.type==='charmville:tutorial-completed'&&message.context==='a'));
 message({type:'charmville:tutorial-reset',context:'a'});tick();assert.equal(button.hidden,true);
 message({type:'charmville:tutorial-state',context:'b',completed:false});tick();
 assert.notEqual(files.get('tutorial-state.txt')!.split('|')[1],nonce);assert.equal(button.hidden,true,'prior account progress is not shown');
 const nextNonce=files.get('tutorial-state.txt')!.split('|')[1];
 files.set('tutorial-progress.txt',`${nextNonce}|0|0`);tick();assert.equal(button.hidden,false);
 files.set('action-run.txt','2');tick();assert.equal(button.hidden,true,'a restarted runtime requires fresh progress');
 assert.notEqual(files.get('tutorial-state.txt')!.split('|')[1],nextNonce);
});
