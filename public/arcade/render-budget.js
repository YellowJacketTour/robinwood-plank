// Resolution changes never alter simulation clocks, geometry or effect counts.
export function renderRatio(width, height, deviceRatio = 1, cap = 1.5) {
  return Math.min(Math.max(.5, deviceRatio), cap, Math.sqrt(1500000 / Math.max(1, width * height)));
}

export function createResolutionGovernor(initial = 1.5) {
  let cap = initial, elapsed = 0, frames = 0, healthy = 0;
  return {
    get cap() { return cap; },
    sample(delta) {
      // Visibility resumes and debugger/network pauses are not GPU samples.
      if (!(delta > 0 && delta < .25)) { elapsed = frames = healthy = 0; return null; }
      elapsed += delta; frames++;
      if (elapsed < 3) return null;
      const fps = frames / elapsed;
      healthy = fps > 58 ? healthy + elapsed : 0;
      elapsed = frames = 0;
      const next = fps < 48 ? Math.max(.75, cap - .15) : healthy >= 12 ? Math.min(initial, cap + .1) : cap;
      if (next === cap) return null;
      healthy = 0; cap = Number(next.toFixed(2)); return cap;
    }
  };
}
