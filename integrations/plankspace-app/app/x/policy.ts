import type { XPost } from "./provider";

export const DEFAULT_X_POST_COOLDOWN_MINUTES = 5;
export const X_IMPORT_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const X_IMPORT_LIMIT = 20;

type WindowDecision = { allowed: boolean; retryAfterSeconds: number };

function windowDecision(now: number, previous: string | null | undefined, windowMs: number): WindowDecision {
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  if (!Number.isFinite(previousTime)) return { allowed: true, retryAfterSeconds: 0 };
  const remaining = previousTime + windowMs - now;
  return remaining > 0
    ? { allowed: false, retryAfterSeconds: Math.ceil(remaining / 1_000) }
    : { allowed: true, retryAfterSeconds: 0 };
}

export function normalizeXCooldownMinutes(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_X_POST_COOLDOWN_MINUTES;
  return Math.min(1_440, Math.max(0, Math.round(numeric)));
}

export function evaluateXPostCooldown(input: {
  now?: number;
  lastPublishedAt?: string | null;
  cooldownMinutes: number;
  profileHandle: string;
}): WindowDecision {
  if (isDegenXCooldownExempt(input.profileHandle)) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return windowDecision(
    input.now ?? Date.now(),
    input.lastPublishedAt,
    normalizeXCooldownMinutes(input.cooldownMinutes) * 60_000,
  );
}

export function isDegenXCooldownExempt(profileHandle: string): boolean {
  return profileHandle.trim().toLowerCase().replace(/_/g, "") === "degenwaffle";
}

export function evaluateXImportWindow(input: {
  now?: number;
  lastImportedAt?: string | null;
}): WindowDecision {
  return windowDecision(input.now ?? Date.now(), input.lastImportedAt, X_IMPORT_WINDOW_MS);
}

export function newestTwentyXPosts(posts: XPost[]): XPost[] {
  return [...posts]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, X_IMPORT_LIMIT);
}
