import { NATIVE_RUNTIME_ORIGIN, NATIVE_RUNTIME_URL } from "./native-runtime";

/** UI routing only. Production release input comes from the server readiness gate. */
export function runtimeDestination(localRuntime: boolean, runtimePrefix: string | null | undefined, pageOrigin: string) {
  let origin: URL;
  try { origin = new URL(pageOrigin); } catch { return null; }
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== pageOrigin) return null;
  if (runtimePrefix) {
    if (!/^\/charmville\/runtime\/[A-Za-z0-9][A-Za-z0-9_-]{0,95}\/$/.test(runtimePrefix)) return null;
    return { origin: pageOrigin, url: `${runtimePrefix}play/?test=%2Fquests%2Fcharmville%2Fhomestead-region%2Fr01%2FHomestead.qst&dmap=4&screen=63&storage=idb`, requiresSession: true };
  }
  if (!localRuntime || !["localhost", "127.0.0.1"].includes(origin.hostname)) return null;
  return { origin: NATIVE_RUNTIME_ORIGIN, url: NATIVE_RUNTIME_URL, requiresSession: false };
}
