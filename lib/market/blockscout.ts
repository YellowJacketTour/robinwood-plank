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

/**
 * Real bug found live 2026-08-25 (Season 2 $PLANK KOTH watcher build):
 * confirmed Blockscout is genuinely flaky for real, single-shot lookups
 * (fetchTransaction/fetchTxTokenTransfers) the same way `paginate()` above
 * already accounts for on its own pages -- a request that curl answers
 * instantly one moment can hang past a 10-12s timeout moments later. Every
 * single-shot (non-paginated) caller below now gets one retry after a
 * transient failure, matching paginate's own "retry once, then accept
 * defeat" discipline, instead of the caller silently getting an empty/null
 * result on the very first hiccup.
 */
async function bsGetRetried<T>(path: string, timeoutMs: number): Promise<T> {
  try {
    return await bsGet<T>(path, timeoutMs);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return bsGet<T>(path, timeoutMs);
  }
}

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

/**
 * Real bug found live 2026-08-25 (Season 2 $PLANK KOTH watcher build): this
 * used to unconditionally strip any existing query string off `basePath`
 * before appending `next_page_params`, silently DROPPING a fixed filter
 * param (e.g. fetchAddressTokenTransfers's own `?token=...`) from every
 * page after the first -- page 2+ would have quietly returned an
 * unfiltered result set. Now merges next_page_params INTO whatever query
 * basePath already had, keeping any fixed params across every page.
 */
function nextPath(basePath: string, next: Record<string, string | number> | null | undefined): string | null {
  if (!next || Object.keys(next).length === 0) return null;
  const [bare, existingQs] = basePath.split("?");
  const qs = new URLSearchParams(existingQs);
  for (const [k, v] of Object.entries(next)) qs.set(k, String(v));
  return `${bare}?${qs.toString()}`;
}

type BlockscoutPage = {
  items?: unknown[];
  next_page_params?: Record<string, string | number> | null;
};

/**
 * Walks next_page_params, tolerating a mid-walk failure.
 *
 * Blockscout intermittently 500s on a single page deep into a long walk. This
 * used to throw and discard every page already collected, so one transient
 * upstream blip failed the whole catalog/index build — the caller saw nothing
 * rather than the 30 pages that had succeeded. Now a failed page is retried
 * once, and if it still fails we return the partial result. Page 0 failing is
 * a real outage, so that still throws.
 */
async function paginate<T>(
  firstPath: string,
  pick: (page: unknown) => T[],
  maxPages: number
): Promise<T[]> {
  const out: T[] = [];
  let path: string | null = firstPath;
  for (let page = 0; page < maxPages && path; page += 1) {
    let data: BlockscoutPage;
    try {
      data = await bsGet<BlockscoutPage>(path);
    } catch (error) {
      try {
        await new Promise((r) => setTimeout(r, 500));
        data = await bsGet<BlockscoutPage>(path);
      } catch (retryError) {
        if (page === 0) throw retryError;
        console.warn(
          `[blockscout] partial walk: ${out.length} items from ${page} page(s) before ${
            retryError instanceof Error ? retryError.message : String(retryError)
          }`
        );
        return out;
      }
    }
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

/**
 * Every transfer of ONE token touching ONE address, newest first.
 *
 * Real bug found live 2026-08-25 (Season 2 $PLANK KOTH watcher build):
 * `/api/v2/tokens/{address}/transfers` (fetchTokenTransfers below) returns
 * a real HTTP 500 from Blockscout's own server for the $PLANK token
 * specifically (verified via direct curl -- empty body, real 500, not a
 * timeout or malformed request on this app's side). This address-scoped
 * variant (`/api/v2/addresses/{address}/token-transfers`) works fine for
 * the exact same token when scoped to one of $PLANK's own pool addresses,
 * confirmed live -- use this for anything that needs $PLANK transfer
 * history until/unless the token-wide endpoint is fixed upstream.
 */
export async function fetchAddressTokenTransfers(
  address: string,
  tokenAddress: string,
  opts?: { maxPages?: number }
): Promise<BlockscoutTokenTransfer[]> {
  return paginate(
    `/api/v2/addresses/${address}/token-transfers?token=${tokenAddress}`,
    (d) => ((d as { items?: BlockscoutTokenTransfer[] }).items || []) as BlockscoutTokenTransfer[],
    opts?.maxPages ?? 5
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

/**
 * Every transfer of ONE token, mint included, newest first.
 *
 * The item-detail panel used to derive its history by filtering a recent
 * collection-wide activity scan, which only ever contained whatever had moved
 * lately — so a plank that had not traded since it was minted showed "No
 * transfers recorded", and one that had shown only its most recent move with
 * the mint missing. Measured 2026-08-02: #1533 and #1542 each have exactly one
 * real transfer (their mint) and rendered as empty; #1466 has two and rendered
 * one.
 *
 * This is the per-instance endpoint, so it returns that token's complete
 * lineage regardless of how long ago it last moved. One page is plenty — a
 * single plank has a handful of transfers, not hundreds — and keeping it to one
 * request matters because Blockscout rate-limits hard.
 */
export async function fetchTokenInstanceTransfers(
  tokenAddress: string,
  tokenId: string
): Promise<BlockscoutTokenTransfer[]> {
  const d = await bsGet<{ items?: BlockscoutTokenTransfer[] }>(
    `/api/v2/tokens/${tokenAddress}/instances/${encodeURIComponent(tokenId)}/transfers`
  );
  return d.items || [];
}

export type BlockscoutTokenBalance = {
  token?: {
    address_hash?: string;
    symbol?: string;
    name?: string;
    decimals?: string;
    type?: string;
  };
  value?: string;
};

/**
 * Every token an address actually holds (ERC-20 by far the common case,
 * ERC-721/1155 also returned) — one call, not a fixed probe list. This is
 * what caught the admin Finance dashboard silently missing USDG on the swap
 * fee wallet: it only ever checked $PLANK and WETH by address, so anything
 * else that landed there was invisible. Not paginated by Blockscout for this
 * endpoint — one response has every token.
 */
export async function fetchTokenBalances(address: string): Promise<BlockscoutTokenBalance[]> {
  return bsGet<BlockscoutTokenBalance[]>(`/api/v2/addresses/${address}/token-balances`, 8_000);
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
    const data = await bsGetRetried<{ items?: BlockscoutTxTokenTransfer[] }>(
      `/api/v2/transactions/${txHash}/token-transfers`,
      15_000
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
    return await bsGetRetried<BlockscoutTx>(`/api/v2/transactions/${txHash}`, 15_000);
  } catch {
    return null;
  }
}
