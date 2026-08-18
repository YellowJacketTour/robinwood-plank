import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * Guards the NEXT_PUBLIC inlining trap.
 *
 * Next.js replaces `process.env.NEXT_PUBLIC_*` with a literal in the SERVER
 * bundle, not only the browser bundle -- but ONLY when the variable is
 * defined in the environment `next build` runs in. Its own docs say it:
 * "your app will no longer respond to changes to these environment
 * variables."
 *
 * Measured on this toolchain, against .next/server/**\/*.js:
 *   NEXT_PUBLIC_TRADE_PAUSED    defined at build -> 0 runtime reads (inlined)
 *   NEXT_PUBLIC_MARKET_ENABLED  defined at build -> 0 runtime reads (inlined)
 *   NEXT_PUBLIC_GAMES_ENABLED   NOT defined      -> 5 runtime reads (live)
 *
 * So whether a flag is runtime-changeable silently depends on whether the
 * deploy happens to define it. That is what broke the referral kill switch:
 * the variable was added to the workflow's build env, which froze it, while
 * everyone reasoned about a runtime path that no longer had a consumer.
 * Setting the repository variable to false and deploying changed nothing
 * observable, and the feature had to be disabled in source instead.
 *
 * A server module that GATES BEHAVIOUR on such a variable therefore cannot
 * be treated as having a runtime kill switch. This test does not ban the
 * pattern -- plenty of these are addresses and URLs that are legitimately
 * build-time constants. It pins the list, so ADDING one is a deliberate act
 * with this comment attached, rather than something discovered in an
 * incident.
 *
 * If this test fails because you added a flag: decide whether the feature
 * needs a real kill switch. If it does, do not put it here -- back it with a
 * database-resolved value (see app/api/trade/status/route.ts, which ORs a DB
 * override over the baked value so a pause lands without a deploy) and give
 * it a name WITHOUT the NEXT_PUBLIC_ prefix so it can never be inlined.
 */

const LIB_DIR = path.resolve(import.meta.dirname, "../../lib");

/**
 * Server-side modules that read a NEXT_PUBLIC_* variable, and the variables
 * they read. Everything listed here is build-frozen whenever the deploy
 * defines it.
 */
const KNOWN_BUILD_FROZEN: Record<string, string[]> = {
  "market/multichain/trading/solana-transfer.ts": ["NEXT_PUBLIC_SOLANA_RPC_URL"],
  // sweepSolanaListingsBatched needs its own Connection.getLatestBlockhash()
  // to build the shared blockhash for a combined batch tx -- same
  // client-side, build-time-inlined constant as solana-transfer.ts above,
  // not a runtime kill switch (see that entry's own reasoning).
  "market/multichain/trading/foreign-fulfill.ts": ["NEXT_PUBLIC_SOLANA_RPC_URL"],
  "constants.ts": [
    "NEXT_PUBLIC_DEV_LOCAL_CHAIN",
    "NEXT_PUBLIC_DEV_LOCAL_RPC",
    "NEXT_PUBLIC_DRAND_BEACON_ADDRESS",
    "NEXT_PUBLIC_GASLESS_ENABLED",
    "NEXT_PUBLIC_MARKET_ENABLED",
    "NEXT_PUBLIC_MARKET_VAULT_ADDRESS",
    "NEXT_PUBLIC_MARKET_VAULT_ADDRESSES",
    "NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS",
    "NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES",
    "NEXT_PUBLIC_MARKET_VAULT_V1_KNOWN",
    "NEXT_PUBLIC_MARKET_VAULT_V2_KNOWN",
    "NEXT_PUBLIC_MINT_START_AT",
    "NEXT_PUBLIC_ROBINHOOD_RPC_URL",
    "NEXT_PUBLIC_RULES_RELAXED",
    "NEXT_PUBLIC_SITE_URL",
    "NEXT_PUBLIC_TRADE_OPENS_AT",
    "NEXT_PUBLIC_TRADE_PAUSED",
  ],
  "crosschain-constants.ts": ["NEXT_PUBLIC_CROSSCHAIN_ENABLED"],
  "games/flags.ts": ["NEXT_PUBLIC_GAMES_ENABLED"],
  "market/vault.ts": ["NEXT_PUBLIC_DEV_LOCAL_CHAIN"],
  "mint-contract.ts": ["NEXT_PUBLIC_NFT_CONTRACT_ADDRESS", "NEXT_PUBLIC_ROBINHOOD_RPC_URL"],
  "public-json.ts": ["NEXT_PUBLIC_SITE_URL"],
  "server/rpc-urls.ts": [
    "NEXT_PUBLIC_DEV_LOCAL_CHAIN",
    "NEXT_PUBLIC_DEV_LOCAL_RPC",
    "NEXT_PUBLIC_ROBINHOOD_RPC_URL",
  ],
  "wallet-connect.ts": ["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"],
  "wallet-reown.ts": ["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "NEXT_PUBLIC_WALLET_UI"],
  "zerox-server.ts": ["NEXT_PUBLIC_ZEROX_ENABLED", "NEXT_PUBLIC_ZEROX_CROSSCHAIN_ENABLED"],
};

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) yield full;
  }
}

