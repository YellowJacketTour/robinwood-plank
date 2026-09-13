import { REPUTATION_FACES, validateReputationFilter, type ReputationBasis, type ReputationFace, type ReputationFilter, type ReputationMetric } from "./reputation";

export type PineSearch = { q: string; face: ReputationFace; basis: ReputationBasis; metric: ReputationMetric; minimum: string; direction: "asc" | "desc"; filter?: ReputationFilter };
export class ReputationSearchError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function parsePineSearch(params: URLSearchParams): PineSearch {
  const q = (params.get("q") ?? "").trim();
  const face = params.get("face") ?? "stalk", basis = params.get("basis") ?? "current";
  const metric = params.get("metric") ?? "totals", minimum = params.get("minimum") ?? "0", direction = params.get("direction") ?? "desc";
  if (q.length > 200 || !REPUTATION_FACES.includes(face as ReputationFace) || !["current", "lifetime"].includes(basis) || !["totals", "supporters"].includes(metric) || !/^(0|[1-9]\d{0,39})$/.test(minimum) || !["asc", "desc"].includes(direction)) throw new ReputationSearchError("Choose a valid face, count and search of at most 200 characters.");
  let filter: ReputationFilter | undefined;
  const encoded = params.get("filter");
  if (encoded !== null) {
    if (encoded.length > 16000) throw new ReputationSearchError("Your reputation filter is too large.");
    try { filter = JSON.parse(encoded); validateReputationFilter(filter!); }
    catch (error) { throw new ReputationSearchError(error instanceof Error ? error.message : "Invalid reputation filter."); }
  }
  return { q, face: face as ReputationFace, basis: basis as ReputationBasis, metric: metric as ReputationMetric, minimum, direction: direction as PineSearch["direction"], ...(filter ? { filter } : {}) };
}

/** Public, reproducible query only: session tokens never belong in a shared URL. */
export function encodePineSearch(search: PineSearch) {
  const params = new URLSearchParams({ pines: "1", q: search.q, face: search.face, basis: search.basis, metric: search.metric, direction: search.direction });
  if (search.filter) params.set("filter", JSON.stringify(search.filter));
  else params.set("minimum", search.minimum);
  parsePineSearch(params);
  return params;
}
