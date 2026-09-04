import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("PlankSpace preview defaults to unlisted while direct routes remain mounted", () => {
  const constants = source("lib/constants.ts");
  const nav = source("components/Nav.tsx");
  const footer = source("components/Footer.tsx");
  const sitemap = source("app/sitemap.ts");
  const layout = source("app/(plankspace)/layout.tsx");

  assert.match(constants, /NEXT_PUBLIC_PLANKSPACE_DISCOVERABLE/);
  assert.match(constants, /export const PLANKSPACE_DISCOVERABLE/);
  assert.match(constants, /===\s*["']true["']/);
  assert.match(constants, /PLANKSPACE_DISCOVERABLE[\s\S]*PLANKSPACE_URL[\s\S]*PlankSpace/);
  assert.match(nav, /NAV_LINKS\.map/);
  assert.match(footer, /PLANKSPACE_DISCOVERABLE/);
  assert.match(sitemap, /PLANKSPACE_DISCOVERABLE/);
  assert.match(layout, /index:\s*PLANKSPACE_DISCOVERABLE/);
  assert.match(layout, /follow:\s*PLANKSPACE_DISCOVERABLE/);

  for (const path of [
    "app/plankspace/page.tsx",
    "app/(plankspace)/create-profile/page.tsx",
    "app/(plankspace)/profile-editor/page.tsx",
    "app/(plankspace)/u/[handle]/page.tsx",
  ]) {
    assert.equal(existsSync(join(root, path)), true, `${path} must be directly routable`);
  }
});

test("preview mode does not add PlankSpace to the public sitemap", async () => {
  const previous = process.env.NEXT_PUBLIC_PLANKSPACE_DISCOVERABLE;
  delete process.env.NEXT_PUBLIC_PLANKSPACE_DISCOVERABLE;
  try {
    const { default: sitemap } = await import(`../../app/sitemap.ts?preview=${Date.now()}`);
    assert.equal(sitemap().some(({ url }) => url.includes("/plankspace")), false);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_PLANKSPACE_DISCOVERABLE;
    else process.env.NEXT_PUBLIC_PLANKSPACE_DISCOVERABLE = previous;
  }
});
