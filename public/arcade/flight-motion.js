// Exact critically damped response; rendering cadence never changes game time.
export function advanceFlightMotion(position, velocity, target, elapsedSeconds, omega=6) {
  if (![position,velocity,target,elapsedSeconds,omega].every(Number.isFinite) || elapsedSeconds<0 || omega<=0) throw new RangeError('Invalid flight motion sample');
  const offset=position-target, impulse=velocity+omega*offset, decay=Math.exp(-omega*elapsedSeconds);
  return {position:target+(offset+impulse*elapsedSeconds)*decay,velocity:(velocity-omega*impulse*elapsedSeconds)*decay};
}
