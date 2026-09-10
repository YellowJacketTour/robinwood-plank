// Batch only explicitly static direct children. Articulated and physics meshes
// remain independent; positions and normals are baked into the copied geometry.
export function batchStaticMeshes(THREE,parent,protectedMeshes=new Set()) {
  const buckets=new Map();
  for(const mesh of [...parent.children]){
    if(!mesh.isMesh||protectedMeshes.has(mesh)||Array.isArray(mesh.material))continue;
    const key=`${mesh.material.uuid}:${mesh.castShadow}:${mesh.receiveShadow}`;
    if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(mesh);
  }
  let removed=0;
  for(const meshes of buckets.values()){
    if(meshes.length<2)continue;
    const parts=meshes.map(mesh=>{mesh.updateMatrix();const geometry=mesh.geometry.index?mesh.geometry.toNonIndexed():mesh.geometry.clone();geometry.applyMatrix4(mesh.matrix);return geometry;});
    const geometry=new THREE.BufferGeometry();
    for(const name of ['position','normal','uv']){
      const attributes=parts.map(part=>part.getAttribute(name));
      if(attributes.some(a=>!a))continue;
      const array=new Float32Array(attributes.reduce((n,a)=>n+a.array.length,0));let offset=0;
      for(const attribute of attributes){array.set(attribute.array,offset);offset+=attribute.array.length;}
      geometry.setAttribute(name,new THREE.BufferAttribute(array,attributes[0].itemSize));
    }
    geometry.computeBoundingSphere();
    const batch=new THREE.Mesh(geometry,meshes[0].material);batch.castShadow=meshes[0].castShadow;batch.receiveShadow=meshes[0].receiveShadow;parent.add(batch);
    for(const mesh of meshes){parent.remove(mesh);mesh.geometry.dispose();}parts.forEach(part=>part.dispose());removed+=meshes.length-1;
  }
  return removed;
}
