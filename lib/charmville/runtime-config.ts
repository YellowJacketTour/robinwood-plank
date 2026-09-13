import { charmvilleAdmissionMode } from "./admission";

type Environment = Record<string, string | undefined>;

/** Server-only selection of an operator-approved release. This does not grant access
 * or certify assets: the protected adapter must still check admission and inventory.
 * No URL, filesystem root, credential or client-selected release crosses this boundary.
 */
export function charmvilleRuntimePrefix(env: Environment = process.env): string | null {
  if (env.CHARMVILLE_RUNTIME_READY !== "1" || charmvilleAdmissionMode(env) === "disabled") return null;
  const release = env.CHARMVILLE_RUNTIME_RELEASE;
  if (!release || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(release)) return null;
  return `/charmville/runtime/${release}/`;
}
