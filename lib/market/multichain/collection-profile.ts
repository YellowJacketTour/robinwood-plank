import { durableKv } from "@/lib/market/durable-kv";
import { normalizeContractAddress } from "./collection-key";
import { profileLink } from "./collection-profile-url";
export { profileUrl } from "./collection-profile-url";

export type CollectionProfileField = { value: string; source: string; observedAt: string };
export type CollectionProfile = Partial<Record<"website" | "twitter" | "discord" | "description", CollectionProfileField>>;
const key = (chain: string, address: string) => `plank:collection-profile:${chain}:${normalizeContractAddress(chain, address)}`;

/** Persist independently sourced fields without erasing earlier evidence when
 * another provider omits them. No crawling or provider calls on page reads. */
export async function recordCollectionProfile(chain: string, address: string, input: Record<string, unknown>, source: string): Promise<void> {
  const fields: CollectionProfile = {};
  const observedAt = new Date().toISOString();
  for (const field of ["website", "twitter", "discord"] as const) {
    const value = profileLink(field, input[field]);
    if (value) fields[field] = { value, source, observedAt };
  }
  if (typeof input.description === "string" && input.description.trim()) {
    fields.description = { value: input.description.trim().slice(0, 4000), source, observedAt };
  }
  if (Object.keys(fields).length) await durableKv.hset(key(chain, address), fields);
}

export async function readCollectionProfile(chain: string, address: string): Promise<CollectionProfile | null> {
  return durableKv.hgetall<CollectionProfile>(key(chain, address));
}
