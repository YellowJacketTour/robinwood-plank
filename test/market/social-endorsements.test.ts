import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import {
  endorseTarget,
  getVoterLiveEndorsementCount,
  unendorseTarget,
  verifyEndorsementProof,
  WALLET_PROOF_DOMAIN,
} from "../../lib/social-endorsements";
import { walletProofMessage, walletProofPayloadHash, type WalletProof } from "../../lib/wallet-proof";
import { hasPostgresConfig, postgresQuery, postgresPool } from "../../lib/postgres";
import { SOCIAL_ENDORSEMENTS_WALLET_PROOF_DOMAIN } from "../../lib/wallet-proof-client";

const alice = new Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const bob = new Wallet(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
);

async function signedEndorsement(
  wallet: Wallet,
  action: "endorse" | "unendorse",
  targetType: "wallet" | "collection",
  targetId: string,
  timestamp: number
): Promise<WalletProof> {
  const voter = wallet.address.toLowerCase();
  const payload = JSON.stringify({ voter, targetType, targetId });
  return {
    address: wallet.address,
    timestamp,
    signature: await wallet.signMessage(
      walletProofMessage(WALLET_PROOF_DOMAIN, action, timestamp, walletProofPayloadHash(payload))
    ),
  };
}

// --- pure signature verification (no Postgres required) ------------------

test("verifyEndorsementProof accepts a genuine self-signed endorse request", async () => {
  const now = Date.now();
  const proof = await signedEndorsement(alice, "endorse", "collection", "robinwood", now);
  assert.equal(
    verifyEndorsementProof(alice.address, "endorse", "collection", "robinwood", proof, now),
    true
  );
});

test("verifyEndorsementProof rejects a signature over a different target", async () => {
  const now = Date.now();
  const proof = await signedEndorsement(alice, "endorse", "collection", "robinwood", now);
  assert.equal(
    verifyEndorsementProof(alice.address, "endorse", "collection", "other-collection", proof, now),
    false
  );
});

test("verifyEndorsementProof rejects a signature over a different action (endorse cannot authorize unendorse)", async () => {
  const now = Date.now();
  const proof = await signedEndorsement(alice, "endorse", "collection", "robinwood", now);
  assert.equal(
    verifyEndorsementProof(alice.address, "unendorse", "collection", "robinwood", proof, now),
    false
  );
});

test("verifyEndorsementProof rejects a claim signed by a different wallet", async () => {
  const now = Date.now();
  const proof = await signedEndorsement(alice, "endorse", "collection", "robinwood", now);
  assert.equal(
    verifyEndorsementProof(bob.address, "endorse", "collection", "robinwood", proof, now),
    false
  );
});

test("a plank-checks or social-badges domain signature cannot be replayed as an endorsement (different domain string)", async () => {
  const now = Date.now();
  const voter = alice.address.toLowerCase();
  const payload = JSON.stringify({ voter, targetType: "collection", targetId: "robinwood" });
  // Signed for the WRONG domain ("plank-checks" instead of "social-endorsements").
  const wrongDomainSig = await alice.signMessage(
    walletProofMessage("plank-checks", "endorse", now, walletProofPayloadHash(payload))
  );
  const proof: WalletProof = { address: alice.address, timestamp: now, signature: wrongDomainSig };
  assert.equal(
    verifyEndorsementProof(alice.address, "endorse", "collection", "robinwood", proof, now),
    false
  );
});

test("the client-safe domain constant (lib/wallet-proof-client.ts) stays in sync with the server domain (lib/social-endorsements.ts)", () => {
  assert.equal(SOCIAL_ENDORSEMENTS_WALLET_PROOF_DOMAIN, WALLET_PROOF_DOMAIN);
});

// --- live Postgres: uniqueness constraint + idempotency -------------------
//
// Verified against the REAL local Docker Postgres (migration 008), not a
// mock — the pen-test finding was specifically that no storage layer
// existed at all, so this proves the table + constraint actually work, not
// just that the TypeScript compiles.

const pgAvailable = hasPostgresConfig();

