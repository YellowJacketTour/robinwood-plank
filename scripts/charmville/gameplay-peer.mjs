/** One receive-only viewer connection. Admission/signaling must be authorized by
 * the server before construction. This module never acquires camera/mic input.
 * Publisher owns its capture stream; closing one viewer must not stop others.
 */
export function createGameplayPeer({role,stream=null,send,onTrack=()=>{},onClose=()=>{},configuration={},Peer=globalThis.RTCPeerConnection}){
 if(!['publisher','viewer'].includes(role)||typeof send!=='function'||typeof Peer!=='function')throw Error('Invalid gameplay peer');
 const tracks=stream?.getTracks()??[];
 if(role==='publisher'&&(tracks.filter(t=>t.kind==='video').length!==1||tracks.length>2||tracks.some(t=>!['video','audio'].includes(t.kind)||t.readyState!=='live')))throw Error('A live game source is required');
 if(role==='viewer'&&stream)throw Error('Viewers cannot send media');
 const pc=new Peer(configuration);let closed=false,started=false,chain=Promise.resolve();const pending=[];
 const close=(reason='closed')=>{if(closed)return;closed=true;pending.length=0;pc.onicecandidate=null;pc.ontrack=null;pc.onconnectionstatechange=null;pc.close();onClose(reason);};
 const emit=message=>{if(!closed)send(message);};
 pc.onicecandidate=event=>{if(event.candidate)emit({candidate:event.candidate.toJSON()});};
 pc.ontrack=event=>{if(!closed&&role==='viewer')onTrack(event.track,event.streams);};
 pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed')close('connection-failed');};
 try{if(role==='publisher')for(const track of tracks)pc.addTransceiver(track,{direction:'sendonly',streams:[stream]});}catch(error){close('source-failed');throw error;}
 const serial=operation=>{const result=chain.then(async()=>{if(closed)throw Error('Gameplay peer closed');return operation();});chain=result.catch(()=>{});return result;};
 return {
  start:()=>serial(async()=>{if(role!=='publisher'||started)throw Error('Offer already started or wrong role');started=true;const offer=await pc.createOffer();if(closed)return;await pc.setLocalDescription(offer);if(!closed)emit({description:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});}),
  receive:message=>serial(async()=>{
   if(message?.description){
    const d=message.description;
    if(d.type!==(role==='viewer'?'offer':'answer')||typeof d.sdp!=='string'||d.sdp.length>131072||pc.remoteDescription)throw Error('Invalid gameplay description');
    await pc.setRemoteDescription({type:d.type,sdp:d.sdp});if(closed)return;
    for(const candidate of pending.splice(0)){await pc.addIceCandidate(candidate);if(closed)return;}
    if(role==='viewer'){const answer=await pc.createAnswer();if(closed)return;await pc.setLocalDescription(answer);if(!closed)emit({description:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});}
   }else if(message?.candidate){
    const c=message.candidate;
    if(typeof c.candidate!=='string'||c.candidate.length>4096)throw Error('Invalid ICE candidate');
    if(pc.remoteDescription)await pc.addIceCandidate(c);
    else{if(pending.length>=64)throw Error('Too many pending candidates');pending.push(c);}
   }else throw Error('Invalid gameplay signal');
  }),
  close,
  get active(){return !closed;}
 };
}
