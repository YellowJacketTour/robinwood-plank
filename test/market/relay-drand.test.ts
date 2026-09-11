import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  DrandRoundUnavailableError,
  settleVault,
  type VaultRelayPort,
} from "../../scripts/relay-drand";

const VAULT = "0x1111111111111111111111111111111111111111";
const REQUESTER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

function fakePort(
  overrides: Partial<VaultRelayPort> = {}
): VaultRelayPort {
  let requester = REQUESTER;
  return {
    pendingRequester: async () => requester,
    pendingRound: async () => ({ round: BigInt(100), available: true }),
    latestDrandRound: async () => BigInt(100),
    relayExactRound: async () => {},
    isRoundAvailable: async () => true,
    currentDrandRound: async () => BigInt(100),
    pin: async () => {},
    claim: async () => {
      requester = ZERO;
    },
    forfeit: async () => {
      requester = ZERO;
    },
    ...overrides,
  };
}

test("idle vault reports idle without performing actions", async () => {
  let acted = false;
  const port = fakePort({
    pendingRequester: async () => ZERO,
    pin: async () => {
      acted = true;
    },
  });
  assert.deepEqual(await settleVault(VAULT, port), {
    vault: VAULT,
    state: "idle",
    actionable: false,
  });
  assert.equal(acted, false);
});

test("future exact round reports waiting without spending gas", async () => {
  let acted = false;
  const port = fakePort({
    pendingRound: async () => ({ round: BigInt(101), available: false }),
    latestDrandRound: async () => BigInt(100),
    relayExactRound: async () => {
      acted = true;
    },
  });
  const value = await settleVault(VAULT, port);
  assert.equal(value.state, "waiting");
  assert.equal(value.actionable, false);
  assert.match(value.detail || "", /latest published drand round is 100/);
  assert.equal(acted, false);
});

test("published request relays its exact round, pins, claims, and confirms clear", async () => {
  let available = false;
  let requester = REQUESTER;
  const actions: string[] = [];
  const port = fakePort({
    pendingRequester: async () => requester,
    pendingRound: async () => ({ round: BigInt(123), available }),
    latestDrandRound: async () => BigInt(123),
    relayExactRound: async (round) => {
      actions.push(`relay:${round.toString()}`);
      available = true;
    },
    isRoundAvailable: async () => available,
    pin: async () => {
      actions.push("pin");
    },
    claim: async () => {
      actions.push("claim");
      requester = ZERO;
    },
  });
  const value = await settleVault(VAULT, port);
  assert.equal(value.state, "settled");
  assert.equal(value.actionable, false);
  assert.deepEqual(actions, ["relay:123", "pin", "claim"]);
});

test("expired unavailable request is forfeited and confirmed clear", async () => {
  let requester = REQUESTER;
  const port = fakePort({
    pendingRequester: async () => requester,
    pendingRound: async () => ({ round: BigInt(100), available: false }),
    latestDrandRound: async () => BigInt(30_000),
    relayExactRound: async (round) => {
      throw new DrandRoundUnavailableError(round);
    },
    currentDrandRound: async () => BigInt(30_000),
    forfeit: async () => {
      requester = ZERO;
    },
  });
  const value = await settleVault(VAULT, port);
  assert.equal(value.state, "forfeited");
  assert.equal(value.actionable, false);
});

test("action failure remains visible when the occupied slot remains", async () => {
  const port = fakePort({
    pin: async () => {
      throw new Error("execution reverted");
    },
  });
  const value = await settleVault(VAULT, port);
  assert.equal(value.state, "error");
  assert.equal(value.actionable, true);
  assert.match(value.detail || "", /pin failed: execution reverted/);
});

// casino-keeper.ts imports from relay-drand.ts, and esbuild bundles both into
// ONE file for deployment. Both modules carry an "am I the entrypoint?" check,
// and in the bundle both compare the same process.argv[1] to the same
// import.meta.url -- so BOTH passed, and running the keeper also started the
// relayer's main(), which died on its own required("RPC_URL") before the
// keeper ticked once. Observed against the live testnet deploy:
//   RELAYER_FATAL={"detail":"Missing required env var RPC_URL"}
// Identity cannot distinguish two mains sharing a file, so each must name
// itself.
test("the bundled keeper cannot start the relayer's main loop", () => {
  const relay = readFileSync(new URL("../../scripts/relay-drand.ts", import.meta.url), "utf8");
  const keeper = readFileSync(new URL("../../scripts/casino-keeper.ts", import.meta.url), "utf8");
  assert.match(
    relay,
    /process\.env\.PLANK_RELAYER_MAIN === "1"/,
    "the relayer must have an explicit opt-in that survives bundling"
  );
  assert.match(
    relay,
    /!process\.env\.PLANK_KEEPER_MAIN/,
    "the relayer must stand down when the keeper owns the process"
  );
  assert.match(
    keeper,
    /process\.env\.PLANK_KEEPER_MAIN === "1"/,
    "the keeper must be startable by name, since the bundle's argv identity is shared"
  );
});
