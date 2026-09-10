// Presentation ownership only. Betting deadlines and payouts remain chain-owned.
export function createRoundStory() {
  let round=null,phase='idle';
  return {
    get round(){return round;},get phase(){return phase;},get active(){return round!==null;},
    reserve(id){if(round!==null)return false;round=String(id);phase='loading';return true;},
    acceptSettlement(id){
      id=String(id);
      if(round===null||round===id)return true;
      if(phase==='loading'&&BigInt(round)>BigInt(id)){round=id;return true;}
      return false;
    },
    flight(id){id=String(id);if((round!==null&&round!==id)||!['idle','loading'].includes(phase))return false;round=id;phase='flight';return true;},
    crash(id){if(round!==String(id)||phase!=='flight')return false;phase='crash';return true;},
    lottery(id){if(round!==String(id)||phase!=='crash')return false;phase='lottery';return true;},
    close(id){if(round!==String(id)||!['crash','lottery'].includes(phase))return false;round=null;phase='idle';return true;},
    reset(){round=null;phase='idle';}
  };
}
