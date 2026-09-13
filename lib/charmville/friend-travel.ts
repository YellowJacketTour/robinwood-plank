export type TravelPresence = { active: boolean; ownerHandle: string | null; peers: {profileId:string;handle:string}[] };
export function visitHandle(value: string): string | null {
  const handle=value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{1,40}$/.test(handle) ? handle : null;
}
export function travelLabel(presence: TravelPresence | null, ownHandle: string) {
  if (!presence?.active) return 'Choose where to join';
  if (!presence.ownerHandle) return 'In the public meadow';
  return presence.ownerHandle === ownHandle ? 'At your homestead' : `Visiting @${presence.ownerHandle}’s homestead`;
}
export function nearbyVisitTargets(presence: TravelPresence | null, profileId: string) {
  if (!presence?.active) return [];
  const seen=new Set<string>();
  return presence.peers.filter(peer => peer.profileId !== profileId && visitHandle(peer.handle) === peer.handle && !seen.has(peer.handle) && !!seen.add(peer.handle));
}
