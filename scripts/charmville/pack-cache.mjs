import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");

/** Additive and deterministic: existing revisions and their assets are retained for N-1 clients. */
export async function packCharmvilleCache(root = process.cwd()) {
  const publicRoot = resolve(root, "public"), sourceRoot = resolve(publicRoot, "images/charmville");
  const prefix = "/images/charmville/cache";
  const writePublic = async (url, bytes) => {
    const destination = resolve(publicRoot, `.${url}`);
    if (!destination.startsWith(sourceRoot + "/") && !destination.startsWith(sourceRoot + "\\")) throw Error("Cache output escaped its asset directory");
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  };
  const readJson = async path => JSON.parse(await readFile(resolve(sourceRoot, path), "utf8"));
  const crop = await readJson("original/manifest.json"), character = await readJson("quaternius-farmer/atlases/manifest.json"), scenery = await readJson("kenney/scenery.json");
  const assets = {};
  const add = async (id, relative, expected, provenance) => {
    const bytes = await readFile(resolve(sourceRoot, relative));
    const sha256 = hash(bytes), extension = extname(relative).slice(1), url = `${prefix}/assets/${sha256}.${extension}`;
    let dimensions = {}, mime;
    if (extension === "glb") {
      if (bytes.length < 20 || bytes.toString("utf8", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a || 20 + bytes.readUInt32LE(12) > bytes.length) throw Error(`Invalid GLB for ${id}`);
      const model = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
      if (model.asset?.version !== "2.0" || [...(model.buffers ?? []), ...(model.images ?? [])].some(item => item.uri && !item.uri.startsWith("data:"))) throw Error(`GLB must be self-contained for ${id}`);
      mime = "model/gltf-binary";
    } else {
      if (!["png", "webp"].includes(extension)) throw Error(`Unsupported cache image: ${relative}`);
      const metadata = await sharp(bytes).metadata();
      if (!metadata.width || !metadata.height || (expected && (metadata.width !== expected[0] || metadata.height !== expected[1]))) throw Error(`Invalid dimensions for ${id}`);
      dimensions = { width: metadata.width, height: metadata.height };
      mime = extension === "webp" ? "image/webp" : "image/png";
    }
    if (provenance?.expectedHash && sha256 !== provenance.expectedHash) throw Error(`Workshop manifest hash mismatch for ${id}`);
    await writePublic(url, bytes);
    assets[id] = { url, sha256, bytes: bytes.length, ...dimensions, mime, source: `/images/charmville/${relative}`, ...(provenance ? { authoringSource: provenance.sourceId } : {}) };
  };
  for (const face of ["stalk", "splinter"]) for (const stage of ["seedling", "growing", "ripe"]) await add(`crop:${face}:${stage}`, `original/${face}-${stage}.png`, [crop.frameSize[0] * crop.frames, crop.frameSize[1]]);
  for (const [action, frames] of Object.entries(character.actions)) for (let direction = 0; direction < character.directions; direction++) await add(`character:${action}:${direction}`, `quaternius-farmer/atlases/${action}-${direction}.webp`, [character.frameWidth * frames, character.frameHeight]);
  const faces = ["stalk", "splinter", "knock", "hum", "pith", "gleam", "knot"];
  for (const face of faces) await add(`face:${face}`, `charms/${face}.png`);
  for (const name of ["soil", "turf", "boardwalk", "access-path"]) await add(`terrain:${name}`, `original/${name}.png`);
  for (const name of (await readdir(resolve(sourceRoot, "kenney"))).filter(name => name.endsWith(".png")).sort()) await add(`scenery:${name.slice(0, -4)}`, `kenney/${name}`);
  const workshop = await readJson("workshop/manifest.json"), authoringSources = {}, workshopDefinitions = [];
  for (const [id, item] of Object.entries(workshop.assets).sort(([a], [b]) => a.localeCompare(b))) {
    const sourceBytes = await readFile(resolve(sourceRoot, "workshop", item.source));
    const sourceHash = hash(sourceBytes), sourceId = `workshop:${id}:source`;
    if (sourceHash !== item.sha256.source) throw Error(`Workshop source hash mismatch for ${id}`);
    const sourceUrl = `${prefix}/sources/${sourceHash}.blend`;
    await writePublic(sourceUrl, sourceBytes);
    authoringSources[sourceId] = { url: sourceUrl, sha256: sourceHash, bytes: sourceBytes.length, mime: "application/x-blender", original: `/images/charmville/workshop/${item.source}`, author: workshop.author, license: workshop.license, generator: workshop.generator, blender: workshop.blender };
    const definition = { id: `workshop:${id}`, frameSize: item.frameSize, ...(item.anchor ? { anchor: item.anchor } : {}), ...(item.seamless ? { seamless: true } : {}), authoringSource: sourceId };
    for (const variant of ["image", "image3x", "model"]) {
      if (!item[variant]) continue;
      const assetId = `workshop:${id}:${variant}`;
      await add(assetId, `workshop/${item[variant]}`, variant === "model" ? undefined : item.frameSize.map(size => size * (variant === "image3x" ? 3 : 1)), { expectedHash: item.sha256[variant], sourceId });
      definition[variant] = assetId;
    }
    workshopDefinitions.push(definition);
  }
  const definitions = {
    schemaVersion: 1,
    authority: "server-receipts-and-yard-snapshots",
    faces: faces.map(id => ({ id, portrait: `face:${id}`, cropAvailable: ["stalk", "splinter"].includes(id) })),
    crops: ["stalk", "splinter"].map(id => ({ id, stages: Object.fromEntries(["seedling", "growing", "ripe"].map(stage => [stage, `crop:${id}:${stage}`])), frameSize: crop.frameSize, anchor: crop.anchor, frames: crop.frames, fps: crop.fps })),
    geometry: { projection: "orthographic-2:1", tileSize: [80, 40], origin: [360, 70], sceneryBounds: [0, 0, 8, 8], cropFootprint: [2, 3, 7, 6], crop: { frameSize: crop.frameSize, anchor: crop.anchor }, scenery: { frameSize: scenery.frameSize, anchor: scenery.anchor }, miniature: { frameSize: [256, 512], anchor: [128, 448] } },
    maps: [{ id: "porch:starter", plots: Array.from({ length: 6 }, (_, index) => ({ id: `plot:${index}`, plotIndex: index, cell: [2.5 + index % 3 * 2, 3.5 + Math.floor(index / 3) * 2] })) }],
    animations: Object.entries(character.actions).map(([id, frames]) => ({ id, frameSize: [character.frameWidth, character.frameHeight], frames, fps: 8, directions: Array.from({ length: character.directions }, (_, direction) => `character:${id}:${direction}`), loop: id !== "pickup" })),
    stamps: { enabledFaces: ["stalk"], accounting: "accepted-server-receipts", quantities: "server-snapshot" },
    landValue: { status: "not-implemented", formula: null },
    workshop: workshopDefinitions,
    authoring: { crops: "scripts/charmville/render_crops.py", character: "scripts/charmville/render_sourced_character.py", portraits: "scripts/charmville/render_charms.py", credits: "/images/charmville/CREDITS.html", gltf: workshop.generator, sources: authoringSources },
  };
  const defsBytes = encode(definitions), defsHash = hash(defsBytes);
  const defs = { url: `${prefix}/definitions/${defsHash}.json`, sha256: defsHash, bytes: defsBytes.length };
  await writePublic(defs.url, defsBytes);
  const body = { schemaVersion: 1, definitions: defs, assets }, revision = hash(encode(body));
  const manifestBytes = encode({ ...body, revision }), manifest = { revision, url: `${prefix}/revisions/${revision}/manifest.json`, sha256: hash(manifestBytes), bytes: manifestBytes.length };
  await writePublic(manifest.url, manifestBytes);
  let history = [];
  try { history = (await readJson("cache/cache.idx")).revisions; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const revisions = [manifest, ...history.filter(item => item.revision !== revision)];
  const index = { schemaVersion: 1, latest: revision, supported: revisions.slice(0, 2).map(item => item.revision), revisions };
  await writePublic(`${prefix}/cache.idx`, encode(index));
  await writePublic(`${prefix}/index.json`, encode(index));
  // Pin the bundled renderer to a complete revision. It never mixes latest-index
  // metadata with assets from a different publication during a rolling deploy.
  const generatedRoot = resolve(root, "lib/charmville");
  await mkdir(generatedRoot, { recursive: true });
  await writeFile(resolve(generatedRoot, "content-manifest.json"), manifestBytes);
  return { revision, definitionsRevision: defsHash, assets: Object.keys(assets).length, bytes: Object.values(assets).reduce((sum, item) => sum + item.bytes, 0), supported: index.supported };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await packCharmvilleCache(), null, 2));
