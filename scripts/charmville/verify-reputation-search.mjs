import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { chromium } from "playwright";

const database = new URL(process.env.CHARMVILLE_TEST_DATABASE_URL);
const base = new URL(process.env.CHARMVILLE_TEST_BASE_URL || "http://localhost:3017");
if (![database.hostname, base.hostname].every(host => ["localhost", "127.0.0.1"].includes(host))) throw Error("Local isolated verification only");
const pool = new Pool({ connectionString: database.href });
const browser = await chromium.launch({ headless: true });
const wallet = `0x${randomBytes(20).toString("hex")}`, handle = `search_${randomBytes(5).toString("hex")}`;
try {
  await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,'Pine search check','approved')", [wallet, handle]);
  const targetPost=await pool.query("INSERT INTO plankspace_posts(author_wallet,body) VALUES($1,$2) RETURNING id::text", [wallet, `A reputation search pine from ${handle}`]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => localStorage.setItem("plankspace-terms-2026-08-22-v1", "accepted"));
  await page.goto(`${base.origin}/search`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Find pines by reputation" }).waitFor();
  await page.getByLabel("Words or author").fill(handle);
  await page.getByRole("button", { name: "Find pines", exact: true }).click();
  await page.getByText("1 matching pine from 1 searched.", { exact: true }).waitFor({ timeout: 45000 });
  assert.equal(await page.getByText("0 stalk stamps", { exact: true }).count(), 1);
  await page.getByLabel("Rule 1 value", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Find pines", exact: true }).click();
  await page.getByText("No pines match yet.", { exact: false }).waitFor();
  await page.getByLabel("Rule 1 comparison", { exact: true }).selectOption("between");
  await page.getByLabel("Rule 1 minimum", { exact: true }).fill("0");
  await page.getByLabel("Rule 1 maximum", { exact: true }).fill("0");
  await page.getByLabel("Rule 1 match", { exact: true }).selectOption("all");
  await page.getByRole("button", { name: "Add rule to 1", exact: true }).click();
  await page.getByLabel("Rule 1.2 value", { exact: true }).fill("1");
  await page.getByLabel("Rule 1.2 match", { exact: true }).selectOption("not");
  await page.getByRole("button", { name: "Find pines", exact: true }).click();
  await page.getByText("1 matching pine from 1 searched.", { exact: true }).waitFor();
  const shared = page.url();
  assert.ok(new URL(shared).searchParams.get("filter").includes('"not"'));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("1 matching pine from 1 searched.", { exact: true }).waitFor({ timeout: 45000 });
  assert.equal(await page.getByLabel("Rule 1.1 comparison", { exact: true }).inputValue(), "between");
  assert.equal(await page.getByLabel("Rule 1.2 match", { exact: true }).inputValue(), "not");
  const invalid = await page.request.get(`${base.origin}/api/charmville/reputation?minimum=-1`);
  assert.equal(invalid.status(), 400);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.getByRole("heading", { name: "Find pines by reputation" }).evaluate(el => el.closest("article").getBoundingClientRect().right <= innerWidth), "search fits mobile width");
  // A result older than the default 30-post feed must still open its exact pine.
  await pool.query("INSERT INTO plankspace_posts(author_wallet,body) SELECT $1,'Later fixture pine '||n FROM generate_series(1,31) n",[wallet]);
  await page.locator(`a[href='/u/${handle}#pine-${targetPost.rows[0].id}']`).click();
  await page.locator(`#pine-${targetPost.rows[0].id}`).waitFor();
  assert.match(await page.locator(`#pine-${targetPost.rows[0].id}`).innerText(),/A reputation search pine/);
  console.log("Reputation browser checks passed: real public pine, zero-count discovery, minimum and nested inclusive-range/NOT filtering, shared URL reload, invalid query rejection and mobile layout.");
} finally {
  await browser.close();
  await pool.query("DELETE FROM plankspace_posts WHERE author_wallet=$1", [wallet]);
  await pool.query("DELETE FROM plankspace_profiles WHERE wallet=$1", [wallet]);
  await pool.end();
}
