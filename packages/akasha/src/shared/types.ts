import type { Hex } from "./hex.ts";

export type ChainFamily = "evm" | "solana" | "bitcoin";

export type ChainId =
  | "ethereum"
  | "base"
  | "optimism"
  | "polygon"
  | "arbitrum"
  | "bsc"
  | "avalanche"
  | "zora"
  | "solana"
  | "bitcoin";

export const EVM_CHAINS: ChainId[] = [
  "ethereum",
  "base",
  "optimism",
  "polygon",
  "arbitrum",
  "bsc",
  "avalanche",
  "zora",
];

export const FINALITY_LAG: Record<ChainId, number> = {
  ethereum: 12,
  base: 20,
  optimism: 20,
  polygon: 64,
  arbitrum: 40,
  bsc: 15,
  avalanche: 20,
  zora: 20,
  solana: 32,
  bitcoin: 6,
};

export type StreamKind =
  | "ws_newheads"
  | "http_tick"
  | "zmq"
  | "sol_program"
  | "dead";

export type GapReason =
  | "reconnect"
  | "reorg"
  | "bloom_audit"
  | "seq_gap"
  | "attention_history"
  /**
   * The block was read, but not all of it. Distinct from every reason above:
   * those describe a range we never reached, this describes one we reached and
   * could not finish. Recording it as covered would be the archive claiming
   * history it never read.
   */
  | "incomplete_tx_walk";

export type EventKind =
  | "transfer721"
  | "transfer1155"
  | "transfer1155_batch"
  | "seaport_fill"
  | "clone"
  | "envelope"
  | "mpl_collection"
  | "mpl_verify"
  | "sol_mint"
  | "btc_spend";

export type ArtifactKind = "evm_token" | "evm_contract" | "sol_mint" | "inscription";

export interface Header {
  chain: ChainId;
  height: number;
  hash: Hex;
  parentHash: Hex;
  logsBloom?: Hex;
  receiptsRoot?: Hex;
}

export interface ChainEvent {
  chain: ChainId;
  blockHash: Hex;
  height: number;
  loc: number;
  txHash: Hex;
  kind: EventKind;
  contractOrProgram: string;
  tokenOrInscription: string;
  fromAddr: string;
  toAddr: string;
  raw: Record<string, unknown>;
}

export interface Artifact {
  id: string;
  chain: ChainId;
  kind: ArtifactKind;
  genesisEvent: { blockHash: Hex; loc: number };
  firstHash: Hex;
  firstHeight: number;
}

export interface ChainCursor {
  chain: ChainId;
  t0Hash: Hex;
  t0Height: number;
  tipHash: Hex;
  tipHeight: number;
  finalizedHash: Hex;
  finalizedHeight: number;
  streamAlive: boolean;
  streamKind: StreamKind;
}

export interface CoverageRun {
  chain: ChainId;
  fromHeight: number;
  toHeight: number;
  toHash: Hex;
  eventCount: number;
  artifactCount: number;
  receiptDigest: Hex;
}

export interface Gap {
  chain: ChainId;
  fromHeight: number;
  toHeight: number;
  reason: GapReason;
  enqueuedAt: number;
  attempts: number;
  /**
   * The artifact this gap was opened on behalf of. Required for
   * `attention_history`, which exists only to backfill an artifact we already
   * hold: without it, attention could open unbounded history walks for
   * subjects the archive has never seen, which is exactly the "attention
   * creates identity" failure the cluster layer refuses.
   */
  artifactId?: string;
}

export type ClaimKind =
  | "holders_at_block"
  | "holders_at_block_partial"
  | "traits_content_addressed"
  | "traits_under_obs"
  | "min_exhibited_valid_order"
  | "min_observed_fill_in_window"
  | "amm_state"
  | "creator_from_genesis";

export type ObservationStatus = "unconfirmed" | "confirmed" | "disputed";

export type UriClass = "content_addressed" | "signed_order" | "https_mutable";
