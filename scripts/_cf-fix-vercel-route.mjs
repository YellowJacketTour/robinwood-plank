import fs from "node:fs";
import path from "node:path";

const ACCOUNT = "06475b600e80399c135115cc2d31eeb7";
const ZID = "8491542c778c1f2325bcfe393d8eb587";
const SCRIPT = "plank-love";

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
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, status: res.status, preview: text.slice(0, 400) };
  }
}

async function main() {
  // Full DNS inventory
  const dns = await cf(`/zones/${ZID}/dns_records?per_page=100`);
  console.log("DNS success:", dns.success, "count:", (dns.result || []).length);
  for (const r of dns.result || []) {
    console.log(
      JSON.stringify({
        id: r.id,
        type: r.type,
        name: r.name,
        content: r.content,
        proxied: r.proxied,
        ttl: r.ttl,
        comment: r.comment,
      })
    );
  }

  // Worker routes on zone
  const routes = await cf(`/zones/${ZID}/workers/routes`);
  console.log("\nWorker routes:", JSON.stringify(routes.result || routes.errors, null, 2));

  // Custom domains for worker
  const domains = await cf(`/accounts/${ACCOUNT}/workers/domains`);
  console.log(
    "\nWorker custom domains:",
    JSON.stringify(
      (domains.result || []).filter((d) => String(d.hostname || "").includes("plank")),
      null,
      2
    )
  );

  // Page rules / redirect rules
  const pageRules = await cf(`/zones/${ZID}/pagerules`);
  console.log("\nPage rules:", JSON.stringify(pageRules.result || pageRules.errors, null, 2).slice(0, 2000));

  // Rulesets (redirects, etc.)
  const rulesets = await cf(`/zones/${ZID}/rulesets`);
  console.log(
    "\nRulesets:",
    JSON.stringify(
      (rulesets.result || []).map((r) => ({ id: r.id, name: r.name, phase: r.phase, kind: r.kind })),
      null,
      2
    )
  );

  // Origin / custom hostnames
  const customHostnames = await cf(`/zones/${ZID}/custom_hostnames?per_page=50`);
  console.log(
    "\nCustom hostnames:",
    JSON.stringify(customHostnames.result || customHostnames.errors, null, 2).slice(0, 1500)
  );

  // Zone settings that might matter
  for (const setting of ["ssl", "always_use_https", "min_tls_version", "proxy_read_timeout"]) {
    const s = await cf(`/zones/${ZID}/settings/${setting}`);
    console.log(`setting ${setting}:`, s.result?.value ?? s.errors);
  }

  // Public DNS multi-resolver
  for (const resolver of [
    "https://cloudflare-dns.com/dns-query",
    "https://dns.google/resolve",
  ]) {
    for (const name of ["plank.love", "www.plank.love"]) {
      for (const type of ["A", "AAAA", "CNAME", "NS"]) {
        const url =
          resolver.includes("google")
            ? `${resolver}?name=${name}&type=${type}`
            : `${resolver}?name=${name}&type=${type}`;
        const r = await fetch(url, { headers: { Accept: "application/dns-json" } });
        const j = await r.json();
        const ans = (j.Answer || []).map((a) => a.data).join(", ");
        if (ans) console.log(`DNS ${resolver.includes("google") ? "google" : "cf"} ${name} ${type}:`, ans);
      }
    }
  }

  // Live response headers - look for vercel vs cloudflare
  for (const url of [
    "https://plank.love/",
    "https://plank.love/market",
    "https://www.plank.love/",
    "http://plank.love/",
  ]) {
    try {
      const r = await fetch(url, {
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
          Accept: "text/html",
        },
      });
      const body = await r.text();
      const server = r.headers.get("server");
      const vercelId = r.headers.get("x-vercel-id") || r.headers.get("x-vercel-error");
      const cfRay = r.headers.get("cf-ray");
      const paused = /temporarily paused|DEPLOYMENT/i.test(body);
      console.log(
        "\nLIVE",
        url,
        "status",
        r.status,
        "server",
        server,
        "vercel",
        vercelId,
        "cf-ray",
        cfRay,
        "paused?",
        paused,
        "body snippet:",
        body.replace(/\s+/g, " ").slice(0, 120)
      );
    } catch (e) {
      console.log("LIVE fail", url, e.message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
