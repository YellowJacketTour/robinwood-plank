// Presentation only. Never extend or shorten the contract's betting deadline.
export const CRASH_FINALE_MS=2600;
export const REDUCED_CRASH_FINALE_MS=150;
export function lotteryDelay(deadline,now,reduced=false){
  return Number.isFinite(deadline)?Math.max(0,Math.min(CRASH_FINALE_MS,deadline-now)):(reduced?REDUCED_CRASH_FINALE_MS:CRASH_FINALE_MS);
}
