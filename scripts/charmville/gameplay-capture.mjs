/** Canvas plus an explicitly supplied game-output node; never requests device capture. */
export function captureGameplay(canvas,{frameRate=30,audioOutput=null,onStop=()=>{}}={}){
 if(!canvas||typeof canvas.captureStream!=='function')throw Error('Game video capture is not supported in this browser.');
 if(![15,30,60].includes(frameRate))throw Error('Choose a supported capture frame rate.');
 if(!(canvas.width>0&&canvas.height>0))throw Error('Start the game before capturing video.');
 let stream;
 try{stream=canvas.captureStream(frameRate);}catch{throw Error('The game canvas cannot be captured. No other screen will be shared.');}
 const tracks=stream.getTracks();
 const video=stream.getVideoTracks();
 if(video.length!==1||tracks.length!==1||video[0].readyState==='ended'){
  for(const track of tracks)track.stop();
  throw Error('A game-only video track could not be created.');
 }
 const track=video[0];
 // Favor preserving small text and pixel edges; transport adaptation may still
 // lower quality. This hint is not a guarantee of lossless pixel reproduction.
 // Some browsers expose a read-only or unsupported hint. Capture must still
 // remain usable, and this optional optimization must never leak a track.
 try{track.contentHint='detail';}catch{}
 let audioDestination=null;
 if(audioOutput){
  try{
   if(audioOutput.context?.state!=='running')throw Error('Game audio is not running.');
   audioDestination=audioOutput.context.createMediaStreamDestination();
   const audioTracks=audioDestination.stream.getTracks();
   if(audioTracks.length!==1||audioTracks[0].kind!=='audio'||audioTracks[0].readyState!=='live')throw Error('Game audio unavailable.');
   // Branch the engine's output. Never disconnect or replace local speakers.
   audioOutput.connect(audioDestination);
   stream.addTrack(audioTracks[0]);
  }catch{
   if(audioDestination){try{audioOutput.disconnect(audioDestination);}catch{}for(const item of audioDestination.stream.getTracks())item.stop();}
   track.stop();
   throw Error('Game audio could not be attached. No microphone or desktop was captured.');
  }
 }
 const ownedTracks=stream.getTracks();
 let stopped=false;
 function stop(reason='stopped'){
  if(stopped)return;stopped=true;
  for(const item of ownedTracks)item.removeEventListener('ended',ended);
  audioOutput?.context.removeEventListener('statechange',audioChanged);
  canvas.removeEventListener('webglcontextlost',lost);
  canvas.removeEventListener('contextlost',lost);
  if(audioDestination){try{audioOutput.disconnect(audioDestination);}catch{}}
  for(const item of ownedTracks)item.stop();
  onStop(reason);
 }
 const ended=()=>stop('track-ended');
 const lost=()=>stop('rendering-interrupted');
 const audioChanged=()=>{if(audioOutput.context.state==='closed')stop('audio-ended');};
 for(const item of ownedTracks)item.addEventListener('ended',ended,{once:true});
 audioOutput?.context.addEventListener('statechange',audioChanged);
 canvas.addEventListener('webglcontextlost',lost,{once:true});
 canvas.addEventListener('contextlost',lost,{once:true});
 return {stream,stop,hasGameAudio:Boolean(audioDestination),get active(){return !stopped;}};
}
