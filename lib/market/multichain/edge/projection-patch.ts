/** A sparse projection owns only fields it actually returned. Null is an
 * authoritative empty/expired value; absence must retain the previous source. */
export function applyProjectionFields<T extends object>(current: T, incoming: Record<string, unknown>, fields: readonly (keyof T)[]): T {
  const next = { ...current };
  for (const field of fields) {
    if (Object.hasOwn(incoming, field) && incoming[field as string] !== undefined) {
      next[field] = incoming[field as string] as T[typeof field];
    }
  }
  return next;
}
