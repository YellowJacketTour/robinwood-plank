import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import {
  verifyWalletProof,
  walletProofMessage,
  walletProofPayloadHash,
  WALLET_PROOF_WINDOW_MS,
} from "../../lib/wallet-proof";

/**
 * Same contract as lib/admin-auth.ts's verifyAdminProof, generalized to any
 * wallet (see that file's own tests in woodamp-playlist.test.ts for the
 * sibling coverage) — a signature authorizes exactly one domain + action +
 * payload + freshness window, and every failure path rejects rather than
 * degrading to "probably fine."
 */

const alice = new Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const bob = new Wallet(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
);

async function signedProof(
  wallet: Wallet,
  domain: string,
  action: string,
  payloadJson: string,
  timestamp: number
) {
  return {
    address: wallet.address,
    timestamp,
    signature: await wallet.signMessage(
      walletProofMessage(domain, action, timestamp, walletProofPayloadHash(payloadJson))
    ),
  };
}

test("a genuine signature over the exact domain, action, and payload verifies", async () => {
  const now = Date.now();
  const payload = JSON.stringify({ wallet: alice.address });
  const proof = await signedProof(alice, "plank-checks", "link-wallet", payload, now);
  const verdict = verifyWalletProof("plank-checks", "link-wallet", payload, proof, { now });
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.address, alice.address.toLowerCase());
});

test("payload substitution after signing rejects", async () => {
  const now = Date.now();
  const payload = JSON.stringify({ wallet: alice.address });
  const proof = await signedProof(alice, "plank-checks", "link-wallet", payload, now);
  const tampered = JSON.stringify({ wallet: bob.address });
  const verdict = verifyWalletProof("plank-checks", "link-wallet", tampered, proof, { now });
  assert.equal(verdict.ok, false);
});

test("a signature for one domain does not authorize another", async () => {
  const now = Date.now();
  const payload = JSON.stringify({ wallet: alice.address });
  const proof = await signedProof(alice, "plank-checks", "link-wallet", payload, now);
  const verdict = verifyWalletProof("admin", "link-wallet", payload, proof, { now });
  assert.equal(verdict.ok, false);
});

test("a signature for one action does not authorize another", async () => {
  const now = Date.now();
  const payload = JSON.stringify({ wallet: alice.address });
  const proof = await signedProof(alice, "plank-checks", "link-wallet", payload, now);
  const verdict = verifyWalletProof("plank-checks", "claim-points", payload, proof, { now });
  assert.equal(verdict.ok, false);
});

test("stale timestamps reject", async () => {
  const now = Date.now();
  const payload = JSON.stringify({ wallet: alice.address });
  const stale = await signedProof(
    alice,
    "plank-checks",
    "link-wallet",
    payload,
    now - WALLET_PROOF_WINDOW_MS - 1
  );
  const verdict = verifyWalletProof("plank-checks", "link-wallet", payload, stale, { now });
  assert.equal(verdict.ok, false);
});

test("future-dated timestamps reject", async () => {
  const now = Date.now();
  const payload = JSON.stringify({ wallet: alice.address });
  const future = await signedProof(
    alice,
    "plank-checks",
    "link-wallet",
    payload,
    now + WALLET_PROOF_WINDOW_MS + 1
  );
  const verdict = verifyWalletProof("plank-checks", "link-wallet", payload, future, { now });
  assert.equal(verdict.ok, false);
});

test("a claimed address that does not match the recovered signer rejects", async () => {
  const now = Date.now();
  const payload = JSON.stringify({ wallet: alice.address });
  const proof = await signedProof(alice, "plank-checks", "link-wallet", payload, now);
  const verdict = verifyWalletProof(
    "plank-checks",
    "link-wallet",
    payload,
    { ...proof, address: bob.address },
    { now }
  );
  assert.equal(verdict.ok, false);
});

test("garbage signatures fail closed", () => {
  const now = Date.now();
  const payload = JSON.stringify({ wallet: alice.address });
  const verdict = verifyWalletProof(
    "plank-checks",
    "link-wallet",
    payload,
    { address: alice.address, timestamp: now, signature: "0xnotasignature" },
    { now }
  );
  assert.equal(verdict.ok, false);
});
