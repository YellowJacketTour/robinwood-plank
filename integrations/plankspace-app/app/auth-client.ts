import { buildWalletProof } from "@/lib/wallet-proof-client";
import { readApiJson } from "./api-client";

const SESSION_DOMAIN = "plankspace-session";
const SESSION_ACTION = "create";
const key = (wallet: string) => `plankspace-session:${wallet.toLowerCase()}`;

async function activeToken(wallet: string) {
  const token = localStorage.getItem(key(wallet)) || "";
  if (!token) return "";

  const response = await fetch(
    `/api/auth/session?wallet=${encodeURIComponent(wallet)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  const result = await readApiJson<{ active?: boolean }>(
    response,
    "Could not check the saved PlankSpace session.",
  ).catch(() => ({ active: false }));

  if (result.active) return token;

  localStorage.removeItem(key(wallet));
  return "";
}

async function createSession(wallet: string) {
  const normalized = wallet.toLowerCase();

  // Use plank.love master's canonical EIP-191 wallet proof implementation.
  // The exact payload string below is reconstructed server-side and verified
  // through lib/wallet-proof.ts, so PlankSpace cannot drift into a second
  // signature scheme again.
  const payload = {
    wallet: normalized,
    scope: "plankspace",
    durationHours: 12,
  };

  const proof = await buildWalletProof(
    normalized,
    SESSION_DOMAIN,
    SESSION_ACTION,
    payload,
  );

  const sessionResponse = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: normalized, payload, proof }),
  });

  const session = await readApiJson<{
    token?: string;
    wallet?: string;
    expiresAt?: string;
    error?: string;
  }>(sessionResponse, "Wallet verification failed.");

  if (!session.token) {
    throw new Error(session.error || "Wallet verification failed.");
  }

  localStorage.setItem(key(normalized), session.token);
  return session.token;
}

export async function walletProof(
  wallet: string,
  _action: string,
  _resource: string,
  _payload: unknown,
) {
  void _action;
  void _resource;
  void _payload;

  const normalized = wallet.toLowerCase();
  const sessionToken =
    (await activeToken(normalized)) || (await createSession(normalized));

  return { wallet: normalized, sessionToken };
}

/** Reuse an already-verified wallet session without opening a signing prompt. */
export async function savedWalletProof(wallet: string) {
  const normalized = wallet.toLowerCase();
  const sessionToken = await activeToken(normalized);
  return sessionToken ? { wallet: normalized, sessionToken } : {};
}
