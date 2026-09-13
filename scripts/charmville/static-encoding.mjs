import {readFile} from 'node:fs/promises';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
const zip=promisify(gzip);
const cache=new Map();let cacheBytes=0;
const MAX_CACHE=32*1024*1024;
export function acceptsGzip(value=''){
 const entries=new Map(value.toLowerCase().split(',').map(part=>{const [name,...parameters]=part.trim().split(';');const q=parameters.find(v=>v.trim().startsWith('q='));const weight=q?Number(q.trim().slice(2)):1;return [name,Number.isFinite(weight)&&weight>=0&&weight<=1?weight:0];}));
 return (entries.get('gzip')??entries.get('*')??0)>0;
}
export async function encodedStatic(file,info,requestHeaders={}){
 const eligible=/\.(wasm|data|pat|qst|qst\.gz)$/i.test(file)&&info.size>=1024&&info.size<=32*1024*1024;
 if(!eligible||requestHeaders.range||!acceptsGzip(requestHeaders['accept-encoding']))return null;
 const key=`${file}:${info.mtimeMs}:${info.size}`;
 if(cache.has(key)){const result=cache.get(key);cache.delete(key);cache.set(key,result);return result;}
 const body=await zip(await readFile(file),{level:4});
 if(body.length>=info.size)return null;
 // Bound retained compressed buffers; source files are never rewritten.
 for(const [old,value]of cache)if(old.startsWith(file+':')){cache.delete(old);cacheBytes-=value.length;}
 while(cache.size>=128||cacheBytes+body.length>MAX_CACHE){const oldest=cache.keys().next().value;if(oldest===undefined)break;cacheBytes-=cache.get(oldest).length;cache.delete(oldest);}
 cache.set(key,body);cacheBytes+=body.length;return body;
}
