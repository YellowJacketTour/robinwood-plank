import fs from "node:fs";
import path from "node:path";

const p = path.join(
  process.env.APPDATA,
  "xdg.config/.wrangler/config/default.toml"
);
const t = fs.readFileSync(p, "utf8");
const m = t.match(/oauth_token\s*=\s*"([^"]+)"/);
const tok = m[1];
const ZID = "8491542c778c1f2325bcfe393d8eb587";

const z = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZID}`, {
  headers: { Authorization: `Bearer ${tok}` },
}).then((r) => r.json());

console.log(
  JSON.stringify(
    {
      name: z.result?.name,
      status: z.result?.status,
      paused: z.result?.paused,
      name_servers: z.result?.name_servers,
      original_name_servers: z.result?.original_name_servers,
    },
    null,
    2
  )
);

// activation check
const act = await fetch(
  `https://api.cloudflare.com/client/v4/zones/${ZID}/activation_check`,
  {
    method: "PUT",
    headers: { Authorization: `Bearer ${tok}` },
  }
).then((r) => r.json());
console.log("activation_check:", act.success, act.errors, act.messages);
