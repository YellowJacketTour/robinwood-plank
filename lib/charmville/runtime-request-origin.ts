import {YardError} from './errors';

/** Passenger may construct an internal HTTP request URL. Browser authority is
 * the fixed public origin, never a caller-supplied forwarded/Host header. */
export function requireRuntimeRequestOrigin(request:Request, {allowMissing=false,env=process.env}:{allowMissing?:boolean;env?:Record<string,string|undefined>}={}) {
  let expected='https://plank.love';
  if(env.NODE_ENV==='development') {
    const url=new URL(request.url);
    if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol))throw new YardError('Open the game through PlankSpace',403);
    expected=url.origin;
  }
  const origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
  if((origin===null?!allowMissing:origin!==expected)||(site!==null&&site!=='same-origin'))throw new YardError('Open the game through your signed-in PlankSpace page',403);
}
