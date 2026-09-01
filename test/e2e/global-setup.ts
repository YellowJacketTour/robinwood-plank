import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HDNodeWallet } from "ethers";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIRNAME, "..", "..");
const NODE_PIDFILE = path.join(DIRNAME, ".hardhat-node.pid");
const KEEPER_PIDFILE = path.join(DIRNAME, ".casino-keeper.pid");
const RPC_URL = "http://127.0.0.1:8545";
// Account #6 of hardhat's default test mnemonic -- pre-funded with 10000
// ETH like every default account, but NOT one crash.html's Deployer/Alice/
// Bob/Carol picker or Simulate mode ever signs from. The keeper must use a
// signer no spec touches: sharing an account with a spec's own signer
// caused real nonce collisions (two independent processes racing
// eth_getTransactionCount("pending") for the same address) that stalled
// every subsequent Simulate connect on the shared chain. No privilege
// comes with this key either way (see casino-keeper.ts's own header): it
// can't influence outcomes, only pay gas to advance rounds.
const KEEPER_PK = HDNodeWallet.fromPhrase(
  "test test test test test test test test test test test junk",
  undefined,
  "m/44'/60'/0'/0/6"
).privateKey;

async function waitForRpc(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // node not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("hardhat node did not become ready in time");
}

export default async function globalSetup() {
  // A leftover node from an unrelated dev session decays badly over hours
  // of manual poking (huge nonce/block history, orphaned pending state) and
  // produced real hangs when this suite reused one. Always start fresh --
  // kill anything already on 8545 first.
  try {
    execSync(
      `for /f "tokens=5" %p in ('netstat -ano ^| findstr "127.0.0.1:8545 " ^| findstr LISTENING') do taskkill /PID %p /F`,
      { shell: "cmd.exe", stdio: "ignore" }
    );
  } catch {
    // nothing was listening -- fine
  }

  const nodeChild = spawn("npx", ["hardhat", "node"], {
    cwd: ROOT,
    shell: true,
    detached: true,
    stdio: "ignore",
  });
  nodeChild.unref();
  writeFileSync(NODE_PIDFILE, String(nodeChild.pid));
  await waitForRpc(60_000);

  // Fresh deploy every run so specs see known, predictable round/contract
  // state regardless of whatever a prior manual session left behind.
  execSync("npx hardhat run scripts/local-casino-setup.ts --network localhost", {
    cwd: ROOT,
    stdio: "inherit",
  });

  const manifest = JSON.parse(readFileSync(path.join(ROOT, "public", "arcade", "deploy-addresses.local.json"), "utf8"));

  // Real production always has a keeper advancing rounds (lock -> reveal ->
  // settle). Without one here, the very first spec to lock a round strands
  // every later spec's Simulate connect indefinitely -- nothing ever opens
  // the next round. Run the same keeper script real ops use, in mock-beacon
  // mode since there's no real drand relay against a local chain.
  const keeperChild = spawn(
    "npx",
    ["hardhat", "run", "scripts/casino-keeper.ts", "--network", "localhost"],
    {
      cwd: ROOT,
      shell: true,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        KEEPER_RPC_URL: RPC_URL,
        KEEPER_PK: KEEPER_PK,
        CRASH_ADDRESS: manifest.crash,
        POWERBOARD_ADDRESS: manifest.powerboard,
        BEACON_ADDRESS: manifest.beacon,
        DISTRIBUTOR_ADDRESS: manifest.distributor,
        // Without these, the TWAP oracle never gets primed (consult()
        // reverts NotInitialized forever) and fuel-burn.spec.ts's burnFuel
        // call reverts every time -- see local-casino-setup.ts's own
        // printed warning about this, added after finding it live.
        ORACLE_ADDRESS: manifest.oracle,
        BURN_ENGINE_ADDRESS: manifest.burnEngine,
        KEEPER_MOCK_BEACON: "1",
        // Browser tests need a long enough deterministic flight to observe
        // the accepted-bet and cash-out states. Production remains genuinely
        // random; this only selects a mock-beacon fixture on chain 31337.
        KEEPER_MOCK_MIN_CRASH_BPS: "50000",
        KEEPER_INTERVAL_MS: "1500",
      },
    }
  );
  keeperChild.unref();
  writeFileSync(KEEPER_PIDFILE, String(keeperChild.pid));

  // Give the keeper a couple of ticks to settle in before specs start hitting it.
  await new Promise((r) => setTimeout(r, 3000));
}
