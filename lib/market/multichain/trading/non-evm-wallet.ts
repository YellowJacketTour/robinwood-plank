/**
 * Minimal raw injected-provider wallet connect for Solana (Phantom) and
 * Bitcoin Ordinals (UniSat) -- the non-EVM counterpart to lib/wallet.ts's
 * getEthereumProvider(). Deliberately NOT a new SDK dependency: per this
 * task's own constraint (checked package.json first -- no
 * @solana/wallet-adapter*, no @solana/web3.js, no Bitcoin wallet lib
 * installed), this talks directly to each wallet's own injected `window`
 * object, exactly the same "no heavy SDK, just the browser extension's own
 * interface" posture lib/wallet.ts already takes for window.ethereum.
 *
 * Phantom's window.solana: connect() resolves { publicKey }, and
 * signAndSendTransaction(tx) is Phantom's own documented method (see
 * docs.phantom.app/solana/sending-a-transaction) -- this module passes
 * through the base64 tx string the adapter functions
 * (magiceden-solana-trade.ts) already return, matching that file's own
 * "never sign or broadcast itself" boundary: THIS module is the one place
 * that actually calls signAndSendTransaction, invoked only from
 * foreign-fulfill.ts's buySolanaListingNow.
 *
 * UniSat's window.unisat: getAccounts()/requestAccounts() and
 * signPsbt(psbtHex, opts) are UniSat's own documented injected-provider
 * methods (see docs.unisat.io/dev/unisat-developer-service/unisat-wallet -
 * the EXTENSION's own API, distinct from the open-api.unisat.io REST API
 * unisat-ordinals-trade.ts calls). signPsbt takes/returns HEX, not base64 --
 * a real, easy-to-get-wrong distinction from Magic Eden's base64 convention,
 * called out explicitly here so a future caller doesn't silently mix them up.
 */

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  signAndSendTransaction: (transaction: unknown) => Promise<{ signature: string }>;
};

type UniSatProvider = {
  requestAccounts: () => Promise<string[]>;
  getAccounts: () => Promise<string[]>;
  signPsbt: (psbtHex: string, options?: { autoFinalized?: boolean; toSignInputs?: Array<{ index: number; address?: string }> }) => Promise<string>;
  /**
   * REAL, DOCUMENTED method (docs.unisat.io, fetched live 2026-08-18) --
   * transfers one inscription directly to `address`, with UniSat's OWN
   * wallet doing the UTXO selection internally. This is the safe path this
   * whole module's header (and unisat-ordinals-trade.ts's) warns a caller
   * to use instead of hand-building a transfer PSBT: "must never
   * independently select UTXOs" -- sendInscription is UniSat's own
   * sanctioned way to move an inscription without that risk, not a gap
   * this app is working around.
   */
  sendInscription: (address: string, inscriptionId: string, options?: { feeRate?: number }) => Promise<{ txid: string }>;
};

type SolanaWindow = Window & { solana?: PhantomProvider; phantom?: { solana?: PhantomProvider } };
type UnisatWindow = Window & { unisat?: UniSatProvider };

export function getPhantomProvider(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as SolanaWindow;
  const provider = w.phantom?.solana ?? w.solana;
  return provider?.isPhantom ? provider : (provider ?? null);
}

export function getUnisatProvider(): UniSatProvider | null {
  if (typeof window === "undefined") return null;
  return (window as UnisatWindow).unisat ?? null;
}

/** Connects Phantom and returns the connected Solana address (base58 public key). Throws with a clear message if Phantom isn't installed -- never silently no-ops. */
export async function connectPhantomWallet(): Promise<string> {
  const provider = getPhantomProvider();
  if (!provider) {
    throw new Error("Phantom wallet not found -- install the Phantom browser extension to trade Solana collections (phantom.app).");
  }
  const { publicKey } = await provider.connect();
  return publicKey.toString();
}

/** Connects UniSat and returns the connected Bitcoin address. Throws with a clear message if UniSat isn't installed. */
export async function connectUnisatWallet(): Promise<string> {
  const provider = getUnisatProvider();
  if (!provider) {
    throw new Error("UniSat wallet not found -- install the UniSat browser extension to trade Bitcoin Ordinals (unisat.io).");
  }
  const accounts = await provider.requestAccounts();
  const address = accounts[0];
  if (!address) throw new Error("UniSat did not return a connected address.");
  return address;
}

/**
 * Signs and submits an unsigned base64 Solana transaction via Phantom, using
 * Phantom's own signAndSendTransaction (which needs a real @solana/web3.js
 * Transaction/VersionedTransaction object, not a bare string) -- this
 * dynamically imports @solana/web3.js's Transaction.from() ONLY to
 * deserialize the base64 buffer Magic Eden's API returned, exactly the
 * narrow use lib/market/multichain/adapters/magiceden-solana-trade.ts's own
 * header says every caller needs ("a serialized, UNSIGNED Solana transaction
 * for the connected wallet to sign"). Confirmed via package.json: @solana/
 * web3.js is NOT installed as a dependency; Phantom's own injected provider
 * additionally exposes signAndSendTransaction accepting a raw
 * {message: Uint8Array}-shaped legacy transaction in some wallet versions,
 * but the officially documented, stable contract
 * (docs.phantom.app/solana/sending-a-transaction) requires a real
 * Transaction/VersionedTransaction instance -- so this function requires
 * @solana/web3.js's Transaction class to exist at call time and throws a
 * clear, actionable error if it doesn't, rather than attempting an
 * undocumented raw-bytes shape that could silently misbehave across Phantom
 * versions.
 */
export async function signAndSendSolanaTransaction(txBase64: string): Promise<string> {
  const provider = getPhantomProvider();
  if (!provider) {
    throw new Error("Phantom wallet not found -- install the Phantom browser extension to trade Solana collections (phantom.app).");
  }
  let Transaction: { from: (buf: Buffer) => unknown };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const web3 = (await import("@solana/web3.js")) as unknown as { Transaction: { from: (buf: Buffer) => unknown } };
    Transaction = web3.Transaction;
  } catch {
    throw new Error(
      "@solana/web3.js is not installed -- required to deserialize Magic Eden's unsigned transaction before Phantom can sign it. Add it as a dependency to enable Solana buy/sweep execution."
    );
  }
  const tx = Transaction.from(Buffer.from(txBase64, "base64"));
  const { signature } = await provider.signAndSendTransaction(tx);
  return signature;
}
