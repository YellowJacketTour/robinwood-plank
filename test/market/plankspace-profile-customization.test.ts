import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProfileCustomization } from "../../integrations/plankspace-app/app/customization/profile-customization";

test("stores raw profile CSS separately from sandboxed custom HTML", () => {
  const result = normalizeProfileCustomization({ customCss: ".plankspace-profile{background:#090b14}", customHtml: "<h2>Hello</h2>" });
  assert.equal(result.customCss, ".plankspace-profile{background:#090b14}");
  assert.equal(result.customHtml, "<h2>Hello</h2>");
  assert.match(result.compiledCss, /\.classic-profile/);
});

test("migrates legacy style blocks but does not render them as custom-space content", () => {
  const result = normalizeProfileCustomization({ customHtml: "<style>.module-feed{color:#fff}</style><p>About me</p>" });
  assert.equal(result.customCss, ".module-feed{color:#fff}");
  assert.equal(result.customHtml, "<p>About me</p>");
  assert.match(result.compiledCss, /\.classic-profile \.module-feed/);
});

test("does not mistake TypeScript exports for valid profile CSS", () => {
  const result = normalizeProfileCustomization({ customCss: "export const CSS = `.plankspace-profile{color:red}`;" });
  assert.equal(result.compiledCss, "");
  assert.ok(result.warnings.length > 0);
});

test("clearing CSS restores the default profile stylesheet", () => {
  const result = normalizeProfileCustomization({ customCss: "", customHtml: "<p>Kept</p>" });
  assert.equal(result.compiledCss, "");
  assert.equal(result.customHtml, "<p>Kept</p>");
});
