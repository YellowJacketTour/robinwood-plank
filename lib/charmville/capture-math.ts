/** Emerald ordinary Poke Ball, no-status subset. No inventory or ownership mutation. */
export function ordinaryBallThreshold(catchRate:number,hp:number,maxHp:number){
 if(!Number.isInteger(catchRate)||catchRate<1||catchRate>255||!Number.isInteger(maxHp)||maxHp<1||maxHp>65535||!Number.isInteger(hp)||hp<1||hp>maxHp)throw Error('Invalid capture inputs');
 const odds=Math.floor(catchRate*(3*maxHp-2*hp)/(3*maxHp));
 if(odds>254)return {odds,threshold:65536};
 if(odds===0)return {odds,threshold:0};
 const root=Math.floor(Math.sqrt(Math.floor(Math.sqrt(Math.floor(16711680/odds)))));
 return {odds,threshold:Math.floor(1048560/root)};
}
/** Supply four server-generated uint16 draws; persist result before displaying it. */
export function captureShakes(threshold:number,draws:readonly number[]){
 if(!Number.isInteger(threshold)||threshold<0||threshold>65536||draws.length!==4||draws.some(n=>!Number.isInteger(n)||n<0||n>65535))throw Error('Invalid capture draws');
 for(let i=0;i<4;i++)if(draws[i]>=threshold)return {captured:false,shakes:i};
 return {captured:true,shakes:4};
}
