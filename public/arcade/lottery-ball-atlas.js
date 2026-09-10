// Chamber balls share one texture and one draw. The selected prize keeps its
// separate high-resolution material for the final reveal.
export function createChamberBalls(THREE,parent,labels,colorFor,radius){
  const columns=Math.max(1,Math.min(labels.length>128?16:8,labels.length)),rows=Math.max(1,Math.ceil(labels.length/columns));
  const surface=document.createElement('canvas');surface.width=columns*256;surface.height=rows*128;
  const context=surface.getContext('2d'),offsets=new Float32Array(labels.length*2);
  const balls=labels.map((label,index)=>{
    const column=index%columns,row=Math.floor(index/columns),x=column*256,y=row*128;
    context.fillStyle=`#${colorFor(label).toString(16).padStart(6,'0')}`;context.fillRect(x,y,256,128);
    context.fillStyle='#f4efdf';context.beginPath();context.ellipse(x+64,y+64,26.5,24,0,0,Math.PI*2);context.fill();
    context.strokeStyle='#263c3530';context.lineWidth=1;context.stroke();
    context.font='600 23px Arial';context.textAlign='center';context.textBaseline='middle';context.fillStyle='#23372f';context.fillText(label.toString(),x+64,y+64.5,46);
    // CanvasTexture's Y flip means the first painted row is the highest UV row.
    offsets[index*2]=(x+4)/surface.width;offsets[index*2+1]=1-(y+124)/surface.height;
    const group=new THREE.Group();parent.add(group);return{group};
  });
  const texture=new THREE.CanvasTexture(surface);texture.colorSpace=THREE.SRGBColorSpace;
  const geometry=new THREE.SphereGeometry(radius,labels.length>128?16:32,labels.length>128?12:24);geometry.setAttribute('ballTile',new THREE.InstancedBufferAttribute(offsets,2));
  const material=new THREE.MeshPhysicalMaterial({map:texture,roughness:.30,clearcoat:.32,clearcoatRoughness:.24});
  material.onBeforeCompile=shader=>{
    shader.vertexShader='attribute vec2 ballTile;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <uv_vertex>',`#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv=vMapUv*vec2(${248/surface.width},${120/surface.height})+ballTile;\n#endif`);
  };
  const mesh=new THREE.InstancedMesh(geometry,material,labels.length);mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=false;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);parent.add(mesh);
  return{balls,mesh,texture,sync(){balls.forEach((ball,index)=>{ball.group.updateMatrix();mesh.setMatrixAt(index,ball.group.matrix);});mesh.instanceMatrix.needsUpdate=true;},dispose(){mesh.dispose();}};
}
