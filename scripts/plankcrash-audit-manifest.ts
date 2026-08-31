import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputArg = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
const tracked = execFileSync("git", ["ls-files", "contracts/*.sol", "contracts/lib/*.sol", "test/contracts/PlankCrash*.ts", "hardhat.config.ts", "package.json", "package-lock.json"], { encoding: "utf8" })
  .split(/\r?\n/).filter(Boolean).sort();
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const files = await Promise.all(tracked.map(async (file) => ({ file, sha256: sha256(await readFile(file)) })));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
const artifactPath = path.join(".hardhat-artifacts", "contracts", "PlankCrashDrand.sol", "PlankCrashDrand.json");
let artifact = null;
try {
  const compiled = JSON.parse(await readFile(artifactPath, "utf8"));
  artifact = { path: artifactPath, bytecodeSha256: sha256(compiled.bytecode || ""), deployedBytecodeSha256: sha256(compiled.deployedBytecode || "") };
} catch (_) { /* compilation artifact is optional, source manifest is not */ }

const manifest = {
  schema: "plankcrash.audit-manifest.v1",
  generatedAt: new Date().toISOString(),
  commit,
  cleanWorkingTree: status === "",
  compiler: { solidity: "0.8.24", optimizerRuns: 200, viaIR: true, evmVersion: "paris" },
  files,
  artifact,
  requiredReproduction: ["npm ci", "npx tsc --noEmit", "npm run test:market", "npm run test:contracts", "npx next build --webpack"],
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
if (outputArg) await writeFile(outputArg, serialized, { encoding: "utf8", flag: "wx" });
process.stdout.write(serialized);
if (!manifest.cleanWorkingTree) process.stderr.write("WARNING: manifest was generated from a dirty working tree\n");

