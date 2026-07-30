const MARKET_PREFIX = "plank:market:";
const SPECIAL_KEYS = new Set([
  "plank:market:listings",
  "plank:market:offers",
  "plank:market:orders",
  "plank:market:served-order-hashes",
]);
const SUPPORTED_TYPES = new Set(["string", "hash", "set"]);

function entriesCount(type, value) {
  if (type === "hash") return Object.keys(value || {}).length;
  if (type === "set") return value?.length || 0;
  return 1;
}

async function readValue(source, type, key) {
  if (type === "string") return source.get(key);
  if (type === "hash") return source.hgetall(key);
  if (type === "set") return source.smembers(key);
  throw new Error(`Unsupported source type ${type} for ${key}.`);
}

export async function readMarketSnapshot(source) {
  const keys = await source.scanKeys(`${MARKET_PREFIX}*`);
  const entries = [];
  const expiredDuringRead = [];

  for (const key of keys) {
    if (!key.startsWith(MARKET_PREFIX)) {
      throw new Error(`Refusing source key outside ${MARKET_PREFIX}: ${key}`);
    }
    const [type, ttl] = await Promise.all([source.type(key), source.ttl(key)]);
    if (type === "none" || ttl === -2) {
      expiredDuringRead.push(key);
      continue;
    }
    if (!SUPPORTED_TYPES.has(type)) {
      throw new Error(`Unsupported source type ${type} for ${key}.`);
    }
    if (ttl > 0 && type !== "string") {
      throw new Error(
        `Cannot preserve TTL=${ttl}s on ${type} key ${key}; refusing lossy import.`
      );
    }
    const value = await readValue(source, type, key);
    entries.push({
      key,
      type,
      ttl,
      capturedAt: new Date(),
      count: entriesCount(type, value),
      value,
    });
  }

  return { pattern: `${MARKET_PREFIX}*`, entries, expiredDuringRead };
}

function assertOrder(kind, value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${kind} order object in ${key}.`);
  }
  for (const field of ["id", "collectionSlug", "maker", "priceWei", "expiresAt"]) {
    if (value[field] === undefined || value[field] === null || value[field] === "") {
      throw new Error(`Order in ${key} is missing ${field}.`);
    }
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(value.maker))) {
    throw new Error(`Order ${value.id} in ${key} has an invalid maker.`);
  }
  if (!/^\d+$/.test(String(value.priceWei))) {
    throw new Error(`Order ${value.id} in ${key} has an invalid priceWei.`);
  }
  const expiresAt = new Date(value.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error(`Order ${value.id} in ${key} has an invalid expiresAt.`);
  }
  return { kind, value, key, expiresAt };
}

function addOrders(target, kind, values, key, priority) {
  for (const value of Object.values(values || {})) {
    const order = assertOrder(kind, value, key);
    const id = String(value.id);
    const existing = target.get(id);
    if (existing && existing.kind !== kind) {
      throw new Error(
        `Order id ${id} appears as both ${existing.kind} and ${kind}.`
      );
    }
    if (!existing || priority >= existing.priority) {
      target.set(id, { ...order, priority });
    }
  }
}

export function buildPostgresPlan(snapshot) {
  const byKey = new Map(snapshot.entries.map((entry) => [entry.key, entry]));
  const orders = new Map();

  const legacy = byKey.get("plank:market:orders");
  if (legacy) {
    if (legacy.type !== "string") {
      throw new Error("plank:market:orders must be a string value.");
    }
    addOrders(orders, "listing", legacy.value?.listings, legacy.key, 0);
    addOrders(orders, "offer", legacy.value?.offers, legacy.key, 0);
  }

  const listings = byKey.get("plank:market:listings");
  if (listings) {
    if (listings.type !== "hash") {
      throw new Error("plank:market:listings must be a hash.");
    }
    addOrders(orders, "listing", listings.value, listings.key, 1);
  }

  const offers = byKey.get("plank:market:offers");
  if (offers) {
    if (offers.type !== "hash") {
      throw new Error("plank:market:offers must be a hash.");
    }
    addOrders(orders, "offer", offers.value, offers.key, 1);
  }

  const servedEntry = byKey.get("plank:market:served-order-hashes");
  if (servedEntry && servedEntry.type !== "set") {
    throw new Error("plank:market:served-order-hashes must be a set.");
  }
  const servedHashes = [
    ...new Set(
      (servedEntry?.value || []).map((value) => String(value).toLowerCase())
    ),
  ];
  for (const hash of servedHashes) {
    if (!/^0x[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`Invalid served order hash ${hash}.`);
    }
  }

  const values = [];
  const hashFields = [];
  const setMembers = [];
  for (const entry of snapshot.entries) {
    if (SPECIAL_KEYS.has(entry.key)) continue;
    if (entry.type === "string") {
      values.push({
        key: entry.key,
        value: entry.value,
        expiresAt:
          entry.ttl > 0
            ? new Date(entry.capturedAt.getTime() + entry.ttl * 1_000)
            : null,
      });
    } else if (entry.type === "hash") {
      for (const [field, value] of Object.entries(entry.value || {})) {
        hashFields.push({ key: entry.key, field, value });
      }
    } else if (entry.type === "set") {
      for (const member of entry.value || []) {
        setMembers.push({ key: entry.key, member: String(member) });
      }
    }
  }

  return {
    orders: [...orders.values()].map((order) => ({
      kind: order.kind,
      value: order.value,
      key: order.key,
      expiresAt: order.expiresAt,
    })),
    servedHashes,
    values,
    hashFields,
    setMembers,
  };
}

export function expectedCounts(plan) {
  return {
    orders: plan.orders.length,
    listings: plan.orders.filter((order) => order.kind === "listing").length,
    offers: plan.orders.filter((order) => order.kind === "offer").length,
    servedHashes: plan.servedHashes.length,
    values: plan.values.length,
    hashFields: plan.hashFields.length,
    setMembers: plan.setMembers.length,
  };
}
