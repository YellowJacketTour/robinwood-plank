import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { compileProfileCss } from "../../integrations/plankspace-app/app/customization/profile-css";
import { customProfileCss } from "../../integrations/plankspace-app/app/custom-profile-css-v2";
import { CYBERPUNK_PROFILE_CSS } from "../../integrations/plankspace-app/app/customization/default-profile-css";

test("profile CSS changes layout only beneath the PlankSpace profile root", () => {
  const result = compileProfileCss(`
    .module-feed { display: grid; gap: 12px; animation: signal 2s linear infinite; }
    .profile-columns { grid-template-columns: 260px 1fr; }
    @keyframes signal { from { opacity: .8 } to { opacity: 1 } }
  `);

  assert.match(result.css, /\.classic-profile \.module-feed/);
  assert.match(result.css, /display:\s*grid/);
  assert.match(result.css, /grid-template-columns:\s*260px 1fr/);
  assert.match(result.css, /@keyframes signal/);
  assert.deepEqual(result.warnings, []);
});

test("profile root rules outrank the built-in two-class theme selector", () => {
  const result = compileProfileCss(".plankspace-profile{background:#090b14;color:#fff}");
  assert.match(result.css, /\.classic-profile\.classic-profile/);
});

test("profile CSS cannot hide protected PlankSpace controls", () => {
  const result = compileProfileCss(`
    .plankspace-protected { display: none; }
    .module-feed { color: #00f3ff; }
  `);

  assert.doesNotMatch(result.css, /plankspace-protected/);
  assert.match(result.css, /\.classic-profile \.module-feed/);
  assert.ok(result.warnings.some((warning) => warning.includes("protected")));
});

test("profile CSS rejects viewport overlays and executable resources", () => {
  const result = compileProfileCss(`
    .module-custom { position: fixed; inset: 0; background: url(javascript:alert(1)); }
  `);

  assert.equal(result.css, "");
  assert.ok(result.warnings.some((warning) => warning.includes("position: fixed")));
  assert.ok(result.warnings.some((warning) => warning.includes("unsafe URL")));
});

test("removing profile CSS restores the default by producing no stylesheet", () => {
  assert.deepEqual(compileProfileCss("  \n /* cleared */ "), { css: "", warnings: [] });
});

test("legacy combined HTML and CSS can rearrange the full existing profile", () => {
  const css = customProfileCss(`
    <style>
      .profile-columns { display:grid; grid-template-columns: 290px 1fr; gap: 18px; }
      .module-feed { order: -1; border-color: #00f3ff; }
    </style>
    <section>Custom content remains separate.</section>
  `);

  assert.match(css, /\.classic-profile > main/);
  assert.match(css, /display:\s*grid/);
  assert.match(css, /order:\s*-1/);
});

test("complete style snippets and raw CSS are both accepted", () => {
  const wrapped = compileProfileCss(`
    <!-- SpaceHey layout -->
    <style>.profile-info { color: hotpink; }</style>
    <style>.profile .contact { border: 2px solid hotpink; }</style>
    <a href="https://example.com">layout credit</a>
  `);
  const raw = compileProfileCss(".profile-info { color: hotpink; }");

  assert.match(wrapped.css, /\.classic-profile \.identity/);
  assert.match(wrapped.css, /\.classic-profile\.classic-profile \.contact/);
  assert.doesNotMatch(wrapped.css, /<style|<a\b/i);
  assert.match(raw.css, /\.classic-profile \.identity/);
});

test("SpaceHey profile selectors map to PlankSpace modules without reaching site chrome", () => {
  const result = compileProfileCss(`
    body { background: black; color: white; }
    .general-about, .blurbs { border: 2px solid hotpink; }
    .profile .mood { background: black; }
    .profile .url-info { color: grey; }
    .table-section, table.details-table { background: transparent; }
    nav .links, footer { color: hotpink; }
  `);

  assert.match(result.css, /\.classic-profile\.classic-profile\s*\{/);
  assert.match(result.css, /\.classic-profile \.about/);
  assert.match(result.css, /\.classic-profile\.classic-profile \.status/);
  assert.match(result.css, /\.classic-profile\.classic-profile \.url/);
  assert.match(result.css, /\.classic-profile \.interests/);
  assert.doesNotMatch(result.css, /nav \.links|footer/);
  assert.ok(result.warnings.some((warning) => warning.includes("site chrome")));
});

test("SpaceHey fixed background effects are retained as profile-local absolute effects", () => {
  const result = compileProfileCss(`
    @keyframes slide { to { transform: translate(-400px, 400px); } }
    body::after {
      content: "";
      position: fixed;
      inset: -500px;
      background: url("https://images.example/pattern.png");
      animation: slide 20s linear infinite;
      z-index: -1;
    }
  `);

  assert.match(result.css, /\.classic-profile\.classic-profile::after/);
  assert.match(result.css, /position:\s*absolute/);
  assert.doesNotMatch(result.css, /position:\s*fixed/);
  assert.match(result.css, /@keyframes slide/);
});

test("bundled profile example overrides the semantic skin used by module interiors", () => {
  const css = compileProfileCss(CYBERPUNK_PROFILE_CSS).css;

  assert.match(css, /--profile-bg:\s*#090b14\s*!important/);
  assert.match(css, /--profile-panel:\s*#0d1224\s*!important/);
  assert.match(css, /--profile-text:\s*#e9fbff\s*!important/);
  assert.match(css, /--profile-link:\s*#ffe56b\s*!important/);
  assert.match(css, /--profile-heading:\s*#35f2ff\s*!important/);
  assert.match(css, /--profile-font:\s*var\(--font-body\)\s*!important/);
});

test("semantic profile colors reach legacy nested surfaces without leaking outside the profile", () => {
  const globalCss = readFileSync(
    resolve(process.cwd(), "integrations/plankspace-app/app/globals.css"),
    "utf8",
  );

  assert.match(globalCss, /\.classic-profile\.classic-profile :where\([^)]*\.feed article[^)]*\.interests dd/);
  assert.match(globalCss, /\.classic-profile\.classic-profile \.interests dt\{[^}]*--profile-accent/);
  assert.match(globalCss, /\.classic-profile\.classic-profile \.contact \.board-actions button\{[^}]*--profile-link/);
  assert.doesNotMatch(globalCss, /(?:^|[},])\s*\.interests dd\{[^}]*--profile-panel/m);
});
