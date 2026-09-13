/** Canonical ZQuest source-map coordinates, independent of loaded region/camera. */
export const SOURCE_MAP_LAYOUT = Object.freeze({ columns: 16, rows: 8, screenWidth: 256, screenHeight: 176 });

/**
 * Compile spatial topology only. Authored neighbors are candidates, not walkable
 * connections: collision, layers, side-warp flags, scripts and room semantics
 * must be validated before allowing travel. Warp records remain opaque source
 * metadata; zero-valued slots are not interpreted as active destinations.
 */
export function compileWorldTopology(inventory) {
  if (!inventory || !Array.isArray(inventory.rooms)) throw new TypeError('Inventory rooms must be an array');
  const { columns, rows, screenWidth, screenHeight } = SOURCE_MAP_LAYOUT;
  const seen = new Set();
  for (const room of inventory.rooms) {
    if (!Number.isInteger(room?.screen) || room.screen < 0 || room.screen >= columns * rows) {
      throw new RangeError('Room screen must be an integer between 0 and 127');
    }
    if (seen.has(room.screen)) throw new Error(`Duplicate room screen ${room.screen}`);
    seen.add(room.screen);
    if (room.warps != null && !Array.isArray(room.warps)) throw new TypeError(`Room ${room.screen} warps must be an array`);
  }
  const rooms = inventory.rooms.filter((room) => room.authored === true).toSorted((a, b) => a.screen - b.screen);
  const authored = new Set(rooms.map((room) => room.screen));
  const nodes = rooms.map((room) => ({
    screen: room.screen,
    sourceX: (room.screen % columns) * screenWidth,
    sourceY: Math.floor(room.screen / columns) * screenHeight,
    width: screenWidth,
    height: screenHeight,
    roomType: room.roomType ?? null,
    allSolid: room.allSolid ?? null,
  }));
  const spatialNeighborCandidates = [];
  for (const { screen } of rooms) {
    // Emit each undirected adjacency once; rows cannot wrap at columns 15/0.
    for (const [direction, target, withinBounds] of [
      ['east', screen + 1, screen % columns < columns - 1],
      ['south', screen + columns, screen < columns * (rows - 1)],
    ]) {
      if (withinBounds && authored.has(target)) {
        spatialNeighborCandidates.push({ from: screen, to: target, direction, traversability: 'unverified' });
      }
    }
  }
  // Preserve records even for unauthored source screens: audit metadata must not
  // silently disappear just because that screen cannot become a terrain node.
  const warpRecords = inventory.rooms.toSorted((a, b) => a.screen - b.screen).flatMap((room) =>
    (room.warps ?? []).map((record) => ({ sourceScreen: room.screen, sourceAuthored: room.authored === true, record: structuredClone(record) })));
  return {
    schemaVersion: 1,
    source: structuredClone(inventory.meta ?? {}),
    layout: { ...SOURCE_MAP_LAYOUT },
    nodes,
    spatialNeighborCandidates,
    warpRecords,
    travelValidation: 'required',
  };
}
