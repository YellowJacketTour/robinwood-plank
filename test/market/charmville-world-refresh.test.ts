import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {requestWorldEntry} from '../../lib/charmville/world-entry-client';

// Execute the production closures without mounting the native iframe or wallet.
// This covers the timer's actual arguments as well as the async admission path.
const source=ts.createSourceFile('world.tsx',readFileSync(new URL('../../app/charmville/world/world.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let loadSource='',timerSource='';
function visit(node:ts.Node){
 if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='load'&&node.initializer&&ts.isCallExpression(node.initializer))loadSource=node.initializer.arguments[0].getText(source);
 if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes('},30000)'))timerSource=node.arguments[0].getText(source);
 ts.forEachChild(node,visit);
}
visit(source);
assert.ok(loadSource&&timerSource,'production load and presence timer must be found');
const compile=(code:string)=>ts.transpileModule(`(${code})`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;

function harness(ownerHandle:string|null=null){
 const initial={profileId:'player',regionId:ownerHandle?'home:friend':'public:meadow',ownerHandle,revision:'1',active:true,peers:[],reason:null};
 const state={presence:initial,arrival:4,inventory:null as unknown,message:'Existing notice',busy:false};
 const location={current:initial};
 const inFlight:{current:AbortController|null}={current:null};
 const session:{current:unknown}={current:{token:'test-token',identity:{handle:'player'}}};
 const calls:Array<{path:string;body:Record<string,unknown>|undefined}>=[];
 const replies:Array<{status?:number;data:unknown}>=[];
 const document={hidden:false};
 let tick=()=>{},pending:Promise<void>=Promise.resolve();
 const context={AbortController,location,inFlight,session,document,generation:{current:0},requestWorldEntry,
  setPresence:(value:typeof initial)=>{state.presence=value;},setArrivalRequest:(update:(value:number)=>number)=>{state.arrival=update(state.arrival);},
  setInventory:(value:unknown)=>{state.inventory=value;},setBusy:(value:boolean)=>{state.busy=value;},setMessage:(value:string)=>{state.message=value;},
  clear:()=>{throw Error('Unexpected session expiry');},
  fetch:async(path:string,options:{body?:string})=>{
   calls.push({path,body:options.body?JSON.parse(options.body):undefined});
   const reply=replies.shift();assert.ok(reply,`Unexpected request: ${path}`);
   return {ok:(reply.status??200)<400,status:reply.status??200,json:async()=>reply.data};
  },
  setInterval:(callback:()=>void,delay:number)=>{assert.equal(delay,30000);tick=callback;return 1;},clearInterval:()=>{},
 };
 const load=runInNewContext(compile(loadSource),context) as (destination?:{destination:'home'|'public';handle?:string},background?:boolean)=>Promise<void>;
 const cleanup=runInNewContext(compile(timerSource),{...context,load:(...args:Parameters<typeof load>)=>{pending=load(...args);return pending;}})() as ()=>void;
 return {state,initial,calls,replies,document,inFlight,session,load,cleanup,
  tick:async()=>{tick();await pending;},
  renew:(revision:string)=>{replies.push({data:{...initial,revision}},{data:{inventory:{grain:Number(revision)}}});},
 };
}

for(const owner of [null,'friend'])test(`30-second ${owner?'home':'public'} renewals preserve native arrival and existing notice`,async()=>{
 const h=harness(owner);
 for(const revision of ['2','3','4']){h.renew(revision);await h.tick();}
 assert.equal(h.state.arrival,4,'renewal must not restart movement with a fresh arrival');
 assert.equal(h.state.presence.revision,'4');assert.deepEqual(h.state.inventory,{grain:4});
 assert.equal(h.state.message,'Existing notice');assert.equal(h.state.busy,false);
 assert.deepEqual(h.calls.filter(call=>call.body).map(call=>call.body),['1','2','3'].map(revision=>owner?{destination:'home',handle:owner,revision}:{destination:'public',revision}));
 h.cleanup();
});

test('explicit same-region travel still requests one native arrival even if inventory fails',async()=>{
 const h=harness();h.replies.push({data:{...h.initial,revision:'2'}},{status:500,data:{error:'Inventory unavailable'}});
 await h.load({destination:'public'});
 assert.equal(h.state.arrival,5);assert.equal(h.state.presence.revision,'2');
 assert.equal(h.state.message,'Inventory unavailable');assert.equal(h.state.busy,false);h.cleanup();
});

test('rejected background home renewal removes revoked occupancy without requesting arrival',async()=>{
 const h=harness('friend');h.replies.push({status:403,data:{error:'Invitation revoked'}},{data:{...h.initial,regionId:'public:meadow',active:false,reason:'permission-revoked'}});
 await h.tick();assert.equal(h.state.presence.active,false);assert.equal(h.state.arrival,4);
 assert.equal(h.calls[1].body,undefined);assert.equal(h.state.message,'Invitation revoked');h.cleanup();
});

test('background timer skips hidden pages, active requests, and disconnected sessions',async()=>{
 const h=harness();h.document.hidden=true;await h.tick();h.document.hidden=false;
 h.inFlight.current=new AbortController();await h.tick();h.inFlight.current=null;
 h.session.current=null;await h.tick();assert.equal(h.calls.length,0);h.cleanup();
});
