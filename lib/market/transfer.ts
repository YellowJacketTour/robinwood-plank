import { Interface, getAddress, isAddress } from "ethers";
import { sendTransaction, waitForTransaction } from "@/lib/wallet";
import { quoteSendFee, SEND_FEE_RECIPIENT, type SendFeeQuote } from "@/lib/market/send-fee";

const ERC721_TRANSFER_IFACE = new Interface([
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
]);

/**
 * Validate a recipient address the same way everywhere it's typed —
 * rejects the sender's own address (a "send" that goes nowhere is almost
 * always a mistake, not intent) and the zero address (that's a burn, not a
 * send; nothing in this app exposes burning).
 */
export function validateRecipient(raw: string, senderAddress: string): string {
  const trimmed = raw.trim();
  if (!isAddress(trimmed)) {
    throw new Error("Enter a valid wallet address.");
  }
  const checksummed = getAddress(trimmed);
  if (checksummed === "0x0000000000000000000000000000000000000000") {
    throw new Error("Cannot send to the zero address.");
  }
  if (checksummed.toLowerCase() === senderAddress.toLowerCase()) {
    throw new Error("Recipient is the same as your own wallet.");
  }
  return checksummed;
}

/** Validate a collection contract address — same shape check as a
 * recipient, but no self/zero-address rule (a collection is never the
 * signer's own wallet). Works for ANY ERC-721, not just the ones this
 * marketplace lists — the caller supplies the address directly. */
export function validateCollectionAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!isAddress(trimmed)) {
    throw new Error("Enter a valid collection contract address.");
  }
  return getAddress(trimmed);
}

/**
 * Charge the send fee — see lib/market/send-fee.ts for why it's priced off
 * live gas rather than a fixed number. This is charged UNCONDITIONALLY
 * before any transfer is attempted, in both sendNft and sendNftBatch: there
 * is no deployed router contract that could enforce fee-then-transfer
 * atomically in one call (see that file's header), so the fee is collected
 * as its own transaction FIRST, and the transfer(s) only proceed once it
 * has landed. That is the strongest guarantee available without a new
 * contract: the fee is never skippable through this app's own flow, even
 * though it isn't smart-contract-enforced the way an on-chain router's
 * would be.
 */
async function chargeSendFee(
  accountAddress: string,
  itemCount: number
): Promise<{ quote: SendFeeQuote; txHash: string }> {
  const quote = await quoteSendFee(itemCount);
  const txHash = await sendTransaction({
    to: SEND_FEE_RECIPIENT,
    from: accountAddress,
    data: "0x",
    value: quote.totalFeeWei.toString(),
    kind: "transfer",
  });
  await waitForTransaction(txHash, { label: "Send fee" });
  return { quote, txHash };
}

/** Send one NFT to any collection. Resolves once both the fee and the
 * transfer are confirmed. */
export async function sendNft(
  accountAddress: string,
  collectionAddress: string,
  tokenId: string,
  toAddress: string
): Promise<string> {
  const collection = validateCollectionAddress(collectionAddress);
  const to = validateRecipient(toAddress, accountAddress);
  await chargeSendFee(accountAddress, 1);
  const data = ERC721_TRANSFER_IFACE.encodeFunctionData("safeTransferFrom", [
    accountAddress,
    to,
    tokenId,
  ]);
  const hash = await sendTransaction({
    to: collection,
    from: accountAddress,
    data,
    kind: "transfer",
  });
  await waitForTransaction(hash, { label: `Send #${tokenId}` });
  return hash;
}

export type BatchSendItem = {
  collectionAddress: string;
  tokenId: string;
};

export type BatchSendStatus = {
  key: string;
  state: "pending" | "sending" | "sent" | "failed";
  txHash?: string;
  error?: string;
};

function itemKey(item: BatchSendItem): string {
  return `${item.collectionAddress.toLowerCase()}:${item.tokenId}`;
}

/**
 * Send N NFTs (any mix of collections) to ONE recipient. There is no native
 * ERC-721 batch-transfer entry point, so "batch send" is one fee payment
 * followed by N sequential signed transfers — same tradeoff MyInventory's
 * bulk-list already made for listing, for the same underlying reason (see
 * lib/market/bulk-list.ts). `onUpdate` fires after every step so the UI can
 * show live per-token progress instead of one opaque spinner for the whole
 * batch.
 *
 * A failure on one item does not abort the rest — the wallet already showed
 * the user separate prompts; stopping partway through would leave them
 * unsure which sends actually landed. Every item's own status makes that
 * unambiguous instead. The fee, once paid, is not refunded on a partial
 * failure — it was priced (and disclosed) for the whole batch up front.
 */
export async function sendNftBatch(
  accountAddress: string,
  items: BatchSendItem[],
  toAddress: string,
  onUpdate: (statuses: Map<string, BatchSendStatus>) => void
): Promise<Map<string, BatchSendStatus>> {
  const to = validateRecipient(toAddress, accountAddress);
  const statuses = new Map<string, BatchSendStatus>(
    items.map((item) => [itemKey(item), { key: itemKey(item), state: "pending" }])
  );
  onUpdate(new Map(statuses));

  await chargeSendFee(accountAddress, items.length);

  for (const item of items) {
    const key = itemKey(item);
    statuses.set(key, { key, state: "sending" });
    onUpdate(new Map(statuses));
    try {
      const collection = validateCollectionAddress(item.collectionAddress);
      const data = ERC721_TRANSFER_IFACE.encodeFunctionData("safeTransferFrom", [
        accountAddress,
        to,
        item.tokenId,
      ]);
      const hash = await sendTransaction({
        to: collection,
        from: accountAddress,
        data,
        kind: "transfer",
      });
      await waitForTransaction(hash, { label: `Send #${item.tokenId}` });
      statuses.set(key, { key, state: "sent", txHash: hash });
    } catch (error) {
      statuses.set(key, {
        key,
        state: "failed",
        error: error instanceof Error ? error.message : "Send failed.",
      });
    }
    onUpdate(new Map(statuses));
  }

  return statuses;
}
