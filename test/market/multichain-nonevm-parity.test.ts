import assert from "node:assert/strict";
import test from "node:test";
import { sweepSolanaListingsNow, sweepSolanaListingsBatched, sweepBitcoinListingsNow, placeSolanaOfferNow } from "../../lib/market/multichain/trading/foreign-fulfill";
import { sendSolanaToken, sendSolanaTokenBatch } from "../../lib/market/multichain/trading/solana-transfer";
import { sendBitcoinInscription, sendBitcoinInscriptionBatch } from "../../lib/market/multichain/trading/bitcoin-transfer";

// These exercise the real, unmocked fail-closed guards for the new
// Solana/Bitcoin sweep/send/offer parity work -- same discipline as
// multichain-solana-bitcoin.test.ts's own header: properties that hold
// BEFORE any wallet/network call is ever reached, so no browser wallet or
// live network is needed to prove them real.

test("sweepSolanaListingsNow rejects an empty listing set before touching Phantom or the network", async () => {
  await assert.rejects(() => sweepSolanaListingsNow({ listings: [] }), /No listings to sweep/);
});

test("sweepSolanaListingsBatched rejects an empty listing set before touching Phantom or the network", async () => {
  await assert.rejects(() => sweepSolanaListingsBatched({ listings: [] }), /No listings to sweep/);
});

test("sweepBitcoinListingsNow rejects an empty listing set before touching UniSat or the network", async () => {
  await assert.rejects(() => sweepBitcoinListingsNow({ listings: [] }), /No listings to sweep/);
});

test("placeSolanaOfferNow fails closed with a clear Phantom-not-found error in a walletless (Node) environment, never silently no-ops", async () => {
  await assert.rejects(
    () => placeSolanaOfferNow({ tokenMint: "3KMHzE4AYcEwbp3isTT3cV5rycH7XH8MjHAWrTKosBcS", priceLamports: "1000000000" }),
    /Phantom wallet not found/
  );
});

test("sendSolanaToken rejects a garbage recipient address before touching Phantom or the network", async () => {
  await assert.rejects(
    () => sendSolanaToken("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "3KMHzE4AYcEwbp3isTT3cV5rycH7XH8MjHAWrTKosBcS", "not-a-real-address"),
    /valid Solana wallet address/
  );
});

test("sendSolanaToken rejects sending to your own address before touching Phantom or the network", async () => {
  const self = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  await assert.rejects(
    () => sendSolanaToken(self, "3KMHzE4AYcEwbp3isTT3cV5rycH7XH8MjHAWrTKosBcS", self),
    /same as your own wallet/
  );
});

test("sendSolanaTokenBatch rejects an empty recipient before touching any wallet", async () => {
  await assert.rejects(
    () => sendSolanaTokenBatch("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", ["mint1"], "  ", () => {}),
    /valid Solana wallet address/
  );
});

test("sendBitcoinInscription rejects an obviously-too-short recipient before touching UniSat or the network", async () => {
  await assert.rejects(
    () => sendBitcoinInscription("bc1qsomesenderaddress000000000000", "abc123i0", "short"),
    /valid Bitcoin wallet address/
  );
});

test("sendBitcoinInscription rejects sending to your own address before touching UniSat or the network", async () => {
  const self = "bc1qsomesenderaddress0000000000000000000000";
  await assert.rejects(() => sendBitcoinInscription(self, "abc123i0", self), /same as your own wallet/);
});

test("sendBitcoinInscriptionBatch rejects an empty recipient before touching any wallet", async () => {
  await assert.rejects(
    () => sendBitcoinInscriptionBatch("bc1qsomesenderaddress0000000000000000000000", ["abc123i0"], "  ", () => {}),
    /valid Bitcoin wallet address/
  );
});
