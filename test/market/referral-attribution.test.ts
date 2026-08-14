import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";

import {
  REFERRAL_PROOF_DOMAIN,
  verifyReferralProof,
} from "../../lib/referral-server";
import { REFERRAL_PROOF_DOMAIN as CLIENT_DOMAIN } from "../../lib/wallet-proof-client";
import { walletProofMessage, walletProofPayloadHash, type WalletProof } from "../../lib/wallet-proof";

/**
 * Attribution is PERMANENT: first claim wins, and the schema has no UPDATE
 * or DELETE path. That makes the proof the only thing standing between the
 * table and an attacker claiming the entire userbase from `curl` -- wallet
 * addresses are public chain data, and a wrong row can only be repaired by
 * hand-written SQL against production.
 *
 * These cover the pure verification layer. claimReferral's storage
 * behaviour needs Postgres and is exercised by the migration + live checks.
 */

const REFERRER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

async function proofFor(
  signer: Wallet,
  referred: string,
  referrer: string,
  opts?: { timestamp?: number }
): Promise<WalletProof> {
  const timestamp = opts?.timestamp ?? Date.now();
  // The signed payload names the REF as the user saw it (an opaque code, or
  // an address from a pre-code link) -- see lib/referral-codes.ts.
  const payloadJson = JSON.stringify({ referred: referred.toLowerCase(), ref: referrer });
  const message = walletProofMessage(
    REFERRAL_PROOF_DOMAIN,
    "claim",
    timestamp,
    walletProofPayloadHash(payloadJson)
  );
  return { address: signer.address, timestamp, signature: await signer.signMessage(message) };
}

test("a real signature from the referred wallet verifies", async () => {
  const victim = Wallet.createRandom();
  const proof = await proofFor(victim as unknown as Wallet, victim.address, REFERRER);
  assert.equal(verifyReferralProof(victim.address, REFERRER, proof), true);
});

test("nobody can claim a wallet they do not control", async () => {
  // THE land-grab. Before the proof requirement, both addresses were plain
  // strings in a POST body, so this exact call succeeded and permanently
  // locked the real referrer out.
  const attacker = Wallet.createRandom();
  const victim = Wallet.createRandom();
  const proof = await proofFor(attacker as unknown as Wallet, attacker.address, REFERRER);
  // Attacker signs for their OWN wallet but submits the victim's address.
  assert.equal(verifyReferralProof(victim.address, REFERRER, proof), false);
});

test("a proof cannot be moved to a different referrer", async () => {
  // The referrer is inside the signed payload, so a captured proof cannot be
  // replayed to credit someone else -- which would otherwise let anyone who
  // saw one legitimate claim steal that attribution.
  const victim = Wallet.createRandom();
  const proof = await proofFor(victim as unknown as Wallet, victim.address, REFERRER);
  assert.equal(
    verifyReferralProof(victim.address, "0x1234567890123456789012345678901234567890", proof),
    false
  );
});

test("a proof from another feature's domain is rejected", async () => {
  // Domain separation: a signature collected for plank-checks or a badge
  // claim must never authorise a permanent referral attribution.
  const victim = Wallet.createRandom();
  const timestamp = Date.now();
  const payloadJson = JSON.stringify({ referred: victim.address.toLowerCase(), ref: REFERRER });
  const message = walletProofMessage(
    "plank-checks",
    "claim",
    timestamp,
    walletProofPayloadHash(payloadJson)
  );
  const proof: WalletProof = {
    address: victim.address,
    timestamp,
    signature: await victim.signMessage(message),
  };
  assert.equal(verifyReferralProof(victim.address, REFERRER, proof), false);
});

test("a stale proof is rejected", async () => {
  const victim = Wallet.createRandom();
  const old = Date.now() - 60 * 60 * 1000;
  const proof = await proofFor(victim as unknown as Wallet, victim.address, REFERRER, {
    timestamp: old,
  });
  assert.equal(verifyReferralProof(victim.address, REFERRER, proof), false);
});

test("malformed proofs fail closed rather than throwing", async () => {
  const victim = Wallet.createRandom();
  for (const proof of [
    { address: victim.address, timestamp: Date.now(), signature: "0xnotasignature" },
    { address: victim.address, timestamp: Date.now(), signature: "" },
    { address: "not-an-address", timestamp: Date.now(), signature: "0x" },
  ] as WalletProof[]) {
    assert.equal(verifyReferralProof(victim.address, REFERRER, proof), false);
  }
  assert.equal(verifyReferralProof("not-an-address", REFERRER, {} as WalletProof), false);
});

test("the client and server referral domains stay in sync", () => {
  // The client cannot import lib/referral-server.ts (it reaches `pg`), so
  // the domain string is duplicated. If these drift, every real claim fails
  // verification and the feature silently stops working.
  assert.equal(CLIENT_DOMAIN, REFERRAL_PROOF_DOMAIN);
});
