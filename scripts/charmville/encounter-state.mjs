/** Proposed server-only encounter domain. Not a native Pokémon implementation.
 * Caller authenticates actors, validates range/cooldowns/damage, supplies RNG and
 * capture probability, and commits state plus request ledger atomically with CAS.
 * Never accept damage, RNG, probability, or inventories from a browser request.
 */
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const statuses = ['poison', 'burn', 'sleep', 'paralysis', 'freeze'];
export function createEncounter(entity, inventories) {
  if (!id(entity.id) || !id(entity.species) || !Number.isSafeInteger(entity.maxHp) || entity.maxHp < 1 ||
      !Number.isSafeInteger(entity.hp) || entity.hp < 0 || entity.hp > entity.maxHp ||
      !Array.isArray(entity.statuses) || entity.statuses.some(s => !statuses.includes(s))) throw new Error('Invalid entity');
  for (const [actor, count] of Object.entries(inventories)) {
    if (!id(actor) || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid inventory');
  }
  return { entity: { id: entity.id, species: entity.species, maxHp: entity.maxHp, hp: entity.hp,
    statuses: [...new Set(entity.statuses)], mode: 'world', controller: null, owner: null },
  balls: { ...inventories }, specimens: {}, requests: {}, revision: 0 };
}

export function encounterAction(input, actor, request, server = {}) {
  const allowed = ['claim', 'enter-turn', 'return-world', 'release', 'damage', 'status', 'capture'];
  if (!id(actor) || !request || !id(request.id) || !allowed.includes(request.kind) ||
      Object.keys(request).some(k => !['id', 'kind'].includes(k))) return { state: input, error: 'invalid-request' };
  const key = JSON.stringify([actor, request.id]);
  if (Object.hasOwn(input.requests, key)) {
    const prior = input.requests[key];
    return prior.kind === request.kind ? { state: input, ...structuredClone(prior), replay: true }
      : { state: input, error: 'request-id-conflict' };
  }
  const state = structuredClone(input), e = state.entity;
  let error = null, captured = false;
  if (e.owner) error = 'already-captured';
  else if (request.kind === 'claim') {
    if (e.hp === 0) error = 'defeated';
    else if (e.controller && e.controller !== actor) error = 'claimed';
    else e.controller = actor;
  } else if (e.controller !== actor) error = 'not-controller';
  else if (request.kind === 'release') { e.controller = null; e.mode = 'world'; }
  else if (request.kind === 'return-world') e.mode = 'world';
  else if (e.hp === 0) error = 'defeated';
  else if (request.kind === 'enter-turn') e.mode = 'turn';
  else if (request.kind === 'damage') {
    if (!Number.isSafeInteger(server.damage) || server.damage < 0) error = 'invalid-damage';
    else e.hp = Math.max(0, e.hp - server.damage);
  } else if (request.kind === 'status') {
    if (!statuses.includes(server.status) || typeof server.active !== 'boolean') error = 'invalid-status';
    else e.statuses = server.active ? [...new Set([...e.statuses, server.status])] : e.statuses.filter(s => s !== server.status);
  } else if (request.kind === 'capture') {
    if (!Number.isFinite(server.roll) || server.roll < 0 || server.roll >= 1 ||
        !Number.isFinite(server.probability) || server.probability < 0 || server.probability > 1) error = 'invalid-capture-decision';
    else if (!Object.hasOwn(state.balls, actor) || state.balls[actor] < 1) error = 'no-ball';
    else {
      state.balls[actor] -= 1;
      captured = server.roll < server.probability;
      if (captured) {
        e.owner = actor; e.mode = 'captured'; e.controller = null;
        state.specimens = { ...state.specimens, [e.id]: structuredClone(e) };
      }
    }
  }
  const result = { kind: request.kind, error, captured };
  state.requests[key] = result;
  state.revision += 1;
  return { state, ...result };
}
