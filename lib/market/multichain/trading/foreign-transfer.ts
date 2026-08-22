/**
 * Send/batch-send NFTs on ANY foreign chain, to any wallet, across any mix
 * of collections -- the cross-chain counterpart to lib/market/transfer.ts.
 *
 * DELIBERATELY NOT lib/market/transfer.ts's sendNft/sendNftBatch
 * ---------------------------------------------------------------
 * Those route through lib/wallet.ts's sendTransaction(), which hardcodes
 * ensureRobinhoodChain() and rejects any other chainId by design (see its
 * own "CRITICAL: Only RH chain" comment) -- reusing it here would force a
 * foreign-chain send back onto Robinhood Chain. This module is a parallel,
 * chain-aware path, additive alongside transfer.ts rather than a
 * modification of it -- the same pattern every other piece of this
 * multichain effort has followed. It reuses transfer.ts's
 * validateRecipient/validateCollectionAddress directly (pure address
 * validation, no chain dependency) rather than re-implementing them.
 *
 * FEE SOURCING IS CHAIN-AWARE TOO
 * -----------------------------------
 * lib/market/send-fee.ts's getCurrentGasPriceWei() calls this app's own
 * /api/rpc proxy, which only ever talks to Robinhood Chain. A foreign-chain
 * send instead reads gas price directly from the connected wallet's own
 * provider on whichever chain it's currently on -- the only source that is
 * correct regardless of which of the 7 foreign chains is active. The fee
 * schedule itself (computeSendFeeWei, the margin multiplier, the batch
 * discount shape) is reused as-is from send-fee.ts: it's pure arithmetic
 * with no chain dependency.
 */
import { Contract, BrowserProvider } from "ethers";
import { validateRecipient, validateCollectionAddress } from "@/lib/market/transfer";
import type { BatchSendStatus } from "@/lib/market/transfer";
import { computeSendFeeWei, type SendFeeQuote } from "@/lib/market/send-fee";
import { MARKET_FEE_RECIPIENT } from "@/lib/constants";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getEthereumProvider, ensureChain } from "@/lib/wallet";

const ERC721_ABI = ["function safeTransferFrom(address from, address to, uint256 tokenId)"];

export type ForeignBatchSendItem = {
  chainSlug: string;
  collectionAddress: string;
  tokenId: string;
};

async function connectedSigner(chainSlug: string) {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) throw new Error(`foreign-transfer: "${chainSlug}" is not a supported foreign chain.`);
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  await ensureChain({
    chainId: chain.chainId,
    name: chainSlug,
    nativeCurrencySymbol: "ETH",
    rpcUrl: `https://${chainSlug}.g.alchemy.com/v2/demo`,
    blockExplorerUrl: "",
  });
  const browserProvider = new BrowserProvider(injected, { chainId: chain.chainId, name: chainSlug });
  const signer = await browserProvider.getSigner();
  return { signer, browserProvider };
}

/**
 * Quote the send/batch-send fee for a foreign chain -- same schedule and
 * margin as the Robinhood-chain path, priced off THAT chain's own live gas
 * price (read from the connected wallet, not our RPC proxy -- see header).
 */
export async function quoteForeignSendFee(chainSlug: string, itemCount: number): Promise<SendFeeQuote> {
  const { browserProvider } = await connectedSigner(chainSlug);
  const feeData = await browserProvider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? BigInt(0);
  return computeSendFeeWei(itemCount, gasPriceWei);
}

async function chargeForeignSendFee(chainSlug: string, itemCount: number): Promise<{ quote: SendFeeQuote; txHash: string }> {
  const { signer } = await connectedSigner(chainSlug);
  const quote = await quoteForeignSendFee(chainSlug, itemCount);
  const tx = await signer.sendTransaction({ to: MARKET_FEE_RECIPIENT, value: quote.totalFeeWei });
  await tx.wait();
  return { quote, txHash: tx.hash };
}

/** Send one NFT on a foreign chain to any wallet. */
export async function sendForeignNft(
  chainSlug: string,
  collectionAddress: string,
  tokenId: string,
  toAddress: string,
  accountAddress: string
): Promise<string> {
  const collection = validateCollectionAddress(collectionAddress);
  const to = validateRecipient(toAddress, accountAddress);
  await chargeForeignSendFee(chainSlug, 1);

  const { signer } = await connectedSigner(chainSlug);
  const nft = new Contract(collection, ERC721_ABI, signer);
  const tx = await nft.safeTransferFrom(accountAddress, to, tokenId);
  await tx.wait();
  return tx.hash as string;
}

/**
 * Send N NFTs on ONE foreign chain (any mix of collections, since one
 * transaction batch cannot span chains -- that's a property of blockchains,
 * not a limitation of this feature) to ONE recipient. Mirrors
 * lib/market/transfer.ts's sendNftBatch exactly: one fee payment, then
 * sequential per-token sends, live per-item status via onUpdate, and a
 * failure on one item never aborts the rest (the wallet already showed
 * separate prompts -- stopping partway would leave the user unsure which
 * sends actually landed).
 */
export async function sendForeignNftBatch(
  chainSlug: string,
  items: ForeignBatchSendItem[],
  toAddress: string,
  accountAddress: string,
  onUpdate: (statuses: Map<string, BatchSendStatus>) => void
): Promise<Map<string, BatchSendStatus>> {
  const to = validateRecipient(toAddress, accountAddress);
  const itemKey = (item: ForeignBatchSendItem) => `${item.collectionAddress.toLowerCase()}:${item.tokenId}`;
  const statuses = new Map<string, BatchSendStatus>(
    items.map((item) => [itemKey(item), { key: itemKey(item), state: "pending" }])
  );
  onUpdate(new Map(statuses));

  await chargeForeignSendFee(chainSlug, items.length);
  const { signer } = await connectedSigner(chainSlug);

  for (const item of items) {
    const key = itemKey(item);
    statuses.set(key, { key, state: "sending" });
    onUpdate(new Map(statuses));
    try {
      const collection = validateCollectionAddress(item.collectionAddress);
      const nft = new Contract(collection, ERC721_ABI, signer);
      const tx = await nft.safeTransferFrom(accountAddress, to, item.tokenId);
      await tx.wait();
      statuses.set(key, { key, state: "sent", txHash: tx.hash });
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
