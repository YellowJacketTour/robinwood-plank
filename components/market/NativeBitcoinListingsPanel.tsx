"use client";

/**
 * UI for Marketplank-native Bitcoin Ordinals listings -- the browse/list/
 * buy surface over native-bitcoin-listing.ts's engine and its four API
 * routes (native-bitcoin-listing-build, native-bitcoin-listings,
 * native-bitcoin-listing/[id]/fulfill, native-bitcoin-listing/[id]/broadcast).
 * Every one of those routes has already been proven live end-to-end this
 * session -- offline test, independent-signer regtest, real testnet4
 * inscription and broadcast, real HTTP calls against real Postgres -- and
 * hardened against the findings from a follow-up security review
 * (broadcast-time transaction verification, real signature verification
 * on listing creation). This component is the first UI wired to that
 * proven backend; it does not change any of it.
 *
 * SIGNING FOLLOWS THIS APP'S OWN ESTABLISHED CONVENTION, NOT A NEW ONE --
 * see foreign-fulfill.ts's buyBitcoinListingNow: UniSat's signPsbt wants
 * hex, every route here returns/accepts base64, and Buffer.from(...,
 * "base64"/"hex") is the exact conversion this app's own Bitcoin buy flow
 * already uses client-side.
 *
 * BUYER UTXO DISCOVERY GOES THROUGH mempool.space's PUBLIC, KEY-FREE API --
 * same one the broadcast route itself relays through server-side (see that
 * route's own header). The UI needs to show a connected wallet ITS OWN
 * spendable UTXOs before a purchase can be built (the dummy + payment
 * inputs native-bitcoin-listing.ts's protocol needs); UniSat's injected
 * provider (non-evm-wallet.ts) exposes signing and getPublicKey, but not a
 * raw UTXO list, so this is the same public indexer this app already
 * trusts for exactly this class of read.
 *
 * TESTNET4-ONLY FOR NOW, ON PURPOSE. NATIVE_BITCOIN_MAINNET_ENABLED is a
 * server-only env var (never NEXT_PUBLIC_) by design -- see
 * native-bitcoin-listing.ts's own "HARD MAINNET GATE" header on why. This
 * component hardcodes the testnet4 mempool.space base to match; the day
 * that gate is lifted server-side, this needs its own explicit follow-up,
 * not a silent flip.
 */
import { useCallback, useEffect, useState } from "react";

const MEMPOOL_BASE = "https://mempool.space/testnet4/api";
const DUMMY_UTXO_TARGET_SATS = 600;

type Utxo = { txid: string; vout: number; valueSats: number; scriptPubKeyHex: string };

type Listing = {
  id: string;
  sellerAddress: string;
  inscriptionId: string;
  utxoTxid: string;
  utxoVout: number;
  utxoValueSats: number;
  priceSats: number;
  status: string;
};

type UnisatProvider = {
  requestAccounts: () => Promise<string[]>;
  getPublicKey: () => Promise<string>;
  signPsbt: (psbtHex: string, options?: { autoFinalized?: boolean; toSignInputs?: Array<{ index: number }> }) => Promise<string>;
};

function getUnisat(): UnisatProvider | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { unisat?: UnisatProvider }).unisat ?? null;
}

async function fetchAddressUtxos(address: string): Promise<Array<{ txid: string; vout: number; valueSats: number }>> {
  const res = await fetch(`${MEMPOOL_BASE}/address/${address}/utxo`);
  if (!res.ok) throw new Error("Could not load your wallet's UTXOs from mempool.space.");
  const raw = (await res.json()) as Array<{ txid: string; vout: number; value: number }>;
  return raw.map((u) => ({ txid: u.txid, vout: u.vout, valueSats: u.value }));
}

async function fetchScriptPubKeyHex(txid: string): Promise<string[]> {
  const res = await fetch(`${MEMPOOL_BASE}/tx/${txid}`);
  if (!res.ok) throw new Error("Could not load transaction detail from mempool.space.");
  const tx = (await res.json()) as { vout: Array<{ scriptpubkey: string }> };
  return tx.vout.map((o) => o.scriptpubkey);
}

