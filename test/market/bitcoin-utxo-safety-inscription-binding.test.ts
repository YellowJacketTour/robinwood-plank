import assert from "node:assert/strict";
import test from "node:test";

/**
 * getInscriptionIdsOnUtxo is the CRITICAL fix from this session's Opus
 * security audit: the real listing-time/fulfillment-time binding check
 * (native-bitcoin-listings/route.ts POST, and native-bitcoin-listing/[id]/
 * fulfill/route.ts) that closes a previously-real, working fraud
 * primitive (a seller listing a worthless UTXO under a claimed blue-chip
 * inscription id, which a buyer's fully-valid transaction would have paid
 * real money for, irreversibly). Every branch here is fail-closed by
 * design -- pins that discipline directly, since a regression here isn't
 * a display bug, it's a fund-safety regression.
 */

function withEnv() {
  process.env.NATIVE_BITCOIN_MAINNET_ENABLED = "false";
  process.env.UNISAT_TESTNET_API_KEY = "test-key";
}

function mockFetch(response: unknown, ok = true) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
    json: async () => response,
  })) as any;
}

test("getInscriptionIdsOnUtxo returns the real inscription ids when the indexer reports them cleanly", async () => {
  withEnv();
  mockFetch({ code: 0, data: { inscriptionsCount: 1, inscriptions: [{ inscriptionId: "abc123i0" }] } });
  const { getInscriptionIdsOnUtxo } = await import("../../lib/market/multichain/trading/bitcoin-utxo-safety");
  const result = await getInscriptionIdsOnUtxo({ txid: "deadbeef", vout: 0 });
  assert.deepEqual(result, ["abc123i0"]);
});

test("getInscriptionIdsOnUtxo returns an empty array for a genuinely inscription-free UTXO", async () => {
  withEnv();
  mockFetch({ code: 0, data: { inscriptionsCount: 0, inscriptions: [] } });
  const { getInscriptionIdsOnUtxo } = await import("../../lib/market/multichain/trading/bitcoin-utxo-safety");
  const result = await getInscriptionIdsOnUtxo({ txid: "deadbeef", vout: 0 });
  assert.deepEqual(result, []);
});

test("getInscriptionIdsOnUtxo fails closed (null) on a network/HTTP error -- never treated as 'no inscriptions'", async () => {
  withEnv();
  mockFetch({ code: -1, msg: "server error" }, false);
  const { getInscriptionIdsOnUtxo } = await import("../../lib/market/multichain/trading/bitcoin-utxo-safety");
  const result = await getInscriptionIdsOnUtxo({ txid: "deadbeef", vout: 0 });
  assert.equal(result, null);
});

test("getInscriptionIdsOnUtxo fails closed (null) on a malformed response body", async () => {
  withEnv();
  mockFetch({ code: 0, data: {} });
  const { getInscriptionIdsOnUtxo } = await import("../../lib/market/multichain/trading/bitcoin-utxo-safety");
  const result = await getInscriptionIdsOnUtxo({ txid: "deadbeef", vout: 0 });
  assert.equal(result, null);
});

test("getInscriptionIdsOnUtxo fails closed (null) when inscriptionsCount claims > 0 but the array is empty -- malformed, not 'clean'", async () => {
  withEnv();
  mockFetch({ code: 0, data: { inscriptionsCount: 2, inscriptions: [] } });
  const { getInscriptionIdsOnUtxo } = await import("../../lib/market/multichain/trading/bitcoin-utxo-safety");
  const result = await getInscriptionIdsOnUtxo({ txid: "deadbeef", vout: 0 });
  assert.equal(result, null);
});

test("getInscriptionIdsOnUtxo fails closed (null) when the API key is entirely unset", async () => {
  process.env.NATIVE_BITCOIN_MAINNET_ENABLED = "false";
  delete process.env.UNISAT_TESTNET_API_KEY;
  delete process.env.UNISAT_API_KEY;
  const { getInscriptionIdsOnUtxo } = await import("../../lib/market/multichain/trading/bitcoin-utxo-safety");
  const result = await getInscriptionIdsOnUtxo({ txid: "deadbeef", vout: 0 });
  assert.equal(result, null);
});
