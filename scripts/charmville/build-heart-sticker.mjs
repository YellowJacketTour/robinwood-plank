#!/usr/bin/env node
// Original SVG derivative only. Inventory continues to use the unchanged static master.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const masterPath='public/charmville/items/burning-heart.svg';
const target='public/charmville/stickers';
const master=await readFile(masterPath,'utf8');
const paths=[...master.matchAll(/<path\s[^>]*\/>/g)].map(m=>m[0]);
if(paths.length!==7)throw Error('Canonical Heart paths changed: review derivative layering before rebuilding');
const silhouette=paths[0];
const art=paths.map((p,i)=>p.replace('<path',`<path${i===2?' class="flame-light"':i===5?' class="heart-light"':''}`)).join('\n');
const css=`.heart{animation:float 3.2s steps(1,end) infinite}.flame-light,.heart-light{animation:warmth 3.2s ease-in-out infinite}.flame-light{animation-delay:-1.6s}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}@keyframes warmth{0%,100%{opacity:1}50%{opacity:.9}}@media(prefers-reduced-motion:reduce){.heart,.flame-light,.heart-light{animation:none!important;transform:none!important;opacity:1!important}}`;
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges"><title>Burning Heart — a little love, kept alight</title><desc>Original Charmville heart and flame. A gentle one-pixel rise and warm light; reduced-motion settings show the still heart.</desc><style>${css}</style><g class="heart">${art}</g></svg>\n`;
if(!svg.includes(silhouette))throw Error('Canonical silhouette was not preserved');
await mkdir(target,{recursive:true});
await writeFile(path.join(target,'burning-heart.svg'),svg);
const hash=s=>createHash('sha256').update(s).digest('hex');
const metadata={schemaVersion:1,id:'burning-heart.warmth',itemDefinition:'burning-heart',master:{path:'/'+masterPath.replace(/^public\//,''),sha256:hash(master)},animated:{path:'/charmville/stickers/burning-heart.svg',sha256:hash(svg),format:'image/svg+xml',cycleMs:3200,maximumTranslationPixels:1,minimumOpacity:.9},staticFallback:'/'+masterPath.replace(/^public\//,''),reducedMotion:'prefers-reduced-motion: reduce disables all animation',source:'Charmville original artwork',message:'Christian love, generosity and conviction rooted in Christ and the gospels; a little love grown and freely given.',authority:'presentation-only',usage:'Opt-in social sticker presentation. Does not mint, consume, transfer or pin an item.',acceptance:{sourceSilhouettePreserved:true,browserPlaybackReviewed:false,allGameAnimationsComplete:false}};
await writeFile(path.join(target,'burning-heart.json'),JSON.stringify(metadata,null,2)+'\n');
console.log(JSON.stringify({asset:metadata.animated.path,masterSha256:metadata.master.sha256,animatedSha256:metadata.animated.sha256,cycleMs:metadata.animated.cycleMs},null,2));
