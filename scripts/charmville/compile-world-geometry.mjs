import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`Invalid ${label}`);
  return value;
};

/** Static source solidity only. Dynamic gameplay must resolve after this broad phase. */
export function compileWorldGeometry(terrain, topology) {
  const { columns, rows, screenWidth, screenHeight } = topology.layout;
  integer(columns, 1, 256, 'columns'); integer(rows, 1, 256, 'rows');
  if (screenWidth !== 256 || screenHeight !== 176) throw Error('Unsupported source screen dimensions');
  if (terrain.map !== topology.source.map || terrain.dmap !== topology.source.dmap) throw Error('Source identity mismatch');
  const sourceScreens = new Map();
  for (const screen of terrain.screens) {
    integer(screen.screen, 0, columns * rows - 1, 'terrain screen');
    if (sourceScreens.has(screen.screen)) throw Error('Duplicate terrain screen');
    sourceScreens.set(screen.screen, screen);
  }
  const chunks = {};
  for (const node of topology.nodes) {
    const id = integer(node.screen, 0, columns * rows - 1, 'topology screen');
    if (chunks[id]) throw Error('Duplicate topology screen');
    if (node.sourceX !== (id % columns) * screenWidth || node.sourceY !== Math.floor(id / columns) * screenHeight) throw Error('Noncanonical source position');
    const source = sourceScreens.get(id);
    if (!source || !source.layers.some(layer => layer.layer === 0)) throw Error(`Missing terrain for authored screen ${id}`);
    const union = Array(176).fill(0), layerIds = new Set();
    const layers = source.layers.map(layer => {
      integer(layer.layer, 0, 6, 'layer');
      if (layerIds.has(layer.layer)) throw Error('Duplicate layer');
      layerIds.add(layer.layer);
      const solidity = Array(176).fill(null);
      for (const cell of layer.cells) {
        integer(cell.cell, 0, 175, 'cell'); integer(cell.solidity, 0, 15, 'solidity');
        if (solidity[cell.cell] !== null) throw Error('Duplicate cell');
        solidity[cell.cell] = cell.solidity;
        union[cell.cell] |= cell.solidity;
      }
      if (solidity.some(mask => mask === null)) throw Error(`Incomplete layer ${id}:${layer.layer}`);
      return { layer: layer.layer, map: layer.map, sourceScreen: layer.sourceScreen, solidity };
    });
    const blocked = [];
    for (let y = 0; y < 22; y++) for (let x = 0; x < 32; x++) {
      const cell = Math.floor(y / 2) * 16 + Math.floor(x / 2);
      if (union[cell] & (1 << ((x % 2) * 2 + y % 2))) blocked.push([x, y]);
    }
    chunks[id] = { screen: id, x: node.sourceX, y: node.sourceY, width: screenWidth, height: screenHeight, layers, solidity: union, blocked };
  }
  return {
    schemaVersion: 1, source: topology.source, layout: topology.layout,
    cellPixels: 8, missingScreenPolicy: 'blocked', chunks,
    policy: 'Conservative static union of all exported layers; not native traversal authorization.',
    limitations: ['Dynamic objects, water abilities, bridges, doors, elevation, triggers and scripts require native rules.', 'Adjacency does not authorize travel; portals and room transitions remain separate.', 'Missing or unauthored screens and positions outside the source map are blocked.'],
    provenance: { templateSha256: terrain.templateSha256, sourceSha256: terrain.sourceSha256 },
  };
}

/** Coordinates are integer source-world pixels; each bit covers an 8x8 quadrant. */
export function isWorldPointBlocked(geometry, x, y) {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) return true;
  const { columns, rows, screenWidth, screenHeight } = geometry.layout;
  const sx = Math.floor(x / screenWidth), sy = Math.floor(y / screenHeight);
  if (sx >= columns || sy >= rows) return true;
  const chunk = geometry.chunks[sy * columns + sx];
  if (!chunk) return true;
  const cx = Math.floor((x % screenWidth) / 8), cy = Math.floor((y % screenHeight) / 8);
  const cell = Math.floor(cy / 2) * 16 + Math.floor(cx / 2);
  return (chunk.solidity[cell] & (1 << ((cx % 2) * 2 + cy % 2))) !== 0;
}

/** Samples every covered quadrant, including across source screen seams. */
export function isWorldFootprintBlocked(geometry, x, y, width = 16, height = 16) {
  if (![x, y, width, height].every(Number.isSafeInteger) || width <= 0 || height <= 0 || width > 4096 || height > 4096) return true;
  for (let py = Math.floor(y / 8) * 8; py < y + height; py += 8) {
    for (let px = Math.floor(x / 8) * 8; px < x + width; px += 8) {
      if (isWorldPointBlocked(geometry, px, py)) return true;
    }
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve('work/whole-map-audit');
  const [terrainBytes, topologyBytes] = await Promise.all(['terrain.json', 'topology.json'].map(file => readFile(path.join(root, file))));
  const geometry = compileWorldGeometry(JSON.parse(terrainBytes), JSON.parse(topologyBytes));
  geometry.provenance.terrainSha256 = createHash('sha256').update(terrainBytes).digest('hex');
  geometry.provenance.topologySha256 = createHash('sha256').update(topologyBytes).digest('hex');
  await writeFile(path.join(root, 'geometry.json'), JSON.stringify(geometry) + '\n', 'utf8');
  console.log(`Compiled ${Object.keys(geometry.chunks).length} static geometry chunks; no live selection changed.`);
}

