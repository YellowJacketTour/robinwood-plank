// A bounded physical display, never an input to the contract draw.
// One shared, device-independent display budget. Exact odds remain on-chain;
// oversized draws sample the full range and disclose the visible population.
export const MAX_PHYSICAL_BALLS=96;
export function lotteryPopulation(count,selected){
  count=BigInt(count);selected=BigInt(selected);
  if(count<0n||selected<0n||(count===0n&&selected!==0n)||(count>0n&&(selected<1n||selected>count)))throw new RangeError('Invalid numbered draw');
  const visible=Number(count>BigInt(MAX_PHYSICAL_BALLS)?BigInt(MAX_PHYSICAL_BALLS):count);
  const radius=visible<=64?.16:.16*Math.cbrt(64/visible)*.92;
  const labels=[];
  // For oversized draws sample the full range, not just the smallest labels.
  for(let i=0;labels.length<Math.max(0,visible-1);i++){
    const label=count<=BigInt(MAX_PHYSICAL_BALLS)?BigInt(i+1):1n+BigInt(i)*(count-1n)/BigInt(visible-1);
    if(label!==selected&&!labels.includes(label))labels.push(label);
  }
  const homes=[],spacing=radius*2+.014,limit=1.12-radius-.045;
  for(let y=.35;y<1.9-radius;y+=spacing)for(let x=-limit;x<=limit;x+=spacing)for(let z=-limit;z<=limit;z+=spacing){
    if(Math.hypot(x,y-.89,z)<limit&&Math.hypot(x,y-.22,z)>radius+.18)homes.push([x,y,z]);
  }
  if(homes.length<labels.length)throw new RangeError('Chamber capacity exceeded');
  return{count,visible,radius,labels,homes:homes.slice(0,labels.length),sampled:count>BigInt(MAX_PHYSICAL_BALLS)};
}
