/**
 * Send/batch-send a Bitcoin Ordinals inscription -- the Bitcoin counterpart
 * to solana-transfer.ts and foreign-transfer.ts (EVM). Unlike those two,
 * this deliberately does NOT hand-build a PSBT: this module's sibling
 * unisat-ordinals-trade.ts's own header is explicit that a naive UTXO
 * selection for an inscription-holding wallet can accidentally BURN the
 * inscription (an inscription is tied to a specific UTXO, not tracked by an
 * address-keyed balance the way an SPL/ERC-721 token is).
 *
 * REAL, DOCUMENTED, SAFE PATH FOUND -- NOT A WORKAROUND
 * ---------------------------------------------------------------------------
 * A dedicated research pass (2026-08-18) fetching UniSat's real developer
 * docs (docs.unisat.io/developer-support/open-api-documentation/
 * unisat-wallet.md) found `window.unisat.sendInscription(address,
 * inscriptionId, options)` -- a real, documented method on the SAME
 * injected provider unisat-ordinals-trade.ts/non-evm-wallet.ts already use
 * for signPsbt, verified with its exact TypeScript signature and a working
 * code sample. UniSat's own wallet performs the UTXO selection internally
 * (the whole reason this method exists, per its own docs: "the id of
 * Inscription" is all a caller supplies -- no PSBT construction, no input
 * selection, on this app's side at all), so the burn risk this module's own
 * README warns about never applies here: this is the officially sanctioned
 * way to move an inscription, not a smaller version of the risky thing.
 *
 * NO MARKETPLACE INVOLVED, NO FEE ADDED
 * ---------------------------------------------------------------------------
 * This is a plain wallet-to-wallet transfer, same category as
 * solana-transfer.ts's plain SPL transfer -- no UniSat Marketplace API call,
 * no Bearer key, and (matching the Solana send's own reasoning) no
 * Marketplank fee: SendFeeQuote's gas-price-denominated shape has no
 * Bitcoin-fee-rate equivalent, and sendInscription's own `feeRate` option
 * already lets the wallet handle miner-fee sizing itself.
 */
import type { BatchSendStatus } from "@/lib/market/transfer";

/** Loose address-shape check -- Bitcoin has multiple valid address formats (P2PKH/P2SH/Bech32/Taproot) with no single regex worth hand-rolling here; UniSat's own sendInscription call is the real validation (it throws on a genuinely invalid address), this only catches empty/obviously-wrong input before a wallet prompt. */
function validateBitcoinAddressShape(raw: string, senderAddress: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 14) {
    throw new Error("Enter a valid Bitcoin wallet address.");
  }
  if (trimmed === senderAddress) {
    throw new Error("Recipient is the same as your own wallet.");
  }
  return trimmed;
}

/** Send one inscription to any Bitcoin wallet, via UniSat's own sendInscription. */
export async function sendBitcoinInscription(senderAddress: string, inscriptionId: string, toAddress: string): Promise<string> {
  const to = validateBitcoinAddressShape(toAddress, senderAddress);
  const { getUnisatProvider } = await import("@/lib/market/multichain/trading/non-evm-wallet");
  const provider = getUnisatProvider();
  if (!provider) {
    throw new Error("UniSat wallet not found -- install the UniSat browser extension to send Bitcoin Ordinals (unisat.io).");
  }
  const { txid } = await provider.sendInscription(to, inscriptionId);
  return txid;
}

/**
 * Send N inscriptions to ONE recipient. Sequential real Bitcoin
 * transactions -- one sendInscription call, one wallet prompt, per item
 * (there is no batch-inscription-send instruction; each is its own
 * transaction on-chain either way, matching every other batch-send
 * function in this app's own "N sequential signed operations" shape).
 */
export async function sendBitcoinInscriptionBatch(
  senderAddress: string,
  inscriptionIds: string[],
  toAddress: string,
  onUpdate: (statuses: Map<string, BatchSendStatus>) => void
): Promise<Map<string, BatchSendStatus>> {
  if (toAddress.trim().length === 0) {
    throw new Error("Enter a valid Bitcoin wallet address.");
  }
  const statuses = new Map<string, BatchSendStatus>(inscriptionIds.map((id) => [id, { key: id, state: "pending" }]));
  onUpdate(new Map(statuses));

  for (const inscriptionId of inscriptionIds) {
    statuses.set(inscriptionId, { key: inscriptionId, state: "sending" });
    onUpdate(new Map(statuses));
    try {
      const txid = await sendBitcoinInscription(senderAddress, inscriptionId, toAddress);
      statuses.set(inscriptionId, { key: inscriptionId, state: "sent", txHash: txid });
    } catch (error) {
      statuses.set(inscriptionId, { key: inscriptionId, state: "failed", error: error instanceof Error ? error.message : "Send failed." });
    }
    onUpdate(new Map(statuses));
  }
  return statuses;
}
