import {createLotteryWorld} from './lottery-physics-world.js';
let physics;
self.onmessage=async({data})=>{
  try{
    if(data.init){physics=await createLotteryWorld(data.init);const poses=physics.packet();self.postMessage({ready:true,poses},[poses.buffer]);}
    else if(physics){physics.step(data.dt);const poses=physics.packet();self.postMessage({poses},[poses.buffer]);}
  }catch(error){self.postMessage({error:String(error?.message||error)});}
};
