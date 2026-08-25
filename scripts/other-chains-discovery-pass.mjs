import { runRobinhoodChainDiscoveryScan } from "../lib/market/multichain/discovery/robinhood-chain-scan.ts";
import { runHeliusCollectionScan } from "../lib/market/multichain/discovery/helius-collection-scan.ts";
import { runMagicEdenCatalogScan } from "../lib/market/multichain/discovery/magiceden-catalog-scan.ts";
import { runUnisatCollectionListScan } from "../lib/market/multichain/discovery/unisat-collection-list-scan.ts";
import { runOrdiscanCollectionScan } from "../lib/market/multichain/discovery/ordiscan-collection-scan.ts";

// Keeps Robinhood Chain, Solana, and Bitcoin actively covered too -- the
// EVM supervisor loop only covers the 8 EVM chains, so these three were
// going stale otherwise. Same 3-minute bounded pass, clean exit pattern.
const started = Date.now();
let round = 0;
while (Date.now() - started < 1000 * 60 * 3) {
  round += 1;
  const line = [];
  try {
    const r = await runRobinhoodChainDiscoveryScan();
    if (r.registered > 0) line.push(`robinhood:+${r.registered}@${r.toBlock}`);
  } catch (e) {
    console.log(`[robinhood-err] ${e instanceof Error ? e.message : e}`);
  }
  try {
    const s = await runHeliusCollectionScan({ maxPages: 5 });
    if (s.registered > 0 || s.done) line.push(`solana-core:+${s.registered}${s.done ? " DONE" : ""}`);
  } catch (e) {
    console.log(`[solana-err] ${e instanceof Error ? e.message : e}`);
  }
  try {
    // Exhaustive legacy-standard catalog walk (see magiceden-catalog-scan.ts
    // header) -- the real long tail helius-collection-scan.ts's Core-only
    // scope and discoverTopCollections' top-N ranking both structurally miss.
    const me = await runMagicEdenCatalogScan({ maxPages: 25 });
    if (me.registered > 0 || me.done) line.push(`solana-catalog:+${me.registered}${me.done ? " DONE" : ""}`);
  } catch (e) {
    console.log(`[solana-catalog-err] ${e instanceof Error ? e.message : e}`);
  }
  try {
    const b = await runUnisatCollectionListScan({ maxPages: 5 });
    if (b.registered > 0 || b.done) line.push(`bitcoin:+${b.registered}${b.done ? " DONE" : ""}`);
  } catch (e) {
    console.log(`[bitcoin-err] ${e instanceof Error ? e.message : e}`);
  }
  try {
    const o = await runOrdiscanCollectionScan({ maxPages: 5 });
    if (o.registered > 0 || o.done) line.push(`ordiscan:+${o.registered}${o.done ? " DONE" : ""}`);
  } catch (e) {
    console.log(`[ordiscan-err] ${e instanceof Error ? e.message : e}`);
  }
  console.log(`round ${round}: ${line.join(" ") || "(no new candidates)"}`);
}
process.exit(0);
