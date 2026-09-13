import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutDraftKey, parseLayoutDraft } from "../../lib/charmville/layout-draft";
import { STARTER_DECORATIONS } from "../../lib/charmville/layout";

const draft={version:1,revision:"7",decorations:STARTER_DECORATIONS};
test("layout drafts partition by wallet and profile, with canonical casing",()=>{
  assert.equal(layoutDraftKey("0xAB","Home"),layoutDraftKey("0xab","home"));
  assert.notEqual(layoutDraftKey("0xab","home"),layoutDraftKey("0xcd","home"));
  assert.notEqual(layoutDraftKey("0xab","home"),layoutDraftKey("0xab","neighbor"));
});
test("restores the exact base revision and projects only scenery metadata",()=>{
  const raw={...draft,credentials:"ignored",balance:"9000",decorations:STARTER_DECORATIONS.map(item=>({...item,prose:"ignored"}))};
  assert.deepEqual(parseLayoutDraft(JSON.stringify(raw)),draft);
});
test("malformed, overlapping, out-of-bounds and plot-overlapping drafts are rejected",()=>{
  const invalid=[null,"{","x".repeat(8193),JSON.stringify({...draft,revision:"-1"}),JSON.stringify({...draft,revision:7}),JSON.stringify({...draft,version:2})];
  for(const cell of [{x:2,y:3},{x:9,y:0},{x:1,y:0}])invalid.push(JSON.stringify({...draft,decorations:STARTER_DECORATIONS.map(item=>item.id===0?{...item,...cell}:item)}));
  for(const raw of invalid)assert.equal(parseLayoutDraft(raw),null);
});
