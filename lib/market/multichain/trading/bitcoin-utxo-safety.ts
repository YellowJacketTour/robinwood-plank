/**
 * Bitcoin UTXO safety gate -- the hard invariant any FUTURE code that
 * constructs a raw PSBT for BITCOIN_FEE_RECIPIENT (lib/constants.ts) or any
 * other Marketplank-controlled Bitcoin address must go through before
 * selecting a UTXO to spend. Built 2026-08-19 in response to a direct
 * requirement: this treasury address must never let an inscription, a
 * Rune, or a rare/exotic satoshi be accidentally spent as plain "change" --
 * the single sharpest, most-documented footgun in Bitcoin UTXO management
 * (an inscription/Rune is tied to a SPECIFIC satoshi/UTXO, not tracked by
 * an address-keyed balance the way an SPL token or ERC-721 is; naive
 * coin-selection that just picks "enough sats" can burn one).
 *
 * NO CALLER EXISTS YET, AND THAT IS DELIBERATE, NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 * Every OTHER Bitcoin-touching module in this app (unisat-ordinals-trade.ts,
 * bitcoin-transfer.ts, non-evm-wallet.ts) already avoids this risk entirely
 * by NEVER selecting UTXOs itself -- it only relays PSBTs UniSat's own API
 * builds, or calls UniSat's own sendInscription (their wallet does the
 * selection internally). Today, BITCOIN_FEE_RECIPIENT is a pure receive
 * address with no code path that ever spends FROM it. This module exists so
 * that invariant survives the day one DOES exist -- a Marketplank-native
 * PSBT listing engine (the recommended path once UniSat's affiliate-fee gap
 * is confirmed to have no field, per BITCOIN_FEE_RECIPIENT's own comment),
 * or any future treasury-consolidation tooling -- rather than being
 * re-derived (or forgotten) under deadline pressure later.
 *
 * THE MECHANISM: DEFER TO UNISAT'S OWN PURPOSE-BUILT SAFE-LIST, THEN
 * INDEPENDENTLY DOUBLE-CHECK EACH RESULT
 * ---------------------------------------------------------------------------
 * Real, documented UniSat Indexer endpoints (github.com/unisat-wallet/
 * unisat-dev-docs, fetched live 2026-08-19 -- NOT yet exercised against a
 * real API key, same honest boundary every other adapter in this app draws
 * between "documented" and "proven end-to-end"):
 *
 *   GET /v1/indexer/address/{address}/available-utxo-data
 *     UniSat's OWN maintained safe-list: "UTXOs safe for BTC spending
 *     (excludes inscriptions, runes, alkanes)". This is the primary
 *     source -- reusing UniSat's own indexer, not reimplementing inscription/
 *     rune detection independently, the same "don't duplicate proven
 *     infrastructure" discipline this app's EVM indexer already follows
 *     (see seaport-fill-indexer.ts's own header on reusing chain-indexer.ts).
 *
 *   GET /v1/indexer/utxo/{txid}/{index}
 *     Independent per-UTXO double-check: returns inscriptionsCount and an
 *     inscriptions array. A UTXO only passes if this ALSO reports zero.
 *
 *   GET /v1/indexer/runes/utxo/{txid}/{index}/balance
 *     Independent per-UTXO double-check: returns a `data` array of Rune
 *     balances on that exact UTXO. A UTXO only passes if this is empty.
 *
 * A UTXO is spendable ONLY if it appears in the primary safe-list AND both
 * independent checks agree it carries nothing. This is deliberately
 * redundant (belt-and-suspenders), same posture as this session's M2 fix:
 * FAILS CLOSED. Any request error, malformed response, or disagreement
 * between sources excludes the UTXO rather than risking it -- an
 * over-cautious false exclusion costs nothing but a slightly smaller
 * spendable set; a false inclusion could burn a real, valuable asset. There
 * is no "assume safe on error" branch anywhere in this module.
 *
 * NETWORK-AWARE BASE URL, LIVE-VERIFIED 2026-08-19 -- ONE REAL DOCS BUG
 * FOUND ALONG THE WAY
 * ---------------------------------------------------------------------------
 * UniSat's own docs (docs.unisat.io/developer-support/open-api-documentation)
 * state the testnet base is `open-api-testnet.unisat.io` -- confirmed LIVE
 * that this is wrong for a Testnet4-scoped key: it returned
 * `{"code":-2003,"msg":"quota unavailable"}` even with a real Bearer token,
 * and separately responds successfully with NO auth at all serving
 * Testnet3 data (chain height ~5.12M, a different, older network).
 * The real, working Testnet4 base -- confirmed live, `{"code":0,...,
 * "chain":"test","blocks":149163}` matching Testnet4's actual height, and
 * DIFFERENT results with vs. without the Bearer key -- is
 * `open-api-testnet4.unisat.io`, found via the UniSat Developer Center's
 * own dashboard (Bitcoin > Testnet4), not their docs prose.
 *
 * Reads the SAME env var native-bitcoin-listing.ts's own bitcoinNetwork()
 * does (NATIVE_BITCOIN_MAINNET_ENABLED), duplicated locally rather than
 * imported from there -- that module imports filterProvenSafeUtxos FROM
 * this one, so importing bitcoinNetwork back would create a circular
 * module dependency. A few lines of duplication is the safer trade
 * against an ESM circular-import load-order bug.
 */
