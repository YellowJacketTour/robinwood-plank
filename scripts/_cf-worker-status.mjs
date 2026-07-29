import fs from "node:fs";
import path from "node:path";

const ACCOUNT = "06475b600e80399c135115cc2d31eeb7";
const SCRIPT = "plank-love";
const ZID = "8491542c778c1f2325bcfe393d8eb587";

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
    return {
      success: false,
      status: res.status,
      contentType: res.headers.get("content-type"),
      preview: text.slice(0, 300),
    };
  }
}

async function main() {
  const list = await cf(`/accounts/${ACCOUNT}/workers/scripts`);
  console.log("list scripts success:", list.success);
  const hit = (list.result || []).find((s) => s.id === SCRIPT);
  console.log("plank-love meta:", JSON.stringify(hit, null, 2));

  const deployments = await cf(
    `/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/deployments`
  );
  console.log("deployments success:", deployments.success, deployments.errors);
  const deps = deployments.result?.deployments || deployments.result || [];
  console.log(
    "latest deployment:",
    JSON.stringify(Array.isArray(deps) ? deps[0] : deps, null, 2).slice(0, 2500)
  );

  const domains = await cf(`/accounts/${ACCOUNT}/workers/domains`);
  console.log(
    "domains for plank:",
    JSON.stringify(
      (domains.result || []).filter(
        (d) =>
          d.service === SCRIPT || String(d.hostname || "").includes("plank")
      ),
      null,
      2
    )
  );

  const zone = await cf(`/zones/${ZID}`);
  console.log(
    "zone:",
    JSON.stringify(
      {
        name: zone.result?.name,
        status: zone.result?.status,
        paused: zone.result?.paused,
        type: zone.result?.type,
        plan: zone.result?.plan?.name,
        development_mode: zone.result?.development_mode,
      },
      null,
      2
    )
  );

  // Unpause zone if paused
  if (zone.result?.paused) {
    const unpause = await cf(`/zones/${ZID}`, {
      method: "PATCH",
      body: { paused: false },
    });
    console.log("zone unpause:", unpause.success, unpause.errors);
  }

  const purge = await cf(`/zones/${ZID}/purge_cache`, {
    method: "POST",
    body: { purge_everything: true },
  });
  console.log(
    "cache purge:",
    purge.success,
    purge.errors?.[0]?.message || purge.messages || "ok"
  );

  // Workers subdomain enable
  const sub = await cf(`/accounts/${ACCOUNT}/workers/subdomain`, {
    method: "PUT",
    body: { enabled: true },
  });
  console.log("workers subdomain enable:", JSON.stringify(sub).slice(0, 500));

  // Probe live from node
  for (const url of [
    "https://plank.love/",
    "https://plank.love/market",
    "https://plank-love.garden-equity-field-0042.workers.dev/",
    "https://plank-love.garden-equity-field-0042.workers.dev/market",
  ]) {
    try {
      const r = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          Accept: "text/html",
        },
      });
      const body = await r.text();
      const paused =
        /paused|temporarily unavailable|deployment is currently/i.test(body);
      console.log(
        "probe",
        url,
        r.status,
        "paused?",
        paused,
        "snippet:",
        body.replace(/\s+/g, " ").slice(0, 180)
      );
    } catch (e) {
      console.log("probe fail", url, e.message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
