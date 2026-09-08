import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Discovery adapters must not pass `address` into getLogs.
 * The only two address-scoped functions are pinned by name.
 */
const ALLOWED = new Set([
  "findEarliestTransferBlock",
  "runAddressScopedMembershipScan",
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const files = walk(new URL("../src", import.meta.url).pathname);
let scopedDefs = 0;
const extras: string[] = [];

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const fn = [...src.matchAll(/export async function ([A-Za-z0-9_]+)\(/g)];
  for (const m of fn) {
    const name = m[1]!;
    const start = m.index ?? 0;
    const slice = src.slice(start, start + 800);
    if (slice.includes("address,") && slice.includes("getLogs") && f.includes("adapters/evm")) {
      scopedDefs++;
      if (!ALLOWED.has(name)) extras.push(`${name} in ${f}`);
    }
  }
}

if (scopedDefs !== 2) {
  console.error(`expected exactly 2 address-scoped helpers, found ${scopedDefs}`);
  process.exit(1);
}
if (extras.length) {
  console.error("new address-scoped helper requires justification:\n" + extras.join("\n"));
  process.exit(1);
}
console.log("discovery surface: 2 address-scoped helpers, names pinned.");
