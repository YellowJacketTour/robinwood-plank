"use client";

/**
 * Connect: WalletConnect QR first. After pair, if Rabby is on the wrong chain,
 * keep the session and offer “I switched — continue” instead of a new QR freeze.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  cancelWalletConnectConnect,
  connectWithWalletConnect,
  disconnectWalletConnect,
  getWalletConnectProjectId,
  qrDataUrlForUri,
  saveWalletConnectProjectId,
} from "@/lib/wallet-connect";
import {
  connectInjectedWallet,
  ensureRobinhoodChain,
  getChainId,
  isRobinhoodChainId,
} from "@/lib/wallet";
import { useWallet } from "@/lib/wallet-context";
import { CHAIN } from "@/lib/constants";

type Props = {
  open: boolean;
  onClose: () => void;
  onConnected: (address: string) => void;
};

type Phase = "idle" | "pairing" | "need_chain" | "done";

export default function ConnectWalletModal({ open, onClose, onConnected }: Props) {
  // Any connection made here (WalletConnect QR or injected extension) must
  // become visible app-wide, not just to whichever caller passed
  // onConnected — otherwise a WalletConnect-sourced connect would update
  // e.g. SwapWidget's local state but leave the nav/other surfaces stale.
  const { adoptAccount: walletAdoptAccount } = useWallet();
  const [projectId, setProjectId] = useState("");
  const [uri, setUri] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pendingAddress, setPendingAddress] = useState<string | null>(null);
  const [liveChain, setLiveChain] = useState<number | null>(null);
  // Rendered via a portal straight onto <body> — this modal is opened from
  // inside the homepage's ".reveal" section, which sets a (identity)
  // transform once visible. Any non-"none" transform on an ancestor creates
  // a new CSS containing block, so a plain `position: fixed` child (this
  // modal) gets trapped inside that box instead of covering the viewport —
  // same bug, same fix as TokenSelectModal.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setProjectId(getWalletConnectProjectId());
    setUri(null);
    setQrDataUrl(null);
    setError(null);
    setStatus(null);
    setBusy(false);
    setPhase("idle");
    setPendingAddress(null);
    setLiveChain(null);
  }, [open]);

  useEffect(() => {
    if (!uri) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void qrDataUrlForUri(uri).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  const finish = useCallback(
    (addr: string) => {
      setPhase("done");
      walletAdoptAccount(addr);
      onConnected(addr);
      onClose();
    },
    [walletAdoptAccount, onConnected, onClose]
  );

  const handleClose = useCallback(() => {
    if (phase !== "need_chain") {
      cancelWalletConnectConnect();
    }
    setBusy(false);
    setUri(null);
    setQrDataUrl(null);
    setStatus(null);
    onClose();
  }, [onClose, phase]);

  const checkChainAndFinish = useCallback(
    async (addr: string) => {
      try {
        const id = await getChainId();
        setLiveChain(id);
        if (isRobinhoodChainId(id)) {
          finish(addr);
          return;
        }
        // Try automatic switch once (timed out for WC)
        try {
          await ensureRobinhoodChain();
          finish(addr);
          return;
        } catch (e) {
          setPendingAddress(addr);
          setPhase("need_chain");
          setBusy(false);
          setError(
            e instanceof Error
              ? e.message
              : `Need Robinhood Chain (${CHAIN.id}). Switch in Rabby, then continue.`
          );
          setStatus(
            `Connected as ${addr.slice(0, 6)}…${addr.slice(-4)} — waiting for network ${CHAIN.id}.`
          );
        }
      } catch (e) {
        console.error("Network verification failed:", e);
        setPendingAddress(addr);
        setPhase("need_chain");
        setBusy(false);
        setError(e instanceof Error ? e.message : "Could not verify network.");
      }
    },
    [finish]
  );

  const runWc = useCallback(async () => {
    setError(null);
    setBusy(true);
    setPhase("pairing");
    setStatus("Preparing QR…");
    setUri(null);
    setQrDataUrl(null);
    setPendingAddress(null);
    try {
      const id = projectId.trim() || getWalletConnectProjectId();
      if (!id) {
        throw new Error("Paste your WalletConnect Project ID (free at cloud.reown.com).");
      }
      saveWalletConnectProjectId(id);
      const addr = await connectWithWalletConnect({
        projectId: id,
        onDisplayUri: (u) => {
          setUri(u);
          setStatus(
            `1) In Rabby set network to Robinhood Chain (${CHAIN.id})  2) Scan this QR  3) Approve`
          );
        },
      });
      setStatus("Phone approved — checking network…");
      await checkChainAndFinish(addr);
    } catch (e) {
      console.error("WalletConnect failed:", e);
      const msg = e instanceof Error ? e.message : "WalletConnect failed.";
      if (!msg.toLowerCase().includes("cancelled")) {
        // If message is about wrong chain but we have a session, enter need_chain
        if (msg.includes("Robinhood") || msg.includes("chain") || msg.includes("4663")) {
          setError(msg);
          setPhase("need_chain");
        } else {
          setError(msg);
          setPhase("idle");
        }
      }
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [projectId, checkChainAndFinish]);

  const retryChain = useCallback(async () => {
    if (!pendingAddress) {
      // Session may exist without pending — re-read accounts via ensure only
      setError("Connect with QR once first, then switch network and continue.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus("Checking network again…");
    try {
      const id = await getChainId();
      setLiveChain(id);
      if (!isRobinhoodChainId(id)) {
        throw new Error(
          `Still on chain ${id}. In Rabby: tap network → Robinhood Chain (${CHAIN.id}), then Continue again.`
        );
      }
      finish(pendingAddress);
    } catch (e) {
      console.error("Retry network check failed:", e);
      setError(e instanceof Error ? e.message : "Still wrong network.");
    } finally {
      setBusy(false);
    }
  }, [pendingAddress, finish]);

  const runExtension = useCallback(async () => {
    setError(null);
    setBusy(true);
    setStatus("Opening browser extension…");
    setPhase("pairing");
    try {
      await disconnectWalletConnect();
      const addr = await connectInjectedWallet();
      await checkChainAndFinish(addr);
    } catch (e) {
      console.error("Extension connect failed:", e);
      setError(e instanceof Error ? e.message : "Extension connect failed.");
      setStatus(null);
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  }, [checkChainAndFinish]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Connect wallet"
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-gold-500/40 bg-wood-950 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.16em] text-gold-400/80">
              Connect wallet
            </p>
            <h2 className="mt-1 font-display text-xl text-gold-300">
              {phase === "need_chain" ? "Switch network in Rabby" : "WalletConnect QR"}
            </h2>
            <p className="mt-1 text-sm text-foreground/65">
              {phase === "need_chain"
                ? "You are connected. Only the network is wrong — do not scan a new QR."
                : "Rabby / Robinhood mobile. Network must be Robinhood Chain before seed works."}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-sm text-foreground/50 hover:text-gold-300"
          >
            Close
          </button>
        </div>

        {phase !== "need_chain" && (
          <>
            <div className="mt-3 rounded-lg border border-gold-500/20 bg-wood-950/90 px-3 py-2 text-[0.75rem] text-foreground/70">
              <p className="font-bold text-gold-300">Before you scan</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                <li>
                  In Rabby open networks → <strong>Robinhood Chain</strong> (id{" "}
                  <span className="font-mono">{CHAIN.id}</span>)
                </li>
                <li>Tap Show QR below and scan once</li>
                <li>Approve the connection</li>
              </ol>
            </div>

            {/* Config plumbing, not user UI: the project id ships with the
                build (NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID). Ask only when
                no id is configured anywhere — without one, WalletConnect
                cannot pair at all. */}
            {!getWalletConnectProjectId() && (
              <>
                <label className="mt-4 block text-[0.65rem] font-bold uppercase tracking-wide text-foreground/45">
                  WalletConnect Project ID
                </label>
                <input
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value.trim())}
                  placeholder="from cloud.reown.com"
                  className="mt-1 w-full rounded-lg border border-gold-500/20 bg-wood-950/90 px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-gold-400"
                  autoComplete="off"
                />
                <p className="mt-1 text-[0.65rem] text-foreground/40">
                  Free:{" "}
                  <a
                    href="https://cloud.reown.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-gold-300 underline"
                  >
                    cloud.reown.com
                  </a>
                </p>
              </>
            )}

            <button
              type="button"
              disabled={busy && !uri}
              onClick={() => void runWc()}
              className="mt-4 min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50"
            >
              {busy && !uri
                ? "Preparing QR…"
                : busy && uri
                  ? "Waiting for phone…"
                  : uri
                    ? "New QR (cancels previous)"
                    : "Show WalletConnect QR"}
            </button>

            {busy && uri && (
              <button
                type="button"
                onClick={handleClose}
                className="mt-2 w-full text-xs font-bold text-amber-200 underline"
              >
                Cancel &amp; unfreeze
              </button>
            )}

            {qrDataUrl && (
              <div className="mt-4 flex flex-col items-center rounded-xl border border-gold-500/30 bg-wood-950/90 p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrDataUrl}
                  alt="WalletConnect QR"
                  width={280}
                  height={280}
                  className="rounded-lg bg-white"
                />
                <p className="mt-2 text-center text-xs text-foreground/60">{status}</p>
                {uri && (
                  // The raw wc: URI is noise on screen — the copy button
                  // covers the deep-link use case without the text dump.
                  <button
                    type="button"
                    className="mt-2 text-xs font-bold text-gold-300 underline"
                    onClick={() => void navigator.clipboard.writeText(uri)}
                  >
                    Copy connection URI
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {phase === "need_chain" && (
          <div className="mt-4 space-y-3 rounded-xl border border-amber-400/40 bg-amber-400/10 p-4">
            <p className="text-sm font-bold text-amber-100">Connected — switch network only</p>
            <ol className="list-decimal space-y-1 pl-4 text-sm text-amber-50/90">
              <li>Open the Rabby app (don’t close this page)</li>
              <li>
                Switch network to <strong>Robinhood Chain</strong> (chain id{" "}
                <span className="font-mono">{CHAIN.id}</span>)
              </li>
              <li>Come back here and tap Continue</li>
            </ol>
            {liveChain != null && (
              <p className="font-mono text-xs text-foreground/55">
                Wallet reports chain: {liveChain} (want {CHAIN.id}
                {liveChain === 18019
                  ? " — 18019 was a site bug reading 4663 as hex; tap Continue after refresh"
                  : ""}
                )
              </p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void retryChain()}
              className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50"
            >
              {busy ? "Checking…" : "I switched — continue"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                cancelWalletConnectConnect();
                setPhase("idle");
                setPendingAddress(null);
                setUri(null);
                setQrDataUrl(null);
                setError(null);
              }}
              className="w-full text-xs font-bold text-foreground/50 underline"
            >
              Disconnect and start over
            </button>
          </div>
        )}

        {!qrDataUrl && status && phase !== "need_chain" && (
          <p className="mt-3 text-center text-xs text-foreground/55">{status}</p>
        )}

        {phase !== "need_chain" && (
          <div className="mt-5 border-t border-gold-500/15 pt-4">
            <p className="text-[0.65rem] text-foreground/40">Desktop with Rabby extension?</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runExtension()}
              className="mt-2 min-h-10 w-full rounded-lg border border-gold-500/30 text-xs font-bold text-gold-200 hover:border-gold-400 disabled:opacity-50"
            >
              Connect browser extension instead
            </button>
          </div>
        )}

        {error && (
          <p className="mt-3 text-center text-xs text-red-300" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body
  );
}