test(
  "endorseTarget is idempotent under the UNIQUE(voter_wallet, target_type, target_id) constraint — calling it twice never creates two rows",
  { skip: !pgAvailable && "PGHOST/PGDATABASE/PGUSER/PGPASSWORD not set — skipping live Postgres test" },
  async () => {
    const targetId = `test-collection-${Date.now()}`;
    const voter = alice.address.toLowerCase();
    try {
      const now1 = Date.now();
      const proof1 = await signedEndorsement(alice, "endorse", "collection", targetId, now1);
      const first = await endorseTarget(alice.address, "collection", targetId, proof1);
      assert.equal(first.ok, true);

      const now2 = Date.now();
      const proof2 = await signedEndorsement(alice, "endorse", "collection", targetId, now2);
      const second = await endorseTarget(alice.address, "collection", targetId, proof2);
      assert.equal(second.ok, true);

      const rows = await postgresQuery<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM social_endorsements WHERE voter_wallet = $1 AND target_type = 'collection' AND target_id = $2`,
        [voter, targetId]
      );
      assert.equal(Number(rows.rows[0]?.n ?? -1), 1);
    } finally {
      await postgresQuery(
        `DELETE FROM social_endorsements WHERE voter_wallet = $1 AND target_type = 'collection' AND target_id = $2`,
        [voter, targetId]
      );
    }
  }
);

test(
  "unendorseTarget removes the row, and getVoterLiveEndorsementCount reflects live rows only",
  { skip: !pgAvailable && "PGHOST/PGDATABASE/PGUSER/PGPASSWORD not set — skipping live Postgres test" },
  async () => {
    const targetIdA = `test-collection-a-${Date.now()}`;
    const targetIdB = `test-collection-b-${Date.now()}`;
    const voter = alice.address.toLowerCase();
    try {
      const proofA = await signedEndorsement(alice, "endorse", "collection", targetIdA, Date.now());
      await endorseTarget(alice.address, "collection", targetIdA, proofA);
      const proofB = await signedEndorsement(alice, "endorse", "collection", targetIdB, Date.now());
      await endorseTarget(alice.address, "collection", targetIdB, proofB);

      const countAfterTwo = await getVoterLiveEndorsementCount(alice.address);
      assert.ok(countAfterTwo >= 2);

      const unproofA = await signedEndorsement(alice, "unendorse", "collection", targetIdA, Date.now());
      const result = await unendorseTarget(alice.address, "collection", targetIdA, unproofA);
      assert.equal(result.ok, true);

      const rows = await postgresQuery<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM social_endorsements WHERE voter_wallet = $1 AND target_type = 'collection' AND target_id = $2`,
        [voter, targetIdA]
      );
      assert.equal(Number(rows.rows[0]?.n ?? -1), 0);
    } finally {
      await postgresQuery(
        `DELETE FROM social_endorsements WHERE voter_wallet = $1 AND target_type = 'collection' AND target_id = ANY($2::text[])`,
        [voter, [targetIdA, targetIdB]]
      );
    }
  }
);

test(
  "the underlying UNIQUE constraint rejects a raw duplicate insert (bypassing ON CONFLICT DO NOTHING) — proves the constraint itself, not just the app-level guard",
  { skip: !pgAvailable && "PGHOST/PGDATABASE/PGUSER/PGPASSWORD not set — skipping live Postgres test" },
  async () => {
    const targetId = `test-raw-${Date.now()}`;
    const voter = bob.address.toLowerCase();
    try {
      await postgresQuery(
        `INSERT INTO social_endorsements (voter_wallet, target_type, target_id) VALUES ($1, 'collection', $2)`,
        [voter, targetId]
      );
      await assert.rejects(
        postgresQuery(
          `INSERT INTO social_endorsements (voter_wallet, target_type, target_id) VALUES ($1, 'collection', $2)`,
          [voter, targetId]
        )
      );
    } finally {
      await postgresQuery(
        `DELETE FROM social_endorsements WHERE voter_wallet = $1 AND target_type = 'collection' AND target_id = $2`,
        [voter, targetId]
      );
    }
  }
);

test.after(async () => {
  if (pgAvailable) {
    await postgresPool().end();
  }
});
