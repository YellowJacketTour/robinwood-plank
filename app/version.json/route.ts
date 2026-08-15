import { publicJson } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The build the server is currently running. Polled by
 * components/VersionUpdatePrompt.tsx to tell a stale tab it is stale.
 *
 * SEPARATE FROM /api/health ON PURPOSE. Health reports the same version, so
 * this looks redundant — but health also probes Postgres and reports OpenSea
 * key status. Polling it every 5 minutes from every open tab would put real
 * database load behind a question that needs no database. This route reads
 * one environment variable and returns.
 *
 * DEPLOYMENT_VERSION is the release SHA in production: CI sets it at build
 * time, and deploy/inmotion/passenger.cjs re-derives it at runtime from the
 * SHA-named release directory. Unset in local dev, which returns "unknown"
 * and makes the whole feature inert rather than prompting against a marker
 * that never changes.
 *
 * publicJson (lib/security.ts) already sends no-store / no-cache /
 * must-revalidate. That is necessary but NOT sufficient on this host —
 * LiteSpeed in front of Passenger may cache anyway — which is why the client
 * also appends a cache-busting query param. Belt and braces, because a cached
 * version endpoint can never report a new version and the feature would fail
 * silently and permanently.
 */
export function GET() {
  const version = process.env.DEPLOYMENT_VERSION?.trim() || "unknown";
  return publicJson({ version, buildId: version });
}
