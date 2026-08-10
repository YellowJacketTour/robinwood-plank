import { networkHelpers } from "./hardhat.js";

/**
 * ============================================================================
 *  Hardhat 3 compatibility shim for `@nomicfoundation/hardhat-network-helpers`.
 *
 *  WHY THIS EXISTS. Under Hardhat 2 these helpers were a standalone package
 *  imported directly:
 *
 *      import { time, takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
 *
 *  Under Hardhat 3 they are properties of a *network connection* obtained via
 *  `hre.network.create()` (see `./hardhat.ts`), because a connection — not the
 *  process — is now the unit that owns chain state. There is no longer a
 *  module-level singleton to import from.
 *
 *  Re-exporting them here rather than rewriting every call site is a deliberate
 *  choice. 84 contract-test files use these helpers, most of them to warp time
 *  or snapshot/restore around adversarial scenarios. Rewriting each call to
 *  `networkHelpers.time.increase(...)` would touch every one of those files —
 *  a large, uniform, silent diff across the exact suite that proves the audit
 *  fixes. The narrower the change to those files, the easier it is for a
 *  reviewer to confirm no assertion moved. So each file changes by one import
 *  line and nothing else.
 *
 *  NOTE ON `time`, `mine`, ETC. These are bound to ONE connection, shared by
 *  every module that imports this shim — the same sharing Hardhat 2's singleton
 *  had. That is what makes snapshot/restore across suites behave as before, and
 *  it is also why a suite that warps the clock must still restore it: a leaked
 *  warp is charged to whatever runs next. (That hazard is real in this repo —
 *  it previously expired the fixed-endTime Seaport order fixtures and produced
 *  four phantom failures.)
 * ============================================================================
 */

export const {
  time,
  mine,
  mineUpTo,
  takeSnapshot,
  loadFixture,
  impersonateAccount,
  stopImpersonatingAccount,
  setBalance,
  setCode,
  setNonce,
  setStorageAt,
  getStorageAt,
  reset,
  dropTransaction,
} = networkHelpers as any;

/**
 * The restorer handle returned by `takeSnapshot()`.
 *
 * Derived from the function's own return type rather than hand-declared, so it
 * cannot drift from whatever Hardhat actually returns.
 */
export type SnapshotRestorer = Awaited<ReturnType<typeof networkHelpers.takeSnapshot>>;
