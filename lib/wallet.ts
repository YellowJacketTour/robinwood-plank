import { CHAIN } from "@/lib/constants";

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isRabby?: boolean;
  isBraveWallet?: boolean;
  isTrust?: boolean;
  isFrame?: boolean;
  providers?: Eip1193Provider[];
};

type InjectedWindow = Window & {
  ethereum?: Eip1193Provider;
  coinbaseWalletExtension?: Eip1193Provider;
};

export function getEthereumProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const w = window as InjectedWindow;
  const eth = w.ethereum;
  if (!eth) return w.coinbaseWalletExtension || null;
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    return (
      eth.providers.find((p) => p.isMetaMask && !p.isBraveWallet) ||
      eth.providers.find((p) => p.isRabby) ||
      eth.providers.find((p) => p.isCoinbaseWallet) ||
      eth.providers.find((p) => p.isBraveWallet) ||
      eth.providers.find((p) => p.isTrust) ||
      eth.providers[0] ||
      eth
    );
  }
  return eth;
}

export async function getConnectedAccounts(): Promise<string[]> {
  const provider = getEthereumProvider();
  if (!provider) return [];
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function connectWallet(): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) {
    throw new Error(
      "No wallet found. Open in Robinhood Wallet browser, or install MetaMask / Rabby."
    );
  }
  try {
    await provider.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    /* optional */
  }
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts?.[0]) throw new Error("No account returned from wallet.");
  return accounts[0];
}

export async function getChainId(): Promise<number> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return parseInt(hex, 16);
}

export async function switchToRobinhoodChain(): Promise<void> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const chainIdHex = `0x${CHAIN.id.toString(16)}`;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902 || code === -32603 || code === -32601) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainIdHex,
            chainName: CHAIN.name,
            nativeCurrency: {
              name: CHAIN.nativeCurrency.name,
              symbol: CHAIN.nativeCurrency.symbol,
              decimals: CHAIN.nativeCurrency.decimals,
            },
            rpcUrls: [CHAIN.rpcUrls.default],
            blockExplorerUrls: [CHAIN.blockExplorers.default.url],
          },
        ],
      });
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chainIdHex }],
        });
      } catch {
        /* ok */
      }
      return;
    }
    throw err;
  }
}

export async function ensureRobinhoodChain(): Promise<void> {
  const id = await getChainId();
  if (id !== CHAIN.id) {
    await switchToRobinhoodChain();
    const after = await getChainId();
    if (after !== CHAIN.id) {
      throw new Error(`Switch wallet network to ${CHAIN.name} (chain ${CHAIN.id}).`);
    }
  }
}

export function toHexQuantity(value: string | number | bigint): string {
  if (typeof value === "string" && value.startsWith("0x")) return value;
  // Uniswap often returns decimal strings like "86172000"
  const n = typeof value === "bigint" ? value : BigInt(String(value));
  return `0x${n.toString(16)}`;
}

// UR + integrator-fee routes on RH routinely need well above Uniswap's ~135k estimate
const MIN_SWAP_GAS = BigInt(550_000);
const MIN_APPROVE_GAS = BigInt(120_000);

function parseQuantity(raw: string | number | undefined | null): bigint | null {
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    if (typeof raw === "number") return BigInt(Math.floor(raw));
    const s = String(raw).trim();
    if (!s) return null;
    if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
    return BigInt(s);
  } catch {
    return null;
  }
}

type FeePair = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/**
 * Gas fees for Robinhood Chain (EIP-1559, baseFee often ~0.05–0.1 gwei).
 * Single fee style only — never mix gasPrice with maxFee*.
 * Tips scale with chain (do NOT force 1 gwei on a micro-gwei chain).
 */
async function resolveChainEip1559(
  provider: Eip1193Provider
): Promise<FeePair | null> {
  try {
    const block = (await provider.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    })) as { baseFeePerGas?: string } | null;

    const baseFee = parseQuantity(block?.baseFeePerGas ?? null);
    if (!baseFee || baseFee <= BigInt(0)) return null;

    const gasPrice = parseQuantity(
      (await provider.request({ method: "eth_gasPrice", params: [] })) as string
    );

    // tip = max(gasPrice - base, 15% of base, 1 wei), then +100% for inclusion
    let tip = BigInt(1);
    if (gasPrice && gasPrice > baseFee) tip = gasPrice - baseFee;
    const minTip = (baseFee * BigInt(15)) / BigInt(100) || BigInt(1);
    if (tip < minTip) tip = minTip;
    tip = tip * BigInt(2);
    // maxFee must clear next-block base spikes: 4x base + tip
    const maxFee = baseFee * BigInt(4) + tip;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
  } catch {
    return null;
  }
}

