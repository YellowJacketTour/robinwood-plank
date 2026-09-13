import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Rule = { source: string; headers: { key: string; value: string }[] };
async function configuration(mode: string): Promise<Rule[]> {
  const source = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { default?: { headers: () => Promise<Rule[]> } } = {};
  runInNewContext(code, { exports, process: { env: { NODE_ENV: mode } }, require: (name: string) => {
    assert.equal(name, "@opennextjs/cloudflare"); return { initOpenNextCloudflareForDev: () => {} };
  } });
  return JSON.parse(JSON.stringify(await exports.default!.headers()));
}
function effective(rules: Rule[], path: string) {
  const headers: Record<string, string> = {};
  for (const rule of rules) if (rule.source === "/:path*" || rule.source === path || rule.source === "/charmville/runtime/:path*" && path.startsWith("/charmville/runtime/"))
    for (const header of rule.headers) headers[header.key] = header.value;
  return headers;
}
test("production world and runtime both establish cross-origin isolation with sameorigin frames", async () => {
  const rules = await configuration("production");
  for (const path of ["/charmville/world", "/charmville/runtime/r03/play", "/charmville/runtime/r03/zplayer.js"]) {
    const h = effective(rules, path);
    assert.equal(h["Cross-Origin-Opener-Policy"], "same-origin"); assert.equal(h["Cross-Origin-Embedder-Policy"], "require-corp");
    assert.match(h["Permissions-Policy"], /cross-origin-isolated=\(self\)/);
    assert.match(h["Permissions-Policy"], /microphone=\(self\)/);
    assert.doesNotMatch(h["Content-Security-Policy"], /localhost|127\.0\.0\.1/);
  }
  assert.match(effective(rules, "/charmville/world")["Content-Security-Policy"], /frame-src 'self'/);
});
test("protected runtime allows WASM and sameorigin workers without broad eval or external destinations", async () => {
  const h = effective(await configuration("production"), "/charmville/runtime/r03/zplayer.js");
  assert.match(h["Content-Security-Policy"], /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'/);
  assert.match(h["Content-Security-Policy"], /worker-src 'self'/);
  assert.match(h["Content-Security-Policy"], /connect-src 'self'/);
  assert.match(h["Content-Security-Policy"], /media-src 'self' blob:/);
  assert.match(h["Content-Security-Policy"], /frame-ancestors 'self'/);
  assert.doesNotMatch(h["Content-Security-Policy"], /'unsafe-eval'|https:|wss:|worker-src[^;]*blob:/);
  assert.equal(h["Cross-Origin-Resource-Policy"], "same-origin"); assert.equal(h["Cache-Control"], "private, no-store");
});
test("development supports both reviewed local engines without relaxing production or marketing headers", async () => {
  const dev = await configuration("development"), prod = await configuration("production");
  const h = effective(dev, "/charmville/world");
  for (const port of [3021,3024]) {
    assert.ok(h["Content-Security-Policy"].includes(`http://localhost:${port}`));
    assert.ok(h["Permissions-Policy"].includes(`"http://localhost:${port}"`));
  }
  assert.match(h["Content-Security-Policy"], /ws:\/\/127\.0\.0\.1:3023/);
  assert.deepEqual(effective(dev, "/plankspace"), effective(prod, "/plankspace"));
  assert.equal(effective(prod, "/plankspace")["Cross-Origin-Opener-Policy"], undefined);
  assert.match(effective(prod, "/plankspace")["Permissions-Policy"], /microphone=\(\)/);
});
