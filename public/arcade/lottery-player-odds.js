export function playerLotteryOdds(stake,totalStake,ballCount){
  stake=BigInt(stake);totalStake=BigInt(totalStake);ballCount=BigInt(ballCount);
  if(stake<0n||totalStake<0n||stake>totalStake||ballCount<0n)throw new RangeError('Invalid lottery weights');
  if(stake===0n||ballCount===0n)return {numerator:0n,denominator:1n};
  let a=stake,b=totalStake*ballCount;
  while(b!==0n){const remainder=a%b;a=b;b=remainder;}
  return {numerator:stake/a,denominator:totalStake*ballCount/a};
}
