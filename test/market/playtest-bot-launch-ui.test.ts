import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../public/arcade/crash.html", import.meta.url), "utf8");

test("an enabled bankroll-funded bot can unlock launch without a human seat", () => {
  const start = source.indexOf("const queuedBots =");
  assert.ok(start >= 0, "queued bot launch gate is missing");
  const gate = source.slice(start, source.indexOf("launch.title", start));
  assert.match(gate, /member\.botProfile\?\.enabled/);
  // Bots alone unlock a lobby launch; queued humans OR bots unlock a manual
  // launch from a settled intermission (the table must never stick at 0:00).
  assert.match(gate, /snapshot\.seats\.length > 0 \|\| queuedBots > 0/);
  assert.match(gate, /settledReady = snapshot\.room\.phase === "settled" && \(queuedHumans > 0 \|\| queuedBots > 0\)/);
  assert.doesNotMatch(gate, /snapshot\.seats\.length === 0;/);
});
