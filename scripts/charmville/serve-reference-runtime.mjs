import http from 'node:http';
import {createReadStream} from 'node:fs';
import {stat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {adventureUrl} from './adventure-entry.mjs';
const root=path.resolve('../charmville-references/zquest-web-runtime');
const contentRoot=path.resolve('../charmville-references/zquest-quest-snapshots');
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm','.css':'text/css','.png':'image/png','.ico':'image/x-icon','.ogg':'audio/ogg'};
const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:"};
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost:3021');
  // Existing shared links now skip the original title/story sequence too.
  // Append reference=1 to explicitly replay the unchanged source introduction.
  if(url.pathname==='/charmville/' || (url.pathname==='/play/' && url.searchParams.get('open')==='quests/purezc/139' && !url.searchParams.has('reference'))){
   res.writeHead(302,{...headers,Location:adventureUrl()});res.end();return;
  }
  if(url.pathname==='/reference-data/manifest.json'){
   const manifest={};
   for(const id of ['139','204','461']){const quest=JSON.parse(await readFile(path.join(contentRoot,`${id}-metadata.json`),'utf8'));manifest[quest.id]={...quest,images:[]};}
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
    html=html.replace('</body>',`<script>
     const start=document.createElement('button');start.textContent='Enter the world';start.className='panel-button';
     document.querySelector('.panel-buttons').prepend(start);
     start.addEventListener('click',async()=>{start.disabled=true;start.textContent='Loading world…';
      try{for(const src of ['../main.js','../zplayer.data.js','../zplayer.js']) await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.body.append(script);});start.remove();}
      catch{start.textContent='Loading failed — reload to retry';}
     },{once:true});
    </script></body>`);
   }
   res.writeHead(200,{...headers,'Content-Type':'text/html'});res.end(html);return;
  }
  res.writeHead(200,{...headers,'Content-Type':types[path.extname(file)]||'application/octet-stream'});
  const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
 }catch(error){res.writeHead(404,{...headers,'Content-Type':'text/plain'});res.end(`Reference resource unavailable: ${error.code||'content adapter error'}`);}
}).listen(3021,'127.0.0.1',()=>console.log('Local reference runtime: http://localhost:3021/play/?open=quests/purezc/139&storage=idb'));
