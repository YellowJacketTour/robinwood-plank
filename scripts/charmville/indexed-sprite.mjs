import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4), tail = Buffer.alloc(4);
  header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, tail]);
}

// Asset-format compilation, not quantization: retain every opaque source color
// exactly and reserve index zero exclusively for transparent pixels. Allegro's
// 8-bit masked sprite renderer cannot safely consume RGBA source bitmaps.
export function compileIndexedSprite(bytes) {
  const { width, height, data } = PNG.sync.read(bytes);
  const colors = [[0, 0, 0]], indices = new Map();
  const scanlines = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4, alpha = data[offset + 3];
    if (alpha === 0) continue;
    if (alpha !== 255) throw Error('Native indexed sprites require binary transparency; partial alpha needs an explicit art decision.');
    const rgb = Array.from(data.subarray(offset, offset + 3)), key = rgb.join(',');
    if (!indices.has(key)) {
      if (colors.length === 256) throw Error('Native sprite exceeds 255 opaque colors; refusing silent quantization.');
      indices.set(key, colors.length); colors.push(rgb);
    }
    scanlines[y * (width + 1) + x + 1] = indices.get(key);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 3;
  return {
    colors: colors.flat(),
    bytes: Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
      // Allegro loadpng expands tRNS to 32-bit RGBA. Its native mask renderer
      // requires 8-bit pixels and treats index zero as transparent itself.
      chunk('PLTE', Buffer.from(colors.flat())),
      chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]),
  };
}
