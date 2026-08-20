import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Disabled: previous hydrator crashed the hub compile. Stats stay from sync/cron. */
export async function POST() {
  return NextResponse.json({ hydrated: 0, attempted: 0, disabled: true }, { headers: { "Cache-Control": "no-store" } });
}