async function resolveFeeFields(
  provider: Eip1193Provider
): Promise<Record<string, string>> {
  const eip = await resolveChainEip1559(provider);
  if (eip) {
    return {
      maxFeePerGas: `0x${eip.maxFeePerGas.toString(16)}`,
      maxPriorityFeePerGas: `0x${eip.maxPriorityFeePerGas.toString(16)}`,
    };
  }
  try {
    const gasPrice = parseQuantity(
      (await provider.request({ method: "eth_gasPrice", params: [] })) as string
    );
    if (gasPrice && gasPrice > BigInt(0)) {
      const bumped = (gasPrice * BigInt(150)) / BigInt(100);
      return { gasPrice: `0x${bumped.toString(16)}` };
    }
  } catch {
    /* fall through */
  }
  return {};
}

/** Prefer the higher of Uniswap quote fees vs live RH chain fees (never underprice). */
async function mergeFeeFields(
  provider: Eip1193Provider,
  uniMax: bigint | null,
  uniTip: bigint | null,
  uniLegacy: bigint | null
): Promise<Record<string, string>> {
  const chain = await resolveChainEip1559(provider);

  if (uniMax && uniTip && uniMax >= uniTip) {
    // Uniswap decimal wei → boost 30%
    let maxFee = (uniMax * BigInt(130)) / BigInt(100);
    let tip = (uniTip * BigInt(130)) / BigInt(100);
    if (chain) {
      if (maxFee < chain.maxFeePerGas) maxFee = chain.maxFeePerGas;
      if (tip < chain.maxPriorityFeePerGas) tip = chain.maxPriorityFeePerGas;
      // tip cannot exceed maxFee
      if (tip > maxFee) maxFee = tip;
    }
    return {
      maxFeePerGas: `0x${maxFee.toString(16)}`,
      maxPriorityFeePerGas: `0x${tip.toString(16)}`,
    };
  }

  if (chain) {
    return {
      maxFeePerGas: `0x${chain.maxFeePerGas.toString(16)}`,
      maxPriorityFeePerGas: `0x${chain.maxPriorityFeePerGas.toString(16)}`,
    };
  }

  if (uniLegacy && uniLegacy > BigInt(0)) {
    const bumped = (uniLegacy * BigInt(130)) / BigInt(100);
    return { gasPrice: `0x${bumped.toString(16)}` };
  }

  return resolveFeeFields(provider);
}

export type SendTxOpts = {
  to: string;
  from: string;
  data: string;
  value?: string;
  gas?: string;
  gasLimit?: string;
  /** Prefer Uniswap quote gas estimates (decimal or hex) */
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
  kind?: "swap" | "approve";
};

/**
 * Build + send a tx with RH-chain-aware gas.
 * 1) eth_estimateGas on wallet RPC when possible
 * 2) Floor gas limits (UR + fee routes need >> 135k Uniswap estimate)
 * 3) EIP-1559: max(Uniswap quote fees, live RH baseFee schedule)
 * 4) Never mix gasPrice + maxFee*; single fee style only (Rabby-safe)
 * 5) Retry tiers if wallet rejects sim / underpriced
 */
export async function sendTransaction(tx: SendTxOpts): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  await ensureRobinhoodChain();

  const kind = tx.kind || "swap";
  const chainIdHex = `0x${CHAIN.id.toString(16)}`;
  const base: Record<string, string> = {
    to: tx.to,
    from: tx.from,
    data: tx.data,
    chainId: chainIdHex,
  };
  if (tx.value !== undefined && tx.value !== null && tx.value !== "") {
    const v = parseQuantity(tx.value);
    if (v !== null && v > BigInt(0)) {
      base.value = `0x${v.toString(16)}`;
    } else if (typeof tx.value === "string" && tx.value.startsWith("0x") && tx.value !== "0x" && tx.value !== "0x0") {
      base.value = tx.value;
    }
  }

  // --- Gas limit: estimate on wallet RPC, then floor ---
  let gasLimit = parseQuantity(tx.gasLimit ?? tx.gas);
  try {
    const estHex = (await provider.request({
      method: "eth_estimateGas",
      params: [{ to: base.to, from: base.from, data: base.data, ...(base.value ? { value: base.value } : {}) }],
    })) as string;
    const est = parseQuantity(estHex);
    if (est) {
      // +60% headroom for integrator-fee UR routes on RH
      gasLimit = (est * BigInt(160)) / BigInt(100);
    }
  } catch {
    // keep provided / floor — estimate often fails pre-approve on sells
  }
  const floor = kind === "approve" ? MIN_APPROVE_GAS : MIN_SWAP_GAS;
  if (!gasLimit || gasLimit < floor) gasLimit = floor;
  if (gasLimit > BigInt(3_000_000)) gasLimit = BigInt(3_000_000);

  // --- Fees: merge Uniswap quote + live RH chain (never underprice) ---
  const fees = await mergeFeeFields(
    provider,
    parseQuantity(tx.maxFeePerGas),
    parseQuantity(tx.maxPriorityFeePerGas),
    parseQuantity(tx.gasPrice)
  );

  const withGasLimit: Record<string, string> = {
    ...base,
    gas: `0x${gasLimit.toString(16)}`,
    ...fees,
  };
  // Some wallets want gasLimit alias
  withGasLimit.gasLimit = withGasLimit.gas;

  const attempts: Record<string, string>[] = [
    withGasLimit,
    // drop hard limit — wallet re-estimates
    { ...base, ...fees },
    // fee-only without chainId (some injectors choke on chainId in tx)
    (() => {
      const { chainId: _c, ...rest } = base;
      return { ...rest, gas: withGasLimit.gas, ...fees };
    })(),
    // bare essentials
    (() => {
      const bare: Record<string, string> = {
        to: base.to,
        from: base.from,
        data: base.data,
      };
      if (base.value) bare.value = base.value;
      return bare;
    })(),
  ];

  let lastMsg = "Transaction rejected.";
  for (let i = 0; i < attempts.length; i++) {
    try {
      return (await provider.request({
        method: "eth_sendTransaction",
        params: [attempts[i]],
      })) as string;
    } catch (err) {
      const msg =
        (err as { message?: string; shortMessage?: string })?.shortMessage ||
        (err as { message?: string })?.message ||
        "Transaction rejected.";
      lastMsg = msg;
      if (/user rejected|denied|4001/i.test(msg)) {
        throw new Error("Transaction cancelled in wallet.");
      }
      // try next tier
    }
  }
  throw new Error(humanizeTxError(lastMsg, kind));
}

