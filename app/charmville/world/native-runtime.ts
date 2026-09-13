/** One build-time selection for iframe navigation and every account bridge.
 * Only the two local development runtimes are accepted. This does not enable
 * production admission or make either runtime reachable by remote guests.
 */
const rebuilt = process.env.NEXT_PUBLIC_CHARMVILLE_RUNTIME === 'rebuilt';
export const NATIVE_RUNTIME_ORIGIN = rebuilt
  ? 'http://localhost:3024'
  : 'http://localhost:3021';
// The legacy tutorial redirect still selects the single-screen homestead.
// Keep joined-region selection explicit; account coordinate cutover is pending.
export const NATIVE_RUNTIME_URL = rebuilt
  ? `${NATIVE_RUNTIME_ORIGIN}/play/?test=%2Fquests%2Fcharmville%2Fhomestead-region%2Fr01%2FHomestead.qst&dmap=4&screen=63&storage=idb`
  : `${NATIVE_RUNTIME_ORIGIN}/charmville/tutorial/?runtime=movement-history-1`;
