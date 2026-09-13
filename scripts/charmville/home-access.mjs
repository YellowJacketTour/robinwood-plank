/** Domain policy only. Grants, profile IDs and time MUST come from the server.
 * Recheck at action contact inside the same transaction as its economic effect.
 * This does not authenticate clients or persist invitations.
 */
export const HOME_RIGHTS = Object.freeze(['visit', 'help', 'harvest', 'build', 'storage']);
export function canAccessHome({ actorId, ownerId, right = 'visit', grants = [], now, containerId }) {
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (!id(actorId) || !id(ownerId) || !HOME_RIGHTS.includes(right) || !Number.isSafeInteger(now) || now < 0) return false;
  if (actorId === ownerId) return true;
  if (!Array.isArray(grants)) return false;
  const active = grants.filter(grant => grant && grant.ownerId === ownerId && grant.actorId === actorId
    && grant.revoked !== true && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > now
    && Array.isArray(grant.rights));
  if (!active.some(grant => grant.rights.includes('visit'))) return false;
  return active.some(grant => grant.rights.includes(right)
    && (right !== 'storage' || (id(containerId) && Array.isArray(grant.containers) && grant.containers.includes(containerId))));
}
