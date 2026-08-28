import type { Connection } from "@solana/web3.js";
import { fetchM2Listing } from "@/lib/market/multichain/adapters/magiceden-m2-onchain";

type MeTokenListing = {
  auctionHouse?: string; tokenAddress?: string; seller?: string; price?: number;
};

export type SolanaListingVerification =
  | { verified: false; reason: string }
  | { verified: true; priceMatches: boolean; onchain: { pda: string; priceLamports: string; seller: string; tokenMint: string; expiry: number }; apiPriceLamports: string };

export type SolanaListingLead = {
  seller: string; auctionHouse: string; tokenAccount: string;
  priceLamports?: string; priceSol?: number;
};

export async function verifySolanaListingOnChain(input: {
  tokenMint: string; connection: Connection; fetchImpl?: typeof fetch; lead?: SolanaListingLead;
}): Promise<SolanaListingVerification> {
  const tokenAccountOf = (row: MeTokenListing | SolanaListingLead | undefined): string | undefined => {
    if (!row) return undefined;
    if ("tokenAccount" in row && row.tokenAccount) return row.tokenAccount;
    if ("tokenAddress" in row) return row.tokenAddress;
    return undefined;
  };
  let lead: MeTokenListing | SolanaListingLead | undefined = input.lead;
  if (!lead?.seller || !lead.auctionHouse || !tokenAccountOf(lead)) {
    const response = await (input.fetchImpl ?? fetch)(`https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(input.tokenMint)}/listings`, { headers: { accept: "application/json" } });
    if (!response.ok) return { verified: false, reason: `Magic Eden ${response.status}` };
    lead = ((await response.json().catch(() => null)) as MeTokenListing[] | null)?.[0];
  }
  const seller = lead?.seller;
  const auctionHouse = lead?.auctionHouse;
  const tokenAccount = tokenAccountOf(lead);
  if (!seller || !auctionHouse || !tokenAccount) return { verified: false, reason: "No active Magic Eden listing found for this token." };

  let onchain;
  try {
    onchain = await fetchM2Listing({ connection: input.connection, seller, auctionHouse, tokenAccount, tokenMint: input.tokenMint });
  } catch (error) {
    return { verified: false, reason: error instanceof Error ? error.message : "On-chain listing lookup failed." };
  }
  if (!onchain) return { verified: false, reason: "Magic Eden's API shows this listing, but no matching on-chain account was found." };

  const typed = lead as SolanaListingLead & MeTokenListing;
  const apiPriceLamports = typed.priceLamports
    ? typed.priceLamports
    : typeof typed.price === "number"
      ? BigInt(Math.round(typed.price * 1_000_000_000)).toString()
      : typeof typed.priceSol === "number"
        ? BigInt(Math.round(typed.priceSol * 1_000_000_000)).toString()
        : onchain.priceLamports;
  return {
    verified: true,
    priceMatches: onchain.priceLamports === apiPriceLamports,
    onchain: { pda: onchain.pda, priceLamports: onchain.priceLamports, seller: onchain.wallet, tokenMint: onchain.tokenMint, expiry: onchain.expiry },
    apiPriceLamports,
  };
}
