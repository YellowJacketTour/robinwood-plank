export type GameIdentity = { profileId: string; handle: string; expiresAt: string };

/** Instantiate inside the authenticated same-origin shell, never inside quest scripts. */
export function createGameAccountClient(fetcher: typeof fetch = fetch) {
  let token = "";
  let generation = 0;
  const pending = new Set<AbortController>();
  function disconnect() {
    token = ""; ++generation;
    for (const controller of pending) controller.abort();
    pending.clear();
  }
  return {
    disconnect,
    async connect(sessionToken: string): Promise<GameIdentity> {
      disconnect();
      if (!/^[a-f0-9]{64}$/i.test(sessionToken)) throw new Error("Invalid account session.");
      token = sessionToken;
      const version = generation;
      const controller = new AbortController(); pending.add(controller);
      try {
        const response = await fetcher("/api/charmville/session", {
          headers: { authorization: `Bearer ${token}` }, cache: "no-store",
          credentials: "same-origin", mode: "same-origin", redirect: "error", signal: controller.signal,
        });
        if (!response.ok) throw new Error("Sign in to your approved PlankSpace account.");
        const identity = await response.json() as GameIdentity;
        if (version !== generation) throw new Error("Account changed. Reconnect.");
        if (!/^[1-9]\d*$/.test(identity.profileId) || typeof identity.handle !== "string" ||
            !identity.handle || !Number.isFinite(Date.parse(identity.expiresAt)))
          throw new Error("Invalid account response.");
        return identity;
      } catch (error) {
        if (version === generation) disconnect();
        throw error;
      } finally { pending.delete(controller); }
    },
  };
}
