import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {stripWasmDebugBytes} from './strip-wasm-debug.mjs';
// Read-only investigation. This never changes engine files, packages, or gates.
const [engineRoot,packageRoot]=process.argv.slice(2);
if(!engineRoot||!packageRoot||process.argv.length!==4)throw Error('Usage: audit-native-viewport.mjs <engine-source-root> <candidate-root>');
const roots={engine:path.resolve(engineRoot),candidate:path.resolve(packageRoot)};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const checkpoints=[
 ['src/zc/maps.cpp','static std::optional<presentation_camera::geometry> get_world_camera_geometry'],
 ['src/zc/maps.cpp','stretch_blit(scene, framebuf'],
 ['src/zc/maps.cpp','window.charmvilleCameraViewport ='],
 ['src/zc/zelda.cpp','presentbuf = create_bitmap_ex(8,256,224)'],
 ['src/zc/zc_sys.cpp','blit(source, presentbuf'],
 ['src/zc/zc_sys.cpp','int target_bitmap_height = show_bottom_8px'],
 ['src/zc/render.cpp','rti_game.bitmap = create_a5_bitmap(framebuf->w'],
 ['src/zc/render.cpp','float yscale = (float)resy/(h+6)'],
 ['src/zc/render.cpp','return rti_game.rel_mouse().first'],
 ['src/zc/presentation_targets.h','static bool valid(surface_extent'],
];
const sources=[];
for(const [file,marker] of checkpoints){
 const bytes=await readFile(path.join(roots.engine,file)),text=bytes.toString('utf8'),lines=text.split(/\r?\n/);
 const indexes=lines.flatMap((line,index)=>line.includes(marker)?[index]:[]);
 if(indexes.length!==1)throw Error(`Review source marker ${file}: ${marker}`);
 sources.push({file,line:indexes[0]+1,sha256:digest(bytes),context:lines.slice(indexes[0],indexes[0]+3).map(line=>line.trim())});
}
async function binary(file){
 if((await stat(file)).size>512*1024*1024)throw Error('WASM exceeds audit limit');
 const {receipt}=stripWasmDebugBytes(await readFile(file));
 return {bytes:receipt.inputBytes,sha256:receipt.inputSha256,coreSha256:receipt.coreSha256,validated:receipt.inputValidated,debugSections:receipt.removed.map(section=>section.name)};
}
const engine=await binary(path.join(roots.engine,'build_charmville_web/zplayer.wasm'));
const candidate=await binary(path.join(roots.candidate,'runtime/zplayer.wasm'));
console.log(JSON.stringify({kind:'native-viewport-source-binary-audit',acceptedRelease:false,wideViewportComplete:false,engineRevision:execFileSync('git',['-C',roots.engine,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),sources,engine,candidate,matchingExecutableCore:engine.coreSha256===candidate.coreSha256},null,2));
