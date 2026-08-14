import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";

import { walletProofMessage, walletProofPayloadHash, type WalletProof } from "../../lib/wallet-proof";
import { verifyWalletProof } from "../../lib/wallet-proof";

/**
 * /api/portfolio used to return the full accounting view — cost basis,
 * realized PnL, fee drag, unrealized PnL — for ANY address, to anyone.
 * Looking up another wallet is a deliberate feature, so the route was not
 * gated wholesale; instead the line is drawn at provenance:
 *
 *   PUBLIC     what the chain already answers (shares, NAV, shares x NAV)
 *   OWNER ONLY what we computed (cost attribution and every PnL from it)
 *
 * These cover the proof layer that decides which side a caller lands on.
 * The route's field split is asserted by reading the route source, since
 * exercising the handler needs Postgres.
 */

const PORTFOLIO_PROOF_DOMAIN = "portfolio-read";

async function proofFor(signer: Wallet, wallet: string, opts?: { timestamp?: number }): Promise<WalletProof> {
  const timestamp = opts?.timestamp ?? Date.now();
  const payloadJson = JSON.stringify({ wallet: wallet.toLowerCase() });
  const message = walletProofMessage(
    PORTFOLIO_PROOF_DOMAIN,
    "read",
    timestamp,
    walletProofPayloadHash(payloadJson)
  );
  return { address: signer.address, timestamp, signature: await signer.signMessage(message) };
}

function verify(wallet: string, proof: WalletProof): boolean {
  const address = wallet.toLowerCase();
  const verdict = verifyWalletProof(
    PORTFOLIO_PROOF_DOMAIN,
    "read",
    JSON.stringify({ wallet: address }),
    proof
  );
  return verdict.ok && verdict.address === address;
}

test("an owner proves their own wallet and sees the accounting view", async () => {
  const owner = Wallet.createRandom();
  assert.equal(verify(owner.address, await proofFor(owner as unknown as Wallet, owner.address)), true);
});

test("nobody can read another wallet's cost basis by signing their own", async () => {
  // The whole point. An attacker holds a valid signature — for THEIR wallet —
  // and points it at someone else's address.
  const attacker = Wallet.createRandom();
  const victim = Wallet.createRandom();
  const proof = await proofFor(attacker as unknown as Wallet, attacker.address);
  assert.equal(verify(victim.address, proof), false);
});

test("a proof for one wallet cannot be retargeted at another", async () => {
  // The wallet is inside the signed payload, so a captured proof is bound to
  // the address it was issued for.
  const owner = Wallet.createRandom();
  const other = Wallet.createRandom();
  const proof = await proofFor(owner as unknown as Wallet, owner.address);
  assert.equal(verify(other.address, proof), false);
});

test("a proof from another feature's domain does not unlock a portfolio", async () => {
  // Domain separation: a referral claim signature must never double as
  // authorisation to read someone's positions.
  const owner = Wallet.createRandom();
  const timestamp = Date.now();
  const payloadJson = JSON.stringify({ wallet: owner.address.toLowerCase() });
  const message = walletProofMessage(
    "plank-referral",
    "read",
    timestamp,
    walletProofPayloadHash(payloadJson)
  );
  const proof: WalletProof = {
    address: owner.address,
    timestamp,
    signature: await owner.signMessage(message),
  };
  assert.equal(verify(owner.address, proof), false);
});

test("a stale proof is rejected", async () => {
  const owner = Wallet.createRandom();
  const proof = await proofFor(owner as unknown as Wallet, owner.address, {
    timestamp: Date.now() - 60 * 60 * 1000,
  });
  assert.equal(verify(owner.address, proof), false);
});

test("malformed proofs fail closed", async () => {
  const owner = Wallet.createRandom();
  for (const proof of [
    { address: owner.address, timestamp: Date.now(), signature: "0xgarbage" },
    { address: owner.address, timestamp: Date.now(), signature: "" },
  ] as WalletProof[]) {
    assert.equal(verify(owner.address, proof), false);
  }
});

test("the route keeps cost basis and PnL behind the owner check", async () => {
  // Guards the split itself: if someone moves one of these fields back into
  // the always-returned summary, this fails rather than quietly re-exposing
  // a stranger's book.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../app/api/portfolio/route.ts", import.meta.url),
    "utf8"
  );
  const summaryBlock = source.slice(
    source.indexOf("const summary = {"),
    source.indexOf("if (!owner) return summary;")
  );
  for (const ownerOnly of [
    "costBasisWei",
    "avgCostPerShareWei",
    "realizedPnlWei",
    "realizedProceedsWei",
    "realizedCostWei",
    "feeDragWei",
    "unrealizedPnlWei",
    "unmatchedSharesWei",
  ]) {
    assert.ok(
      !summaryBlock.includes(ownerOnly),
      `${ownerOnly} is owner-only and must not appear in the public summary`
    );
  }
  // …and the chain-derivable ones stay public, so gating never quietly
  // becomes "gate everything", which would break wallet lookup entirely.
  for (const publicField of ["sharesHeldWei", "currentNavPerShareWei", "currentValueWei"]) {
    assert.ok(summaryBlock.includes(publicField), `${publicField} should stay public`);
  }
});
