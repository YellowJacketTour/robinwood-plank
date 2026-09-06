/**
 * Backstage door sign-in: POST { user, pin } -> sets the door cookie that
 * bypasses the market gate for this browser for a week. Rate-limited hard
 * per IP; never reveals which half was wrong. DELETE clears it.
 */
import { NextResponse } from "next/server";
import { rateLimit, readJsonBody } from "@/lib/security";
import { buildDoorCookieValue, verifyDoorCredentials, DOOR_COOKIE_MAX_AGE_S, DOOR_COOKIE_NAME } from "@/lib/market-preview-door";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const limited = rateLimit(req, { key: "market-door", limit: 6, windowMs: 10 * 60_000 });
  if (limited) return limited;
  let body: { user?: unknown; pin?: unknown };
  try {
    body = await readJsonBody(req);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const user = typeof body.user === "string" ? body.user : "";
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!user || !pin || !verifyDoorCredentials(user, pin)) {
    return NextResponse.json({ ok: false, error: "Not recognised." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, redirect: "/market/multichain" }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set({
    name: DOOR_COOKIE_NAME,
    value: buildDoorCookieValue(user),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DOOR_COOKIE_MAX_AGE_S,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: DOOR_COOKIE_NAME, value: "", path: "/", maxAge: 0 });
  return res;
}
