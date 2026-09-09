import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { Block, Transaction } from "bitcoinjs-lib";
import { Hose } from "../../packages/akasha/src/hose/main";
import { EsploraBitcoinRpc } from "../../packages/akasha/src/hose/rpc/bitcoin";
import { BitcoinAdapter } from "../../packages/akasha/src/hose/adapters/bitcoin";
import { ArchiveStore } from "../../packages/akasha/src/hose/store";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { BackfillWorker } from "../../packages/akasha/src/hose/backfill";
import { PostgresArchiveStore } from "../../packages/akasha/src/hose/pg-store";

function fixture(parent = "00".repeat(32), count = 1) {
  const block = new Block();
  block.prevHash = Buffer.from(parent, "hex").reverse();
  block.transactions = Array.from({ length: count }, (_, i) => {
    const tx = new Transaction();
    tx.addInput(Buffer.alloc(32), 0xffffffff, undefined, Buffer.from([1, i & 255]));
    tx.addOutput(Buffer.from([0x51]), BigInt(i + 1));
    return tx;
  });
  block.merkleRoot = Block.calculateMerkleRoot(block.transactions);
  return block;
}

test("actual hose boot repairs prefixed parent and backfill sees the corrected height index", async () => {
  const prior = fixture(); const lock = fixture(prior.getId());
  const lockHash = lock.getId(); const parent = prior.getId();
  const updates: unknown[][] = []; const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url === `/block/${lockHash}`) { res.end(JSON.stringify({ id: lockHash, height: 767431, previousblockhash: parent })); }
    else if (req.url === `/block-height/767430`) res.end(parent);
    else if (req.url === `/block/${parent}`) res.end(JSON.stringify({ id: parent, height: 767430, previousblockhash: "00".repeat(32) }));
    else if (req.url === `/block/${parent}/raw`) res.end(Buffer.from(prior.toBuffer()));
    else { res.statusCode = 404; res.end(); }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const hose = new Hose({ chains: ["bitcoin"], endpoints: {}, bitcoinHosts: [`http://127.0.0.1:${port}`], sha256: () => `0x${"00".repeat(32)}`,
    sql: { async query(sql, values) {
      if (sql === "SELECT * FROM akasha_cursor") return { rows: [{ chain: "bitcoin", t0_hash: Buffer.from(lockHash,"hex"), t0_height: 767431,
        tip_hash: Buffer.from(lockHash,"hex"), tip_height: 767431, finalized_hash: Buffer.from(lockHash,"hex"), finalized_height: 767431,
        protocol_t0: 767430, backfill_tail: 767431, stream_kind: "zmq" }] };
      if (sql.includes("SELECT chain, hash, parent_hash, height")) return { rows: [{ chain:"bitcoin", hash:Buffer.from(lockHash,"hex"), parent_hash:Buffer.alloc(32,3), height:767431 }] };
      if (sql.startsWith("UPDATE akasha_header")) updates.push(values!);
      return { rows: [] };
    } },
  });
  try {
    await hose.boot(); await hose.flush();
    assert.ok(paths.includes(`/block/${lockHash}`), "repair uses Esplora wire hash");
    assert.equal(updates.length, 1, "durable repair was issued");
    assert.equal(hose.store.headersAtHeight("bitcoin", 767431)[0].parentHash, `0x${parent}`);
    const progress = await hose.backfillTick() as { tailMoved: boolean };
    assert.equal(progress.tailMoved, true, "actual wired backfill advances after repair");
    assert.equal(hose.durableStore!.getBackfillTail("bitcoin"), 767430);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("raw block fetch ingests beyond 500 transactions and refuses corrupted or partial bytes without coverage", async () => {
  const block = fixture(undefined, 501); const original = Buffer.from(block.toBuffer());
  let bytes = original; let advertised = block.getId();
  const rpc = new EsploraBitcoinRpc({ hosts: ["https://fixture.invalid"], fetchImpl: (async (url) =>
    String(url).endsWith("/raw") ? new Response(bytes) : Response.json({ id: advertised, height: 800000 })) as typeof fetch });
  assert.equal((await rpc.getBlock(`0x${block.getId()}`))!.tx.length, 501);
  const store = new ArchiveStore(); const adapter = new BitcoinAdapter({ rpc, store, sha256: () => "0x00" });
  bytes = Buffer.from(original); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(adapter.ingestBlock(block.getId()), /commitment/);
  assert.equal(store.coverageFor("bitcoin").length, 0);
  bytes = original.subarray(0, original.length - 1);
  await assert.rejects(adapter.ingestBlock(block.getId()));
  assert.equal(store.coverageFor("bitcoin").length, 0);
  bytes = original; advertised = "11".repeat(32);
  await assert.rejects(adapter.ingestBlock(advertised), /hash mismatch/);
  bytes = Buffer.concat([original, Buffer.from([0])]);
  await assert.rejects(adapter.ingestBlock(block.getId()), /size\/weight/);
  bytes = Buffer.alloc(4_000_001);
  await assert.rejects(adapter.ingestBlock(block.getId()), /byte limit/);
});

test("actual worker deadline exits before a late phase can write or a second phase can start", () => {
  const source = ts.createSourceFile("worker.ts", readFileSync("scripts/akasha-hose.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(source) === "phase") initializer = node.initializer; ts.forEachChild(node, visit); }
  visit(source); assert.ok(initializer);
  const code = ts.transpileModule(`const hose = {}; const chains = ['bitcoin']; const PHASE_TIMEOUT_MS = 10;
    const phase = ${initializer.getText(source)};
    phase('late', () => new Promise(r => setTimeout(() => { console.log('LATE_WRITE'); r(); }, 80))).then(() => console.log('SECOND_PHASE'));
    `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const child = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 75);
  assert.doesNotMatch(child.stdout, /LATE_WRITE|SECOND_PHASE/);
  assert.match(child.stderr, /fence unfinished writes/);
});

for (const missing of [767431, 767433]) test(`backfill refuses an epoch with missing header ${missing}`, async () => {
  const store = new PostgresArchiveStore({ query: async () => ({ rows: [] }) });
  const hash = (n: number) => `0x${n.toString(16).padStart(64,"0")}` as const;
  store.putCursor({ chain:"bitcoin", t0Height:767433, t0Hash:hash(767433), tipHeight:767433, tipHash:hash(767433),
    finalizedHeight:767433, finalizedHash:hash(767433), streamKind:"zmq", streamAlive:false });
  store.setBackfillTail("bitcoin",767433);
  const header = (height: number) => ({ chain:"bitcoin" as const, height, hash:hash(height), parentHash:hash(height-1) });
  for (let height=767430; height<=767433; height++) if(height!==missing) store.putHeader(header(height));
  const worker = new BackfillWorker({ store, ingestRange: async () => header(767430) });
  assert.equal((await worker.step(["bitcoin"]))!.tailMoved,false);
  assert.equal(store.getBackfillTail("bitcoin"),767433);
});
