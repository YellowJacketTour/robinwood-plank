import assert from "node:assert/strict";
import test from "node:test";

import {
  isUsableXAccountRecord,
  refreshXAccessToken,
} from "../../integrations/plankspace-app/app/x/account";

const record = {
  accessTokenEncrypted: "encrypted-access",
  refreshTokenEncrypted: "encrypted-refresh",
};

test("live mode rejects stale demo account rows without encrypted credentials", () => {
  assert.equal(
    isUsableXAccountRecord(
      { accessTokenEncrypted: "", refreshTokenEncrypted: "" },
      "live",
    ),
    false,
  );
  assert.equal(isUsableXAccountRecord(record, "live"), true);
  assert.equal(
    isUsableXAccountRecord(
      { accessTokenEncrypted: "", refreshTokenEncrypted: "" },
      "development",
    ),
    true,
  );
});

test("expired X access tokens refresh through OAuth without exposing credentials", async () => {
  const refreshed = await refreshXAccessToken({
    refreshToken: "refresh-token",
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchImpl: async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.match(String(init?.body), /grant_type=refresh_token/);
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 7200,
      });
    },
  });

  assert.deepEqual(refreshed, {
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresIn: 7200,
  });
});
