// One in-flight request keeps slow physics from queuing work on the render thread.
export async function createLotteryPhysics({meshes,drivenSurface,balls,radius,signal,onError=()=>{}}){
  const colliders=meshes.map(mesh=>{
    mesh.updateMatrixWorld(true);const g=mesh.geometry.clone();g.applyMatrix4(mesh.matrixWorld);
    const vertices=new Float32Array(g.attributes.position.array),indices=g.index?new Uint32Array(g.index.array):Uint32Array.from({length:vertices.length/3},(_,i)=>i);
    g.dispose();return {vertices,indices,driven:mesh===drivenSurface};
  });
  const worker=new Worker(new URL('./lottery-physics-worker.js',import.meta.url),{type:'module'});
  let stopped=false,busy=false,pending=0,latest=null,ready=false;
  let resolveReady,rejectReady;
  const initialized=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const fail=error=>{if(stopped)return;stopped=true;clearTimeout(timeout);worker.terminate();if(!ready)rejectReady(error);else onError(error);};
  const timeout=setTimeout(()=>fail(Error('Lottery physics initialization timed out')),8000);
  const abort=()=>{if(stopped)return;stopped=true;clearTimeout(timeout);worker.terminate();if(!ready)rejectReady(Error('Lottery physics cancelled'));};
  signal?.addEventListener('abort',abort,{once:true});
  worker.onerror=()=>fail(Error('Lottery physics worker failed'));
  worker.onmessage=({data})=>{
    if(stopped)return;if(data.error){fail(Error(data.error));return;}
    if(data.ready){ready=true;latest=data.poses;clearTimeout(timeout);resolveReady();return;}
    latest=data.poses;busy=false;
  };
  if(signal?.aborted)abort();
  else worker.postMessage({init:{colliders,positions:balls.map(b=>b.group.position.toArray()),radius}},colliders.flatMap(c=>[c.vertices.buffer,c.indices.buffer]));
  await initialized;
  return {
    worker:true,
    step(dt){
      if(stopped)return;
      if(latest){balls.forEach((b,i)=>{b.group.position.fromArray(latest,i*10);b.group.quaternion.fromArray(latest,i*10+3);});drivenSurface?.quaternion.fromArray(latest,balls.length*10);}
      pending=Math.min(.1,pending+Math.max(0,dt));
      if(!busy&&pending>0){busy=true;worker.postMessage({dt:pending});pending=0;}
    },
    snapshot(){return latest?balls.map((_,i)=>({position:{x:latest[i*10],y:latest[i*10+1],z:latest[i*10+2]},velocity:{x:latest[i*10+7],y:latest[i*10+8],z:latest[i*10+9]}})):[];},
    dispose(){stopped=true;clearTimeout(timeout);signal?.removeEventListener('abort',abort);worker.terminate();latest=null;}
  };
}
