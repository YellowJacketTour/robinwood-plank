import growth from './species-growth.json';
/** Source experience_tables.h macros; integer division at each C division preserved. */
export function experienceAtLevel(speciesId:number,level:number){
 const rate=(growth.species as Record<string,{growth:string}>)[speciesId]?.growth;if(!rate||!Number.isInteger(level)||level<1||level>100)throw Error('Unsupported experience input');
 if(level===1)return 1;const n=level,c=n*n*n,f=Math.floor;
 switch(rate){case 'MEDIUM_FAST':return c;case 'FAST':return f(4*c/5);case 'SLOW':return f(5*c/4);case 'MEDIUM_SLOW':return f(6*c/5)-15*n*n+100*n-140;
 case 'ERRATIC':return n<=50?f((100-n)*c/50):n<=68?f((150-n)*c/100):n<=98?f(f((1911-10*n)/3)*c/500):f((160-n)*c/100);
 case 'FLUCTUATING':return n<=15?f((f((n+1)/3)+24)*c/50):n<=36?f((n+14)*c/50):f((f(n/2)+32)*c/50);default:throw Error('Unknown source growth');}
}
export function experienceLevel(speciesId:number,xp:number){if(!Number.isSafeInteger(xp)||xp<1)throw Error('Invalid experience');let level=1;while(level<100&&xp>=experienceAtLevel(speciesId,level+1))level++;return level;}
