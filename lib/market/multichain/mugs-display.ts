const MUGS_CONTRACT = "0xab75f3d72509cd3b3a386a03de2b82854f0060e5";
const MUG_NAME = /^MUG ([0-9a-f]{40})(?:-([a-z0-9_]{1,15}))?$/i;

/**
 * MUGS' canonical metadata name contains its deterministic wallet seed.
 * Named mints append the creator-entered word; surface that meaningful suffix
 * without rewriting the canonical stored metadata or pretending wallet mints
 * were custom-named.
 */
export function displayMugsName(input: {
  chainSlug: string;
  contractAddress: string;
  tokenId: string;
  name: string | null;
  traits?: Array<{ traitType: string; value: string }>;
}): string | null {
  if (input.chainSlug !== "robinhood" || input.contractAddress.toLowerCase() !== MUGS_CONTRACT || !input.name) {
    return input.name;
  }
  const match = MUG_NAME.exec(input.name);
  if (!match) return input.name;
  const seedKind = input.traits?.find((trait) => trait.traitType.toLowerCase() === "seed")?.value.toLowerCase();
  const suffix = match[2] ?? null;
  if (seedKind === "named" && suffix) return `MUG ${suffix}`;
  if (seedKind === "reroll" && suffix) return `MUG #${input.tokenId} · reroll ${suffix}`;
  return `MUG #${input.tokenId} · wallet`;
}
