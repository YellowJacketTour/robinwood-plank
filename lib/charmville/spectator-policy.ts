import { YardError } from "./errors";

export type SpectatorMode = "public" | "private" | "allowlist";
export type SpectatorPolicy = { mode: SpectatorMode; allowedHandles: string[] };

/** Parse a complete policy update; resolve these handles to profile IDs on the server. */
export function parseSpectatorPolicy(raw: unknown): SpectatorPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new YardError("Invalid spectator policy", 400);
  }
  const input = raw as Record<string, unknown>;
  if (input.mode !== "public" && input.mode !== "private" && input.mode !== "allowlist") {
    throw new YardError("Choose public, private, or allowlist spectator access", 400);
  }
  const handles = input.allowedHandles === undefined ? [] : input.allowedHandles;
  if (!Array.isArray(handles) || handles.length > 100) {
    throw new YardError("Choose at most 100 spectator handles", 400);
  }
  const allowedHandles = new Set<string>();
  for (const handle of handles) {
    if (typeof handle !== "string" || !/^[a-z0-9_]{1,40}$/.test(handle)) {
      throw new YardError("Invalid spectator handle", 400);
    }
    allowedHandles.add(handle);
  }
  return { mode: input.mode, allowedHandles: [...allowedHandles] };
}

/** IDs must come from server-authenticated profiles, never client viewer claims. */
export function canSpectate({ ownerId, viewerId, mode, allowedIds }: {
  ownerId: string;
  viewerId?: string | null;
  mode: unknown;
  allowedIds?: readonly string[];
}): boolean {
  if (typeof viewerId === "string" && viewerId.length > 0 && viewerId === ownerId) return true;
  if (mode === "public") return true;
  if (mode !== "allowlist" || typeof viewerId !== "string" || !viewerId) return false;
  return Array.isArray(allowedIds) && allowedIds.includes(viewerId);
}
