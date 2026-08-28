import assert from "node:assert/strict";
import test from "node:test";
import { CYBERPUNK_PROFILE_CSS, DEFAULT_PROFILE_CSS_GUIDE } from "../../integrations/plankspace-app/app/customization/default-profile-css";

test("starter CSS documents every stable PlankSpace profile hook", () => {
  for (const hook of [".plankspace-profile", ".profile-columns", ".profile-sidebar", ".profile-main", ".module-identity", ".module-contact", ".module-url", ".module-interests", ".module-feed", ".module-widgets"]) {
    assert.match(DEFAULT_PROFILE_CSS_GUIDE, new RegExp(hook.replace(".", "\\.")));
  }
  assert.doesNotMatch(DEFAULT_PROFILE_CSS_GUIDE, /plankspace-protected|plankspace-nav|wallet/i);
});

test("cyberpunk example reskins the existing footprint without protected selectors", () => {
  assert.match(CYBERPUNK_PROFILE_CSS, /\.plankspace-profile/);
  assert.match(CYBERPUNK_PROFILE_CSS, /\.profile-columns/);
  assert.match(CYBERPUNK_PROFILE_CSS, /\.module-feed/);
  assert.doesNotMatch(CYBERPUNK_PROFILE_CSS, /position\s*:\s*fixed|plankspace-nav|wallet/i);
});
