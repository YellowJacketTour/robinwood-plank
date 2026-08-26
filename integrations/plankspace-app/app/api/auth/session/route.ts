import { and, eq, lt } from "drizzle-orm";
import {
  verifyWalletProof,
  type WalletProof,
} from "@/lib/wallet-proof";
import { getDb } from "../../../../db";
import { walletSessions } from "../../../../db/schema";

const SESSION_DOMAIN = "plankspace-session";
const SESSION_ACTION = "create";
const SESSION_HOURS = 12;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const wallet = (url.searchParams.get("wallet") || "").toLowerCase();
    const token =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";

    if (!/^0x[a-f0-9]{40}$/.test(wallet) || !token) {
      return Response.json({ active: false });
    }

    const db = getDb();
    await db
      .delete(walletSessions)
      .where(lt(walletSessions.expiresAt, new Date().toISOString()));

    const [session] = await db
      .select()
      .from(walletSessions)
      .where(
        and(
          eq(walletSessions.tokenHash, await sha256(token)),
          eq(walletSessions.wallet, wallet),
        ),
      )
      .limit(1);

    return Response.json({
      active: Boolean(session && Date.parse(session.expiresAt) > Date.now()),
      expiresAt: session?.expiresAt || null,
    });
  } catch (error) {
    console.error("[plankspace-auth] session lookup failed", error);
    return Response.json({ active: false }, { status: 503 });
  }
}

type SessionPayload = {
  wallet?: unknown;
  scope?: unknown;
  durationHours?: unknown;
};

type SessionRequest = {
  wallet?: unknown;
  payload?: SessionPayload;
  proof?: WalletProof;
};

export async function POST(request: Request) {
  try {
    let body: SessionRequest;
    try {
      body = (await request.json()) as SessionRequest;
    } catch {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }

    const wallet =
      typeof body.wallet === "string" ? body.wallet.trim().toLowerCase() : "";

    if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
      return Response.json(
        { error: "A valid connected wallet is required" },
        { status: 403 },
      );
    }

    const payload = body.payload;
    if (
      !payload ||
      typeof payload.wallet !== "string" ||
      payload.wallet.toLowerCase() !== wallet ||
      payload.scope !== "plankspace" ||
      payload.durationHours !== SESSION_HOURS
    ) {
      return Response.json(
        { error: "Invalid PlankSpace session request" },
        { status: 403 },
      );
    }

    const proof = body.proof;
    if (
      !proof ||
      typeof proof.address !== "string" ||
      typeof proof.timestamp !== "number" ||
      typeof proof.signature !== "string"
    ) {
      return Response.json(
        { error: "A wallet signature is required" },
        { status: 403 },
      );
    }

    // IMPORTANT: use the exact same JSON serialization as the client and
    // plank.love's generic wallet-proof verifier.
    const canonicalPayload = {
      wallet,
      scope: "plankspace",
      durationHours: SESSION_HOURS,
    };

    const verified = verifyWalletProof(
      SESSION_DOMAIN,
      SESSION_ACTION,
      JSON.stringify(canonicalPayload),
      proof,
    );

    if (!verified.ok || verified.address !== wallet) {
      return Response.json(
        { error: "Wallet signature did not match the connected plank.love wallet" },
        { status: 403 },
      );
    }

    const db = getDb();

    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(
      bytes,
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const expiresAt = new Date(
      Date.now() + SESSION_HOURS * 60 * 60 * 1000,
    ).toISOString();

    // One active PlankSpace token per wallet. A successful new proof rotates
    // the previous token instead of creating parallel sessions.
    await db.delete(walletSessions).where(eq(walletSessions.wallet, wallet));
    await db.insert(walletSessions).values({
      tokenHash: await sha256(token),
      wallet,
      expiresAt,
    });

    return Response.json({ token, wallet, expiresAt });
  } catch (error) {
    console.error("[plankspace-auth] session creation failed", error);
    return Response.json(
      {
        error:
          "PlankSpace could not verify the shared plank.love wallet session.",
      },
      { status: 503 },
    );
  }
}
