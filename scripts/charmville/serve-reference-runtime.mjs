import http from 'node:http';
import {createReadStream} from 'node:fs';
import {stat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {adventureUrl,diagnosticKits} from './adventure-entry.mjs';
const root=path.resolve('../charmville-references/zquest-web-runtime');
const contentRoot=path.resolve('../charmville-references/zquest-quest-snapshots');
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm','.css':'text/css','.png':'image/png','.ico':'image/x-icon','.ogg':'audio/ogg'};
const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://localhost:3022; worker-src 'self' blob:"};
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost:3021');
  if(['/runtime-shell.css','/runtime-shell.mjs'].includes(url.pathname)){res.writeHead(200,{...headers,'Content-Type':url.pathname.endsWith('.css')?'text/css':'text/javascript'});res.end(await readFile(new URL('.'+url.pathname,import.meta.url)));return;}
  if(url.pathname.startsWith('/action-sprites/')){
   const name=url.pathname.slice('/action-sprites/'.length);
   if(!['manifest.json','hoe-fg.png','hoe-bg.png','water-fg.png','water-bg.png','gold-hair.png','berry-dirt.png','berry-sprout.png','berry-oran.png'].includes(name)){res.writeHead(404,headers);res.end();return;}
   res.writeHead(200,{...headers,'Content-Type':name.endsWith('.json')?'application/json':'image/png'});res.end(await readFile(path.resolve('../charmville-references/charmville-native-homestead/action-sprites',name)));return;
  }
  if(url.pathname==='/charmville/tutorial/'){
   const entry=new URL(adventureUrl(),'http://localhost:3021');entry.searchParams.set('test','/quests/charmville/homestead/r01/Homestead.qst');res.writeHead(302,{...headers,Location:entry.pathname+entry.search});res.end();return;
  }
  if(url.pathname==='/charmville-display.js'){
   res.writeHead(200,{...headers,'Content-Type':'text/javascript'});res.end(await readFile(new URL('./display-controls.js',import.meta.url)));return;
  }
  if(url.pathname==='/charmville-controller.js'){
   res.writeHead(200,{...headers,'Content-Type':'text/javascript'});res.end(await readFile(new URL('./controller-controls.js',import.meta.url)));return;
  }
  // Existing shared links now skip the original title/story sequence too.
  // Append reference=1 to explicitly replay the unchanged source introduction.
  if(url.pathname==='/charmville/' || (url.pathname==='/play/' && url.searchParams.get('open')==='quests/purezc/139' && !url.searchParams.has('reference'))){
   res.writeHead(302,{...headers,Location:adventureUrl(url.searchParams.get('kit')||'endgame')});res.end();return;
  }
  if(url.pathname==='/reference-data/manifest.json'){
   const manifest={};
   for(const id of ['139','204','461']){const quest=JSON.parse(await readFile(path.join(contentRoot,`${id}-metadata.json`),'utf8'));manifest[quest.id]={...quest,images:[]};}
   try{const quest=JSON.parse(await readFile(path.join(contentRoot,'homestead-metadata.json'),'utf8'));manifest[quest.id]=quest;}catch(error){if(error.code!=='ENOENT')throw error;}
   res.writeHead(200,{...headers,'Content-Type':'application/json'});res.end(JSON.stringify(manifest));return;
  }
  const content=url.pathname.startsWith('/reference-data/');
  const base=content?contentRoot:root;
  const rel=decodeURIComponent(content?url.pathname.slice('/reference-data'.length):url.pathname);
  const resolved=path.resolve(base,'.'+rel);
  if(resolved!==base&&!resolved.startsWith(base+path.sep)){res.writeHead(403,headers);res.end();return;}
  const info=await stat(resolved);
  const file=info.isDirectory()?path.join(resolved,'index.html'):resolved;
  await stat(file);
  // Adapt the web wrapper only; WASM and original quest bytes remain unchanged.
  if(file===path.join(root,'main.js')){
   const original=await readFile(file,'utf8');
   const adapted=original.replace('dataOrigin:"https://data.zquestclassic.com"','dataOrigin:location.origin+"/reference-data"');
   if(adapted===original&&!original.includes('dataOrigin:location.origin+"/reference-data"'))throw Error('Unsupported upstream wrapper');
   res.writeHead(200,{...headers,'Content-Type':'text/javascript'});res.end(adapted);return;
  }
  if(path.extname(file)==='.html'){
   let html=(await readFile(file,'utf8')).replace(/<link[^>]+href="https:\/\/data\.zquestclassic\.com[^>]*>/g,'');
   if(url.pathname==='/play/' && url.searchParams.has('test')){
    // SDL's suspended-audio fallback fails before a user gesture in this build.
    // Start the unchanged engine after a real click, in the required loader order.
    for(const script of ['main.js','zplayer.data.js','zplayer.js']) html=html.replace(`<script src="../${script}"></script>`,'');
    html=html.replace('</head>','<link rel="stylesheet" href="/runtime-shell.css"></head>');
    html=html.replace('</body>',`<script>
     const help=document.createElement('details');
     Object.assign(document.querySelector('header').style,{zIndex:'10001'});
     Object.assign(help.style,{position:'relative',background:'black',padding:'6px',maxWidth:'560px'});
     const summary=document.createElement('summary');summary.textContent='Controls and weapon tests';help.append(summary);
     const instructions=document.createElement('p');instructions.textContent='Arrows move Â· Z sword (hold then release to spin) Â· X selected item Â· Enter inventory. Bow fires immediately in this quest. These isolated tests reset progress and remove the endgame gear that masks damage and costs.';help.append(instructions);
     for(const [key,label] of ${JSON.stringify([['endgame','Full endgame kit'],...Object.entries(diagnosticKits).map(([key,value])=>[key,value.label])])}){const link=document.createElement('a');link.href='/charmville/?kit='+key;link.textContent=label;link.className='panel-button';help.append(link);}
     document.querySelector('.panel-buttons').after(help);
     const tutorial=document.createElement('a');tutorial.href='/charmville/tutorial/';tutorial.textContent='Homestead tutorial';tutorial.className='panel-button';help.append(tutorial);
     const start=document.createElement('button');start.textContent='Enter the world';start.className='panel-button';
     document.querySelector('.panel-buttons').prepend(start);
     start.addEventListener('click',async()=>{start.disabled=true;start.textContent='Loading worldâ€¦';
      try{for(const src of ['../main.js','../zplayer.data.js','../zplayer.js']) {
       if(src==='../zplayer.js' && new URLSearchParams(location.search).get('test')?.includes('/homestead/')){
        const response=await fetch('/action-sprites/manifest.json');if(!response.ok)throw Error('Sprite manifest unavailable');const assets=await response.json();
        const loaded=await Promise.all(assets.map(async asset=>{const response=await fetch('/action-sprites/'+asset.name);if(!response.ok)throw Error('Sprite unavailable');return {name:asset.name,bytes:new Uint8Array(await response.arrayBuffer())};}));
        (Module.preRun??=[]).push(()=>{FS.mkdirTree('/charmville');for(const asset of loaded)FS.writeFile('/charmville/'+asset.name,asset.bytes);});
       }
       await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.body.append(script);});
      }start.remove();}
      catch{start.textContent='Loading failed â€” reload to retry';}
     },{once:true});
    </script><script type="module" src="/charmville-display.js"></script><script type="module" src="/charmville-controller.js"></script><script type="module" src="/runtime-shell.mjs"></script></body>`);
   }
   res.writeHead(200,{...headers,'Content-Type':'text/html'});res.end(html);return;
  }
  res.writeHead(200,{...headers,'Content-Type':types[path.extname(file)]||'application/octet-stream'});
  const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
 }catch(error){res.writeHead(404,{...headers,'Content-Type':'text/plain'});res.end(`Reference resource unavailable: ${error.code||'content adapter error'}`);}
}).listen(3021,'127.0.0.1',()=>console.log('Local reference runtime: http://localhost:3021/play/?open=quests/purezc/139&storage=idb'));
