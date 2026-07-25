/**
 * Final NFT holder audit + 20lab multisender CSV.
 *
 * Run: node scripts/holder-airdrop-audit.mjs
 * Writes:
 *   public/exports/plank-holders-audit.json
 *   public/exports/plank-airdrop-20lab.csv   (address,amount) for 20lab upload
 *   public/exports/plank-airdrop-20lab.txt   (same, no header)
 *   public/exports/plank-airdrop-full.csv    (audit columns)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "public", "exports");

const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const PLANK = "0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc";
const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const AIRDROP_PCT = 4.2069; // official holder share of total supply

const nftAbi = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
];
const plankAbi = [
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const ZERO = "0x0000000000000000000000000000000000000000";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, label, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(200 * (i + 1));
    }
  }
  throw new Error(`${label}: ${last?.message || last}`);
}

async function main() {
  const provider = new JsonRpcProvider(RPC, 4663, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  const nft = new Contract(NFT, nftAbi, provider);
  const plank = new Contract(PLANK, plankAbi, provider);

  console.log("Reading on-chain totals…");
  const [nftSupplyBn, plankWei, decimals] = await Promise.all([
    withRetry(() => nft.totalSupply(), "nft.totalSupply"),
    withRetry(() => plank.totalSupply(), "plank.totalSupply"),
    withRetry(() => plank.decimals(), "plank.decimals"),
  ]);
  const nftSupply = Number(nftSupplyBn);
  const dec = Number(decimals);
  const scale = 10n ** BigInt(dec);
  const plankHuman = plankWei / scale;

  // pool = supply * 4.2069 / 100  using micro-percent (4.2069% = 4206900 / 1e8)
  const pctScaled = BigInt(Math.round(AIRDROP_PCT * 1_000_000)); // 4206900
  const poolHuman =
    (plankHuman * pctScaled) / (100n * 1_000_000n);

  console.log({
    nftSupply,
    plankHuman: plankHuman.toString(),
    poolHuman: poolHuman.toString(),
    airdropPct: AIRDROP_PCT,
  });

  // ownerOf scan
  const counts = new Map(); // address -> count from scan
  const BATCH = 15;
  for (let start = 1; start <= nftSupply; start += BATCH) {
    const end = Math.min(nftSupply, start + BATCH - 1);
    const promises = [];
    for (let id = start; id <= end; id++) {
      promises.push(
        withRetry(() => nft.ownerOf(id), `ownerOf(${id})`).then((o) =>
          String(o).toLowerCase()
        )
      );
    }
    const owners = await Promise.all(promises);
    for (const o of owners) {
      if (!o || o === ZERO) continue;
      counts.set(o, (counts.get(o) || 0) + 1);
    }
    if (start % 150 === 1 || end === nftSupply) {
      console.log(`  scanned tokens ${end}/${nftSupply}`);
    }
  }

  // Verify every holder with balanceOf
  console.log("Verifying balances…");
  const holders = [];
  let verifiedNfts = 0;
  for (const [addr, scanned] of counts.entries()) {
    const bal = Number(
      await withRetry(() => nft.balanceOf(addr), `balanceOf(${addr})`)
    );
    if (bal !== scanned) {
      console.warn(`  balance mismatch ${addr}: scan=${scanned} bal=${bal}`);
    }
    const nfts = bal > 0 ? bal : scanned;
    if (nfts <= 0) continue;
    holders.push({ address: addr, nfts });
    verifiedNfts += nfts;
  }

  holders.sort((a, b) => b.nfts - a.nfts || a.address.localeCompare(b.address));

  const totalNfts = verifiedNfts;
  if (totalNfts !== nftSupply) {
    console.warn(
      `WARNING: sum(balances)=${totalNfts} vs totalSupply=${nftSupply}`
    );
  }

  // Pro-rata allocation (integer, floor) — remainder stays unallocated
  let allocated = 0n;
  const rows = holders.map((h, i) => {
    const amount =
      totalNfts > 0
        ? (poolHuman * BigInt(h.nfts)) / BigInt(totalNfts)
        : 0n;
    allocated += amount;
    const share = totalNfts > 0 ? h.nfts / totalNfts : 0;
    return {
      rank: i + 1,
      address: h.address,
      nfts: h.nfts,
      amount: amount.toString(),
      amountWei: (amount * scale).toString(),
      pctOfPool: Number((share * 100).toFixed(8)),
      pctOfSupply: Number((AIRDROP_PCT * share).toFixed(10)),
    };
  });

  const remainder = poolHuman - allocated;

  const audit = {
    generatedAt: new Date().toISOString(),
    chainId: 4663,
    nftContract: NFT,
    plankContract: PLANK,
    nftTotalSupply: nftSupply,
    uniqueHolders: holders.length,
    sumNftBalances: totalNfts,
    plankTotalSupply: plankHuman.toString(),
    airdropPercentOfSupply: AIRDROP_PCT,
    airdropPoolTokens: poolHuman.toString(),
    allocatedTokens: allocated.toString(),
    unallocatedRemainder: remainder.toString(),
    note:
      "Amounts are human PLANK units (18 decimals on-chain). 20lab CSV uses address,amount. Pro-rata by current NFT balanceOf.",
    top10: rows.slice(0, 10),
  };

  mkdirSync(OUT, { recursive: true });

  // 20lab: address,amount — human token amount (multisender standard)
  const labHeader = "address,amount\n";
  const labBody = rows.map((r) => `${r.address},${r.amount}`).join("\n") + "\n";
  writeFileSync(join(OUT, "plank-airdrop-20lab.csv"), labHeader + labBody, "utf8");
  writeFileSync(join(OUT, "plank-airdrop-20lab.txt"), labBody, "utf8");

  // Full audit CSV
  const fullHeader =
    "rank,address,nfts,amount_plank,amount_wei,pct_of_pool,pct_of_supply\n";
  const fullBody =
    rows
      .map(
        (r) =>
          `${r.rank},${r.address},${r.nfts},${r.amount},${r.amountWei},${r.pctOfPool},${r.pctOfSupply}`
      )
      .join("\n") + "\n";
  writeFileSync(join(OUT, "plank-airdrop-full.csv"), fullHeader + fullBody, "utf8");

  writeFileSync(
    join(OUT, "plank-holders-audit.json"),
    JSON.stringify({ ...audit, holders: rows }, null, 2),
    "utf8"
  );

  console.log("\n=== AUDIT SUMMARY ===");
  console.log(`Holders:     ${holders.length}`);
  console.log(`NFTs:        ${totalNfts} / supply ${nftSupply}`);
  console.log(`PLANK supply:${plankHuman.toString()}`);
  console.log(`Pool 4.2069%:${poolHuman.toString()}`);
  console.log(`Allocated:   ${allocated.toString()}`);
  console.log(`Remainder:   ${remainder.toString()} (floor dust)`);
  console.log(`Top holder:  ${rows[0]?.address} · ${rows[0]?.nfts} NFTs · ${rows[0]?.amount} PLANK`);
  console.log(`\nWrote:`);
  console.log(`  ${join(OUT, "plank-airdrop-20lab.csv")}  ← upload to 20lab`);
  console.log(`  ${join(OUT, "plank-airdrop-20lab.txt")}`);
  console.log(`  ${join(OUT, "plank-airdrop-full.csv")}`);
  console.log(`  ${join(OUT, "plank-holders-audit.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
