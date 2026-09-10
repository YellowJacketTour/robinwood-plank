// Convert the visible two-decimal target to the exact contract integer.
// Invalid text never falls back to a different (possibly riskier) target.
export function parseTargetBps(text,max=100000000n){
  if(!/^\d+(?:\.\d{1,2})?$/.test(String(text)))return null;
  const [whole,fraction='']=String(text).split('.');
  const value=BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0'));
  return value>=10100n&&value<=BigInt(max)?value:null;
}
