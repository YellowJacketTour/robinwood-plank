import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { AccountLayout, createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
const require = createRequire(import.meta.url);

test("Solana account decoder and transfer retain exact u64 values with native-free bigint conversion", () => {
  const amount = (1n << 64n) - 1n;
  const key = new PublicKey(new Uint8Array(32).fill(1));
  const buffer = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: key, owner: key, amount, delegateOption:0, delegate:key, state:1, isNativeOption:0, isNative:0n,
    delegatedAmount:0n, closeAuthorityOption:0, closeAuthority:key }, buffer);
  assert.equal(AccountLayout.decode(buffer).amount, amount);
  const ix = createTransferCheckedInstruction(key,key,key,key,amount,0,[],TOKEN_PROGRAM_ID);
  assert.equal(Buffer.from(ix.data).readBigUInt64LE(1), amount);
  const layoutRequire = createRequire(require.resolve("@solana/buffer-layout-utils"));
  const entry = layoutRequire.resolve("bigint-buffer");
  assert.doesNotMatch(readFileSync(entry,"utf8"), /require\(['"]bindings['"]\)/);
  const converter = layoutRequire("bigint-buffer");
  const wide = Buffer.alloc(4096,255);
  assert.equal(converter.toBigIntLE(wide), (1n << 32768n) - 1n);
});
