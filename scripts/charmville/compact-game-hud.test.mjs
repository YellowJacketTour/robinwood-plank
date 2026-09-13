import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCompactHud,mountCompactHud} from './compact-game-hud.mjs';

test('parses local and account counters without inventing unavailable XP or seeds',()=>{
 assert.equal(parseCompactHud('1|2|1|1|0|0|0|0|0|-1|0|0|60|1').seeds,-1);
 assert.equal(parseCompactHud('1|2|7|3|8|-1|0|2|1|4|0|0|80|1').xp,-1);
 for(const input of ['', '1|2|1|1|0|0|0|0|0|-1|0|0|NaN|1','1|2|50|1|0|0|0|0|0|-1|0|0|60|1'])assert.equal(parseCompactHud(input),null);
});

test('leases only visible valid HUD and removes stale readout on invalid native state',()=>{
 const el=()=>Object.assign(new EventTarget(),{style:{},hidden:true,setAttribute(){},remove(){},getBoundingClientRect:()=>({height:40})});
 const panel=el(),task=el(),button=el(),details=el(),stock=el(),care=el();
 panel.querySelector=s=>({'[data-task]':task,button,'#charm-crop-details':details,'[data-stock]':stock,'[data-care]':care})[s];
 let poll,cleared=false;
 const view=Object.assign(new EventTarget(),{innerWidth:640,innerHeight:800,matchMedia:()=>({matches:false}),setInterval:fn=>(poll=fn,1),clearInterval:()=>{cleared=true;}});
 const canvas={getBoundingClientRect:()=>({left:20,top:50,bottom:500,width:500,height:450})};
 const root={defaultView:view,createElement:()=>panel,body:{append(){},classList:{contains:()=>false}},querySelector:s=>s==='canvas'?canvas:null};
 let state='1|2|2|1|0|0|0|0|0|-1|0|0|60|1';const writes=[];
 const fs={cwd:()=> '/',readFile:path=>path.endsWith('action-run.txt')?'run':state,writeFile:(...args)=>writes.push(args)};
 const dispose=mountCompactHud(root,{getFS:()=>fs});
 assert.equal(panel.hidden,false);assert.match(task.textContent,/Plant a seed/);assert.equal(writes.length,1);
 state='1|2|12|1|0|0|0|0|0|-1|0|0|61|1';poll();
 assert.equal(task.textContent,'Bed 1 · Move closer to this bed');
 assert.doesNotMatch(task.textContent,/E \/ D|Interact/);
 const writesAfterMove=writes.length;
 state='bad';poll();assert.equal(panel.hidden,true);assert.equal(writes.length,writesAfterMove);
 state='1|2|0|1|0|0|0|0|0|-1|0|0|80|0';poll();assert.equal(panel.hidden,true);assert.equal(writes.length,writesAfterMove);
 dispose();assert.equal(cleared,true);
});

// Execute the native task-priority statements unchanged; this is not a quest compile.
test('native proximity guidance preserves permission and pending-state priority',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {runInNewContext}=await import('node:vm');
 const source=await readFile(new URL('./zquest/Homestead.zs',import.meta.url),'utf8');
 const start=source.indexOf('if(resourceMode && resourceReady && !permittedAction && stages[selectedPlot]!=3)presentationTask=8;');
 const end=source.indexOf('if(!presentationAlive)',start);
 assert.ok(start>=0&&end>start);
 const statements=source.slice(start,end);
 const evaluate=overrides=>{
  const context={resourceMode:true,resourceReady:true,permittedAction:true,stages:[1],selectedPlot:0,activity:-1,nearPlot:false,pendingReceipt:false,authorization:1,presentationTask:2,...overrides};
  runInNewContext(statements,context);return context.presentationTask;
 };
 for(const task of [1,2,3,7])assert.equal(evaluate({presentationTask:task}),12);
 assert.equal(evaluate({nearPlot:true}),2);
 assert.equal(evaluate({permittedAction:false}),8);
 assert.equal(evaluate({resourceReady:false}),9);
 assert.equal(evaluate({pendingReceipt:true}),10);
 assert.equal(evaluate({activity:1,authorization:-1}),11);
 assert.equal(evaluate({presentationTask:4,stages:[3]}),4);
 assert.equal(evaluate({activity:1}),2);
 assert.match(source,/if\(presentationTask==12\)sprintf\(line,"Move closer to this bed"\);/);
});
