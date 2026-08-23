/**
 * Canonical CryptoKitties native auction-house deployments -- the two
 * contracts that actually settled every primary/secondary sale before
 * OpenSea/Wyvern existed (Wyvern launched mid-2018; CryptoKitties launched
 * 2017-11-23). KittyCore itself (0x06012c8cf97bead5deae237070f9587f8e7a266d,
 * already tracked in this app via the generic alchemy-nft metadata adapter)
 * never emits a sale event -- both auctions run in their OWN dedicated
 * ClockAuction contracts, which is why its real historical sale activity has
 * been completely unindexed until this file.
 *
 * REAL, INDEPENDENTLY CROSS-CHECKED ADDRESSES
 * ---------------------------------------------------------------------------
 *  - SaleClockAuction, 0xb1690C08E213a35Ed9bAb7B318DE14420FB57d8c --
 *    the primary/secondary marketplace auction (buying/selling a kitty
 *    outright). Corroborated by three independent block-explorer mirrors
 *    (bitquery explorer, bloxy.info, Blockwell) all under the label
 *    "CryptoKitties: Sales Auction" / "SaleClockAuction" -- Etherscan itself
 *    403'd every automated fetch this session (same block this app hit on
 *    Wyvern v2, see wyvern-deployments.ts), so this is cross-referenced
 *    against real independent mirrors rather than a single source.
 *  - SiringClockAuction, 0xC7af99Fe5513eB6710e6D5f44F9989dA40F27F26 --
 *    the breeding-rights auction (put a kitty up to sire, NOT a transfer of
 *    the kitty itself -- see honest note on ownership below). Same
 *    cross-check pattern (Etherscan search-index title "CryptoKitties:
 *    Siring Auction" plus the mirrors above).
 *  - Contract source (both inherit ClockAuctionBase, which declares the
 *    real AuctionSuccessful event decoded here): dapperlabs/cryptokitties-bounty,
 *    contracts/Auction/ClockAuctionBase.sol and SaleClockAuction.sol
 *    (https://github.com/dapperlabs/cryptokitties-bounty/blob/master/contracts/Auction/ClockAuctionBase.sol,
 *    https://github.com/dapperlabs/cryptokitties-bounty/blob/master/contracts/Auction/SaleClockAuction.sol) --
 *    the project's own bug-bounty repo, a real published mirror of the
 *    deployed source.
 *
 * REAL EVENT: `event AuctionSuccessful(uint256 tokenId, uint256 totalPrice,
 * address winner)` -- ClockAuctionBase.sol, both auction types share this
 * exact signature (SaleClockAuction does not override it). Unlike Seaport's
 * OrderFulfilled, it does NOT carry the seller address -- only the kitty id,
 * the winning bid, and the winner. See cryptokitties-fill-indexer.ts's own
 * header for the honest consequence of that (seller left NULL, matching the
 * precedent this app already set for Wyvern's missing nft_contract/token_id
 * in plank_wyvern_fills).
 *
 * GENESIS FLOOR
 * ---------------------------------------------------------------------------
 * CryptoKitties' own launch is well-documented as 2017-11-23 (block 4605167
 * per cross-referenced public sources), but that number is KittyCore's own
 * approximate genesis, not independently confirmed as either auction
 * contract's own creation block (the project shipped a second-generation
 * "KittyCore 2.0" migration a few weeks after launch, so the two auction
 * houses may not share KittyCore's exact deploy block). Rather than assert a
 * precise block this session could not independently verify (Etherscan
 * blocked), the floor below is set conservatively earlier -- 4,600,000,
 * safely before any possible CryptoKitties activity -- so a genesis-forward
 * scan can never miss real early sales by starting too late; it costs a
 * small number of guaranteed-empty pages instead.
 */
export const SALE_CLOCK_AUCTION_ADDRESS = "0xb1690C08E213a35Ed9bAb7B318DE14420FB57d8c";
export const SIRING_CLOCK_AUCTION_ADDRESS = "0xC7af99Fe5513eB6710e6D5f44F9989dA40F27F26";
export const KITTY_CORE_ADDRESS = "0x06012c8cf97bead5deae237070f9587f8e7a266d";

export const CRYPTOKITTIES_AUCTION_DEPLOYMENTS = [
  { kind: "sale" as const, address: SALE_CLOCK_AUCTION_ADDRESS, chainSlug: "eth-mainnet" },
  { kind: "siring" as const, address: SIRING_CLOCK_AUCTION_ADDRESS, chainSlug: "eth-mainnet" },
] as const;

export const ALL_CRYPTOKITTIES_AUCTION_ADDRESSES = CRYPTOKITTIES_AUCTION_DEPLOYMENTS.map((d) => d.address);

/** Conservative, honestly-documented genesis floor -- see header. */
export const CRYPTOKITTIES_GENESIS_BLOCK = 4_600_000;

export function cryptoKittiesAuctionKindForAddress(address: string): "sale" | "siring" | null {
  return CRYPTOKITTIES_AUCTION_DEPLOYMENTS.find((d) => d.address.toLowerCase() === address.toLowerCase())?.kind ?? null;
}
