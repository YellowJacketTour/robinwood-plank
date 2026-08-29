import {
  getConnectedAccounts,
  getEthereumProvider,
} from "@/lib/wallet";
import {
  walletProofMessage,
  walletProofPayloadHash,
  type WalletProof,
} from "@/lib/wallet-proof";
import { readApiJson } from "./api-client";

const SESSION_DOMAIN = "plankspace-session";
const SESSION_ACTION = "create";
const SESSION_HOURS = 12;
const key = (wallet: string) => `plankspace-session:${wallet.toLowerCase()}`;

function utf8Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  return (
    "0x" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

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

/**
 * Sign through the exact provider plank.love currently owns.
 *
 * We intentionally re-read eth_accounts immediately before personal_sign.
 * That prevents a cached PlankSpace/localStorage address from being signed by
 * a different account after the user changes accounts in the wallet.
 *
 * personal_sign receives a hex-encoded UTF-8 message. This is the wallet-safe
 * EIP-191 representation expected by injected + WalletConnect providers.
 * Server verification still verifies the original human-readable message.
 */
async function buildPlankSpaceProof(
  expectedWallet: string,
  payload: Record<string, unknown>,
): Promise<WalletProof> {
  const provider = getEthereumProvider();
  if (!provider) {
    throw new Error("The connected plank.love wallet provider is unavailable.");
  }

  const accounts = await getConnectedAccounts();
  const activeWallet = (accounts[0] || "").toLowerCase();

  if (!/^0x[a-f0-9]{40}$/.test(activeWallet)) {
    throw new Error("Reconnect your wallet from the plank.love navigation.");
  }

  if (activeWallet !== expectedWallet.toLowerCase()) {
    // Never sign against stale PlankSpace state. The master wallet/provider
    // is authoritative.
    localStorage.removeItem(key(expectedWallet));
    localStorage.removeItem("plankspace-last-verified-wallet");
    throw new Error(
      `PlankSpace had a stale wallet (${expectedWallet.slice(0, 6)}…${expectedWallet.slice(-4)}). ` +
        `The active plank.love wallet is ${activeWallet.slice(0, 6)}…${activeWallet.slice(-4)}. Reload and try again.`,
    );
  }

  const timestamp = Date.now();
  const payloadJson = JSON.stringify(payload);
  const message = walletProofMessage(
    SESSION_DOMAIN,
    SESSION_ACTION,
    timestamp,
    walletProofPayloadHash(payloadJson),
  );

  const signature = (await provider.request({
    method: "personal_sign",
    params: [utf8Hex(message), activeWallet],
  })) as string;

  if (!signature || typeof signature !== "string") {
    throw new Error("The wallet did not return a verification signature.");
  }

  return {
    address: activeWallet,
    timestamp,
    signature,
  };
}

async function createSession(wallet: string) {
  const normalized = wallet.toLowerCase();

  const payload = {
    wallet: normalized,
    scope: "plankspace",
    durationHours: SESSION_HOURS,
  };

  const proof = await buildPlankSpaceProof(normalized, payload);

  const sessionResponse = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet: normalized,
      payload,
      proof,
    }),
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
  localStorage.setItem("plankspace-last-verified-wallet", normalized);
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

/** Resolve the public board owned by an already-verified local session. */
export async function savedProfileHandle(wallet: string) {
  const normalized = wallet.toLowerCase();
  const token = localStorage.getItem(key(normalized)) || "";
  if (!token) return "";
  const response = await fetch(`/api/auth/session?wallet=${encodeURIComponent(normalized)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const result = await readApiJson<{ active?: boolean; handle?: string }>(response, "Could not find your PlankSpace profile.").catch((): { active?: boolean; handle?: string } => ({}));
  if (result.active && typeof result.handle === "string") return result.handle;
  const xStatus = await fetch(`/api/x/status?wallet=${encodeURIComponent(normalized)}`)
    .then((item) => item.json() as Promise<{ handle?: string }>)
    .catch((): { handle?: string } => ({}));
  return typeof xStatus.handle === "string" ? xStatus.handle : "";
}
