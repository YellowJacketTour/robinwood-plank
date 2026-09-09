import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * The vendored WalletConnect bundle must be reproducible.
 *
 * public/wallet-connect-bundle.js is 4,862,013 bytes, committed to git, and
 * until this change there was NO script anywhere in the repo that produced it.
 * `@walletconnect/*` was not a dependency either -- which is why every grep
 * for connector names came up empty, and why an earlier audit concluded this
 * app had no mobile wallet support at all. It does; the dependency is vendored.
 *
 * The real consequence is supply-chain, not feature coverage: **a WalletConnect
 * security patch could not be applied**, because upgrading meant reproducing
 * an undocumented manual process nobody had written down, on the code that
 * handles wallet connections.
 *
 * The blob stays committed on purpose -- lib/wallet-connect.ts's own header
 * explains it is loaded as a static asset "so Cloudflare Workers stay under
 * free size limits". Vendoring is right for this deployment. Vendoring without
 * a build script was not.
 */

const PKG = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const SCRIPT = readFileSync("scripts/build-wallet-connect.mjs", "utf8").replace(/\r\n/g, "\n");
const BUNDLE = "public/wallet-connect-bundle.js";

test("the vendored bundle has a build script", () => {
  assert.ok(PKG.scripts["build:wallet-connect"], "an artifact with no build is unpatchable");
  assert.ok(PKG.scripts["check:wallet-connect"], "and must be verifiable without rebuilding");
  assert.ok(existsSync("scripts/build-wallet-connect.mjs"), "the script must exist");
});

test("the version is pinned exactly, not ranged", () => {
  // The artifact is committed. A floating range would mean two people running
  // the script from the same source tree produce different bundles -- exactly
  // the reproducibility this exists to establish.
  const wc = SCRIPT.match(/const WC_VERSION = "([^"]+)"/);
  assert.ok(wc, "the WalletConnect version must be pinned");
  assert.match(wc[1]!, /^\d+\.\d+\.\d+$/, `must be exact, saw "${wc[1]}"`);
  const qr = SCRIPT.match(/const QR_VERSION = "([^"]+)"/);
  assert.ok(qr, "the QR version must be pinned");
  assert.match(qr[1]!, /^\d+\.\d+\.\d+$/, `must be exact, saw "${qr[1]}"`);
});

test("the build verifies BEFORE it overwrites", () => {
  // Replacing a working wallet bundle with a broken one would break every
  // connection on the site, and the failure would surface only when a user
  // clicks Connect.
  const writeAt = SCRIPT.indexOf("writeFileSync(OUT, built)");
  const checkAt = SCRIPT.indexOf("missing exports");
  assert.ok(checkAt > 0 && checkAt < writeAt, "the export check must precede the write");
  assert.match(SCRIPT, /implausibly small/, "and a size floor must guard a truncated build");
});

test("the exports the app destructures are the ones checked", () => {
  // lib/wallet-connect.ts reads EthereumProvider and QRCode off the module. A
  // bundle that loads but lacks one fails at the wallet prompt.
  const loader = readFileSync("lib/wallet-connect.ts", "utf8");
  for (const name of ["EthereumProvider", "QRCode"]) {
    assert.ok(loader.includes(name), `the loader uses ${name}`);
    assert.ok(SCRIPT.includes(name), `so the build must verify ${name}`);
  }
});

test("the committed bundle is present and carries both exports", () => {
  // The check the script performs, asserted here too, so CI fails if the
  // artifact is ever deleted or truncated by a bad merge.
  assert.ok(existsSync(BUNDLE), "the vendored bundle must exist");
  const size = statSync(BUNDLE).size;
  assert.ok(size > 500_000, `implausibly small bundle (${size} bytes)`);
  const src = readFileSync(BUNDLE, "utf8");
  for (const name of ["EthereumProvider", "QRCode"]) {
    assert.ok(src.includes(name), `the committed bundle must export ${name}`);
  }
});

test("the build never touches the app's own node_modules", () => {
  // The bundle's dependencies are not the app's, and installing them into the
  // app tree would change the lockfile for everyone.
  assert.match(SCRIPT, /mkdtempSync/, "the build must use a throwaway tree");
  assert.match(SCRIPT, /rmSync\(dir, \{ recursive: true, force: true \}\)/, "and clean it up");
  assert.match(SCRIPT, /finally \{/, "even when the build throws");
});
