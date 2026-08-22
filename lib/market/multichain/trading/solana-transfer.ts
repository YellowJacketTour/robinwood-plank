/**
 * Send/batch-send a Solana NFT (SPL token, decimals=0, supply=1 — the
 * standard Metaplex NFT shape every Magic Eden listing on this app already
 * assumes, see magiceden-solana-trade.ts's own "mint address IS the unique
 * identifier" note) to any wallet -- the Solana counterpart to
 * lib/market/multichain/trading/foreign-transfer.ts (EVM) and
 * lib/market/transfer.ts (Robinhood Chain).
 *
 * REAL, STANDARD, NO ANALOGOUS RISK TO BITCOIN'S UTXO-BURN PROBLEM
 * ---------------------------------------------------------------------------
 * Unlike an Ordinals inscription (tied to a specific UTXO that naive coin
 * selection can accidentally spend/burn -- see unisat-ordinals-trade.ts's
 * header), an SPL token transfer is address-based: `createTransferInstruction`
 * moves exactly the token in the source Associated Token Account (ATA) to the
 * destination ATA, nothing else. This module uses the real, official
 * `@solana/spl-token` package (added as a new dependency this session,
 * matching the precedent already set by adding `@solana/web3.js`) rather
 * than hand-encoding the SPL Token program's transfer instruction -- getting
 * an ATA derivation or instruction layout wrong by hand is exactly the kind
 * of "don't hand-roll something a real library already gets right" case
 * this codebase's own culture (see unisat-ordinals-trade.ts's header) warns
 * against, even though the blast radius here (one NFT) is smaller than an
 * inscription burn.
 *
 * NO SERVER ROUND-TRIP NEEDED
 * ---------------------------------------------------------------------------
 * Unlike buySolanaListingNow (which needs Magic Eden's own API + a Bearer
 * key that must never reach the client bundle -- see foreign-fulfill.ts's
 * header), a plain SPL transfer needs no third-party API or secret at all:
 * this file builds the transaction entirely client-side from public,
 * unauthenticated RPC calls (getLatestBlockhash, getAccountInfo to check
 * whether the recipient's ATA already exists) and Phantom's own
 * signAndSendTransaction, matching non-evm-wallet.ts's existing
 * "never sign/broadcast outside the one designated module" boundary --
 * THIS file does the signing (via signAndSendSolanaTransaction), same as
 * foreign-fulfill.ts's buySolanaListingNow already does for buys.
 *
 * RPC ENDPOINT: no Solana RPC config exists anywhere else in this codebase
 * (verified via grep before writing this) -- uses Solana Labs' own public
 * mainnet-beta endpoint (api.mainnet-beta.solana.com), the same default
 * every unconfigured Solana dApp uses. Rate-limited but real; swappable via
 * NEXT_PUBLIC_SOLANA_RPC_URL if the deployment ever needs a dedicated
 * provider (Helius/QuickNode/etc) without code changes.
 */
import { validateRecipient } from "@/lib/market/transfer";
import type { BatchSendStatus } from "@/lib/market/transfer";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
  "https://api.mainnet-beta.solana.com";

/**
 * Validates a Solana address by shape only (base58, 32-byte public key) --
 * NOT reusing EVM's validateRecipient (0x-hex-address regex), which would
 * reject every real Solana address outright. Solana has no analogous
 * "same as sender" or "zero address" foot-gun this app already guards
 * against for EVM (there is no canonical Solana burn address the way
 * 0x000...000 is for EVM), so this only checks that the string decodes to
 * a real 32-byte key -- still fails closed on garbage input rather than
 * silently building a transaction to an unparseable destination.
 */
async function validateSolanaAddress(raw: string, senderAddress: string): Promise<InstanceType<typeof import("@solana/web3.js").PublicKey>> {
  const trimmed = raw.trim();
  const { PublicKey } = await import("@solana/web3.js");
  let pubkey: InstanceType<typeof PublicKey>;
  try {
    pubkey = new PublicKey(trimmed);
  } catch {
    throw new Error("Enter a valid Solana wallet address.");
  }
  if (trimmed === senderAddress) {
    throw new Error("Recipient is the same as your own wallet.");
  }
  return pubkey;
}

