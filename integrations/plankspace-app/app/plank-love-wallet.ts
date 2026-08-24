"use client";

export type PlankLoveWalletState = {
  address: string | null;
  chainId: number | null;
  status: "disconnected" | "connecting" | "connected";
  isConnected: boolean;
};

type Method = "getState" | "connect" | "ensureRobinhoodChain" | "signMessage" | "sendNativeTransaction";
type Result = { state?: PlankLoveWalletState; signature?: string; address?: string; txHash?: string };

function request(method: Method, payload?: { address?: string; message?: string; to?: string; valueHex?: string; chainId?: number }): Promise<Result> {
  if (typeof window === "undefined") return Promise.reject(new Error("Wallet requests run in the browser."));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("plank:wallet-response", onResponse);
      reject(new Error("Plank.love did not finish the wallet request. Try again."));
    }, method === "connect" || method === "signMessage" ? 120_000 : 30_000);
    const onResponse = (raw: Event) => {
      const detail = (raw as CustomEvent).detail as { requestId?: string; result?: Result; error?: string };
      if (detail?.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("plank:wallet-response", onResponse);
      if (detail.error) reject(new Error(detail.error));
      else resolve(detail.result || {});
    };
    window.addEventListener("plank:wallet-response", onResponse);
    window.dispatchEvent(new CustomEvent("plank:wallet-request", { detail: { requestId, method, payload } }));
  });
}

export async function getPlankLoveWalletState() {
  const result = await request("getState");
  return result.state || { address: null, chainId: null, status: "disconnected", isConnected: false };
}

export async function connectPlankLoveWallet() {
  const result = await request("connect");
  const address = result.address || result.state?.address;
  if (!address) throw new Error("Plank.love did not return a connected wallet.");
  return address.toLowerCase();
}

export async function ensurePlankLoveRobinhoodChain(address?: string) {
  const result = await request("ensureRobinhoodChain", { address });
  if (!result.state) throw new Error("Could not verify Robinhood Chain.");
  return result.state;
}

export async function signPlankLoveMessage(message: string, address: string) {
  const expectedPrefix = "PlankSpace wallet verification\nSite: https://plank.love/plankspace\n";
  if (!message.startsWith(expectedPrefix) || !message.includes("Safety: This is only a login signature") || message.length > 2000) {
    throw new Error("PlankSpace rejected an unknown signing request.");
  }
  const result = await request("signMessage", { message, address });
  if (!result.signature) throw new Error("Plank.love did not return a signature.");
  return result.signature;
}

export async function sendPlankLoveNativeTransaction(input:{address:string;to:string;valueHex:string;chainId:number}){
  if(!/^0x[a-f0-9]{40}$/i.test(input.to)||!/^0x[0-9a-f]+$/i.test(input.valueHex))throw new Error("Invalid tip transaction details.");
  const result=await request("sendNativeTransaction",input);
  if(!result.txHash)throw new Error("The wallet did not return a transaction hash.");
  return result.txHash;
}

export async function disconnectPlankLoveWallet() {
  // Deliberately do not disconnect the app-wide Plank.love session from a
  // feature route. The main wallet control owns disconnect behavior.
  return getPlankLoveWalletState();
}

export function subscribePlankLoveWalletState(
  listener: (state: PlankLoveWalletState) => void
) {
  if (typeof window === "undefined") return () => {};

  const handleState = (event: Event) => {
    const detail = (event as CustomEvent<PlankLoveWalletState>).detail;
    if (detail) listener(detail);
  };

  const handleResponse = (event: Event) => {
    const detail = (event as CustomEvent<{
      result?: { state?: PlankLoveWalletState };
    }>).detail;

    if (detail?.result?.state) {
      listener(detail.result.state);
    }
  };

  window.addEventListener("plank:wallet-state", handleState);
  window.addEventListener("plank:wallet-response", handleResponse);

  void getPlankLoveWalletState().then(listener).catch(() => undefined);

  return () => {
    window.removeEventListener("plank:wallet-state", handleState);
    window.removeEventListener("plank:wallet-response", handleResponse);
  };
}
