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
  assert.match(subnav, /className="plankspace-mobile-brand[^"]*"[^>]*>\s*PlankSpace\s*</);
  assert.match(subnav, /aria-expanded=/);
  assert.match(subnav, /aria-controls="plankspace-mobile-menu"/);
  for (const href of expected) assert.match(subnav, new RegExp(`href[:=].*"${href}"`));
  assert.doesNotMatch(sharedNav, /plankspace-mobile-menu|Board menu/);
});

test("profile video UI leaves navigation to the native YouTube player", () => {
  const css = read("integrations/plankspace-app/app/globals.css");
  const player = read("integrations/plankspace-app/app/profile-video-player.tsx");

  assert.doesNotMatch(css, /profile-video-choices/);
  assert.doesNotMatch(player, /data-video-choice|<button/);
  assert.match(player, /playlist/);
});

test("mobile profile remains one continuous page without added tabs or collapsible modules", () => {
  const profile = read("integrations/plankspace-app/app/u/[handle]/page.tsx");

  for (const target of ["profile-feed", "video", "profile-friends", "profile-about"]) {
    assert.match(profile, new RegExp(`id=[{]?"${target}"`));
  }
  assert.doesNotMatch(profile, /mobile-profile-jumps|mobile-profile-details|<summary>/);
});

test("mobile profile keeps visible background gutters and breathing room between modules", () => {
  const css = read("integrations/plankspace-app/app/globals.css");
  const mobileBlock = css.slice(css.indexOf("\/\* plankspace-mobile-profile \*\/"));

  assert.match(mobileBlock, /\.classic-profile\s*>\s*main\s*\{[^}]*width:\s*calc\(100%\s*-\s*32px\)[^}]*gap:\s*16px/s);
  assert.match(mobileBlock, /\.classic-profile\s+\.classic-left\s*,\s*\.classic-profile\s+\.public-modules\s*\{[^}]*gap:\s*16px/s);
});

test("new mobile profile rules stay beneath the PlankSpace boundary", () => {
  const css = read("integrations/plankspace-app/app/globals.css");
  const mobileBlock = css.slice(css.indexOf("/* plankspace-mobile-profile */"));

  assert.notEqual(mobileBlock.length, 0);
  assert.doesNotMatch(mobileBlock, /(?:^|[},])\s*(?:body|html|header|nav|main|aside|section|button)\s*[{,]/m);
  assert.match(mobileBlock, /\[data-plankspace-subnav\]/);
  assert.match(mobileBlock, /\.classic-profile/);
});

test("mobile Board menu positioning is loaded outside the native content scope", () => {
  const subnavCss = read("integrations/plankspace-app/app/plankspace-subnav.css");
  const groupedLayout = read("app/(plankspace)/layout.tsx");
  const landingLayout = read("app/plankspace/layout.tsx");

  assert.match(groupedLayout, /plankspace-subnav\.css/);
  assert.match(landingLayout, /plankspace-subnav\.css/);
  assert.match(subnavCss, /\[data-plankspace-subnav\] \.plankspace-mobile-menu\s*\{[^}]*position:\s*relative/s);
  assert.match(subnavCss, /\.plankspace-mobile-menu\s*>\s*nav\s*\{[^}]*position:\s*absolute/s);
  assert.doesNotMatch(subnavCss, /(?:^|[},])\s*(?:body|html|header|nav|main|aside|section|button)\s*[{,]/m);
});