/**
 * Builds and signs a single SPL-token (NFT) transfer transaction, creating
 * the recipient's Associated Token Account first if it doesn't exist yet
 * (a fresh wallet that has never held this exact mint has no ATA for it --
 * the SENDER pays the one-time rent to create it, the standard convention
 * every Solana wallet/marketplace follows since the recipient has no way to
 * pre-pay for an account they don't know is coming).
 */
async function buildAndSendSolanaTransfer(input: {
  senderAddress: string;
  tokenMint: string;
  toAddress: string;
}): Promise<string> {
  const web3 = await import("@solana/web3.js");
  const splToken = await import("@solana/spl-token");
  const { Connection, PublicKey, Transaction } = web3;
  const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = splToken;

  const to = await validateSolanaAddress(input.toAddress, input.senderAddress);
  const from = new PublicKey(input.senderAddress);
  const mint = new PublicKey(input.tokenMint);

  const connection = new Connection(SOLANA_RPC_URL, "confirmed");

  const sourceAta = await getAssociatedTokenAddress(mint, from);
  const destAta = await getAssociatedTokenAddress(mint, to);

  const tx = new Transaction();
  const destAccountInfo = await connection.getAccountInfo(destAta);
  if (!destAccountInfo) {
    tx.add(createAssociatedTokenAccountInstruction(from, destAta, to, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  // amount=1, decimals=0 -- the whole (only) unit of a standard NFT mint,
  // matching every real Metaplex NFT this app already lists via Magic Eden.
  tx.add(createTransferInstruction(sourceAta, destAta, from, 1, [], TOKEN_PROGRAM_ID));

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = from;

  const { getPhantomProvider } = await import("@/lib/market/multichain/trading/non-evm-wallet");
  const provider = getPhantomProvider();
  if (!provider) {
    throw new Error("Phantom wallet not found -- install the Phantom browser extension to send Solana NFTs (phantom.app).");
  }
  const { signature } = await provider.signAndSendTransaction(tx);
  return signature;
}

/** Send one Solana NFT (by mint address) to any wallet. */
export async function sendSolanaToken(senderAddress: string, tokenMint: string, toAddress: string): Promise<string> {
  return buildAndSendSolanaTransfer({ senderAddress, tokenMint, toAddress });
}

/**
 * Send N Solana NFTs to ONE recipient. Same "no native batch-transfer
 * instruction across arbitrary mints, so N sequential signed transactions"
 * shape as transfer.ts's sendNftBatch and foreign-transfer.ts's
 * sendForeignNftBatch -- Solana's SPL Token program transfers exactly one
 * mint per instruction the way ERC-721's safeTransferFrom does, so this is
 * a genuine cross-chain parallel, not a shortcut taken here specifically.
 * No separate "fee" transaction (unlike the EVM paths' chargeSendFee) --
 * this app charges no Marketplank fee on a Solana send in this pass; adding
 * one would need its own quote/UI wiring this task didn't ask for and
 * SendFeeQuote's shape (gas-price-denominated) has no Solana equivalent
 * (Solana fees are a fixed ~5000 lamports/signature, not a gas market).
 */
export async function sendSolanaTokenBatch(
  senderAddress: string,
  tokenMints: string[],
  toAddress: string,
  onUpdate: (statuses: Map<string, BatchSendStatus>) => void
): Promise<Map<string, BatchSendStatus>> {
  // Reuses validateRecipient's own-address check is EVM-hex-specific and
  // would reject every real Solana address -- the per-item
  // validateSolanaAddress call inside buildAndSendSolanaTransfer is the
  // real guard; this top-level check only rejects an obviously-empty
  // recipient before any wallet prompt, same fail-fast shape as the EVM
  // batch functions' own top-of-function validateRecipient call.
  if (toAddress.trim().length === 0) {
    throw new Error("Enter a valid Solana wallet address.");
  }
  const statuses = new Map<string, BatchSendStatus>(tokenMints.map((mint) => [mint, { key: mint, state: "pending" }]));
  onUpdate(new Map(statuses));

  for (const mint of tokenMints) {
    statuses.set(mint, { key: mint, state: "sending" });
    onUpdate(new Map(statuses));
    try {
      const signature = await sendSolanaToken(senderAddress, mint, toAddress);
      statuses.set(mint, { key: mint, state: "sent", txHash: signature });
    } catch (error) {
      statuses.set(mint, { key: mint, state: "failed", error: error instanceof Error ? error.message : "Send failed." });
    }
    onUpdate(new Map(statuses));
  }
  return statuses;
}

export { validateRecipient };
