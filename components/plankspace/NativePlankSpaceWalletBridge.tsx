"use client";

import { useEffect, useMemo, useRef } from "react";
import { useWallet } from "@/lib/wallet-context";
import { ensureRobinhoodChain, getEthereumProvider } from "@/lib/wallet";
import { stringToHex } from "viem";
import {
  handleNativePlankSpaceWalletRequest,
  type NativeWalletRequest,
} from "./native-wallet-bridge-core";

type RequestDetail = NativeWalletRequest & { requestId?: string };

export default function NativePlankSpaceWalletBridge() {
  const wallet = useWallet();
  const pendingConnect = useRef<string[]>([]);
  const state = useMemo(
    () => ({
      address: wallet.address,
      chainId: wallet.chainId,
      status: wallet.status,
      isConnected: wallet.isConnected,
    }),
    [wallet.address, wallet.chainId, wallet.status, wallet.isConnected],
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("plank:wallet-state", { detail: state }));
    if (state.address && pendingConnect.current.length) {
      const requestIds = pendingConnect.current.splice(0);
      for (const requestId of requestIds) {
        window.dispatchEvent(
          new CustomEvent("plank:wallet-response", {
            detail: { requestId, result: { state } },
          }),
        );
      }
    }
  }, [state]);

  useEffect(() => {
    const onRequest = async (event: Event) => {
      const detail = (event as CustomEvent<RequestDetail>).detail;
      if (!detail?.requestId) return;
      try {
        const result = await handleNativePlankSpaceWalletRequest(detail, {
          getState: () => stateRef.current,
          openConnect: wallet.openConnect,
          disconnect: wallet.disconnect,
          ensureRobinhoodChain,
          signMessage: async (message, address) => {
            const provider = getEthereumProvider();
            if (!provider) throw new Error("The connected wallet provider is unavailable.");
            return String(
              await provider.request({
                method: "personal_sign",
                params: [stringToHex(message), address],
              }),
            );
          },
          sendNativeTransaction: async (transaction) => {
            const provider = getEthereumProvider();
            if (!provider) throw new Error("The connected wallet provider is unavailable.");
            return String(
              await provider.request({ method: "eth_sendTransaction", params: [transaction] }),
            );
          },
        });
        if ("pending" in result) {
          pendingConnect.current.push(detail.requestId);
          return;
        }
        window.dispatchEvent(
          new CustomEvent("plank:wallet-response", {
            detail: { requestId: detail.requestId, result },
          }),
        );
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("plank:wallet-response", {
            detail: {
              requestId: detail.requestId,
              error: error instanceof Error ? error.message : "Wallet request failed.",
            },
          }),
        );
      }
    };
    window.addEventListener("plank:wallet-request", onRequest);
    return () => window.removeEventListener("plank:wallet-request", onRequest);
  }, [wallet.disconnect, wallet.openConnect]);

  return null;
}
