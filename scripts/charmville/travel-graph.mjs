/** Logical travel contract; native maps must be bound before runtime use. */
import { canAccessHome } from './home-access.mjs';
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export const TRAVEL_GRAPH = freeze({
  regions: {
    home: { privacy: 'owner', playable: true, width: 256, height: 176 },
    meadow: { privacy: 'public', playable: true, width: 256, height: 176 },
    woodland: { privacy: 'public', playable: false, width: 256, height: 176 },
    island: { privacy: 'public', playable: false, width: 256, height: 176 },
    orbit: { privacy: 'public', playable: false, width: 256, height: 176 },
  },
  portals: {
    'home-gate': { from: 'home', to: 'meadow', trigger: { x: 128, y: 152, radius: 12 }, spawn: { x: 128, y: 24, facing: 'down' }, requires: [] },
    'return-home': { from: 'meadow', to: 'home', trigger: { x: 128, y: 16, radius: 12 }, spawn: { x: 128, y: 136, facing: 'up' }, requires: [] },
    'woodland-trail': { from: 'meadow', to: 'woodland', trigger: { x: 232, y: 88, radius: 12 }, spawn: { x: 24, y: 88, facing: 'right' }, requires: ['mount'] },
    'island-dock': { from: 'meadow', to: 'island', trigger: { x: 24, y: 136, radius: 12 }, spawn: { x: 128, y: 136, facing: 'up' }, requires: ['boat'] },
    'orbital-launch': { from: 'meadow', to: 'orbit', trigger: { x: 200, y: 32, radius: 12 }, spawn: { x: 128, y: 88, facing: 'down' }, requires: ['spacecraft'] },
  },
});

const directions = new Set(['up', 'down', 'left', 'right']);
const capabilities = new Set(['boat', 'mount', 'spacecraft']);
const validPoint = (point, region) => point && Number.isFinite(point.x) && Number.isFinite(point.y)
  && point.x >= 0 && point.x < region.width && point.y >= 0 && point.y < region.height;

export function validateTravelGraph(graph) {
  if (!graph?.regions || !graph?.portals) throw new Error('Missing travel graph');
  for (const [id, region] of Object.entries(graph.regions)) {
    if (!['owner', 'public'].includes(region.privacy) || typeof region.playable !== 'boolean'
      || !Number.isInteger(region.width) || region.width < 1 || !Number.isInteger(region.height) || region.height < 1) throw new Error(`Invalid region: ${id}`);
  }
  for (const [id, portal] of Object.entries(graph.portals)) {
    const from = graph.regions[portal.from];
    const to = graph.regions[portal.to];
    if (!from || !to || !validPoint(portal.trigger, from) || !Number.isFinite(portal.trigger.radius)
      || portal.trigger.radius <= 0 || !validPoint(portal.spawn, to) || !directions.has(portal.spawn.facing)
      || !Array.isArray(portal.requires) || portal.requires.some(value => !capabilities.has(value))) throw new Error(`Invalid portal: ${id}`);
  }
  return true;
}

const actorKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const instanceFor = (regionId, region, actorId) => region.privacy === 'owner' ? `${regionId}:${actorId}` : `${regionId}:public`;

/** Supply authenticated actor and authoritative state, never client inventory/position claims.
 * This returns a proposal, not a mutation. The host must atomically apply it and
 * cancel/release any in-progress action before accepting input in the next map.
 */
export function resolveTravel({ actorId, current, portalId, ownedCapabilities = [], activeAction = null,
  destinationOwnerId = actorId, grants = [], now }, graph = TRAVEL_GRAPH) {
  validateTravelGraph(graph);
  const denied = reason => ({ ok: false, reason });
  if (!actorKey(actorId)) return denied('invalid-actor');
  const portal = Object.hasOwn(graph.portals, portalId) ? graph.portals[portalId] : null;
  if (!portal) return denied('unknown-portal');
  if (!current || current.region !== portal.from) return denied('wrong-region');
  const source = graph.regions[portal.from];
  const sourceOwner = source.privacy === 'owner' && typeof current.instance === 'string'
    && current.instance.startsWith(`${portal.from}:`) ? current.instance.slice(portal.from.length + 1) : actorId;
  if (current.instance !== instanceFor(portal.from, source, sourceOwner)
    || (source.privacy === 'owner' && !canAccessHome({ actorId, ownerId: sourceOwner, grants, now: sourceOwner === actorId ? 0 : now }))) return denied('instance-access-denied');
  if (!source.playable) return denied('source-unavailable');
  if (!validPoint(current, source)) return denied('invalid-position');
  if (Math.hypot(current.x - portal.trigger.x, current.y - portal.trigger.y) > portal.trigger.radius) return denied('outside-portal');
  if (!Array.isArray(ownedCapabilities)) return denied('invalid-capabilities');
  const missing = portal.requires.filter(value => !ownedCapabilities.includes(value));
  if (missing.length) return { ok: false, reason: 'requirements-missing', missing };
  const destination = graph.regions[portal.to];
  if (!destination.playable) return denied('destination-unavailable');
  if (destination.privacy === 'owner' && !canAccessHome({ actorId, ownerId: destinationOwnerId, grants, now: destinationOwnerId === actorId ? 0 : now })) return denied('destination-access-denied');
  return {
    ok: true,
    destination: { region: portal.to, instance: instanceFor(portal.to, destination, destinationOwnerId), ...portal.spawn },
    cancelActiveAction: activeAction !== null,
    resetPresentation: ['tool', 'projectile-preview', 'pose-override'],
  };
}

validateTravelGraph(TRAVEL_GRAPH);