function humanizeTxError(msg: string, kind: string): string {
  if (/insufficient funds|exceeds balance/i.test(msg)) {
    return "Insufficient funds. For buys leave ~0.002+ ETH for gas after the amount.";
  }
  if (/allowance|transfer amount exceeds|TRANSFER_FROM/i.test(msg)) {
    return "Token approval needed. Confirm the approve step, then swap again.";
  }
  if (/simulation|estimateGas|intrinsic gas|gas required/i.test(msg)) {
    return `Wallet simulation failed on ${kind}. Fresh quote, higher slip (2–3%), leave ETH for gas, retry.`;
  }
  if (/nonce|already known|replacement/i.test(msg)) {
    return "Pending tx in wallet — Speed Up or Cancel the old one, then retry.";
  }
  return msg.slice(0, 280);
}

export async function waitForTransaction(
  hash: string,
  opts?: {
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
    onPending?: (elapsedMs: number) => void;
  }
): Promise<{ status: "0x0" | "0x1" | string }> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const intervalMs = opts?.intervalMs ?? 2_000;
  const label = opts?.label || "Transaction";
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start;
    opts?.onPending?.(elapsed);

    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt?.status) {
      if (receipt.status === "0x0") {
        throw new Error(
          `${label} reverted on-chain. Try smaller size or higher slip (2–3%).`
        );
      }
      return { status: receipt.status };
    }

    if (elapsed > 40_000) {
      try {
        const tx = (await provider.request({
          method: "eth_getTransactionByHash",
          params: [hash],
        })) as { hash?: string } | null;
        if (!tx) {
          throw new Error(
            `${label} dropped from mempool (underpriced gas). Speed Up in wallet or retry with a fresh quote.`
          );
        }
      } catch (e) {
        if (e instanceof Error && /dropped|mempool/i.test(e.message)) throw e;
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `${label} still pending — open wallet → Speed Up, or wait. Use the explorer link.`
  );
}

export async function signTypedData(
  address: string,
  domain: unknown,
  types: Record<string, unknown>,
  value: unknown
): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  const typesCopy = { ...types } as Record<string, unknown>;
  delete typesCopy.EIP712Domain;

  let primaryType = "PermitSingle";
  if (typesCopy.PermitBatch) primaryType = "PermitBatch";
  else if (typesCopy.PermitSingle) primaryType = "PermitSingle";
  else {
    const keys = Object.keys(typesCopy);
    if (keys.length === 1) primaryType = keys[0];
    else if (keys.length > 0 && value && typeof value === "object") {
      const msgKeys = Object.keys(value as object);
      const match = keys.find((k) => {
        const fields = typesCopy[k] as { name: string }[] | undefined;
        if (!Array.isArray(fields)) return false;
        return fields.every((f) => msgKeys.includes(f.name));
      });
      primaryType = match || keys[0];
    } else if (keys.length > 0) {
      primaryType = keys[0];
    }
  }

  const payload = JSON.stringify({
    domain,
    types: typesCopy,
    primaryType,
    message: value,
  });

  try {
    return (await provider.request({
      method: "eth_signTypedData_v4",
      params: [address, payload],
    })) as string;
  } catch (err) {
    const msg = (err as { message?: string })?.message || "Signature rejected.";
    if (/user rejected|denied|4001/i.test(msg)) {
      throw new Error("Signature cancelled in wallet.");
    }
    throw new Error(msg);
  }
}

export async function getNativeBalance(address: string): Promise<bigint> {
  const provider = getEthereumProvider();
  if (!provider) return BigInt(0);
  try {
    const hex = (await provider.request({
      method: "eth_getBalance",
      params: [address, "latest"],
    })) as string;
    return BigInt(hex || "0x0");
  } catch {
    return BigInt(0);
  }
}
