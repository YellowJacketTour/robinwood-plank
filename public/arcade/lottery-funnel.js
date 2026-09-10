// Shallow pressed flutes belong to the rotating bowl itself, not floating arms.
// Rendering and rigid-body contact use this exact same surface.
export function createLotteryFunnelGeometry(THREE) {
  const profile = [[.21,-.60],[.21,-.31],[.28,-.20],[.39,-.02],[.5,.16],[.64,.22],[.77,.275],[.88,.32],[.94,.32]];
  const geometry = new THREE.LatheGeometry(profile.map(p=>new THREE.Vector2(...p)),96);
  const position=geometry.attributes.position;
  for(let i=0;i<position.count;i++){
    const x=position.getX(i),z=position.getZ(i),r=Math.hypot(x,z);
    const envelope=Math.max(0,Math.sin(Math.PI*Math.max(0,Math.min(1,(r-.21)/.67))));
    const flute=Math.pow(.5+.5*Math.cos(6*Math.atan2(z,x)+3*r),4);
    position.setY(i,position.getY(i)+.035*envelope*flute);
  }
  geometry.computeVertexNormals();
  return geometry;
}
