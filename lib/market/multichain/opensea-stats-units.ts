/**
 * Units of OpenSea's v2 collection stats, read as OpenSea states them.
 *
 * OpenSea's docs: `total.floor_price` is "denominated in the currency named
 * by floor_price_symbol"; each interval's `volume` carries `volume_symbol`,
 * which "can differ". Measured 2026-09-14 for slug `beezie-base`:
 * floor_price 25.0 with floor_price_symbol "USDC"; one_day volume 5.93 with
 * volume_symbol "ETH". Before this file the stats hydrator labelled every
 * floor with the chain's native symbol, so Beezie's 25 USDC floor was
 * stored as 25 ETH and shown at $62.7K.
 */

/** The floor's currency IS the symbol OpenSea names. The chain's native
 * symbol is the honest default only when OpenSea omits it. */
export function openSeaFloorCurrency(floorPriceSymbol: string | undefined | null, nativeSymbol: string): string {
  const symbol = floorPriceSymbol?.trim().toUpperCase();
  return symbol && /^[A-Z0-9]{2,12}$/.test(symbol) ? symbol : nativeSymbol;
}

/** volume_*_wei columns are the chain's native unit by contract. An interval
 * volume is storable only when OpenSea says it is in the native symbol (or
 * its wrapped form, or names no symbol -- the documented default). Any other
 * symbol is a hole, never a mislabelled number. */
export function openSeaVolumeWei(
  interval: { volume?: number; volume_symbol?: string } | undefined,
  nativeSymbol: string,
  toWei: (v: number | undefined) => string | null,
): string | null {
  const symbol = interval?.volume_symbol?.trim().toUpperCase();
  const native = nativeSymbol.toUpperCase();
  if (symbol && symbol !== native && symbol !== `W${native}`) return null;
  return toWei(interval?.volume);
}
