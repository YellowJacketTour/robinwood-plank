/** Pure server policy, not wired to live AI. Context and entity state must come
 * from authoritative simulation, never a browser body. No damage or rewards. */
export type Point={x:number;y:number};
export type Creature={id:string;ownerId:string;regionId:string;position:Point;capabilities:readonly ("follow"|"attack"|"livestock")[];stance:"follow"|"passive"|"defend"|"free-range";targetId?:string};
export type Party={ownerId:string;revision:number;slots:readonly (Creature|null)[]};
export type CreatureCommand={kind:"follow"|"passive"|"defend"|"attack"|"free-range";entityIds:string[];targetId?:string};
export type CreatureContext={actorId:string;regionId:string;position:Point;leash:number;targets:readonly {id:string;regionId:string;position:Point;hostile:boolean;alive:boolean;threatens:readonly string[]}[];habitat?:{regionId:string;min:Point;max:Point;canManage:boolean}};
const id=(v:unknown):v is string=>typeof v==="string"&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const point=(p:Point)=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
function validateParty(p:Party){if(!id(p.ownerId)||!Number.isSafeInteger(p.revision)||p.revision<0||p.revision>=Number.MAX_SAFE_INTEGER||p.slots.length!==6)throw new Error("Invalid party");const seen=new Set<string>();for(const e of p.slots){if(!e)continue;if(!id(e.id)||e.ownerId!==p.ownerId||seen.has(e.id)||!point(e.position)||!id(e.regionId))throw new Error("Invalid party member");seen.add(e.id);}}
export function assignParty(ownerId:string,entities:readonly (Creature|null)[],revision=0):Party{const p={ownerId,slots:[...entities],revision};validateParty(p);return structuredClone(p);}
export function parseCreatureCommand(raw:unknown):CreatureCommand{
 const p=raw as Record<string,unknown>|null;const kinds=["follow","passive","defend","attack","free-range"];
 if(!p||!kinds.includes(String(p.kind))||Object.keys(p).some(k=>!["kind","entityIds","targetId"].includes(k))||!Array.isArray(p.entityIds)||p.entityIds.length<1||p.entityIds.length>6||!p.entityIds.every(id)||new Set(p.entityIds).size!==p.entityIds.length)throw new Error("Invalid creature command");
 if((p.kind==="attack"&&!id(p.targetId))||(p.kind!=="attack"&&p.targetId!==undefined))throw new Error("Invalid target");
 return {kind:p.kind as CreatureCommand["kind"],entityIds:p.entityIds,...(p.kind==="attack"?{targetId:p.targetId as string}:{})};
}
export function applyCreatureCommand(party:Party,revision:number,raw:unknown,context:CreatureContext):Party{
 validateParty(party);const command=parseCreatureCommand(raw);
 if(context.actorId!==party.ownerId||revision!==party.revision)throw new Error("Party ownership or revision changed");
 if(!id(context.regionId)||!point(context.position)||!Number.isFinite(context.leash)||context.leash<=0)throw new Error("Invalid server context");
 const selected=command.entityIds.map(entityId=>{const e=party.slots.find(e=>e?.id===entityId);if(!e||e.regionId!==context.regionId||distance(e.position,context.position)>context.leash)throw new Error("Creature unavailable");return e;});
 const result=structuredClone(party);for(const e of selected){const next=result.slots.find(c=>c?.id===e.id)!;
  if(command.kind==="attack"){
   const target=context.targets.find(t=>t.id===command.targetId);
   if(!e.capabilities.includes("attack")||!target||target.id===context.actorId||party.slots.some(member=>member?.id===target.id)||!target.hostile||!target.alive||target.regionId!==context.regionId||!point(target.position)||distance(target.position,context.position)>context.leash||distance(target.position,e.position)>context.leash)throw new Error("Invalid hostile target");
   next.targetId=target.id;
  }else{
   if(command.kind==="follow"&&!e.capabilities.includes("follow"))throw new Error("Cannot follow");
   if(command.kind==="defend"&&!e.capabilities.includes("attack"))throw new Error("Cannot defend");
   if(command.kind==="free-range"){
    const h=context.habitat;if(!e.capabilities.includes("livestock")||!h?.canManage||h.regionId!==context.regionId||!h.regionId.startsWith("home:")||!point(h.min)||!point(h.max)||h.min.x>h.max.x||h.min.y>h.max.y||e.position.x<h.min.x||e.position.x>h.max.x||e.position.y<h.min.y||e.position.y>h.max.y)throw new Error("Habitat unavailable");
   }
   next.stance=command.kind;delete next.targetId;
  }
 }
 return {...result,revision:party.revision+1};
}
/** Chooses intent only. Combat engine must validate contact, cooldown and damage. */
export function defendTarget(creature:Creature,context:CreatureContext):string|null{
 if(creature.stance!=="defend"||creature.ownerId!==context.actorId||creature.regionId!==context.regionId||!creature.capabilities.includes("attack")||!point(creature.position)||!point(context.position)||!Number.isFinite(context.leash)||context.leash<=0||distance(creature.position,context.position)>context.leash)return null;
 return context.targets.filter(t=>t.hostile&&t.alive&&t.regionId===context.regionId&&point(t.position)&&(t.threatens.includes(context.actorId)||t.threatens.includes(creature.id))&&distance(t.position,context.position)<=context.leash&&distance(t.position,creature.position)<=context.leash).sort((a,b)=>distance(a.position,creature.position)-distance(b.position,creature.position)||a.id.localeCompare(b.id))[0]?.id??null;
}
/** Bounds a proposed AI waypoint; never authorizes terrain collision or rewards. */
export function habitatWaypoint(creature:Creature,context:CreatureContext,proposed:Point):Point{
 const h=context.habitat;if(creature.stance!=="free-range"||creature.ownerId!==context.actorId||!creature.capabilities.includes("livestock")||!h?.canManage||h.regionId!==creature.regionId||h.regionId!==context.regionId||!h.regionId.startsWith("home:")||!point(proposed)||!point(h.min)||!point(h.max)||h.min.x>h.max.x||h.min.y>h.max.y)throw new Error("Habitat unavailable");
 return {x:Math.max(h.min.x,Math.min(h.max.x,proposed.x)),y:Math.max(h.min.y,Math.min(h.max.y,proposed.y))};
}
