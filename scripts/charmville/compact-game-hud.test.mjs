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
 state='bad';poll();assert.equal(panel.hidden,true);assert.equal(writes.length,1);
 state='1|2|0|1|0|0|0|0|0|-1|0|0|80|0';poll();assert.equal(panel.hidden,true);assert.equal(writes.length,1);
 dispose();assert.equal(cleared,true);
});
