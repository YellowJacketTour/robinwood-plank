import {getOrRefreshWithMeta} from "../../../lib/market/multichain/singleflight-cache";
import {closePostgres} from "../../../lib/postgres";
const [key, url] = process.argv.slice(2);
try {
  const result = await getOrRefreshWithMeta(key!, {softTtlMs: 5000, hardTtlMs: 10000}, async () => {
    const response = await fetch(url!, {signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    return await response.text();
  });
  console.log(JSON.stringify({ok: true, ...result}));
} catch (error) {
  console.log(JSON.stringify({ok: false, error: error instanceof Error ? error.message : String(error)}));
  process.exitCode = 1;
} finally { await closePostgres(); }
