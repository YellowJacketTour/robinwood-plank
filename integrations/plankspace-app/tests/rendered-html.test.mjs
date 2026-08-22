import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("build emits a deployable worker and PlankSpace metadata",async()=>{
 const [worker,manifest,layout]=await Promise.all([
  readFile(new URL("../dist/server/index.js",import.meta.url),"utf8"),
  readFile(new URL("../dist/.openai/hosting.json",import.meta.url),"utf8"),
  readFile(new URL("../app/layout.tsx",import.meta.url),"utf8"),
 ]);
 assert.match(worker,/export\s*\{[^}]*default/);
 assert.equal(JSON.parse(manifest).d1,"DB");
 assert.match(layout,/title:\{default:"PlankSpace"/);
 assert.doesNotMatch(layout,/codex-preview/);
});

test("worker applies browser security headers",async()=>{
 const worker=await readFile(new URL("../worker/index.ts",import.meta.url),"utf8");
 assert.match(worker,/X-Content-Type-Options/);
 assert.match(worker,/frame-ancestors https:\/\/plank\.love/);
 assert.match(worker,/Permissions-Policy/);
});

test("social persistence and wallet session protections are included",async()=>{
 const [migration,sessionMigration,moderationMigration,bridge]=await Promise.all([
  readFile(new URL("../drizzle/0008_colossal_skrulls.sql",import.meta.url),"utf8"),
  readFile(new URL("../drizzle/0019_wallet_sessions.sql",import.meta.url),"utf8"),
  readFile(new URL("../drizzle/0020_profile_moderation_settings.sql",import.meta.url),"utf8"),
  readFile(new URL("../app/plank-love-wallet.ts",import.meta.url),"utf8"),
 ]);
 for(const table of ["board_messages","notifications","reports","game_scores","owner_access_attempts"])assert.ok(migration.includes("CREATE TABLE `"+table+"`"));
 assert.match(sessionMigration,/CREATE TABLE `wallet_sessions`/);
 assert.match(moderationMigration,/CREATE TABLE IF NOT EXISTS `site_settings`/);
 assert.doesNotMatch(bridge,/owner-access|admin-access|PIN/);
 assert.doesNotMatch(bridge,/endsWith\("\.chatgpt\.site"\)/);
});

test("wallet-only admins can approve profiles and control auto approval",async()=>{
 const [adminPage,adminRoute,profilesRoute,adminTab]=await Promise.all([
  readFile(new URL("../app/admin/page.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/api/admin/profiles/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/api/profiles/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/admin-nav-link.tsx",import.meta.url),"utf8"),
 ]);
 for(const wallet of ["0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d","0x7304b78e28370f45fdf77ca67bdbbf550c3aac34"]){assert.match(adminRoute,new RegExp(wallet));assert.match(adminTab,new RegExp(wallet))}
 assert.match(adminPage,/All accounts approved/);
 assert.match(adminPage,/Approve all pending now/);
 assert.match(adminRoute,/Verified admin wallet required/);
 assert.match(profilesRoute,/auto_approve_profiles/);
});

test("every completed social feature has a real route",async()=>{
 for(const route of ["mail","notifications","content","mood","scores","layout-asset"]){
  const source=await readFile(new URL(`../app/api/${route}/route.ts`,import.meta.url),"utf8");
  assert.match(source,/export async function/);
 }
});
