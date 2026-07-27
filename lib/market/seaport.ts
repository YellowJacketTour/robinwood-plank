import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";
import { BrowserProvider } from "ethers";
import { CHAIN, NATIVE_TOKEN_ADDRESS, SEAPORT_ADDRESS } from "@/lib/constants";
import { ensureRobinhoodChain, getEthereumProvider } from "@/lib/wallet";

/**
 * Client-side Seaport instance bound to the connected wallet. Always
 * re-checks the chain first — same discipline as lib/wallet.ts's swap path,
 * because a Seaport order signed on the wrong chain is either useless or,
 * worse, replayable somewhere it shouldn't be.
 */
export async function getSeaport(): Promise<Seaport> {
  await ensureRobinhoodChain();
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");

  const provider = new BrowserProvider(injected, {
    chainId: CHAIN.id,
    name: CHAIN.name,
  });
  const signer = await provider.getSigner();
  // seaport-js ships its own ethers type declarations; TS sees the ESM vs
  // CJS entry points of the *same* installed ethers version as nominally
  // different types (dual-package-hazard on the private class fields).
  // Runtime object is identical — cast is safe.
  return new Seaport(signer as unknown as ConstructorParameters<typeof Seaport>[0], {
    overrides: { contractAddress: SEAPORT_ADDRESS },
  });
}

export type ListInput = {
  offerTokenAddress: string;
  offerTokenId: string;
  considerationWei: string;
  /** ISO 8601; converted to unix seconds for Seaport internally. */
  expiresAt: string;
};

/** Builds and signs a fixed-price sell order. Never broadcasts anything on its own. */
export async function buildListing(accountAddress: string, input: ListInput) {
  const seaport = await getSeaport();
  const endTime = Math.floor(new Date(input.expiresAt).getTime() / 1000).toString();

  const { executeAllActions } = await seaport.createOrder(
    {
      offer: [
        {
          itemType: ItemType.ERC721,
          token: input.offerTokenAddress,
          identifier: input.offerTokenId,
        },
      ],
      consideration: [
        {
          amount: input.considerationWei,
          token: NATIVE_TOKEN_ADDRESS,
          recipient: accountAddress,
        },
      ],
      endTime,
    },
    accountAddress
  );

  return executeAllActions();
}

export type OfferInput = {
  offerWei: string;
  considerationTokenAddress: string;
  /** Omit for a collection-wide offer. */
  considerationTokenId?: string;
  expiresAt: string;
};

/**
 * Builds and signs an offer — item-level when a tokenId is given, collection-wide
 * otherwise. Collection-wide offers use Seaport's criteria-based item shape with
 * an empty `identifiers` array, which the protocol treats as "any token ID in
 * this collection" — the same mechanism OpenSea uses for collection offers.
 */
export async function buildOffer(accountAddress: string, input: OfferInput) {
  const seaport = await getSeaport();
  const endTime = Math.floor(new Date(input.expiresAt).getTime() / 1000).toString();

  const { executeAllActions } = await seaport.createOrder(
    {
      offer: [
        {
          amount: input.offerWei,
          token: NATIVE_TOKEN_ADDRESS,
        },
      ],
      consideration: [
        input.considerationTokenId
          ? {
              itemType: ItemType.ERC721,
              token: input.considerationTokenAddress,
              identifier: input.considerationTokenId,
              recipient: accountAddress,
            }
          : {
              itemType: ItemType.ERC721,
              token: input.considerationTokenAddress,
              identifiers: [],
              recipient: accountAddress,
            },
      ],
      endTime,
    },
    accountAddress
  );

  return executeAllActions();
}

/** Fulfills an existing signed order (buy a listing, or accept an offer). */
export async function fulfillOrder(
  order: Parameters<Seaport["fulfillOrder"]>[0]["order"],
  accountAddress: string
) {
  const seaport = await getSeaport();
  const { executeAllActions } = await seaport.fulfillOrder({
    order,
    accountAddress,
  });
  return executeAllActions();
}
