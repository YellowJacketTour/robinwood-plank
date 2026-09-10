import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { readFileSync } from "node:fs";

test("actual coverage route never promotes a cursor with fragmented coverage to completeness", async () => {
  const row = { chain: "bitcoin", protocol_t0: 767430, backfill_tail: 965761,
    finalized_height: 966225, tip_height: 966231, run_count: 431, complete_from_protocol: false };
  const code = ts.transpileModule(readFileSync("app/api/market/multichain/akasha-coverage/route.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ exports: {}, require: (name: string) => name === "next/server"
    ? { NextResponse: { json: (data: unknown) => data } } : name.endsWith("postgres")
      ? { hasPostgresConfig: () => true, postgresQuery: async () => ({ rows: [row] }) }
      : { rateLimit: () => null, publicError: (error: unknown) => { throw error; } } });
  vm.runInContext(code, context);
  const result = await context.exports.GET({});
  assert.equal(result.chains[0].completeFromProtocol, false);
  assert.equal(result.chains[0].sentence, "backfill at block 965761; archive incomplete");
  assert.equal(result.chains[0].runCount, 431);
  row.complete_from_protocol = true;
  assert.equal((await context.exports.GET({})).chains[0].sentence, "complete from protocol origin");
});
