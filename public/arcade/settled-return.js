// Financial ratios stay in integer arithmetic; gas is not included in net.
export function settledReturn(stake,paid) {
  stake=BigInt(stake);paid=BigInt(paid);
  if(stake<=0n||paid<0n)throw new RangeError('Invalid settled amounts');
  const net=paid-stake;
  const fixed=(numerator,denominator)=>{
    const units=numerator*100n/denominator;
    return `${units/100n}.${(units%100n).toString().padStart(2,'0')}`;
  };
  return {net,returnedX:fixed(paid,stake),roiPercent:`${net<0n?'-':net>0n?'+':''}${fixed((net<0n?-net:net)*100n,stake)}%`};
}
