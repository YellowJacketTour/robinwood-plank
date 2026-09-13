export type StandardCaptureBall = 'poke'|'great'|'ultra'|'safari'|'premier'|'luxury';
export type CaptureStatus = 'none'|'sleep'|'freeze'|'poison'|'toxic-poison'|'burn'|'paralysis';
const ballTenths:Record<StandardCaptureBall,number>={poke:10,great:15,ultra:20,safari:15,premier:10,luxury:10};
const statuses:readonly CaptureStatus[]=['none','sleep','freeze','poison','toxic-poison','burn','paralysis'];

/** Emerald Cmd_handleballthrow and sBallCatchBonuses, source:
 * https://github.com/pret/pokeemerald/blob/master/src/battle_script_commands.c
 * Preserve truncation at ball bonus, HP factor and status stages separately.
 * This pure math does not authorize an item, apply a status or grant custody.
 * Callers must obtain ball/status from trusted inventory and encounter state.
 * Contextual balls and Master Ball are deliberately excluded.
 */
export function standardBallThreshold(catchRate:number,hp:number,maxHp:number,ball:StandardCaptureBall,status:CaptureStatus='none'){
 if(!Number.isInteger(catchRate)||catchRate<1||catchRate>255||!Number.isInteger(maxHp)||maxHp<1||maxHp>65535||!Number.isInteger(hp)||hp<1||hp>maxHp)throw Error('Invalid capture inputs');
 if(!Object.hasOwn(ballTenths,ball)||!statuses.includes(status))throw Error('Unsupported capture modifier');
 let odds=Math.floor(Math.floor(catchRate*ballTenths[ball]/10)*(3*maxHp-2*hp)/(3*maxHp));
 if(status==='sleep'||status==='freeze')odds*=2;
 else if(status!=='none')odds=Math.floor(odds*15/10);
 if(odds>254)return {odds,threshold:65536};
 if(odds===0)return {odds,threshold:0};
 const root=Math.floor(Math.sqrt(Math.floor(Math.sqrt(Math.floor(16711680/odds)))));
 return {odds,threshold:Math.floor(1048560/root)};
}
/** Live ordinary-ball subset; unsupported battle statuses remain gated by the caller. */
export function ordinaryBallThreshold(catchRate:number,hp:number,maxHp:number){
 return standardBallThreshold(catchRate,hp,maxHp,'poke','none');
}
/** Supply four server-generated uint16 draws; persist result before displaying it. */
export function captureShakes(threshold:number,draws:readonly number[]){
 if(!Number.isInteger(threshold)||threshold<0||threshold>65536||draws.length!==4||draws.some(n=>!Number.isInteger(n)||n<0||n>65535))throw Error('Invalid capture draws');
 for(let i=0;i<4;i++)if(draws[i]>=threshold)return {captured:false,shakes:i};
 return {captured:true,shakes:4};
}
