import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual production callback, including paging, response handling
// and state setters. Only its I/O boundary and React setter functions are
// controlled here; the catalog policy is not reimplemented in the test.
const file = ts.createSourceFile("view.tsx", readFileSync("components/market/MultichainCollectionView.tsx", "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "fetchCatalogTokens") initializer = node.initializer;
  ts.forEachChild(node, visit);
}
visit(file);
assert.ok(initializer, "production callback exists");
const code = ts.transpileModule(`globalThis.callback = ${initializer.getText(file)};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

async function exercise(response: unknown, fail = false) {
  let tokens: unknown[] = [{ tokenId: "known" }];
  const context = vm.createContext({
    URLSearchParams, chainSlug: "bitcoin-mainnet", collectionSlug: "fixture",
    listingSort: "id", activeTier: "all", activeTiers: [], tokenLimit: 40, surface: { catalogPageSize: 40 },
    useCallback: (fn: unknown) => fn,
    swrJson: async () => { if (fail) throw new Error("controlled outage"); return response; },
    setTokens: (next: unknown[]) => { tokens = next; },
    setCatalogBuilding: () => {}, setCatalogMeta: () => {}, setCatalogInitialLoading: () => {},
  });
  vm.runInContext(code, context);
  await context.callback(true);
  return JSON.parse(JSON.stringify(tokens));
}

test("actual collection live callback retains known tokens while projection is unavailable", async () => {
  assert.deepEqual(await exercise({ tokens: [], building: true, partial: true }), [{ tokenId: "known" }]);
});
test("actual collection live callback retains known tokens after a read fails", async () => {
  assert.deepEqual(await exercise(null, true), [{ tokenId: "known" }]);
});
test("actual collection live callback accepts a complete empty projection", async () => {
  assert.deepEqual(await exercise({ tokens: [], building: false, partial: false }), []);
});
