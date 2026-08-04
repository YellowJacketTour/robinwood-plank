import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { BADGE_TYPES, verifyBadgeClaimProof, WALLET_PROOF_DOMAIN } from "../../lib/social-badges";
import { walletProofMessage, walletProofPayloadHash } from "../../lib/wallet-proof";

const alice = new Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const bob = new Wallet(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
);

async function signedClaim(wallet: Wallet, badgeType: string, timestamp: number) {
  const payload = JSON.stringify({ wallet: wallet.address.toLowerCase(), badgeType });
  return {
    address: wallet.address,
    timestamp,
    signature: await wallet.signMessage(
      walletProofMessage(WALLET_PROOF_DOMAIN, "claim-badge", timestamp, walletProofPayloadHash(payload))
    ),
  };
}

test("verifyBadgeClaimProof accepts a genuine self-signed badge claim", async () => {
  const now = Date.now();
  const proof = await signedClaim(alice, "verified_collector", now);
  assert.equal(verifyBadgeClaimProof(alice.address, "verified_collector", proof, now), true);
});

test("verifyBadgeClaimProof rejects a claim signed for a different badge type", async () => {
  const now = Date.now();
  const proof = await signedClaim(alice, "verified_collector", now);
  assert.equal(verifyBadgeClaimProof(alice.address, "verified_lp", proof, now), false);
});

test("verifyBadgeClaimProof rejects one wallet claiming a badge for a different wallet", async () => {
  const now = Date.now();
  const proof = await signedClaim(alice, "verified_collector", now);
  assert.equal(verifyBadgeClaimProof(bob.address, "verified_collector", proof, now), false);
});

test("verifyBadgeClaimProof rejects an unknown badge type even with a well-formed signature shape", () => {
  const now = Date.now();
  assert.equal(
    verifyBadgeClaimProof(
      alice.address,
      // @ts-expect-error deliberately invalid badge type
      "verified_whale",
      { address: alice.address, timestamp: now, signature: "0x00" },
      now
    ),
    false
  );
});

test("BADGE_TYPES exposes exactly the two documented badges", () => {
  assert.deepEqual([...BADGE_TYPES].sort(), ["verified_collector", "verified_lp"]);
});
