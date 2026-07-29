import fs from "node:fs";
import path from "node:path";

const ZID = "8491542c778c1f2325bcfe393d8eb587";
const ACCOUNT = "06475b600e80399c135115cc2d31eeb7";

function token() {
  const p = path.join(
    process.env.APPDATA,
    "xdg.config/.wrangler/config/default.toml"
  );
  const t = fs.readFileSync(p, "utf8");
  const m = t.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("no wrangler token");
  return m[1];
}

async function cf(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// Nudge Cloudflare to re-check NS
const act = await cf(`/zones/${ZID}/activation_check`, { method: "PUT" });
console.log(
  "activation_check:",
  act.success,
  act.errors?.[0]?.message || "",
  act.messages?.[0]?.message || ""
);

const z = await cf(`/zones/${ZID}`);
console.log("zone status:", z.result?.status);
console.log("expected NS:", z.result?.name_servers?.join(", "));
console.log("original NS:", z.result?.original_name_servers?.join(", "));

const dns = await fetch(
  "https://cloudflare-dns.com/dns-query?name=plank.love&type=NS",
  { headers: { Accept: "application/dns-json" } }
).then((r) => r.json());
console.log(
  "public NS (1.1.1.1):",
  (dns.Answer || []).map((a) => a.data).join(", ") || "(none yet)"
);

// If active, attach worker custom domains
if (z.result?.status === "active") {
  for (const hostname of ["plank.love", "www.plank.love"]) {
    const existing = await cf(
      `/accounts/${ACCOUNT}/workers/domains?hostname=${hostname}`
    );
    const hit = (existing.result || []).find((d) => d.hostname === hostname);
    if (hit) {
      console.log("domain already attached:", hostname, "→", hit.service);
      continue;
    }
    const put = await cf(`/accounts/${ACCOUNT}/workers/domains`, {
      method: "PUT",
      body: {
        hostname,
        service: "plank-love",
        environment: "production",
        zone_id: ZID,
      },
    });
    if (put.success) {
      console.log("attached custom domain:", hostname);
    } else {
      console.log(
        "attach failed",
        hostname,
        put.errors?.map((e) => e.message).join("; ")
      );
    }
  }
} else {
  console.log("\nZone not active yet — wait for NS propagation, then re-run.");
}
