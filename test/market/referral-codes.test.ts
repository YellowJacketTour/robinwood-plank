import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";

import {
  generateReferralCode,
  isReferralCode,
  normalizeReferralCode,
} from "../../lib/referral-codes";
import { REFERRAL_PROOF_DOMAIN, verifyReferralProof } from "../../lib/referral-server";
import { walletProofMessage, walletProofPayloadHash, type WalletProof } from "../../lib/wallet-proof";

/**
 * Codes exist so an invite link stops publishing a wallet address. The
 * properties that matter: a code must not be derivable from the address it
 * points at, and the claim signature must cover the code the user actually
 * saw rather than the address it resolves to.
 *
 * Storage round-trips (getOrCreateReferralCode / resolveReferrer) need
 * Postgres and are exercised against a real database alongside the migration.
 */

test("codes avoid characters people misread when retyping", () => {
  // These get read off one screen and typed into another. O/0 and I/1 are the
  // pairs that come back wrong.
  const codes = Array.from({ length: 200 }, () => generateReferralCode());
  for (const code of codes) {
    assert.equal(code.length, 8);
    assert.ok(!/[ILOU01]/.test(code), `ambiguous character in ${code}`);
    assert.ok(/^[2-9A-HJ-NP-TV-Z]+$/.test(code), `unexpected character in ${code}`);
  }
});

test("codes are random, not derived from anything", () => {
  // A code derived from the address would be recoverable: every holder is
  // public chain data, so an attacker hashes a list of known wallets and
  // matches. Randomness is what makes a shared code carry no information.
  const codes = new Set(Array.from({ length: 500 }, () => generateReferralCode()));
  assert.ok(codes.size > 495, `expected near-unique codes, got ${codes.size}/500`);
});

test("code validation accepts what a user would paste", () => {
  const code = generateReferralCode();
  assert.equal(normalizeReferralCode(`  ${code.toLowerCase()}  `), code);
  assert.ok(isReferralCode(code.toLowerCase()));
  assert.ok(isReferralCode(` ${code} `));
});

test("code validation rejects near-misses rather than guessing", () => {
  for (const bad of ["", "SHORT", "TOOLONGCODE", "ABCDEFG!", "0x1234", "IIIIIIII", "OOOOOOOO"]) {
    assert.equal(isReferralCode(bad), false, `should reject ${bad}`);
  }
});

test("the claim signature covers the code, not the resolved address", async () => {
  // The browser never learns the referrer's address when a code is used, so
  // signing the address would mean authorising something resolved out of
  // sight. This pins the payload to the ref as seen.
  const victim = Wallet.createRandom();
  const code = generateReferralCode();
  const timestamp = Date.now();
  const payloadJson = JSON.stringify({ referred: victim.address.toLowerCase(), ref: code });
  const message = walletProofMessage(
    REFERRAL_PROOF_DOMAIN,
    "claim",
    timestamp,
    walletProofPayloadHash(payloadJson)
  );
  const proof: WalletProof = {
    address: victim.address,
    timestamp,
    signature: await victim.signMessage(message),
  };
  assert.equal(verifyReferralProof(victim.address, code, proof), true);

  // The same signature must not authorise a DIFFERENT invite.
  assert.equal(verifyReferralProof(victim.address, generateReferralCode(), proof), false);
  // …nor be usable by another wallet.
  const attacker = Wallet.createRandom();
  assert.equal(verifyReferralProof(attacker.address, code, proof), false);
});

test("pre-code address links still verify, so early invites keep working", async () => {
  // 010 shipped ?ref=0x... links. Rejecting them outright would break real
  // invites to protect a privacy property their sender already gave up.
  const victim = Wallet.createRandom();
  const referrer = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const timestamp = Date.now();
  const payloadJson = JSON.stringify({ referred: victim.address.toLowerCase(), ref: referrer });
  const message = walletProofMessage(
    REFERRAL_PROOF_DOMAIN,
    "claim",
    timestamp,
    walletProofPayloadHash(payloadJson)
  );
  const proof: WalletProof = {
    address: victim.address,
    timestamp,
    signature: await victim.signMessage(message),
  };
  assert.equal(verifyReferralProof(victim.address, referrer, proof), true);
});
