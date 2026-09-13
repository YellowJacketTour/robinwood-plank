/** Match the current256x224 native game plus its6px vertical render allowance.
 * Integer3x keeps the640x480 system dialogs reachable and avoids allocating a
 * large retina backbuffer for an inherently low-resolution source frame.
 * This changes the presentation surface only, never the world viewport. */
export function fitNativeCanvas(source){
 const replacements=[
  ['var VIRTUAL_W = 640;','window.charmvilleNativeFrame = true; var VIRTUAL_W = 768;'],
  ['var VIRTUAL_H = 480;','var VIRTUAL_H = 690;'],
  ['bufW: Math.max(VIRTUAL_W, Math.round(cssW * devicePixelRatio))','bufW: VIRTUAL_W'],
  ['bufH: Math.max(VIRTUAL_H, Math.round(cssH * devicePixelRatio))','bufH: VIRTUAL_H'],
 ];
 for(const [before,after] of replacements){
  if(source.split(before).length!==2)throw Error('Native canvas layout adapter needs review for this runtime build.');
  source=source.replace(before,after);
 }
 return source;
}
