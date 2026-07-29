/**
 * Cloudflare Workers kill long vault log-walks (eth_getLogs over hundreds of
 * thousands of blocks). Vercel serverless often survived; Workers free/paid
 * wall-clock budgets do not. These helpers keep Instant Swap live by returning
 * core on-chain reads fast and treating history scans as best-effort.
 */

/** True when running on Cloudflare Workers / Pages. */
export function isCloudflareRuntime(): boolean {
  // workerd identifies itself this way; CF_PAGES/WORKERS_CI set in CI deploys
  const ua =
    typeof navigator !== "undefined"
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        String((navigator as any).userAgent || "")
      : "";
  return (
    ua.includes("Cloudflare-Workers") ||
    Boolean(
      process.env.CF_PAGES ||
        process.env.CF_WORKER ||
        process.env.WORKERS_CI ||
        process.env.OPEN_NEXT_CLOUDFLARE
    )
  );
}

/**
 * Fewer / smaller eth_getLogs windows on Workers so Instant Swap stats and
 * stream ticks finish under the platform limit.
 */
export function logScanBudget(): { chunkBlocks: number; maxChunks: number } {
  if (isCloudflareRuntime()) {
    return { chunkBlocks: 12_000, maxChunks: 3 };
  }
  return { chunkBlocks: 50_000, maxChunks: 12 };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label = "rpc"
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[rpc-budget] ${label} timed out after ${ms}ms — using fallback`);
          resolve(fallback);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
