import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/inmotion.yml"), "utf8");

test("X OAuth configuration is a manual server-only operation", () => {
  assert.match(workflow, /- configure-plankspace-x/);
  assert.match(workflow, /inputs\.operation == 'configure-plankspace-x'/);
  assert.match(workflow, /X_CLIENT_ID:\s*\$\{\{ secrets\.X_CLIENT_ID \}\}/);
  assert.match(workflow, /X_CLIENT_SECRET:\s*\$\{\{ secrets\.X_CLIENT_SECRET \}\}/);
  assert.match(workflow, /PLANKSPACE_X_TOKEN_ENCRYPTION_KEY:\s*\$\{\{ secrets\.PLANKSPACE_X_TOKEN_ENCRYPTION_KEY \}\}/);
  assert.doesNotMatch(workflow, /NEXT_PUBLIC_(?:X_CLIENT|PLANKSPACE_X_TOKEN)/);
});

test("X OAuth installer validates, atomically updates, and rolls back production env", () => {
  const job = workflow.slice(workflow.indexOf("configure-plankspace-x:"));
  assert.match(job, /base64.*32|32.*base64/s);
  assert.match(job, /\.env\.production\.bak/);
  assert.match(job, /mv -f .*env_file/s);
  assert.match(job, /touch .*restart\.txt/);
  assert.match(job, /api\/health/);
  assert.match(job, /restore|rollback/i);
  assert.match(job, /chmod 600/);
});

test("X OAuth installer allowlists only the intended runtime keys", () => {
  const job = workflow.slice(workflow.indexOf("configure-plankspace-x:"));
  for (const name of [
    "PLANKSPACE_X_PROVIDER",
    "X_CLIENT_ID",
    "X_CLIENT_SECRET",
    "X_REDIRECT_URI",
    "PLANKSPACE_X_TOKEN_ENCRYPTION_KEY",
  ]) {
    assert.match(job, new RegExp(name));
  }
  assert.doesNotMatch(job, /RELAYER_PRIVATE_KEY/);
});
