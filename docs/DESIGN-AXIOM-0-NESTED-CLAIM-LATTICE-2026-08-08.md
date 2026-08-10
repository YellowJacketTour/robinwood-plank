# AXIOM-0 — Nested Claim Lattice (Pure-Mode Maximum Vision)

**Status:** design truth / research synthesis. Does **not** authorize deploy.  
**Cover surface:** marketing leak page (`docs/mockups/index-fund-marketing/index.html`, `public/x/iv.html`).  
**Hard constraint:** zero external oracle; all settlement on-chain.  
**Date:** 2026-08-08  

---

## One sentence

Permissionless NFTX-class vaults per collection, mandatory WETH fee slices into a global pro-rata basket of `{WETH, vaultShare_i…}`, three-stream accrual (PPS / dividend / buyback), sybil weight from matured WETH fees, free pro-rata exit — **no price feed on any write path**.

---

## Lattice

| Layer | Name | What lives there | Settlement |
|-------|------|------------------|------------|
| **L0** | Cash numeraire | WETH only for fees, weight, dividends, buyback | One energy unit |
| **L1** | Collection vaults × N | 1 NFT ↔ 1 share; CPAMM share/WETH; Streams A/B | Inventory + endogenous AMM |
| **L2** | Global index | `{WETH, cvShare_i…}` only | mintProRata / redeemProRata / reconcile |
| **L3** | Cash utilities | PPS claim↑, EIP-2222 cash, buyback+lock | Balances + user minOut |
| **∅** | Forbidden core | priced single-asset, IPriceSource, $ volume weight | Deleted in pure mode |

**Periphery (not custody):** intent/solver “WETH-in” assembles pro-rata recipe atomically; core only checks balances ≥ recipe.

---

## Composition theorem

If every settlement is  

`f(balances on this contract, assets transferred this tx, supply, fixed params)`  

then V1–V10 of maximum vision are jointly achievable without an oracle.

Multi-collection exposure = **hold vault shares + WETH**, not mark heterogeneous floors in ETH on-chain.

---

## Streams

- **A (mint/redeem):** ≥810 bps to sink, rest to collection treasury (timelocked).  
- **B (swap):** default 100 bps; 50% sink / 50% local pool.  
- **After L2 reconcile:** hybrid split into reserve growth (PPS), optional cash dividend, buyback-lock.

Fees **never mint free index shares**.

---

## Sybil

`w_v = mature(Δt) · F_v^WETH` with `mature = Δt/(Δt+K)` from confirmed sink receipts only.

---

## Production cut (when authorized)

**Keep:** pro-rata core, reconcile Δbalance, vest injects, virtual shares, finalize diamond, CollectionVault streams.  

**Delete from settlement:** mintSingleAsset / redeemSingleAsset priced paths, IIndexPriceSource on write paths, TWAP mint size, $ volume weight.

---

## Related

- `docs/RESEARCH-ORACLE-FREE-MAXIMUM-VISION-2026-08-08.md`  
- `docs/DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md`  
- Cover leak HTML (this design’s public-facing form)

*Source of truth for deployment remains audited bytecode.*
