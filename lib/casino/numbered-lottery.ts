/** Candidate only. Not wired to an active lottery or any transaction path. */
export const LOTTERY_PROBABILITY_SCALE=10n**18n;
export function numberedLotteryBudget(threshold:bigint):{ballCount:bigint;winningNumber:bigint|null}{
  if(threshold<0n||threshold>LOTTERY_PROBABILITY_SCALE)throw new RangeError('Invalid probability threshold');
  if(threshold===0n)return {ballCount:0n,winningNumber:null};
  return {ballCount:(LOTTERY_PROBABILITY_SCALE+threshold-1n)/threshold,winningNumber:1n};
}
