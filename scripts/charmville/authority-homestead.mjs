/**
 * Preparatory, engine-neutral simulation. NOT wired to the game, authentication,
 * storage, inventories or markets. Caller must supply authenticated actor IDs,
 * authoritative positions and monotonic server ticks, and serialize transactions.
 * Keep the request ledger durably with rewards before exposing this over a network.
 * Advance at each authoritative movement/scene event and simulation tick: this
 * module cannot infer a departure and return hidden between two position snapshots.
 * The in-memory ledger is intentionally unbounded here; production must archive
 * deduplication records safely rather than expire IDs that could mint rewards again.
 * Coordinates use world units; timing uses simulation ticks, never client clocks.
 * Sprite adapters consume phase/action/direction; art cannot grant a reward.
 */
export const TIMING = Object.freeze({ contact: 28, end: 48, growth: 300, range: 32 });
const kinds = ['till', 'plant', 'water', 'harvest'];
const own = (object, key) => Object.hasOwn(object, key);
const keyOf = (actor, id) => JSON.stringify([actor, id]);
const validID = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const copy = value => structuredClone(value);

export function createHomestead(plots) {
  const byId = Object.create(null);
  for (const plot of plots) {
    if (!validID(plot.id) || own(byId, plot.id) || !validID(plot.scene) ||
        !Number.isFinite(plot.x) || !Number.isFinite(plot.y)) throw new Error('Invalid plot');
    byId[plot.id] = { ...plot, stage: 'untilled', readyAt: null };
  }
  return { tick: 0, plots: byId, requests: {}, rewards: {} };
}

function targetError(state, actor, request) {
  const plot = state.plots[request.target];
  if (!own(state.plots, request.target)) return 'unknown-target';
  if (!actor || actor.scene !== plot.scene) return 'wrong-scene';
  if (!Number.isFinite(actor.x) || !Number.isFinite(actor.y) ||
      Math.hypot(actor.x - plot.x, actor.y - plot.y) > TIMING.range) return 'out-of-range';
  const expected = { till: 'untilled', plant: 'tilled', water: 'planted', harvest: 'growing' };
  if (plot.stage !== expected[request.kind]) return 'wrong-stage';
  if (request.kind === 'harvest' && state.tick < plot.readyAt) return 'not-grown';
  return null;
}

export function submitAction(input, actorId, request, actors) {
  if (!validID(actorId) || !request || !validID(request.id) || !validID(request.target) ||
      !kinds.includes(request.kind) || ![0, 1, 2, 3].includes(request.direction) ||
      Object.keys(request).some(key => !['id', 'target', 'kind', 'direction'].includes(key))) {
    return { state: input, error: 'invalid-request' };
  }
  const key = keyOf(actorId, request.id);
  const fingerprint = JSON.stringify([request.target, request.kind, request.direction]);
  if (own(input.requests, key)) {
    const previous = input.requests[key];
    return previous.fingerprint === fingerprint
      ? { state: input, action: copy(previous), replay: true, error: previous.error }
      : { state: input, error: 'request-id-conflict' };
  }
  const state = copy(input);
  let error = targetError(state, actors[actorId], request);
  const pending = Object.values(state.requests).filter(a => a.status === 'active');
  if (!error && pending.some(a => a.actorId === actorId)) error = 'actor-busy';
  if (!error && pending.some(a => a.target === request.target)) error = 'target-busy';
  const action = { ...request, actorId, fingerprint, start: state.tick,
    contactAt: state.tick + TIMING.contact, endAt: state.tick + TIMING.end,
    status: error ? 'rejected' : 'active', phase: error ? 'rejected' : 'windup',
    applied: false, error };
  state.requests[key] = action;
  return { state, action: copy(action), error };
}

export function cancelAction(input, actorId, requestId) {
  const key = keyOf(actorId, requestId);
  if (!own(input.requests, key)) return { state: input, error: 'unknown-request' };
  const state = copy(input);
  const action = state.requests[key];
  if (action.status === 'active') {
    action.status = 'cancelled';
    action.phase = 'cancelled';
    // Contact is committed: cancellation during recovery does not undo rewards.
  }
  return { state, action: copy(action) };
}

export function advanceHomestead(input, tick, actors) {
  if (!Number.isSafeInteger(tick) || tick < input.tick) throw new Error('Non-monotonic server tick');
  const state = copy(input);
  state.tick = tick;
  for (const action of Object.values(state.requests)) {
    if (action.status !== 'active') continue;
    // Revalidate every advance; authoritative movement/disconnect interrupts windup.
    if (!action.applied) {
      const error = targetError(state, actors[action.actorId], action);
      if (error) {
        action.status = 'cancelled'; action.phase = 'cancelled'; action.error = error;
        continue;
      }
      if (tick >= action.contactAt) {
        const plot = state.plots[action.target];
        if (action.kind === 'till') plot.stage = 'tilled';
        if (action.kind === 'plant') plot.stage = 'planted';
        if (action.kind === 'water') { plot.stage = 'growing'; plot.readyAt = action.contactAt + TIMING.growth; }
        if (action.kind === 'harvest') {
          plot.stage = 'tilled'; plot.readyAt = null;
          const rewardKey = keyOf(action.actorId, 'harvest-total');
          const reward = state.rewards[rewardKey] ?? { crops: 0, xp: 0 };
          state.rewards[rewardKey] = { crops: reward.crops + 1, xp: reward.xp + 10 };
        }
        action.applied = true;
      }
    }
    action.phase = tick < action.contactAt ? 'windup' : tick === action.contactAt ? 'contact' : 'recovery';
    if (tick >= action.endAt) { action.status = 'complete'; action.phase = 'complete'; }
  }
  return state;
}
