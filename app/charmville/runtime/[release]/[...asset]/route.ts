import {Readable} from 'node:stream';
import {postgresPool} from '@/lib/postgres';
import {requireRuntimeSession} from '@/lib/charmville/runtime-session';
import {readRuntimeRelease} from '@/lib/charmville/runtime-release';
import {openRuntimeArtifact,RuntimeArtifactError} from '@/lib/charmville/runtime-artifact';
import {YardError} from '@/lib/charmville/errors';

export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{release:string;asset:string[]}>};
const privateHeaders={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
async function serve(request:Request,context:Context) {
  try {
    // This switch is server runtime configuration, never a public build flag.
    if(process.env.CHARMVILLE_RUNTIME_READY!=='1')throw new RuntimeArtifactError(404);
    await requireRuntimeSession(postgresPool(),request);
    const {release,asset}=await context.params;
    if(release!==process.env.CHARMVILLE_RUNTIME_RELEASE)throw new RuntimeArtifactError(404);
    const localCandidate=process.env.NODE_ENV==='development'&&process.env.CHARMVILLE_RUNTIME_CANDIDATE_TEST==='1'&&new URL(request.url).origin==='http://localhost:3018';
    const config=await readRuntimeRelease(process.env.CHARMVILLE_RUNTIME_ROOT??'',release,{localCandidate});
    const route=asset.length===1&&asset[0]==='play'?'/play/':'/'+asset.join('/');
    const opened=await openRuntimeArtifact({...config,requestedRelease:release,route,method:request.method,signal:request.signal});
    const body=opened.body?Readable.toWeb(opened.body) as ReadableStream<Uint8Array>:null;
    return new Response(body,{status:opened.status,headers:{...privateHeaders,...opened.headers,
      'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}});
  } catch(error) {
    const status=error instanceof YardError||error instanceof RuntimeArtifactError?error.status:503;
    return new Response(request.method==='HEAD'?null:'Game runtime unavailable. Open it through your signed-in Charmdex.',{status,headers:privateHeaders});
  }
}
export const GET=serve;
export const HEAD=serve;
