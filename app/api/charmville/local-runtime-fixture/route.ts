import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { postgresPool } from "@/lib/postgres";
import { readGameSession } from "@/lib/charmville/account-session";
import { LOCAL_RUNTIME_FIXTURE_DATABASE, LOCAL_RUNTIME_FIXTURE_ORIGIN, localRuntimeFixtureRequestAllowed } from "./policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

/** Local synthetic credential handoff only. No fixture is minted by this route. */
export async function POST(request: Request) {
  if (!localRuntimeFixtureRequestAllowed(request, process.env)) return Response.json({ error: "Not found" }, { status: 404, headers });
  try {
    const filename = path.resolve(process.env.CHARMVILLE_RUNTIME_FIXTURE_FILE!);
    const directory = path.dirname(filename), temp = await realpath(tmpdir());
    if (path.basename(filename) !== "fixture.json" || !/^charmville-runtime-fixture-[A-Za-z0-9]+$/.test(path.basename(directory)) ||
      path.dirname(await realpath(directory)) !== temp) throw new Error("Invalid fixture path");
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid fixture file");
    const fixture = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
    if (fixture.schemaVersion !== 1 || fixture.synthetic !== true || fixture.purpose !== "isolated-runtime-browser-acceptance" ||
      fixture.baseUrl !== LOCAL_RUNTIME_FIXTURE_ORIGIN || fixture.database !== LOCAL_RUNTIME_FIXTURE_DATABASE ||
      typeof fixture.token !== "string" || !/^[a-f0-9]{64}$/.test(fixture.token) ||
      typeof fixture.wallet !== "string" || !/^0x[a-f0-9]{40}$/.test(fixture.wallet) ||
      typeof fixture.handle !== "string" || !/^runtime_test_[a-f0-9]{12}$/.test(fixture.handle) ||
      typeof fixture.expiresAt !== "string" || !Number.isFinite(Date.parse(fixture.expiresAt)) || Date.parse(fixture.expiresAt) <= Date.now()) throw new Error("Invalid fixture");
    const db = postgresPool();
    if ((await db.query("SELECT current_database() AS name")).rows[0]?.name !== LOCAL_RUNTIME_FIXTURE_DATABASE) throw new Error("Wrong database");
    const identity = await readGameSession(db, fixture.token);
    if (identity.profileId !== fixture.profileId || identity.handle !== fixture.handle) throw new Error("Fixture identity mismatch");
    const wallet = (await db.query("SELECT wallet FROM plankspace_profiles WHERE id=$1", [identity.profileId])).rows[0]?.wallet;
    if (wallet !== fixture.wallet) throw new Error("Fixture wallet mismatch");
    return Response.json({ synthetic: true, wallet, token: fixture.token, handle: identity.handle, expiresAt: identity.expiresAt }, { headers });
  } catch {
    return Response.json({ error: "The isolated fixture is unavailable or expired. Ask the local operator to prepare it again." }, { status: 503, headers });
  }
}
