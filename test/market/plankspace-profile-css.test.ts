import assert from "node:assert/strict";
import test from "node:test";

import { compileProfileCss } from "../../integrations/plankspace-app/app/customization/profile-css";
import { customProfileCss } from "../../integrations/plankspace-app/app/custom-profile-css-v2";

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