async function actualUsage(): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {};
  for await (const file of walk(LIB_DIR)) {
    const source = await readFile(file, "utf8");
    const matches = source.match(/process\.env\.NEXT_PUBLIC_[A-Z0-9_]+/g);
    if (!matches) continue;
    const rel = path.relative(LIB_DIR, file).split(path.sep).join("/");
    found[rel] = [...new Set(matches.map((m) => m.replace("process.env.", "")))].sort();
  }
  return found;
}

test("no server module starts gating on a NEXT_PUBLIC_ flag unnoticed", async () => {
  const actual = await actualUsage();

  const added = Object.keys(actual).filter((f) => !(f in KNOWN_BUILD_FROZEN));
  assert.deepEqual(
    added,
    [],
    `New server module(s) reading NEXT_PUBLIC_*: ${added.join(", ")}.\n` +
      `Next inlines these at build time when the deploy defines them, so this is NOT a runtime kill switch.\n` +
      `If the feature needs to be switchable without a deploy, back it with a DB-resolved value and drop the NEXT_PUBLIC_ prefix.\n` +
      `If it is genuinely a build-time constant, add it to KNOWN_BUILD_FROZEN.`
  );
});

test("the set of build-frozen flags per module does not grow silently", async () => {
  const actual = await actualUsage();
  for (const [file, expected] of Object.entries(KNOWN_BUILD_FROZEN)) {
    if (!actual[file]) continue; // file deleted or renamed — the test above covers additions
    const surprises = actual[file].filter((v) => !expected.includes(v));
    assert.deepEqual(
      surprises,
      [],
      `${file} newly reads ${surprises.join(", ")}. Same trap: build-frozen, not a kill switch.`
    );
  }
});

test("a feature flag that must be killable is not NEXT_PUBLIC", () => {
  // Referrals learned this the hard way. REFERRAL_ENABLED is currently a
  // hardcoded false precisely because its env-driven form could not be
  // trusted to turn the feature off. When it is restored, it must come back
  // as a DB-resolved value on a non-public name — if this assertion starts
  // failing, that restoration took the old shape again.
  const killable = ["NEXT_PUBLIC_REFERRAL_ENABLED", "NEXT_PUBLIC_MOONPAY_ENABLED"];
  const frozen = new Set(Object.values(KNOWN_BUILD_FROZEN).flat());
  for (const name of killable) {
    assert.ok(
      !frozen.has(name),
      `${name} is a kill switch and must not be a NEXT_PUBLIC_ build-time flag. ` +
        `Back it with a DB override (see app/api/trade/status/route.ts) on a non-public name.`
    );
  }
});
