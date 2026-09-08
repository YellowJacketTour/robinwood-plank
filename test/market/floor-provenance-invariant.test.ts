import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A floor may never be written without naming the venue it came from.
 *
 * A bare floor is unfalsifiable. A stranger looking at "0.42" cannot tell an
 * exhibit-min from "we asked a venue that is now dark", and neither can we,
 * which means a wrong floor is indistinguishable from a right one. That is
 * the same silent-success species as a topic0 that matches nothing: the cell
 * renders, nobody errors, and the number is a rumour.
 *
 * Today every `updateCollectionFloorOnly` call site does pass
 * `floorPriceMarketplace`. Nothing enforced it. This test is the enforcement,
 * so the invariant cannot be lost by the next route that ships a floor.
 *
 * WHAT THIS DOES NOT CLAIM. Naming a venue is not proof of a price -- a venue
 * quote is an observation, not a fact, and the honest typed kinds
 * (min_exhibited_valid_order / min_observed_fill_in_window / amm_state) live
 * in packages/akasha and are not what production emits yet. This test only
 * holds the weaker line that production can hold TODAY: no anonymous floors.
 */

const ROOTS = ["lib", "app", "scripts"];
const CALL = "updateCollectionFloorOnly(";

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Every call to the floor writer, with the argument object that follows it. */
function floorCallSites(): Array<{ file: string; line: number; body: string }> {
  const sites: Array<{ file: string; line: number; body: string }> = [];
  for (const root of ROOTS) {
    for (const file of walk(path.join(process.cwd(), root))) {
      const src = readFileSync(file, "utf8");
      if (!src.includes(CALL)) continue;
      let idx = src.indexOf(CALL);
      while (idx !== -1) {
        // Skip the declaration/import of the function itself.
        const lineStart = src.lastIndexOf("\n", idx) + 1;
        const lineText = src.slice(lineStart, src.indexOf("\n", idx));
        if (!/export\s+(async\s+)?function/.test(lineText)) {
          // Take the balanced argument list, capped so a malformed file cannot
          // make this test read the whole repo into one string.
          const body = src.slice(idx, idx + 800);
          const line = src.slice(0, idx).split("\n").length;
          sites.push({ file: path.relative(process.cwd(), file), line, body });
        }
        idx = src.indexOf(CALL, idx + 1);
      }
    }
  }
  return sites;
}

test("the floor writer is actually called somewhere (the test is not vacuous)", () => {
  const sites = floorCallSites();
  assert.ok(
    sites.length >= 4,
    `expected several floor write sites, found ${sites.length} -- a guard that inspects nothing always passes`,
  );
});

test("every floor write names the venue it came from", () => {
  const anonymous: string[] = [];
  for (const site of floorCallSites()) {
    // The argument object must set floorPriceMarketplace to something that is
    // not null/undefined/empty.
    const m = /floorPriceMarketplace\s*:\s*([^,\n}]+)/.exec(site.body);
    const value = m?.[1]?.trim();
    const named =
      !!value && value !== "null" && value !== "undefined" && value !== '""' && value !== "''";
    if (!named) anonymous.push(`${site.file}:${site.line} -> ${value ?? "(field absent)"}`);
  }

  assert.deepEqual(
    anonymous,
    [],
    "a floor written without a venue is a number nobody can falsify:\n  " + anonymous.join("\n  "),
  );
});

test("the guard fires on an anonymous write", () => {
  // Mutation check in miniature: the detector must reject the shape it exists
  // to reject, or it is a mirror rather than a check.
  const shapes = [
    'updateCollectionFloorOnly("eth", id, { floorPriceWei: w, floorPriceCurrency: "ETH" })',
    'updateCollectionFloorOnly("eth", id, { floorPriceWei: w, floorPriceMarketplace: null })',
    'updateCollectionFloorOnly("eth", id, { floorPriceWei: w, floorPriceMarketplace: "" })',
  ];
  for (const body of shapes) {
    const m = /floorPriceMarketplace\s*:\s*([^,\n}]+)/.exec(body);
    const value = m?.[1]?.trim();
    const named =
      !!value && value !== "null" && value !== "undefined" && value !== '""' && value !== "''";
    assert.equal(named, false, `should have been rejected: ${body}`);
  }
  // And accept a real one, so it is not simply refusing everything.
  const good = 'updateCollectionFloorOnly("btc", id, { floorPriceWei: w, floorPriceMarketplace: "unisat" })';
  const gm = /floorPriceMarketplace\s*:\s*([^,\n}]+)/.exec(good);
  assert.equal(gm?.[1]?.trim(), '"unisat"');
});