function isMainnetActive(): boolean {
  return process.env.NATIVE_BITCOIN_MAINNET_ENABLED === "true";
}

function indexerBase(): string {
  return isMainnetActive() ? "https://open-api.unisat.io" : "https://open-api-testnet4.unisat.io";
}

function requireApiKey(): string {
  const isMainnet = isMainnetActive();
  const key = isMainnet ? process.env.UNISAT_API_KEY : (process.env.UNISAT_TESTNET_API_KEY ?? process.env.UNISAT_API_KEY);
  if (!key) {
    const envVar = isMainnet ? "UNISAT_API_KEY" : "UNISAT_TESTNET_API_KEY";
    throw new Error(
      `bitcoin-utxo-safety: ${envVar} is not configured -- UniSat's Indexer API requires a real Bearer token, and mainnet/testnet4 keys are separate (see the UniSat Developer Center dashboard's own Bitcoin > Mainnet/Testnet4 split). Sign up at docs.unisat.io/developer-support/how-to-acquire-a-unisat-api-key before this path can be used.`
    );
  }
  return key;
}

async function indexerGet<T>(path: string): Promise<T> {
  const key = requireApiKey();
  const res = await fetch(`${indexerBase()}${path}`, {
    headers: { accept: "application/json", authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`bitcoin-utxo-safety: ${res.status} ${res.statusText} on ${path}`);
  }
  return (await res.json()) as T;
}

export type BitcoinUtxoRef = { txid: string; vout: number };

type AvailableUtxoResponse = {
  data?: { utxo?: Array<{ txid: string; vout: number; satoshi: number }> };
};

type UtxoDetailResponse = {
  data?: { inscriptionsCount?: number };
};

type RunesUtxoBalanceResponse = {
  data?: unknown[];
};

/**
 * The primary safe-list for one address, straight from UniSat's own
 * "available-utxo-data" endpoint. Use filterProvenSafeUtxos (below) for
 * the actual gating decision on any specific UTXO -- this alone is a
 * single source, not the full belt-and-suspenders check.
 */
export async function fetchUnisatAvailableUtxos(address: string): Promise<BitcoinUtxoRef[]> {
  const res = await indexerGet<AvailableUtxoResponse>(
    `/v1/indexer/address/${encodeURIComponent(address)}/available-utxo-data`
  );
  const list = res.data?.utxo ?? [];
  return list.map((u) => ({ txid: u.txid, vout: u.vout }));
}

/**
 * Independent double-check for exactly one UTXO: true only if BOTH the
 * inscription-count check and the Runes-balance check independently agree
 * it carries nothing. Any fetch failure returns false (fail closed) --
 * callers must never treat a thrown/rejected check as "assume safe."
 */
async function isIndependentlyClean(ref: BitcoinUtxoRef): Promise<boolean> {
  try {
    const [inscriptionDetail, runesBalance] = await Promise.all([
      indexerGet<UtxoDetailResponse>(`/v1/indexer/utxo/${ref.txid}/${ref.vout}`),
      indexerGet<RunesUtxoBalanceResponse>(`/v1/indexer/runes/utxo/${ref.txid}/${ref.vout}/balance`),
    ]);
    const inscriptionsCount = inscriptionDetail.data?.inscriptionsCount ?? -1;
    const runesCount = runesBalance.data?.length ?? -1;
    // -1 sentinel: a malformed/missing field is NOT the same as a
    // confirmed zero -- treat it as unproven, not clean.
    return inscriptionsCount === 0 && runesCount === 0;
  } catch {
    return false;
  }
}

/**
 * THE gate every future PSBT-constructing caller must use. Returns only
 * the subset of `candidates` that (a) UniSat's own available-utxo-data
 * safe-list includes for `address`, AND (b) an independent per-UTXO
 * double-check confirms carries zero inscriptions and zero Runes.
 *
 * Never returns a UTXO on partial/ambiguous data -- see this module's own
 * header on why fail-closed is the only acceptable default here.
 */
export async function filterProvenSafeUtxos(
  address: string,
  candidates: BitcoinUtxoRef[]
): Promise<BitcoinUtxoRef[]> {
  if (candidates.length === 0) return [];
  const safeList = await fetchUnisatAvailableUtxos(address);
  const safeSet = new Set(safeList.map((u) => `${u.txid}:${u.vout}`));
  const inPrimaryList = candidates.filter((c) => safeSet.has(`${c.txid}:${c.vout}`));
  const checks = await Promise.all(inPrimaryList.map((ref) => isIndependentlyClean(ref)));
  return inPrimaryList.filter((_, i) => checks[i]);
}
