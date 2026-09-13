// JSON Schema draft 2020-12. Keep this deliberately data-only: no executable hooks.
const string = { type: 'string', minLength: 1, maxLength: 2048 };
const id = { type: 'string', pattern: '^[a-z][a-z0-9.-]{0,95}$' };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const version = { type: 'string', pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$' };
const uint = { type: 'integer', minimum: 0, maximum: 65536 };
const positive = { type: 'integer', minimum: 1, maximum: 65536 };
const object = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items, minItems = 0) => ({ type: 'array', minItems, maxItems: 4096, items });
const point = object({ x: uint, y: uint });
const rect = object({ x: uint, y: uint, width: positive, height: positive });
const frame = object({
  asset: id, region: rect, durationMs: positive, origin: point, grip: point,
  collision: rect, flipX: { type: 'boolean' }, flipY: { type: 'boolean' },
});
export const packSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Charmville action and asset pack, version 1',
  ...object({
    schemaVersion: { const: 1 }, id, version,
    authors: array(string, 1),
    dependencies: array(object({ id, version, manifestSha256: hash })),
    assets: array(object({
      id, path: string, sha256: hash, width: positive, height: positive,
      provenance: object({ source: string, revision: string, sourcePath: string, attribution: string }),
      rights: object({
        status: { enum: ['unreviewed', 'permission-recorded', 'licensed', 'original'] },
        license: string, evidence: string,
      }),
    }), 1),
    actions: array(object({
      id, meaning: string, itemDefinition: id,
      authority: { const: 'server-contact' },
      contactMs: uint, recoveryMs: uint,
      interruptPolicy: { enum: ['cancel-before-contact', 'finish-contact-then-cancel'] },
      directions: object(Object.fromEntries(['up', 'down', 'left', 'right'].map(direction => [direction, array(frame, 1)]))),
    }), 1),
  }),
};
