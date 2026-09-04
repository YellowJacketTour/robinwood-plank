"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useWallet } from "@/lib/wallet-context";
import { getEthereumProvider } from "@/lib/wallet";
import { stringToHex } from "viem";

const CHILD_SOURCE = "plankspace-wallet-v1";
const PARENT_SOURCE = "plank-love-wallet-v1";

type WalletRequest = {
  source: typeof CHILD_SOURCE;
  type: "wallet:ready" | "wallet:request";
  requestId?: string;
  method?: "getState" | "connect" | "disconnect" | "ensureRobinhoodChain" | "signMessage";
  payload?: { address?: string; message?: string };
};

export default function PlankSpaceFrame({ src }: { src: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pendingConnect = useRef<string[]>([]);
  const wallet = useWallet();
  const origin = useMemo(() => new URL(src).origin, [src]);
  const state = useMemo(() => ({
    address: wallet.address,
    chainId: wallet.chainId,
    status: wallet.status,
    isConnected: wallet.isConnected,
  }), [wallet.address, wallet.chainId, wallet.status, wallet.isConnected]);

  const send = useCallback((message: object) => {
    frame.current?.contentWindow?.postMessage(message, origin);
  }, [origin]);

  const respond = useCallback((requestId: string, result?: object, error?: string) => {
    send({ source: PARENT_SOURCE, type: "wallet:response", requestId, result, error });
  }, [send]);

  useEffect(() => {
    send({ source: PARENT_SOURCE, type: "wallet:state", state });
    if (wallet.address && pendingConnect.current.length) {
      const requests = pendingConnect.current.splice(0);
      for (const requestId of requests) respond(requestId, { state });
    }
  }, [respond, send, state, wallet.address]);

  useEffect(() => {
    const onMessage = async (event: MessageEvent<unknown>) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data as Partial<WalletRequest>;
      if (message.source !== CHILD_SOURCE) return;
      if (message.type === "wallet:ready") {
        send({ source: PARENT_SOURCE, type: "wallet:state", state });
        return;
      }
      if (message.type !== "wallet:request" || !message.requestId || !message.method) return;
      const requestId = message.requestId;
      try {
        if (message.method === "getState" || message.method === "ensureRobinhoodChain") {
          respond(requestId, { state });
        } else if (message.method === "connect") {
          if (wallet.address) respond(requestId, { state });
          else {
            pendingConnect.current.push(requestId);
            wallet.openConnect();
          }
        } else if (message.method === "disconnect") {
          wallet.disconnect();
          respond(requestId, { state: { address: null, chainId: null, status: "disconnected", isConnected: false } });
        } else if (message.method === "signMessage") {
          const address = wallet.address?.toLowerCase();
          const requestedAddress = message.payload?.address?.toLowerCase();
          const text = message.payload?.message || "";
          if (!address || address !== requestedAddress) throw new Error("Connect the wallet that owns this profile first.");
          if (!text.startsWith("PlankSpace wallet verification\n") || text.length > 2400) throw new Error("Rejected an unknown signature request.");
          const provider = getEthereumProvider();
          if (!provider) throw new Error("The connected wallet provider is unavailable.");
          // EIP-1193 personal_sign takes hex-encoded bytes. Some desktop
          // providers accept a raw UTF-8 string, but Robinhood mobile signs
          // that input differently, making server-side recovery fail.
          const signature = await provider.request({
            method: "personal_sign",
            params: [stringToHex(text), address],
          });
          respond(requestId, { signature: String(signature), address });
        }
      } catch (error) {
        respond(requestId, undefined, error instanceof Error ? error.message : "Wallet request failed.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, respond, send, state, wallet]);

  return (
    <iframe
      ref={frame}
      title="PlankSpace"
      src={src}
      className="h-[max(760px,calc(100dvh-120px))] w-full rounded-xl border border-gold-500/30 bg-wood-950"
      sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
      allow="autoplay"
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}
