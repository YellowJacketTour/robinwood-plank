/** Trusted account traversal subset, not the renderer's full source atlas.
 * Expansion requires revisioned collision geometry, explicit reciprocal edges,
 * arrival/return and resource/peer coordinate checks before adding a room.
 */
export const nativeRooms = Object.freeze([
 Object.freeze({dmap:4,screen:62,geometryId:'native-adventure-d4-s62'}),
 Object.freeze({dmap:4,screen:63,geometryId:'native-adventure-d4-s63'}),
]);
export function admittedNativeRoom(dmap:number,screen:number){
 return nativeRooms.find(room=>room.dmap===dmap&&room.screen===screen);
}
/** Numeric adjacency does not grant traversal permission. */
export function connectedNativeRooms(from:{dmap:number;screen:number},to:{dmap:number;screen:number}):boolean {
 return Boolean(admittedNativeRoom(from.dmap,from.screen)&&admittedNativeRoom(to.dmap,to.screen)&&
  ((from.screen===62&&to.screen===63)||(from.screen===63&&to.screen===62)));
}
