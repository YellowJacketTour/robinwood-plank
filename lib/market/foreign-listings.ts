import type { ListingVenue } from "@/lib/market/types";

/**
 * A listing held by a marketplace other than ours, reduced to the only fields
 * the book actually needs.
 *
 * Lives in its own module rather than in opensea.ts or pulp.ts because it is
 * the contract BETWEEN them and lib/market/book.ts. Putting it in one venue's
 * file would make every other venue import that venue, which is how
 * `mergeBook(ours, theirs: NormalisedOpenSeaListing[])` ended up typed to a
 * single marketplace in the first place.
 *
 * Deliberately carries NO fulfilment material — no signature, no raw order.
 * Foreign rows link out (see isForeignListing in ./types.ts), and holding the
 * material to fill them would imply a capability we have decided not to build.
 * test/market/book-merge.test.ts asserts its absence.
 */
export type NormalisedForeignListing = {
  tokenId: string;
  priceWei: string;
  /** Seller. Whatever the venue reports as the order's owner/offerer. */
  maker: string;
  /** ISO-8601, or null when the venue publishes no end time. */
  expiresAt: string | null;
  /** Which marketplace this came from — drives the badge and the link out. */
  venue: ListingVenue;
};
