"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Passenger bootstrap uses CommonJS. */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

/** Server bootstrap only. A package cannot opt itself into serving. Failure
 * disables the game runtime, never the surrounding PlankSpace application. */
function configureCharmvilleRuntime(env, releaseRoot) {
  const requested = env.CHARMVILLE_RUNTIME_READY === "1";
  const release = env.CHARMVILLE_RUNTIME_RELEASE;
  env.CHARMVILLE_RUNTIME_READY = "0";
  delete env.CHARMVILLE_RUNTIME_ROOT;
  if (!requested) return { ready: false, reason: "not-enabled" };
  if (typeof release !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(release)) return { ready: false, reason: "invalid-release" };
  try {
    if (!path.isAbsolute(releaseRoot)) throw Error("Expected resolved release");
    const root = path.join(releaseRoot, "private", "charmville", "runtime");
    let cursor = path.parse(root).root;
    for (const part of root.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, part);
      const info = fs.lstatSync(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw Error("Unsafe release path");
    }
    function smallFile(name) {
      const filename = path.join(root, name), info = fs.lstatSync(filename);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 2_000_000) throw Error("Invalid package metadata");
      return fs.readFileSync(filename);
    }
    const receipt = JSON.parse(smallFile("PACKAGE-COMPLETE.json").toString("utf8"));
    if (receipt.kind !== "charmville-runtime-release" || receipt.readyToServe !== true || receipt.release !== release || !/^[a-f0-9]{64}$/.test(receipt.inventorySha256 || "")) throw Error("Unaccepted package");
    const bytes = smallFile("inventory.json");
    if (createHash("sha256").update(bytes).digest("hex") !== receipt.inventorySha256) throw Error("Inventory mismatch");
    const inventory = JSON.parse(bytes.toString("utf8"));
    if (inventory.schemaVersion !== 1 || inventory.scope !== "joined-homestead-private-inventory" || inventory.completeInventory !== true || !Array.isArray(inventory.files) || !Array.isArray(inventory.issues) || inventory.issues.length) throw Error("Incomplete inventory");
    env.CHARMVILLE_RUNTIME_ROOT = root;
    env.CHARMVILLE_RUNTIME_READY = "1";
    return { ready: true, release };
  } catch {
    return { ready: false, reason: "bundle-unavailable" };
  }
}
module.exports = { configureCharmvilleRuntime };