export default function NativeBitcoinListingsPanel() {
  const [address, setAddress] = useState<string | null>(null);
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [listings, setListings] = useState<Listing[]>([]);
  const [listingsLoading, setListingsLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [lastTxid, setLastTxid] = useState<string | null>(null);

  const [sellInscriptionId, setSellInscriptionId] = useState("");
  const [sellTxid, setSellTxid] = useState("");
  const [sellVout, setSellVout] = useState("0");
  const [sellValueSats, setSellValueSats] = useState("");
  const [sellPriceSats, setSellPriceSats] = useState("");
  const [selling, setSelling] = useState(false);
  const [sellError, setSellError] = useState<string | null>(null);

  const loadListings = useCallback(async () => {
    setListingsLoading(true);
    try {
      const res = await fetch("/api/market/multichain/native-bitcoin-listings");
      const body = (await res.json()) as { listings?: Listing[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Failed to load listings.");
      setListings(body.listings ?? []);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to load listings.");
    } finally {
      setListingsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadListings();
  }, [loadListings]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const provider = getUnisat();
      if (!provider) {
        throw new Error("UniSat wallet not found -- install the UniSat browser extension (unisat.io) and switch it to Testnet4 in its network settings.");
      }
      const accounts = await provider.requestAccounts();
      const addr = accounts[0];
      if (!addr) throw new Error("UniSat did not return a connected address.");
      const pk = await provider.getPublicKey();
      setAddress(addr);
      setPubkeyHex(pk);
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : "Failed to connect UniSat.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const submitListing = useCallback(async () => {
    if (!address || !pubkeyHex) {
      setSellError("Connect your UniSat wallet first.");
      return;
    }
    setSelling(true);
    setSellError(null);
    try {
      const valueSats = Number(sellValueSats);
      const priceSats = Number(sellPriceSats);
      const vout = Number(sellVout);
      if (!sellInscriptionId.trim() || !sellTxid.trim() || !Number.isFinite(vout) || !Number.isFinite(valueSats) || !Number.isFinite(priceSats)) {
        throw new Error("Fill in every field with real values from your inscription's own UTXO.");
      }

      const scriptPubKeys = await fetchScriptPubKeyHex(sellTxid.trim());
      const scriptPubKeyHex = scriptPubKeys[vout];
      if (!scriptPubKeyHex) throw new Error(`Output ${vout} not found on that transaction.`);

      const buildRes = await fetch("/api/market/multichain/native-bitcoin-listing-build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sellerAddress: address,
          sellerInternalPubkeyHex: pubkeyHex,
          inscriptionUtxo: { txid: sellTxid.trim(), vout, valueSats, scriptPubKeyHex },
          priceSats,
        }),
      });
      const built = (await buildRes.json()) as { psbtBase64?: string; inputIndexToSign?: number; error?: string; message?: string };
      if (!buildRes.ok || !built.psbtBase64) throw new Error(built.message ?? built.error ?? "Failed to build the listing PSBT.");

      const provider = getUnisat();
      if (!provider) throw new Error("UniSat wallet not found.");
      const psbtHex = Buffer.from(built.psbtBase64, "base64").toString("hex");
      const signedPsbtHex = await provider.signPsbt(psbtHex, {
        autoFinalized: false,
        toSignInputs: [{ index: built.inputIndexToSign ?? 0 }],
      });
      const signedPsbtBase64 = Buffer.from(signedPsbtHex, "hex").toString("base64");

      const createRes = await fetch("/api/market/multichain/native-bitcoin-listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inscriptionId: sellInscriptionId.trim(), sellerPsbtBase64: signedPsbtBase64 }),
      });
      const createBody = (await createRes.json()) as { error?: string; message?: string };
      if (!createRes.ok) throw new Error(createBody.message ?? createBody.error ?? "Failed to create the listing.");

      setSellInscriptionId("");
      setSellTxid("");
      setSellVout("0");
      setSellValueSats("");
      setSellPriceSats("");
      await loadListings();
    } catch (e) {
      setSellError(e instanceof Error ? e.message : "Failed to create the listing.");
    } finally {
      setSelling(false);
    }
  }, [address, pubkeyHex, sellInscriptionId, sellTxid, sellVout, sellValueSats, sellPriceSats, loadListings]);

  const buyListing = useCallback(
    async (listing: Listing) => {
      if (!address || !pubkeyHex) {
        setActionError("Connect your UniSat wallet first.");
        return;
      }
      setActionBusyId(listing.id);
      setActionError(null);
      setLastTxid(null);
      try {
        const utxos = await fetchAddressUtxos(address);
        if (utxos.length === 0) throw new Error("Your wallet has no spendable testnet4 UTXOs.");

        // Same dummy/payment split logic proven live this session: smallest
        // UTXO near the dummy target as input 0, largest remaining as payment.
        const sorted = [...utxos].sort((a, b) => a.valueSats - b.valueSats);
        const dummyCandidate = sorted.find((u) => u.valueSats >= DUMMY_UTXO_TARGET_SATS) ?? sorted[0];
        const remaining = utxos.filter((u) => !(u.txid === dummyCandidate.txid && u.vout === dummyCandidate.vout));
        const paymentCandidates = remaining.sort((a, b) => b.valueSats - a.valueSats);
        if (paymentCandidates.length === 0) throw new Error("Need at least two separate UTXOs (one for the dummy input, one for payment).");

        const withScripts = async (u: { txid: string; vout: number; valueSats: number }): Promise<Utxo> => {
          const scripts = await fetchScriptPubKeyHex(u.txid);
          return { ...u, scriptPubKeyHex: scripts[u.vout] };
        };
        const buyerDummyUtxo = await withScripts(dummyCandidate);
        const buyerPaymentUtxoCandidates = await Promise.all(paymentCandidates.slice(0, 5).map(withScripts));

        const fulfillRes = await fetch(`/api/market/native-bitcoin-listing/${encodeURIComponent(listing.id)}/fulfill`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            buyerAddress: address,
            buyerInternalPubkeyHex: pubkeyHex,
            buyerReceivingAddress: address,
            buyerChangeAddress: address,
            buyerDummyUtxo,
            buyerPaymentUtxoCandidates,
            feeRateSatPerVb: 2,
          }),
        });
        const fulfilled = (await fulfillRes.json()) as {
          psbtBase64?: string;
          inputIndexesForBuyerToSign?: number[];
          error?: string;
          message?: string;
        };
        if (!fulfillRes.ok || !fulfilled.psbtBase64) {
          throw new Error(fulfilled.message ?? fulfilled.error ?? "Failed to build the fulfillment PSBT.");
        }

        const provider = getUnisat();
        if (!provider) throw new Error("UniSat wallet not found.");
        const psbtHex = Buffer.from(fulfilled.psbtBase64, "base64").toString("hex");
        const signedPsbtHex = await provider.signPsbt(psbtHex, {
          autoFinalized: false,
          toSignInputs: (fulfilled.inputIndexesForBuyerToSign ?? []).map((index) => ({ index })),
        });
        const signedFulfillmentPsbtBase64 = Buffer.from(signedPsbtHex, "hex").toString("base64");

        const broadcastRes = await fetch(`/api/market/native-bitcoin-listing/${encodeURIComponent(listing.id)}/broadcast`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ signedFulfillmentPsbtBase64 }),
        });
        const broadcastBody = (await broadcastRes.json()) as { txid?: string; error?: string; message?: string };
        if (!broadcastRes.ok || !broadcastBody.txid) {
          throw new Error(broadcastBody.message ?? broadcastBody.error ?? "Broadcast rejected -- see the message above for why.");
        }

        setLastTxid(broadcastBody.txid);
        await loadListings();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Purchase failed.");
      } finally {
        setActionBusyId(null);
      }
    },
    [address, pubkeyHex, loadListings]
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-gold-400">Native Bitcoin Listings (Testnet4)</p>
          <p className="text-xs text-foreground/65">
            {address ? `Connected: ${address}` : "Connect UniSat, switched to Testnet4, to list or buy."}
          </p>
        </div>
        {!address && (
          <button
            onClick={connect}
            disabled={connecting}
            className="rounded-md bg-gold-500 px-4 py-2 text-sm font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-60"
          >
            {connecting ? "Connecting…" : "Connect UniSat"}
          </button>
        )}
      </div>
      {connectError && <p className="text-sm text-red-400">{connectError}</p>}
      {actionError && <p className="text-sm text-red-400">{actionError}</p>}
      {lastTxid && (
        <p className="text-sm text-gold-400">
          Purchase broadcast:{" "}
          <a
            className="underline"
            href={`https://mempool.space/testnet4/tx/${lastTxid}`}
            target="_blank"
            rel="noreferrer"
          >
            {lastTxid}
          </a>
        </p>
      )}

      <section className="rounded-lg border border-line bg-panel p-4">
        <h3 className="mb-3 text-base font-bold text-foreground">List an inscription</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            value={sellInscriptionId}
            onChange={(e) => setSellInscriptionId(e.target.value)}
            placeholder="Inscription id (txid i0)"
            className="rounded border border-line bg-wood-900 px-3 py-2 text-sm text-foreground"
          />
          <input
            value={sellTxid}
            onChange={(e) => setSellTxid(e.target.value)}
            placeholder="Inscription UTXO txid"
            className="rounded border border-line bg-wood-900 px-3 py-2 text-sm text-foreground"
          />
          <input
            value={sellVout}
            onChange={(e) => setSellVout(e.target.value)}
            placeholder="vout"
            className="rounded border border-line bg-wood-900 px-3 py-2 text-sm text-foreground"
          />
          <input
            value={sellValueSats}
            onChange={(e) => setSellValueSats(e.target.value)}
            placeholder="UTXO value (sats)"
            className="rounded border border-line bg-wood-900 px-3 py-2 text-sm text-foreground"
          />
          <input
            value={sellPriceSats}
            onChange={(e) => setSellPriceSats(e.target.value)}
            placeholder="Price (sats, min 30,334)"
            className="rounded border border-line bg-wood-900 px-3 py-2 text-sm text-foreground sm:col-span-2"
          />
        </div>
        {sellError && <p className="mt-2 text-sm text-red-400">{sellError}</p>}
        <button
          onClick={submitListing}
          disabled={selling || !address}
          className="mt-3 rounded-md bg-gold-500 px-4 py-2 text-sm font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-60"
        >
          {selling ? "Signing & listing…" : "List for sale"}
        </button>
      </section>

      <section className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-bold text-foreground">Active listings</h3>
          <button onClick={loadListings} disabled={listingsLoading} className="text-xs text-gold-400 underline">
            {listingsLoading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {listings.length === 0 && !listingsLoading && (
          <p className="text-sm text-foreground/65">No active listings right now.</p>
        )}
        <ul className="flex flex-col gap-2">
          {listings.map((listing) => (
            <li
              key={listing.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded border border-line bg-wood-900 px-3 py-2"
            >
              <div className="text-sm">
                <p className="font-semibold text-foreground">{listing.inscriptionId}</p>
                <p className="text-xs text-foreground/65">
                  {listing.priceSats.toLocaleString()} sats · seller {listing.sellerAddress.slice(0, 10)}…
                </p>
              </div>
              <button
                onClick={() => buyListing(listing)}
                disabled={actionBusyId === listing.id || !address || listing.sellerAddress === address}
                className="rounded-md bg-gold-500 px-3 py-1.5 text-xs font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-60"
              >
                {actionBusyId === listing.id ? "Buying…" : listing.sellerAddress === address ? "Your listing" : "Buy"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
