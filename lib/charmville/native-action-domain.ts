/** Unwired authoritative movement/action domain. Geometry, policy and nowMs are
 * trusted server inputs. This module emits contacts, never rewards or damage. */
export type Cell={x:number;y:number};
export type Geometry={width:number;height:number;blocked:ReadonlySet<string>};
export type Action={id:string;kind:string;target:Cell;contactAt:number;contacted:boolean};
export type ActorState={cell:Cell;sequence:number;regionEpoch:number;lastMoveAt:number;lastCheckedAt:number;action:Action|null};
export type Policy={stepMs:number;windupMs:number;range:number;actions:readonly string[]};
const cell=(p:Cell)=>p&&Number.isSafeInteger(p.x)&&Number.isSafeInteger(p.y);
const time=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const distance=(a:Cell,b:Cell)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
function valid(g:Geometry,p:Cell){return cell(p)&&p.x>=0&&p.y>=0&&p.x<g.width&&p.y<g.height&&!g.blocked.has(`${p.x},${p.y}`);}
function context(state:ActorState,nowMs:number,policy:Policy){if(!time(nowMs)||nowMs<state.lastCheckedAt||!Number.isSafeInteger(policy.stepMs)||policy.stepMs<1||!Number.isSafeInteger(policy.windupMs)||policy.windupMs<1||!Number.isSafeInteger(policy.range)||policy.range<1)throw new Error("Invalid server clock or policy");}
export function spawnActor(g:Geometry,start:Cell,regionEpoch:number,nowMs:number):ActorState{
 if(!Number.isSafeInteger(g.width)||!Number.isSafeInteger(g.height)||g.width<1||g.height<1||!valid(g,start)||!time(regionEpoch)||!time(nowMs))throw new Error("Invalid spawn");
 return {cell:{...start},sequence:0,regionEpoch,lastMoveAt:nowMs,lastCheckedAt:nowMs,action:null};
}
export function stepActor(state:ActorState,raw:unknown,g:Geometry,nowMs:number,policy:Policy){
 context(state,nowMs,policy);const p=raw as Record<string,unknown>|null;
 if(!p||Object.keys(p).some(k=>!["x","y","sequence","regionEpoch"].includes(k))||p.regionEpoch!==state.regionEpoch||p.sequence!==state.sequence+1||!Number.isSafeInteger(p.sequence))throw new Error("Stale or invalid movement");
 const to={x:p.x as number,y:p.y as number};if(!valid(g,to))throw new Error("Blocked destination");const dx=to.x-state.cell.x,dy=to.y-state.cell.y;
 if(Math.abs(dx)>1||Math.abs(dy)>1||(!dx&&!dy))throw new Error("Move one neighboring cell");
 if(dx&&dy&&(!valid(g,{x:state.cell.x+dx,y:state.cell.y})||!valid(g,{x:state.cell.x,y:state.cell.y+dy})))throw new Error("Blocked corner");
 const required=policy.stepMs*(dx&&dy?Math.SQRT2:1);if(nowMs-state.lastMoveAt<required)throw new Error("Movement too fast");
 return {state:{...state,cell:to,sequence:p.sequence as number,lastMoveAt:nowMs,lastCheckedAt:nowMs,action:null},cancelledActionId:state.action&&!state.action.contacted?state.action.id:null};
}
export function beginAction(state:ActorState,raw:unknown,nowMs:number,policy:Policy):ActorState{
 context(state,nowMs,policy);const p=raw as Record<string,unknown>|null;
 if(!p||Object.keys(p).some(k=>!["id","kind","target","regionEpoch"].includes(k))||p.regionEpoch!==state.regionEpoch||typeof p.id!=="string"||!/^[a-zA-Z0-9_-]{1,128}$/.test(p.id)||typeof p.kind!=="string"||!policy.actions.includes(p.kind)||!cell(p.target as Cell))throw new Error("Invalid action intention");
 if(state.action)throw new Error("Finish or cancel the current action");
 const target=p.target as Cell;if(distance(state.cell,target)>policy.range)throw new Error("Target out of range");
 if(!Number.isSafeInteger(nowMs+policy.windupMs))throw new Error("Invalid contact time");
 return {...state,lastCheckedAt:nowMs,action:{id:p.id,kind:p.kind,target:{...target},contactAt:nowMs+policy.windupMs,contacted:false}};
}
export function cancelAction(state:ActorState,nowMs:number,policy:Policy):ActorState{context(state,nowMs,policy);return {...state,lastCheckedAt:nowMs,action:null};}
/** Caller must revalidate permissions/resource revision and atomically persist
 * returned state with settlement. A contact event alone is not an inventory credit. */
export function advanceAction(state:ActorState,nowMs:number,policy:Policy,targetStillValid:boolean){
 context(state,nowMs,policy);const next={...state,lastCheckedAt:nowMs};const action=state.action;
 if(!action||action.contacted)return {state:next,contact:null};
 if(!targetStillValid||distance(state.cell,action.target)>policy.range)return {state:{...next,action:null},contact:null};
 if(nowMs<action.contactAt)return {state:next,contact:null};
 return {state:{...next,action:{...action,contacted:true}},contact:{actionId:action.id,kind:action.kind,target:{...action.target}}};
}
