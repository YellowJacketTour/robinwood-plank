/**
 * Blockscout REST for Robinhood Chain — primary data plane on Cloudflare when
 * public eth_ JSON-RPC rate-limits Worker egress (HTTP 429).
 */

export const BLOCKSCOUT_BASE = "https://robinhoodchain.blockscout.com";

export type BlockscoutNftItem = {
  id: string;
  image_url?: string | null;
  media_url?: string | null;
  metadata?: {
    image?: string;
    name?: string;
    attributes?: Array<{ trait_type?: string; value?: string | number }>;
  } | null;
  token?: { address_hash?: string };
};

export type BlockscoutTokenTransfer = {
  timestamp?: string | null;
  transaction_hash?: string;
  block_number?: number;
  from?: { hash?: string };
  to?: { hash?: string };
  method?: string | null;
  type?: string;
  total?: {
    token_id?: string;
    token_instance?: {
      id?: string;
      image_url?: string | null;
      media_url?: string | null;
      metadata?: { image?: string } | null;
    } | null;
  } | null;
  token?: { address_hash?: string };
};

export type BlockscoutLog = {
  topics?: (string | null)[];
  data?: string;
  index?: number;
  transaction_hash?: string;
  block_number?: number;
  block_timestamp?: string | null;
  decoded?: { method_call?: string; name?: string } | null;
};

export type BlockscoutTx = {
  hash?: string;
  method?: string | null;
  timestamp?: string | null;
  block_number?: number;
  from?: { hash?: string };
  to?: { hash?: string };
  value?: string;
  status?: string;
  raw_input?: string;
  decoded_input?: {
    method_call?: string;
    method_id?: string;
    parameters?: Array<{ name?: string; type?: string; value?: string }>;
  } | null;
};

async function bsGet<T>(path: string, timeoutMs = 15_000): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${BLOCKSCOUT_BASE}${path}`, {
      headers: { Accept: "application/json", "User-Agent": "plank.love/1.0" },
      signal: ac.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Blockscout HTTP ${res.status} ${path}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function nextPath(basePath: string, next: Record<string, string | number> | null | undefined): string | null {
  if (!next || Object.keys(next).length === 0) return null;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) qs.set(k, String(v));
  const join = basePath.includes("?") ? "&" : "?";
  // strip existing query for clean rebuild when path already has ?
  const bare = basePath.split("?")[0];
  return `${bare}?${qs.toString()}`;
}

async function paginate<T>(
  firstPath: string,
  pick: (page: unknown) => T[],
  maxPages: number
): Promise<T[]> {
  const out: T[] = [];
  let path: string | null = firstPath;
  for (let page = 0; page < maxPages && path; page += 1) {
    const data = await bsGet<{
      items?: unknown[];
      next_page_params?: Record<string, string | number> | null;
    }>(path);
    out.push(...pick(data));
    path = nextPath(firstPath, data.next_page_params);
  }
  return out;
}

export async function fetchNftsHeldBy(
  owner: string,
  opts?: { maxPages?: number }
): Promise<BlockscoutNftItem[]> {
  return paginate(
    `/api/v2/addresses/${owner}/nft?type=ERC-721`,
    (d) => ((d as { items?: BlockscoutNftItem[] }).items || []) as BlockscoutNftItem[],
    opts?.maxPages ?? 20
  );
}

export async function fetchTokenInstances(
  tokenAddress: string,
  opts?: { maxPages?: number }
): Promise<BlockscoutNftItem[]> {
  return paginate(
    `/api/v2/tokens/${tokenAddress}/instances`,
    (d) => {
      const items = (d as { items?: Array<BlockscoutNftItem & { id?: string }> }).items || [];
      return items.map((it) => ({ ...it, id: String(it.id) }));
    },
    opts?.maxPages ?? 40
  );
}

export async function fetchTokenTransfers(
  tokenAddress: string,
  opts?: { maxPages?: number }
): Promise<BlockscoutTokenTransfer[]> {
  return paginate(
    `/api/v2/tokens/${tokenAddress}/transfers`,
    (d) => ((d as { items?: BlockscoutTokenTransfer[] }).items || []) as BlockscoutTokenTransfer[],
    opts?.maxPages ?? 5
  );
}

export async function fetchAddressLogs(
  address: string,
  opts?: { maxPages?: number }
): Promise<BlockscoutLog[]> {
  return paginate(
    `/api/v2/addresses/${address}/logs`,
    (d) => ((d as { items?: BlockscoutLog[] }).items || []) as BlockscoutLog[],
    // Vault address logs are mostly share ERC-20 Transfers — need depth.
    opts?.maxPages ?? 25
  );
}

export async function fetchAddressTransactions(
  address: string,
  opts?: { maxPages?: number }
): Promise<BlockscoutTx[]> {
  return paginate(
    `/api/v2/addresses/${address}/transactions`,
    (d) => ((d as { items?: BlockscoutTx[] }).items || []) as BlockscoutTx[],
    opts?.maxPages ?? 5
  );
}

export type BlockscoutTxTokenTransfer = {
  type?: string;
  from?: { hash?: string };
  to?: { hash?: string };
  total?: { token_id?: string; value?: string };
  token?: {
    address_hash?: string;
    address?: string;
    symbol?: string;
    type?: string;
  };
  timestamp?: string | null;
  transaction_hash?: string;
  block_number?: number;
};

/** Token transfers inside one transaction (NFTs + ERC-20). */
export async function fetchTxTokenTransfers(
  txHash: string
): Promise<BlockscoutTxTokenTransfer[]> {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return [];
  try {
    const data = await bsGet<{ items?: BlockscoutTxTokenTransfer[] }>(
      `/api/v2/transactions/${txHash}/token-transfers`,
      12_000
    );
    return data.items || [];
  } catch {
    return [];
  }
}

/** Single transaction detail (value, method, status). */
export async function fetchTransaction(txHash: string): Promise<BlockscoutTx | null> {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  try {
    return await bsGet<BlockscoutTx>(`/api/v2/transactions/${txHash}`, 10_000);
  } catch {
    return null;
  }
}
