/** Authored launch infrastructure. Coordinates are local; the deck is y=.25.
 * Release retracts hardware BEFORE flight. This module never controls game time.
 */
export function createLaunchEnvironment(THREE) {
  const group = new THREE.Group(); group.name = 'Launch infrastructure';
  const geometries = new Set(), materials = new Set(), textures = new Set();
  const mat = (color, roughness, metalness, extra = {}) => {
    const m = new THREE.MeshStandardMaterial({color, roughness, metalness, ...extra});
    materials.add(m); return m;
  };
  const steel = mat('#c1ccd5', .58, .68), edge = mat('#e3e9e6', .38, .78);
  const dark = mat('#222c32', .72, .68), ceramic = mat('#b7ab8f', .91, .06);
  const gold = mat('#ffc857', .45, .62), rubber = mat('#10191e', .92, .05);
  const lamp = mat('#ffdca0', .25, .15, {emissive:'#ffc857', emissiveIntensity:2});
  const warning = mat('#ff8a5c', .45, .35, {emissive:'#ff8a5c', emissiveIntensity:.3});
  // Deterministic mill-scale: faint directional machining, pitting and uneven
  // oxidation. Separate normal and roughness channels respond to scene lighting.
  const size=256, height=new Float32Array(size*size);
  const hash=(x,y)=>{const n=Math.sin(x*127.1+y*311.7)*43758.5453;return n-Math.floor(n);};
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    height[y*size+x]=.45+.13*hash(x,y)+.075*Math.sin(x*.47)+.04*Math.sin(y*.08+x*.12);
  }
  const surface=new Uint8Array(size*size*4),rough=new Uint8Array(size*size*4),normals=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const p=y*size+x,k=p*4,h=height[p];
    const pit=hash(x+17,y+19)>.989 ? .12 : 0;
    const value=Math.round(203+h*46-pit*100);
    surface.set([value,value,Math.min(255,value+2),255],k);
    const r=Math.round(162+h*67+pit*70);rough.set([r,r,r,255],k);
    const dx=height[y*size+(x+1)%size]-height[y*size+(x+size-1)%size];
    const dy=height[((y+1)%size)*size+x]-height[((y+size-1)%size)*size+x];
    normals.set([Math.round(128-dx*70),Math.round(128-dy*70),254,255],k);
  }
  function texture(bytes,color=false){const t=new THREE.DataTexture(bytes,size,size,THREE.RGBAFormat);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(3,3);t.magFilter=THREE.LinearFilter;t.minFilter=THREE.LinearMipmapLinearFilter;t.generateMipmaps=true;if(color)t.colorSpace=THREE.SRGBColorSpace;t.needsUpdate=true;textures.add(t);return t;}
  const steelMap=texture(surface,true),roughMap=texture(rough),normalMap=texture(normals);
  for(const m of [steel,edge,dark]){m.map=steelMap;m.roughnessMap=roughMap;m.normalMap=normalMap;m.normalScale=new THREE.Vector2(.42,.42);}
  new THREE.TextureLoader().load('./art/launch/titanium.png', map=>{
    map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(2,2);textures.add(map);
    for(const material of [steel,edge,dark]){material.map=map;material.needsUpdate=true;}
  });
  function mesh(geometry, material, parent = group) {
    geometries.add(geometry); const m = new THREE.Mesh(geometry, material);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  }
  function box(w,h,d,x,y,z,m=steel,parent=group) {
    // Narrow chamfers catch the area/environment light without rounded toy edges.
    const bevel=Math.min(.018,w*.1,h*.1,d*.1);
    const shape=new THREE.Shape();
    shape.moveTo(-w/2+bevel,-h/2+bevel);shape.lineTo(w/2-bevel,-h/2+bevel);
    shape.lineTo(w/2-bevel,h/2-bevel);shape.lineTo(-w/2+bevel,h/2-bevel);shape.closePath();
    const geo=new THREE.ExtrudeGeometry(shape,{depth:d-2*bevel,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:bevel,bevelThickness:bevel,curveSegments:1});
    geo.translate(0,0,-d/2+bevel);
    const o=mesh(geo,m,parent);o.position.set(x,y,z);return o;
  }
  function beam(a,b,width=.09,depth=width,m=steel,parent=group) {
    const av=new THREE.Vector3(...a), bv=new THREE.Vector3(...b), delta=bv.clone().sub(av);
    const o=box(width,delta.length(),depth,0,0,0,m,parent);
    o.position.copy(av.add(bv).multiplyScalar(.5));
    o.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return o;
  }
  function tube(points,r=.04,m=edge,parent=group) {
    return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),32,r,8,false),m,parent);
  }
  function cylinder(r,h,x,y,z,m=edge,parent=group) {
    const o=mesh(new THREE.CylinderGeometry(r,r,h,16),m,parent);o.position.set(x,y,z);return o;
  }
  // Flanged columns have a real web, front/back flanges and connection plates.
  function column(x,z,height) {
    box(.12,height,.35,x,height/2+.2,z);
    for(const zz of [-.21,.21]) box(.38,height,.065,x,height/2+.2,z+zz,edge);
    box(.68,.16,.75,x,.2,z,dark);
    for(let y=.6;y<height;y+=1.25){
      box(.43,.24,.49,x,y,z,steel);
      for(const xx of [-.12,.12])for(const yy of [-.075,.075]) {
        const rivet=cylinder(.026,.026,x+xx,y+yy,z+.264,edge);rivet.rotation.x=Math.PI/2;
      }
    }
  }
  const bolts=[];
  function bolt(x,y,z){bolts.push(new THREE.Vector3(x,y,z));}
  // A split deck leaves a genuine open flame trench; no solid floor below exhaust.
  for(const x of [-3.65,3.65]) {
    box(5.4,.38,7.8,x,.02,.4,dark);
    for(let row=0;row<6;row++)for(let col=0;col<4;col++) {
      const xx=x+(col-1.5)*1.28,zz=-2.8+row*1.27;
      box(1.23,.035,1.22,xx,.226,zz, (row+col)%3 ? steel : dark);
      for(const a of [-.51,.51])for(const b of [-.49,.49])bolt(xx+a,.253,zz+b);
    }
  }
  box(1.92,.36,2.0,0,0,-2.55,dark);
  // Refractory walls slope into a sunken ceramic channel visible from the front.
  for(const x of [-1.1,1.1]) {
    const wall=box(.18,1.12,6.6,x,-.36,.7,ceramic);wall.rotation.z=Math.sign(x)*-.16;
    for(let z=-2.3;z<3.8;z+=.55)box(.22,.065,.04,x,.21,z,dark);
    box(.24,.12,6.8,x,.21,.7,edge);
  }
  box(1.86,.1,6.6,0,-.9,.7,ceramic);
  for(let z=-2;z<4;z+=.6)box(1.8,.03,.025,0,-.84,z,dark);
  // Raised segmented launch collar: the central bore stays physically empty.
  for(let i=0;i<12;i++) {
    const a=i*Math.PI/6, x=Math.sin(a)*1.17,z=Math.cos(a)*1.17;
    const seg=box(.58,.26,.42,x,.36,z,steel);seg.rotation.y=a;
    bolt(x,.503,z);
  }
  // Four hold-down arms rotate outwards on anchored hinges, clear of the avatar.
  const clamps=[];
  for(const a of [-Math.PI/2,Math.PI/2,Math.PI]) {
    const mount=new THREE.Group();mount.position.set(Math.sin(a)*1.36,.4,Math.cos(a)*1.36);mount.rotation.y=a;group.add(mount);
    box(.55,.23,.7,0,-.04,.1,dark,mount);
    const arm=new THREE.Group();mount.add(arm);clamps.push(arm);
    const housing=box(.33,.82,.25,0,.39,-.05,steel,arm);housing.rotation.x=-.27;
    box(.43,.22,.33,0,.82,-.15,edge,arm);
    box(.38,.08,.18,0,.89,-.32,rubber,arm);
    beam([.2,.02,.25],[.2,.62,-.08],.10,.10,dark,arm);
    beam([.2,.35,.09],[.2,.66,-.1],.046,.046,edge,arm);
    const axle=cylinder(.14,.54,0,0,0,edge,mount);axle.rotation.z=Math.PI/2;
  }
  // Gantry: four I-section uprights, X bracing and service platforms.
  for(const x of [-4.85,-3.15])for(const z of [-2.25,-.95])column(x,z,9.2);
  for(let y=1.1;y<9;y+=1.55) {
    for(const z of [-2.25,-.95]) {
      beam([-4.85,y,z],[-3.15,y,z],.13,.18,edge);
      beam([-4.8,y,z],[-3.2,y+1.5,z],.10,.09);
      beam([-3.2,y,z],[-4.8,y+1.5,z],.10,.09);
      for(const x of [-4.8,-3.2]) {bolt(x,y,z+.27);bolt(x,y+.1,z+.27);}
    }
    for(const x of [-4.85,-3.15])beam([x,y,-2.25],[x,y,-.95],.13,.15,edge);
  }
  for(const y of [1.25,3.95,6.65,9]) {
    box(2.25,.15,2.25,-3.98,y,-1.5,dark);
    for(let x=-5.02;x<-2.85;x+=.12)box(.035,.035,2.17,x,y+.09,-1.5,edge);
    for(const z of [-2.57,-.42]) {
      for(let x=-5.03;x<=-2.9;x+=.53)beam([x,y,z],[x,y+.69,z],.035,.035,gold);
      beam([-5.03,y+.69,z],[-2.9,y+.69,z],.043,.043,gold);
      beam([-5.03,y+.35,z],[-2.9,y+.35,z],.025,.025,edge);
    }
    box(.19,.25,.13,-3.07,y+.42,-.37,dark);
    box(.12,.18,.025,-3.07,y+.42,-.29,lamp);
  }
  // Fixed pipe rack, flanges, valve wheels and ladder remain connected to structure.
  for(let i=0;i<3;i++) {
    const x=-4.52+i*.27;
    tube([[x,.2,-.64],[x,.7,-.64],[x,8.9,-.64]],.055+i*.007,i===0?gold:edge);
    for(let y=1;y<9;y+=1.4)cylinder(.095,.1,x,y,-.64,dark);
  }
  for(const x of [-4.88,-4.4])beam([x,.3,-.33],[x,8.9,-.33],.035,.035,edge);
  for(let y=.5;y<8.9;y+=.24)beam([-4.88,y,-.33],[-4.4,y,-.33],.025,.025,edge);
  // Articulated umbilical swings backwards instead of passing through the hull.
  const umbilical=new THREE.Group();umbilical.position.set(-3.12,3.45,-.9);group.add(umbilical);
  box(1.94,.21,.22,.97,0,0,edge,umbilical);
  box(1.7,.035,.28,.97,.13,0,dark,umbilical);
  const joint=cylinder(.22,.30,0,0,0,dark,umbilical);joint.rotation.x=Math.PI/2;
  const coupler=cylinder(.16,.32,2.05,0,0,steel,umbilical);coupler.rotation.z=Math.PI/2;
  for(const z of [-.18,.18]) {
    const flange=cylinder(.26,.055,0,0,z,edge,umbilical);flange.rotation.x=Math.PI/2;
    for(let i=0;i<8;i++){const a=i*Math.PI/4;const nut=cylinder(.024,.038,Math.cos(a)*.2,Math.sin(a)*.2,z+Math.sign(z)*.04,dark,umbilical);nut.rotation.x=Math.PI/2;}
  }
  for(const x of [1.89,2.03,2.19]) {
    const collar=cylinder(.205,.065,x,0,0,edge,umbilical);collar.rotation.z=Math.PI/2;
  }
  for(let i=0;i<6;i++){const a=i*Math.PI/3;box(.13,.055,.055,2.07,Math.sin(a)*.18,Math.cos(a)*.18,gold,umbilical);}
  // Corrugated insulation follows the sagging cable curve, including its tangent;
  // end ferrules seat against the joint and service coupler, never float nearby.
  const hosePath=new THREE.CatmullRomCurve3([[0,-.13,0],[.5,-.65,0],[1.3,-.68,0],[2,-.12,0]].map(p=>new THREE.Vector3(...p)));
  mesh(new THREE.TubeGeometry(hosePath,64,.075,12,false),rubber,umbilical);
  const ribGeo=new THREE.TorusGeometry(.078,.012,4,12);geometries.add(ribGeo);
  for(let i=0;i<=65;i++) {
    const t=i/65,rib=mesh(ribGeo,i%9===0?edge:dark,umbilical);
    rib.position.copy(hosePath.getPoint(t));rib.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),hosePath.getTangent(t).normalize());
  }
  // Low foreground utility runs are routed around the central exhaust channel.
  for(const x of [-2,2]) {
    tube([[x,.35,3.7],[x,.35,2.5],[x*1.4,.35,1.8],[x*1.4,.35,-2.8]],.085,dark);
    for(const z of [-2,0,2.8]){box(.32,.14,.25,x,.29,z,edge);}
  }
  for(const x of [-2.5,2.5])for(const z of [-1.6,1.6,3.7]) {
    box(.32,.16,.27,x,.31,z,dark);box(.22,.08,.18,x,.43,z,lamp);
  }
  const beacon=box(.12,.17,.12,-3.15,9.38,-.95,warning);
  // All deck fasteners share one instanced draw, keeping phone cost bounded.
  const boltGeo=new THREE.CylinderGeometry(.033,.033,.022,6);geometries.add(boltGeo);
  const fasteners=new THREE.InstancedMesh(boltGeo,edge,bolts.length);
  const matrix=new THREE.Matrix4();bolts.forEach((p,i)=>{matrix.makeTranslation(p.x,p.y,p.z);fasteners.setMatrixAt(i,matrix);});group.add(fasteners);
  const ignitionLight=new THREE.PointLight('#ffdca0',0,8,2);ignitionLight.position.set(0,.3,0);group.add(ignitionLight);
  // Bake immobile infrastructure by material. Hundreds of individually authored
  // parts become a few draw calls; articulated hardware stays separate.
  for(const assembly of [group,umbilical]) {
  const batches=new Map();
  for(const child of [...assembly.children]) {
    if(!child.isMesh || child.isInstancedMesh)continue;
    child.updateMatrix();
    const geometry=child.geometry.index?child.geometry.toNonIndexed():child.geometry.clone();
    geometry.applyMatrix4(child.matrix);
    if(!batches.has(child.material))batches.set(child.material,[]);
    batches.get(child.material).push(geometry);assembly.remove(child);
  }
  for(const [material,parts] of batches) {
    const merged=new THREE.BufferGeometry();
    for(const attrName of ['position','normal','uv']) {
      const total=parts.reduce((n,g)=>n+g.getAttribute(attrName).array.length,0);
      const buffer=new Float32Array(total);let offset=0;
      for(const part of parts){buffer.set(part.getAttribute(attrName).array,offset);offset+=part.getAttribute(attrName).array.length;}
      merged.setAttribute(attrName,new THREE.BufferAttribute(buffer,attrName==='uv'?2:3));
    }
    merged.computeBoundingSphere();mesh(merged,material,assembly);parts.forEach(p=>p.dispose());
  }
  }
  // Bounded cryogenic vent plumes, independent of outcome and round count.
  const vaporGeometry=new THREE.SphereGeometry(1,16,12);geometries.add(vaporGeometry);
  const vaporMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,
    vertexShader:`varying vec3 n;varying vec3 eye;void main(){vec4 p=modelViewMatrix*instanceMatrix*vec4(position,1.);n=normalize(normalMatrix*mat3(instanceMatrix)*normal);eye=-p.xyz;gl_Position=projectionMatrix*p;}`,
    fragmentShader:`varying vec3 n;varying vec3 eye;void main(){float soft=pow(max(0.,dot(normalize(n),normalize(eye))),2.);gl_FragColor=vec4(vec3(.68,.77,.80),soft*.10);}`
  });materials.add(vaporMaterial);
  const vapor=new THREE.InstancedMesh(vaporGeometry,vaporMaterial,16);vapor.frustumCulled=false;group.add(vapor);
  const puff=new THREE.Object3D();
  return {group,update({release=0,ignition=0,fueling=0,time=0}={}) {
    vapor.visible=fueling>0&&ignition===0;
    if(vapor.visible){
      for(let slot=0;slot<16;slot++){
        const i=slot+16;
        const age=(time*.24+i*.61803398875)%1,side=i%2?1:-1;
        
        puff.position.set(side*1.1+side*age*1.9, .6-age*.2+Math.sin(i*2.4+age*3)*.1, .3+Math.sin(i*2.7)*.25+age*.8);
        const size=Math.sin(age*Math.PI)*(.12+age*.45);
        puff.scale.set(size*1.4,size*.8,size);puff.updateMatrix();vapor.setMatrixAt(slot,puff.matrix);
      }
      vapor.instanceMatrix.needsUpdate=true;
    }
    const r=THREE.MathUtils.clamp(release,0,1),e=r*r*(3-2*r);
    for(const clamp of clamps)clamp.rotation.x=e*1.12;
    umbilical.rotation.y=e*1.45;
    ignitionLight.intensity=Math.max(0,ignition)*(3.8+.22*Math.sin(time*41));
    beacon.material.emissiveIntensity=.35+.7*Math.pow(Math.max(0,Math.sin(time*3)),8);
  },dispose(){geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());group.removeFromParent();}};
}
