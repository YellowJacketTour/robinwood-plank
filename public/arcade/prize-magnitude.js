// Display-only magnitude; never used for eligibility, odds, or payouts.
export function prizeMagnitude(value){
 const text=String(value??'');if(text.length>100||!/^\d+(?:\.\d{1,18})?$/.test(text))return null;
 const [whole,fraction='']=text.split('.');const wei=BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'));
 if(wei===0n)return null;
 const thresholds=[10n**16n,10n**17n,10n**18n,10n**19n,10n**21n];
 return thresholds.filter(t=>wei>=t).length;
}
export function prizePieces(tier){
 if(!Number.isInteger(tier)||tier<0||tier>5)return [];
 const kinds=tier===0?['coin','coin','coin']:tier===1?['note','note','coin','coin']:tier===2?['cash','cash','cash','coin','coin','coin']:tier===3?Array.from({length:14},(_,i)=>i%3?'cash':'coin'):Array.from({length:24},(_,i)=>i<3?'gem':tier===5&&i<8?'bar':i%3?'cash':'coin');
 return kinds.map((kind,i)=>{
  const a=i*2.3999632297,r=.16*Math.sqrt(i),scale=kind==='gem'&&tier===5&&i===0?1.8:1;
  return {kind,scale,x:Math.cos(a)*r,y:.28+Math.floor(i/5)*.17,z:Math.sin(a)*r*.65,angle:a};
 });
}
