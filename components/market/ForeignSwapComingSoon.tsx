/**
 * Instant Swap's foreign-chain placeholder. Instant Swap on the native
 * Marketplank tab is powered by MarketplankVaultV3, which foreign
 * collections don't have yet -- this is NOT a "feature we haven't built,"
 * it's a real prerequisite (a vault contract has to exist and hold
 * inventory before instant swap has anything to swap against). Held in the
 * SAME tab-rail position as the native page (not omitted) because admins
 * may start seeding vaults for external collections at any time, and the
 * tab needs to already exist for that to just start working.
 */
export default function ForeignSwapComingSoon({ collectionName }: { collectionName?: string }) {
  return (
    <div className="mx-auto max-w-lg space-y-3 rounded-xl border border-line bg-panel px-5 py-10 text-center">
      <p className="text-[0.55rem] font-black uppercase tracking-wide text-foreground/45">Instant Swap</p>
      <h2 className="font-display text-lg text-gold-300">Vault coming soon</h2>
      <p className="text-sm text-foreground/60">
        Instant Swap needs a funded vault behind {collectionName ? `${collectionName}` : "a collection"} to swap
        against — foreign collections don't have one yet. This tab will activate the moment a vault is seeded, with
        no other changes needed on your end.
      </p>
    </div>
  );
}
