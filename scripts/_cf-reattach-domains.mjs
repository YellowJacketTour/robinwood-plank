import fs from "node:fs";
import path from "node:path";

const ACCOUNT = "06475b600e80399c135115cc2d31eeb7";
const ZID = "8491542c778c1f2325bcfe393d8eb587";

const t = fs.readFileSync(
  path.join(process.env.APPDATA, "xdg.config/.wrangler/config/default.toml"),
  "utf8"
);
const tok = t.match(/oauth_token\s*=\s*"([^"]+)"/)[1];

for (const hostname of ["plank.love", "www.plank.love"]) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/domains`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hostname,
        service: "plank-love",
        environment: "production",
        zone_id: ZID,
      }),
    }
  );
  const j = await r.json();
  console.log(
    hostname,
    r.status,
    j.success,
    j.errors?.[0]?.message || j.result?.id
  );
}
