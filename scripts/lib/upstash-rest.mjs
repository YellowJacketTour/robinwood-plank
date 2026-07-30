const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function decodeJsonish(value) {
  if (Array.isArray(value)) return value.map(decodeJsonish);
  if (typeof value !== "string") return value;
  try {
    const decoded = JSON.parse(value);
    if (
      typeof decoded === "number" &&
      JSON_NUMBER.test(value) &&
      (!Number.isSafeInteger(decoded) || String(decoded) !== value)
    ) {
      return value;
    }
    return decoded;
  } catch {
    return value;
  }
}

function requireHttpsUpstashUrl(raw) {
  const value = raw?.trim();
  if (!value) throw new Error("Missing UPSTASH_REDIS_REST_URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".upstash.io")) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL must be an https://*.upstash.io endpoint."
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export class ReadonlyUpstashRest {
  constructor({
    url = process.env.UPSTASH_REDIS_REST_URL,
    token = process.env.UPSTASH_REDIS_REST_TOKEN,
    fetchImpl = fetch,
  } = {}) {
    this.url = requireHttpsUpstashUrl(url);
    this.token = token?.trim();
    if (!this.token) throw new Error("Missing UPSTASH_REDIS_REST_TOKEN.");
    this.fetchImpl = fetchImpl;
  }

  async command(parts) {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(parts),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Upstash REST command failed with HTTP ${response.status}.`);
    }
    const payload = await response.json();
    if (payload?.error) {
      throw new Error(`Upstash REST command failed: ${payload.error}`);
    }
    if (!payload || !Object.hasOwn(payload, "result")) {
      throw new Error("Upstash REST response did not contain a result.");
    }
    return payload.result;
  }

  async scanKeys(pattern, count = 100) {
    const keys = [];
    let cursor = "0";
    do {
      const result = await this.command([
        "SCAN",
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        String(count),
      ]);
      if (!Array.isArray(result) || result.length !== 2) {
        throw new Error("Unexpected SCAN response.");
      }
      cursor = String(result[0]);
      const page = result[1];
      if (!Array.isArray(page)) throw new Error("Unexpected SCAN key page.");
      keys.push(...page.map(String));
    } while (cursor !== "0");
    return [...new Set(keys)].sort();
  }

  async type(key) {
    return String(await this.command(["TYPE", key])).toLowerCase();
  }

  async ttl(key) {
    const ttl = Number(await this.command(["TTL", key]));
    if (!Number.isInteger(ttl)) throw new Error(`Invalid TTL for ${key}.`);
    return ttl;
  }

  async get(key) {
    return decodeJsonish(await this.command(["GET", key]));
  }

  async hgetall(key) {
    const flat = await this.command(["HGETALL", key]);
    if (!Array.isArray(flat) || flat.length % 2 !== 0) {
      throw new Error(`Invalid HGETALL response for ${key}.`);
    }
    const values = {};
    for (let index = 0; index < flat.length; index += 2) {
      values[String(flat[index])] = decodeJsonish(flat[index + 1]);
    }
    return values;
  }

  async smembers(key) {
    const members = await this.command(["SMEMBERS", key]);
    if (!Array.isArray(members)) {
      throw new Error(`Invalid SMEMBERS response for ${key}.`);
    }
    return members.map(decodeJsonish);
  }
}

export { decodeJsonish, requireHttpsUpstashUrl };
