import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import {
  ADDITIONAL_WALLET_FEE_WEI,
  depositPoints,
  lpHoldPoints,
  memePoints,
  POINT_WEIGHTS,
  redeemPoints,
  referralPoints,
  salePoints,
  swapPoints,
  UNATTRIBUTED_SALE_MULTIPLIER,
  verifyWalletLinkProof,
  volumeBountyPoints,
  WALLET_PROOF_DOMAIN,
} from "../../lib/plank-checks";
import { walletProofMessage, walletProofPayloadHash } from "../../lib/wallet-proof";

const ONE_ETH = BigInt("1000000000000000000");
const alice = new Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const bob = new Wallet(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
);

// --- pure scoring formulas ------------------------------------------------

test("swapPoints scales linearly with fee paid, zero fee earns zero", () => {
  assert.equal(swapPoints(BigInt(0)), 0);
  assert.equal(swapPoints(ONE_ETH), Number(POINT_WEIGHTS.swap));
  assert.equal(swapPoints(ONE_ETH * BigInt(2)), Number(POINT_WEIGHTS.swap) * 2);
});

test("depositPoints scales with the deposited item's floor value", () => {
  assert.equal(depositPoints(ONE_ETH), Number(POINT_WEIGHTS.deposit));
});

test("redeemPoints scores the fee paid, not any notion of value extracted", () => {
  // A tiny redeem fee on an expensive plank still earns the fee-based rate —
  // the function only ever receives the fee, so there is no way to smuggle
  // extracted value into this score even by mistake.
  const tinyFee = BigInt("1000000000000000"); // 0.001 ETH
  assert.equal(redeemPoints(tinyFee), Math.floor(0.001 * Number(POINT_WEIGHTS.redeem)));
});

test("salePoints rewards Marketplank-attributed fills at the full rate, others reduced", () => {
  const attributed = salePoints(ONE_ETH, true);
  const unattributed = salePoints(ONE_ETH, false);
  assert.equal(attributed, Number(POINT_WEIGHTS.sale));
  assert.equal(unattributed, Math.floor(Number(POINT_WEIGHTS.sale) * UNATTRIBUTED_SALE_MULTIPLIER));
  assert.ok(unattributed < attributed);
});

test("referralPoints matches swapPoints exactly at the same fee — a referred swap earns the same rate a direct one would, not a fraction of it", () => {
  const fee = BigInt("50000000000000000"); // 0.05 ETH
  assert.equal(referralPoints(fee), swapPoints(fee));
});

test("volumeBountyPoints scales with the brought-in collection's ongoing fee revenue", () => {
  assert.equal(volumeBountyPoints(BigInt(0)), 0);
  assert.ok(volumeBountyPoints(ONE_ETH) > 0);
});

test("lpHoldPoints is zero for a zero-value or zero-duration position — never a flat reward for merely depositing", () => {
  assert.equal(lpHoldPoints(BigInt(0), 100), 0);
  assert.equal(lpHoldPoints(ONE_ETH, 0), 0);
});

test("lpHoldPoints scales with BOTH value and duration — twice the hours held earns twice the points at the same value", () => {
  const oneHour = lpHoldPoints(ONE_ETH, 1);
  const twoHours = lpHoldPoints(ONE_ETH, 2);
  assert.ok(oneHour > 0);
  assert.equal(twoHours, oneHour * 2);
});

test("lpHoldPoints for a brief flash deposit-then-withdraw (near-zero hours) earns near-zero points regardless of size", () => {
  const flashFarmed = lpHoldPoints(ONE_ETH * BigInt(1000), 0.001);
  const genuineSmallHold = lpHoldPoints(ONE_ETH, 100);
  // A huge flash deposit should not out-earn a modest but genuinely-held one —
  // this is the whole point of time-weighting instead of a flat per-deposit score.
  assert.ok(flashFarmed < genuineSmallHold);
});

test("memePoints is clamped to the [0,1] originality multiplier range regardless of bad input", () => {
  assert.equal(memePoints(1), Number(POINT_WEIGHTS.meme));
  assert.equal(memePoints(0), 0);
  assert.equal(memePoints(-5), 0);
  assert.equal(memePoints(5), Number(POINT_WEIGHTS.meme));
});

test("memePoints rewards a first-to-archive submission more than a lower-originality repost", () => {
  assert.ok(memePoints(1.0) > memePoints(0.2));
});

// --- wallet-link proof verification --------------------------------------

async function signedLinkProof(wallet: Wallet, profileId: number, linkedWallet: string, timestamp: number) {
  const payload = JSON.stringify({ profileId, wallet: linkedWallet.toLowerCase() });
  return {
    proof: {
      address: wallet.address,
      timestamp,
      signature: await wallet.signMessage(
        walletProofMessage(WALLET_PROOF_DOMAIN, "link-wallet", timestamp, walletProofPayloadHash(payload))
      ),
    },
    payload,
  };
}

test("verifyWalletLinkProof accepts a genuine self-signed link request", async () => {
  const now = Date.now();
  const { proof, payload } = await signedLinkProof(alice, 1, alice.address, now);
  assert.equal(verifyWalletLinkProof(alice.address, proof, payload, now), true);
});

test("verifyWalletLinkProof rejects one wallet signing to link a DIFFERENT wallet — you can only prove control of your own address", async () => {
  const now = Date.now();
  // Alice signs a payload claiming to link Bob's wallet — the signature
  // recovers to Alice, not Bob, so this must reject.
  const payload = JSON.stringify({ profileId: 1, wallet: bob.address.toLowerCase() });
  const proof = {
    address: alice.address,
    timestamp: now,
    signature: await alice.signMessage(
      walletProofMessage(WALLET_PROOF_DOMAIN, "link-wallet", now, walletProofPayloadHash(payload))
    ),
  };
  assert.equal(verifyWalletLinkProof(bob.address, proof, payload, now), false);
});

test("verifyWalletLinkProof rejects a malformed wallet address", async () => {
  const now = Date.now();
  const { proof, payload } = await signedLinkProof(alice, 1, alice.address, now);
  assert.equal(verifyWalletLinkProof("not-an-address", proof, payload, now), false);
});

// --- constants sanity -----------------------------------------------------

test("ADDITIONAL_WALLET_FEE_WEI is exactly 0.01 ETH", () => {
  assert.equal(ADDITIONAL_WALLET_FEE_WEI, BigInt("10000000000000000"));
});
