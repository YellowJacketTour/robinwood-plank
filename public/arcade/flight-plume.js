// Cel-shaded engine, smoke and pressure fronts. Presentation has no settlement authority.
export function createFlightPlume(THREE){
  const group=new THREE.Group();group.name='Cel engine plume';
  const plume=new THREE.Group();group.add(plume);
  const materials=[],geometries=[];
  const colors=[0x173e90,0x2ec3ed,0xf86d79,0xffb65a,0xfff2b1];
  // Long, scalloped silhouettes produce strong color bands instead of blurry points.
  const layers=colors.map((color,i)=>{
    const shape=new THREE.Shape();shape.moveTo(-.12,0);
    shape.bezierCurveTo(-.25,-.3,-.56,-.6,-.50,-1.05);
    shape.lineTo(-.31,-.90);shape.bezierCurveTo(-.53,-1.5,-.20,-1.8,-.26,-2.25);
    shape.lineTo(-.08,-1.96);shape.lineTo(0,-3.2);shape.lineTo(.13,-2.18);shape.lineTo(.28,-2.48);
    shape.bezierCurveTo(.17,-1.7,.52,-1.35,.32,-.94);shape.lineTo(.48,-1.10);shape.bezierCurveTo(.51,-.5,.19,-.24,.12,0);shape.closePath();
    const geo=new THREE.ShapeGeometry(shape,28);geometries.push(geo);
    const mat=new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide,transparent:true,depthTest:true,depthWrite:false,toneMapped:false});materials.push(mat);
    mat.onBeforeCompile=shader=>{shader.uniforms.plumeTime={value:0};shader.uniforms.plumeForce={value:0};shader.vertexShader='uniform float plumeTime;uniform float plumeForce;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      float tail=max(0.,-position.y);float flutter=(sin(tail*8.7-plumeTime*19.3)+.45*sin(tail*13.1-plumeTime*27.7))*tail*.022;
      transformed.x+=flutter*(.3+plumeForce);
      transformed.y+=sin(tail*10.1-plumeTime*22.7)*tail*.015*(.2+plumeForce);`);mat.userData.shader=shader;};
    const mesh=new THREE.Mesh(geo,mat);mesh.position.z=-.14+i*.015;mesh.renderOrder=2+i;plume.add(mesh);return mesh;
  });
  const diamondGeo=new THREE.OctahedronGeometry(.13);geometries.push(diamondGeo);
  const diamondMat=new THREE.MeshBasicMaterial({color:0xfffbdb,toneMapped:false});materials.push(diamondMat);
  const diamonds=Array.from({length:5},(_,i)=>{const m=new THREE.Mesh(diamondGeo,diamondMat);m.position.y=-.6-i*.6;m.position.z=.02;plume.add(m);return m;});
  const gradient=new THREE.DataTexture(new Uint8Array([45,120,205,255]),4,1,THREE.RedFormat);gradient.minFilter=gradient.magFilter=THREE.NearestFilter;gradient.needsUpdate=true;
  // Sculpt each cloud from overlapping lobes, so its outline reads as smoke,
  // not a single translucent polygonal sphere. All clouds still share one draw.
  const lobe=new THREE.IcosahedronGeometry(1,2),positions=[],normals=[];
  for(const [x,y,z,r] of [[0,0,0,.72],[-.46,.1,0,.48],[.43,.12,.03,.52],[-.16,.48,.02,.46],[.18,-.38,0,.46],[0,.05,.42,.48]]){
    const p=lobe.attributes.position,n=lobe.attributes.normal;
    for(let i=0;i<p.count;i++){positions.push(p.getX(i)*r+x,p.getY(i)*r+y,p.getZ(i)*r+z);normals.push(n.getX(i),n.getY(i),n.getZ(i));}
  }
  lobe.dispose();const smokeGeo=new THREE.BufferGeometry();smokeGeo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));smokeGeo.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometries.push(smokeGeo);
  const smokeMat=new THREE.MeshToonMaterial({color:0xffffff,gradientMap:gradient,transparent:true,depthWrite:true});materials.push(smokeMat);
  const smokeOpacity=new THREE.InstancedBufferAttribute(new Float32Array(54),1);smokeOpacity.setUsage(THREE.DynamicDrawUsage);smokeGeo.setAttribute('smokeOpacity',smokeOpacity);
  smokeMat.onBeforeCompile=shader=>{
    shader.vertexShader='attribute float smokeOpacity; varying float vSmokeOpacity;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n vSmokeOpacity=smokeOpacity;');
    shader.fragmentShader='varying float vSmokeOpacity;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\n diffuseColor.a*=vSmokeOpacity;');
  };
  const smokeBatch=new THREE.InstancedMesh(smokeGeo,smokeMat,54);smokeBatch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);smokeBatch.frustumCulled=false;smokeBatch.count=0;group.add(smokeBatch);
  const smokeColors=[0x8c9aaf,0xc2cbd8,0xe4e5db].map(c=>new THREE.Color(c));
  const clouds=Array.from({length:54},(_,i)=>({position:new THREE.Vector3(),rotation:i*2.39996,scale:0,opacity:0,color:smokeColors[i%3],age:10,v:new THREE.Vector3()}));
  const smokePose=new THREE.Object3D();
  const ringGeo=new THREE.TorusGeometry(1,.035,6,64);geometries.push(ringGeo);
  const rings=Array.from({length:3},(_,i)=>{const mat=new THREE.MeshBasicMaterial({color:[0xc0f5ff,0xffce87,0xbd9fff][i],transparent:true,opacity:0,depthWrite:false,toneMapped:false});materials.push(mat);const m=new THREE.Mesh(ringGeo,mat);group.add(m);return m;});
  const streakGeo=new THREE.BufferGeometry(),streakPositions=new Float32Array(48*6);streakGeo.setAttribute('position',new THREE.BufferAttribute(streakPositions,3));geometries.push(streakGeo);
  const streakColors=new Float32Array(48*6);for(let i=0;i<48;i++){const color=new THREE.Color([0x76e2ff,0xffd175,0xc4a3ff][i%3]);for(let j=0;j<2;j++)color.toArray(streakColors,i*6+j*3);}streakGeo.setAttribute('color',new THREE.BufferAttribute(streakColors,3));
  const streakMat=new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.5,depthWrite:false,toneMapped:false});materials.push(streakMat);
  const streaks=new THREE.LineSegments(streakGeo,streakMat);streaks.frustumCulled=false;group.add(streaks);
  let clock=0,spawn=0,cursor=0,lastBand=-1,pressureAge=10;
  return {group,reset(){clouds.forEach(c=>c.age=2);spawn=0;cursor=0;lastBand=-1;pressureAge=10;smokeBatch.count=0;group.visible=false;},update({dt,time,origin,camera,active,intensity=0,progress=0,groundY=-4,reduced=false}){
    group.visible=active||clouds.some(c=>c.age<2.0);if(!group.visible)return;
    clock+=dt;
    plume.visible=active;plume.position.copy(origin);
    // Face the viewer horizontally while retaining a world-vertical exhaust axis.
    plume.rotation.y=Math.atan2(camera.position.x-origin.x,camera.position.z-origin.z);
    const length=.25+Math.pow(intensity,.65)*3.1,width=.26+Math.pow(intensity,.7)*2.0;
    layers.forEach((m,i)=>{const shader=m.material.userData.shader;if(shader){shader.uniforms.plumeTime.value=reduced?0:time;shader.uniforms.plumeForce.value=intensity;}const inset=1-i*.14;m.scale.set(width*inset,length*(1-i*.12)*(reduced?1:1+.035*Math.sin(time*17-i)),1);});
    diamonds.forEach((m,i)=>{m.visible=intensity>.42;m.position.y=-(.55+i*.6)*length;m.scale.set(.6+intensity,.9+intensity*2,.6+intensity);});
    if(active&&!reduced){spawn+=dt*(18+intensity*18);while(spawn>=1){spawn--;const c=clouds[cursor++%clouds.length];c.age=0;const angle=cursor*2.39996;c.position.copy(origin).add(new THREE.Vector3(Math.cos(angle)*.18,-1.8*length,Math.sin(angle)*.18-.25));c.ground=progress<.10;
      if(c.ground){c.position.set(origin.x+Math.cos(angle)*.65,groundY+.1,Math.sin(angle)*.65);c.v.set(Math.cos(angle)*(2.8+intensity*3),.4+Math.sin(angle*3)*.2,Math.sin(angle)*(2.8+intensity*3));}
      else c.v.set(Math.cos(angle)*(.5+intensity),-2.4-intensity*4,Math.sin(angle)*.25);}}
    for(const c of clouds){c.age+=dt;if(c.age>=2||reduced)continue;c.position.addScaledVector(c.v,dt);c.scale=(.12+c.age*(c.ground?1.6:.75))*(1+intensity*.6);c.rotation+=dt*.3;c.opacity=Math.min(.95,c.age*8)*Math.min(1,(2-c.age)*2);}
    // One draw call; sort instances back-to-front to preserve transparent smoke depth.
    const visibleClouds=reduced?[]:clouds.filter(c=>c.age<2).sort((a,b)=>b.position.distanceToSquared(camera.position)-a.position.distanceToSquared(camera.position));
    smokeBatch.count=visibleClouds.length;
    visibleClouds.forEach((c,i)=>{smokePose.position.copy(c.position);smokePose.rotation.set(0,0,c.rotation);smokePose.scale.set(c.scale,c.scale*.85,c.scale);smokePose.updateMatrix();smokeBatch.setMatrixAt(i,smokePose.matrix);smokeBatch.setColorAt(i,c.color);smokeOpacity.setX(i,c.opacity);});
    smokeBatch.instanceMatrix.needsUpdate=true;if(smokeBatch.instanceColor)smokeBatch.instanceColor.needsUpdate=true;smokeOpacity.needsUpdate=true;
    group.userData.smokeParticles=visibleClouds.length;group.userData.smokeDrawCalls=visibleClouds.length?1:0;
    streaks.visible=active&&!reduced&&intensity>.22;
    if(streaks.visible){for(let i=0;i<48;i++){const side=i%2?1:-1,x=side*(2.1+(i%9)*.40),y=origin.y+7-((time*(2+intensity*12)+i*1.73)%17),z=-2-(i%5);streakPositions.set([origin.x+x,y,z,origin.x+x,y-.12-intensity*1.7,z],i*6);}streakGeo.attributes.position.needsUpdate=true;streakMat.opacity=(intensity-.22)*.8;}
    const band=Math.floor(intensity*4);if(active&&band>lastBand){lastBand=band;if(band>0)pressureAge=0;}if(!active)lastBand=-1;pressureAge+=dt;
    rings.forEach((m,i)=>{const age=pressureAge-i*.11;m.visible=active&&!reduced&&age>=0&&age<1.25;if(!m.visible)return;m.position.copy(origin).y+=2.1;m.quaternion.copy(camera.quaternion);m.scale.setScalar(.65+age*8);m.material.opacity=.55*(1-age/1.25);});
  },dispose(){smokeBatch.dispose();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());gradient.dispose();group.removeFromParent();}};
}
