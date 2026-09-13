import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./runtime-shell.mjs', import.meta.url), 'utf8');
const parser = source.slice(source.indexOf('export function parseEquipmentSnapshot'), source.indexOf('function mountEquipmentReadout')).replace('export ', '');
const context = {};
vm.runInNewContext(parser, context);
const parse = raw => JSON.parse(JSON.stringify(context.parseEquipmentSnapshot(raw)));
test('equipment uses authored names and preserves distinct A/B identities', () => {
  assert.deepEqual(parse('36|17\nMaster Sword\nBlue return\n'), [{id:36,name:'Master Sword'},{id:17,name:'Blue return'}]);
  assert.deepEqual(parse('-1|5\n\n\n'), [{id:-1,name:'Empty'},{id:5,name:'Unnamed item 5'}]);
});
test('equipment rejects malformed snapshots without guessing a weapon', () => {
  for (const raw of ['NaN|5\nSword', '3|4|5', '1.5|4', '-2|4', '1|99999999999999999', '1|2\na\nb\nc']) assert.equal(parse(raw), null);
});
