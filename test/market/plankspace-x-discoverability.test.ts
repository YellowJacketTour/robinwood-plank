import assert from "node:assert/strict";
import test from "node:test";

import { profileToolsVisibility } from "../../integrations/plankspace-app/app/profile-tools-visibility";

test("existing profiles expose X and widget tools before wallet state arrives", () => {
  assert.equal(
    profileToolsVisibility({ editing: true, handle: "degenwaffle" }),
    true
  );
});

test("new and incomplete profiles do not expose owner tools", () => {
  assert.equal(
    profileToolsVisibility({ editing: false, handle: "degenwaffle" }),
    false
  );
  assert.equal(profileToolsVisibility({ editing: true, handle: "" }), false);
});

test("the main app mounts every PlankSpace X route", async () => {
  const [status, connect, callback, disconnect, sync] = await Promise.all([
    import("../../app/api/x/status/route"),
    import("../../app/api/x/connect/route"),
    import("../../app/api/x/callback/route"),
    import("../../app/api/x/disconnect/route"),
    import("../../app/api/x/sync/route"),
  ]);

  assert.equal(typeof status.GET, "function");
  assert.equal(typeof connect.POST, "function");
  assert.equal(typeof callback.GET, "function");
  assert.equal(typeof disconnect.POST, "function");
  assert.equal(typeof sync.POST, "function");
});
