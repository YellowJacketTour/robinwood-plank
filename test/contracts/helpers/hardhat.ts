import hre from "hardhat";

/**
 * One explicit Hardhat 3 connection shared by each contract-test module.
 *
 * The network name is passed EXPLICITLY. `hre.network.create()` with no
 * argument does not read `config.networks.hardhat` — it spins up Hardhat 3's
 * own built-in default in-process network, silently ignoring any override
 * (in particular the `hardfork: "cancun"` pin in hardhat.config.ts that
 * exists specifically to lift EIP-7825's Fusaka-era 16,777,216 per-tx gas
 * cap, which `IndexDeployer`'s one-shot manifest deploy exceeds). Naming the
 * network is what makes the configured connection the one actually used.
 */
export const { ethers, networkHelpers, provider } = await hre.network.create("hardhat");

/**
 * ---------------------------------------------------------------------------
 * Hardhat 2 compatibility re-exports.
 *
 * Under Hardhat 2 the whole surface came off one import:
 *
 *     import { ethers, artifacts, network } from "hardhat";
 *
 * Hardhat 3 splits that in two. `ethers` / `networkHelpers` / `provider` belong
 * to a *connection* (above), because a connection is now the thing that owns
 * chain state. `artifacts` and the network-control surface stay on the
 * environment itself, since they are process-level, not chain-level.
 *
 * Both are re-exported here so a test file changes by one import line rather
 * than being rewritten. That matters specifically because this suite is the
 * evidence for a security audit: the smaller and more uniform the migration
 * diff, the easier it is for a reviewer to confirm that no assertion moved
 * while the toolchain moved underneath it.
 * ---------------------------------------------------------------------------
 */

/** Compiled-artifact reader — `hre.artifacts` in Hardhat 3. */
export const artifacts = hre.artifacts;

/**
 * Hardhat-2-style `network` shim.
 *
 * Tests use this almost entirely for `network.provider.send(...)` (raw RPC:
 * `evm_mine`, `evm_setNextBlockTimestamp`, `hardhat_setCode`, …). In Hardhat 3
 * that provider is the connection's, so `network.provider` is wired to it here
 * while `name`/`config` still come from the environment.
 */
export const network = {
  ...hre.network,
  provider,
  name: (hre.globalOptions as any)?.network ?? "hardhat",
} as any;
