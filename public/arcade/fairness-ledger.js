const MAX_LEDGER_ENTRIES = 200;

function proofKey(entry) {
  return `${entry.roomId}:${entry.round}`;
}

function validHex(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function normalizeFairnessEntry(input) {
  if (!input || typeof input !== "object") throw new TypeError("proof entry required");
  const entry = {
    roomId: String(input.roomId || ""),
    round: String(input.round || ""),
    commitment: String(input.commitment || ""),
    reveal: String(input.reveal || ""),
    crashBps: String(input.crashBps || ""),
    verifiedAt: String(input.verifiedAt || new Date().toISOString()),
  };
  if (!entry.roomId || !/^\d+$/.test(entry.round) || !validHex(entry.commitment) ||
      !validHex(entry.reveal) || !/^\d+$/.test(entry.crashBps)) {
    throw new RangeError("invalid settled-round proof");
  }
  return entry;
}

/**
 * Append-only browser evidence ledger. A second proof for the same table/round
 * must be byte-identical; otherwise the caller receives an equivocation error
 * instead of silently replacing history.
 */
export function appendFairnessEntry(entries, input, maxEntries = MAX_LEDGER_ENTRIES) {
  if (!Array.isArray(entries)) throw new TypeError("ledger must be an array");
  const entry = normalizeFairnessEntry(input);
  const existing = entries.find((candidate) => proofKey(candidate) === proofKey(entry));
  if (existing) {
    const same = existing.commitment === entry.commitment && existing.reveal === entry.reveal && existing.crashBps === entry.crashBps;
    if (!same) throw new Error(`FAIRNESS_EQUIVOCATION:${proofKey(entry)}`);
    return entries.slice();
  }
  return [...entries, entry].slice(-Math.max(1, maxEntries));
}

export function readFairnessLedger(storage, key = "plankcrash:fairness-ledger:v1") {
  try {
    const value = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(value) ? value.map(normalizeFairnessEntry) : [];
  } catch (_) {
    return [];
  }
}

export function persistFairnessEntry(storage, input, key = "plankcrash:fairness-ledger:v1") {
  const entries = appendFairnessEntry(readFairnessLedger(storage, key), input);
  storage.setItem(key, JSON.stringify(entries));
  return entries;
}

