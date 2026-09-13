import test from 'node:test';
import assert from 'node:assert/strict';
import { compileWorldTopology } from './world-topology.mjs';

const room = (screen, extra = {}) => ({ screen, authored: true, roomType: 0, allSolid: 0, ...extra });

test('source positions survive arbitrary input order and never wrap east edges', () => {
  const topology = compileWorldTopology({ rooms: [room(31), room(16), room(15), room(0)] });
  assert.deepEqual(topology.nodes.map(({ screen, sourceX, sourceY }) => ({ screen, sourceX, sourceY })), [
    { screen: 0, sourceX: 0, sourceY: 0 }, { screen: 15, sourceX: 3840, sourceY: 0 },
    { screen: 16, sourceX: 0, sourceY: 176 }, { screen: 31, sourceX: 3840, sourceY: 176 },
  ]);
  assert.deepEqual(topology.spatialNeighborCandidates.map(({ from, to }) => [from, to]), [[0, 16], [15, 31]]);
});

test('holes and missing screens never gain nodes or adjacency; special/solid rooms stay unverified', () => {
  const topology = compileWorldTopology({ rooms: [room(62), room(63, { roomType: 9, allSolid: 176 }), room(61, { authored: false }), room(78)] });
  assert.deepEqual(topology.nodes.map((node) => node.screen), [62, 63, 78]);
  assert.deepEqual(topology.spatialNeighborCandidates, [
    { from: 62, to: 63, direction: 'east', traversability: 'unverified' },
    { from: 62, to: 78, direction: 'south', traversability: 'unverified' },
  ]);
  assert.equal(topology.nodes[1].roomType, 9);
  assert.equal(topology.nodes[1].allSolid, 176);
  assert.equal(topology.travelValidation, 'required');
});

test('all warp records are retained separately without destination interpretation or aliases', () => {
  const record = { slot: 0, tileType: 4, tileDmap: 149, tileScreen: 97, sideType: 0, sideScreen: 0 };
  const inventory = { meta: { dmap: 4, map: 10 }, rooms: [room(3, { warps: [record] }), room(4, { authored: false, warps: [{ slot: 0, tileType: 0 }] })] };
  const topology = compileWorldTopology(inventory);
  assert.deepEqual(topology.warpRecords, [
    { sourceScreen: 3, sourceAuthored: true, record },
    { sourceScreen: 4, sourceAuthored: false, record: { slot: 0, tileType: 0 } },
  ]);
  assert.equal(topology.spatialNeighborCandidates.length, 0);
  topology.warpRecords[0].record.tileScreen = 2;
  topology.source.map = 2;
  assert.equal(record.tileScreen, 97);
  assert.equal(inventory.meta.map, 10);
});

test('reject ambiguous or invalid screen identities instead of generating corrupt topology', () => {
  for (const screen of [-1, 128, 1.5, '1', undefined]) {
    assert.throws(() => compileWorldTopology({ rooms: [room(screen)] }), RangeError);
  }
  assert.throws(() => compileWorldTopology({ rooms: [room(1), room(1, { authored: false })] }), /Duplicate/);
  assert.throws(() => compileWorldTopology({ rooms: [room(1, { warps: {} })] }), TypeError);
  assert.throws(() => compileWorldTopology({}), TypeError);
});

test('empty inventory and final row have bounded topology', () => {
  assert.equal(compileWorldTopology({ rooms: [] }).nodes.length, 0);
  const topology = compileWorldTopology({ rooms: [room(126), room(127)] });
  assert.deepEqual(topology.spatialNeighborCandidates.map(({ from, to }) => [from, to]), [[126, 127]]);
  assert.equal(topology.nodes[1].sourceY, 1232);
});
