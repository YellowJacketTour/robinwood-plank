import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("mobile Board menu exposes every PlankSpace destination without changing shared Nav", () => {
  const subnav = read("integrations/plankspace-app/app/plankspace-subnav.tsx");
  const sharedNav = read("components/Nav.tsx");
  const expected = [
    "/plankspace",
    "/browse",
    "/search",
    "/woodstock",
    "/planks-list",
    "/board-mail",
    "/profile-editor",
  ];

  assert.match(subnav, />\s*Board menu\s*</);
  assert.match(subnav, /aria-expanded=/);
  assert.match(subnav, /aria-controls="plankspace-mobile-menu"/);
  for (const href of expected) assert.match(subnav, new RegExp(`href[:=].*"${href}"`));
  assert.doesNotMatch(sharedNav, /plankspace-mobile-menu|Board menu/);
});

test("mobile profile has primary jump navigation and collapsible secondary details", () => {
  const profile = read("integrations/plankspace-app/app/u/[handle]/page.tsx");

  for (const target of ["profile-feed", "video", "profile-friends", "profile-about"]) {
    assert.match(profile, new RegExp(`(?:id|href)=[{]?"#?${target}"`));
  }
  assert.match(profile, /className="mobile-profile-jumps"/);
  assert.match(profile, /className="mobile-profile-details/);
  assert.match(profile, /<summary>/);
});

test("new mobile profile rules stay beneath the PlankSpace boundary", () => {
  const css = read("integrations/plankspace-app/app/globals.css");
  const mobileBlock = css.slice(css.indexOf("/* plankspace-mobile-profile */"));

  assert.notEqual(mobileBlock.length, 0);
  assert.doesNotMatch(mobileBlock, /(?:^|[},])\s*(?:body|html|header|nav|main|aside|section|button)\s*[{,]/m);
  assert.match(mobileBlock, /\[data-plankspace-subnav\]/);
  assert.match(mobileBlock, /\.classic-profile/);
});
