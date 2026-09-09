#!/usr/bin/env node
/**
 * Rebuild public/wallet-connect-bundle.js from source.
 *
 * WHY THIS SCRIPT HAD TO EXIST
 * ----------------------------
 * `public/wallet-connect-bundle.js` is 4,862,013 bytes, committed to git, and
 * until now there was NO script anywhere in the repo that produced it --
 * verified: `git ls-files` tracks it, and `package.json` had no matching
 * build step. Neither did `@walletconnect/*` appear as a dependency, which is
 * why every grep for connector names came up empty and an earlier audit
 * concluded this app had no mobile wallet support at all. It does; the
 * dependency is simply vendored.
 *
 * The practical consequence is the serious one, and it is a supply-chain
 * problem rather than a missing feature: **a WalletConnect security patch
 * could not be applied.** Upgrading would have meant reproducing an
 * undocumented manual bundling process that nobody had written down, on a
 * dependency that handles wallet connections. That is the kind of risk that
 * stays invisible until the day it is urgent.
 *
 * This makes the artifact reproducible. The blob stays committed on purpose --
 * see below -- but it can now be regenerated from a pinned version by anyone,
 * in one command, with the output verified before it replaces anything.
 *
 * WHY THE BUNDLE IS STILL COMMITTED
 * ---------------------------------
 * The file's own header explains it: the bundle is loaded as a static asset
 * "so Cloudflare Workers stay under free size limits". Importing
 * @walletconnect/ethereum-provider directly into the app bundle would push the
 * Worker over its ceiling. Vendoring is the right call for this deployment;
 * vendoring WITHOUT a build script was not.
 *
 * USAGE
 *   npm run build:wallet-connect          # rebuild and verify
 *   npm run build:wallet-connect -- --check  # verify only, no write
 *
 * The pinned version lives in WC_VERSION below. Bump it deliberately, run
 * this, and commit both the version and the regenerated bundle together so the
 * artifact and its provenance never drift apart.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The pinned WalletConnect version.
 *
 * Pinned exactly, not a range: this artifact is committed, so a floating range
 * would mean two people running this script produce different bundles from the
 * same source tree -- which is precisely the reproducibility this script
 * exists to establish.
 */
const WC_VERSION = "2.17.2";
const QR_VERSION = "1.5.4";

const OUT = "public/wallet-connect-bundle.js";

/**
 * The named exports lib/wallet-connect.ts destructures from the bundle.
 *
 * Checked after every build. A bundle that loads but is missing an export
 * fails at the moment a user clicks Connect -- in production, on a wallet
 * flow, which is the worst place to discover it.
 */
const REQUIRED_EXPORTS = ["EthereumProvider", "QRCode"];

function main() {
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    if (!existsSync(OUT)) {
      console.error(`[wallet-connect] MISSING: ${OUT}`);
      process.exit(1);
    }
    const src = readFileSync(OUT, "utf8");
    const missing = REQUIRED_EXPORTS.filter((e) => !src.includes(e));
    if (missing.length) {
      console.error(`[wallet-connect] bundle is missing exports: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log(
      `[wallet-connect] ok: ${OUT} present, ${src.length} bytes, exports ${REQUIRED_EXPORTS.join(", ")}`,
    );
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "wc-build-"));
  try {
    console.log(`[wallet-connect] building in ${dir}`);
    // A throwaway tree, so this never touches the app's own node_modules or
    // its lockfile -- the bundle's dependencies are not the app's.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "wc-bundle", private: true, type: "module" }, null, 2),
    );
    writeFileSync(
      join(dir, "entry.js"),
      [
        `export { EthereumProvider } from "@walletconnect/ethereum-provider";`,
        `export * as QRCode from "qrcode";`,
      ].join("\n"),
    );

    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        `@walletconnect/ethereum-provider@${WC_VERSION}`,
        `qrcode@${QR_VERSION}`,
        "esbuild",
      ],
      { cwd: dir, stdio: "inherit", shell: process.platform === "win32" },
    );

    execFileSync(
      "npx",
      [
        "esbuild",
        "entry.js",
        "--bundle",
        "--format=esm",
        "--platform=browser",
        "--minify",
        "--target=es2020",
        `--outfile=out.js`,
      ],
      { cwd: dir, stdio: "inherit", shell: process.platform === "win32" },
    );

    const built = readFileSync(join(dir, "out.js"), "utf8");

    // VERIFY BEFORE REPLACING. Overwriting a working wallet bundle with a
    // broken one would break every connection on the site, and the failure
    // would appear only when a user clicks Connect.
    const missing = REQUIRED_EXPORTS.filter((e) => !built.includes(e));
    if (missing.length) {
      throw new Error(`built bundle is missing exports: ${missing.join(", ")}`);
    }
    if (built.length < 500_000) {
      throw new Error(`built bundle is implausibly small (${built.length} bytes)`);
    }

    const prevBytes = existsSync(OUT) ? readFileSync(OUT, "utf8").length : 0;
    writeFileSync(OUT, built);
    console.log(
      `[wallet-connect] wrote ${OUT}: ${prevBytes} -> ${built.length} bytes ` +
        `(walletconnect ${WC_VERSION}, qrcode ${QR_VERSION})`,
    );
    console.log("[wallet-connect] commit the bundle and this script's pinned versions together.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
