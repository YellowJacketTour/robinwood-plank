/**
 * Canonical Wyvern Exchange deployments (OpenSea's pre-Seaport marketplace
 * contract, 2018-2022). Unlike Seaport, Wyvern was never deployed at the
 * same address across chains -- it is Ethereum mainnet only, in two
 * generations. Both addresses and their deployment blocks below are real,
 * independently verified, not estimated:
 *
 *  - v1 ("WyvernExchange"), 0x7Be8076f4EA4A4AD08075C2508e481d6C946D12b,
 *    startBlock 5774644 -- taken directly from protofire's own
 *    opensea-wyvern-exchange-subgraph-v1 subgraph.yaml (real, published
 *    subgraph manifest, not a guess):
 *    https://github.com/protofire/opensea-wyvern-exchange-subgraph-v1/blob/main/subgraph.yaml
 *
 *  - v2 ("WyvernExchangeWithBulkCancellations"),
 *    0x7f268357A8c2552623316e2562D90e642bB538E5, deployment block 14120913
 *    (2022-02-01T22:30:32Z, matching Ethplorer's reported creation
 *    timestamp 1643729432) -- verified live 2026-08-23 via Ethplorer's
 *    getAddressInfo (creationTransaction
 *    0xb387cc66173783ef9faef775d4b7eaaff3fdd47e765239d5ffb7633ec0be665b,
 *    from 0x939c8d89ebc11fa45e576215e2353673ad0ba18a) and cross-checked
 *    against that exact tx's own getTxInfo, whose `creates` field matches
 *    this address exactly and whose `blockNumber` is 14120913. Etherscan
 *    itself returned HTTP 403 to automated fetches all session, so this is
 *    a real, independently-obtained number from a different real source,
 *    not a fallback/estimate -- flagged here anyway per this app's own
 *    "document provenance honestly" standard.
 */
export const WYVERN_DEPLOYMENTS = [
  { version: "1", address: "0x7Be8076f4EA4A4AD08075C2508e481d6C946D12b", chainSlug: "eth-mainnet", deploymentBlock: 5774644 },
  { version: "2", address: "0x7f268357A8c2552623316e2562D90e642bB538E5", chainSlug: "eth-mainnet", deploymentBlock: 14120913 },
] as const;

export const ALL_WYVERN_ADDRESSES = WYVERN_DEPLOYMENTS.map((deployment) => deployment.address);

/** Earliest real deployment block across every known Wyvern generation -- the genesis floor for a full-history scan. */
export const WYVERN_GENESIS_BLOCK = Math.min(...WYVERN_DEPLOYMENTS.map((d) => d.deploymentBlock));

export function wyvernVersionForAddress(address: string): string | null {
  return WYVERN_DEPLOYMENTS.find((deployment) =>
    deployment.address.toLowerCase() === address.toLowerCase())?.version ?? null;
}
