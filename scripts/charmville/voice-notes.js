// Local voice drafts. Starting either microphone feature requires an explicit action.
const open=document.createElement('button');open.type='button';open.textContent='Voice notes';open.dataset.voiceNotesOpen='';document.querySelector('header').append(open);
const panel=document.createElement('dialog');panel.className='charmdex voice-notes';panel.innerHTML='<form method="dialog"><strong>Voice note</strong><button aria-label="Close voice note">Close</button></form><p>Record, listen, then save your draft. Nothing is posted automatically.</p><div class="voice-actions"><button type="button" data-record>Record</button><button type="button" data-stop disabled>Stop</button><button type="button" data-play disabled>Play draft</button><button type="button" data-save disabled>Save audio</button><button type="button" data-discard disabled>Discard</button></div><p role="status">Microphone off · up to 60 seconds</p><audio controls hidden></audio><label>Caption or transcript<textarea aria-label="Voice note caption" maxlength="500" rows="4"></textarea></label><button type="button" data-copy disabled>Copy caption</button><button type="button" data-dictate>Dictate caption</button><p class="voice-recognition-note">Optional dictation may use your browser’s speech service. Review the text before posting.</p><p>To publish this local draft, save the audio and attach it in your signed-in PlankSpace composer. Attachments become public when uploaded. Live proximity chat is not connected.</p>';
document.body.append(panel);
const get=name=>panel.querySelector('[data-'+name+']');const status=panel.querySelector('[role=status]'),audio=panel.querySelector('audio'),caption=panel.querySelector('textarea');
let recorder=null,stream=null,chunks=[],url='',blob=null,timer=null,elapsed=null,generation=0,recognition=null,disposed=false;
function release(){clearTimeout(timer);clearInterval(elapsed);stream?.getTracks().forEach(track=>track.stop());stream=null;}
function stop(){generation++;const active=recorder?.state==='recording';if(active)recorder.stop();release();get('stop').disabled=true;get('record').disabled=active;}
function discard(){if(url)URL.revokeObjectURL(url);url='';blob=null;audio.pause();audio.removeAttribute('src');audio.hidden=true;for(const name of ['play','save','discard'])get(name).disabled=true;}
open.onclick=()=>{for(const [key,keyCode] of [['ArrowUp',38],['ArrowDown',40],['ArrowLeft',37],['ArrowRight',39],['z',90],['x',88],['d',68],['c',67],['Enter',13]])document.dispatchEvent(new KeyboardEvent('keyup',{key,keyCode,which:keyCode,bubbles:true}));panel.showModal();get('record').focus();};
get('record').onclick=async()=>{
 if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){status.textContent='Audio recording is unavailable in this browser.';return;}
 if(recognition){recognition.abort();}
 const own=++generation;get('record').disabled=true;status.textContent='Waiting for microphone permission…';
 try{
  const acquired=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  if(own!==generation||!panel.open){acquired.getTracks().forEach(t=>t.stop());return;}
  stream=acquired;discard();chunks=[];let bytes=0,tooLarge=false;
  const mimeType=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
  recorder=new MediaRecorder(stream,mimeType?{mimeType}:undefined);
  recorder.ondataavailable=event=>{bytes+=event.data.size;if(bytes>3_000_000){tooLarge=true;stop();}else if(event.data.size)chunks.push(event.data);};
  recorder.onstop=()=>{release();if(disposed)return;get('record').disabled=false;get('stop').disabled=true;if(tooLarge){status.textContent='Recording exceeded the draft limit. Please record a shorter note.';return;}blob=new Blob(chunks,{type:recorder.mimeType});if(!blob.size){status.textContent='No audio captured. Try again.';return;}url=URL.createObjectURL(blob);audio.src=url;audio.hidden=false;for(const name of ['play','save','discard'])get(name).disabled=false;status.textContent='Microphone off · draft ready to review';};
  recorder.onerror=()=>{stop();status.textContent='Recording failed. Try again.';};recorder.start(250);get('stop').disabled=false;get('stop').focus();const began=Date.now();status.textContent='Recording · 0 / 60 seconds';elapsed=setInterval(()=>status.textContent=`Recording · ${Math.floor((Date.now()-began)/1000)} / 60 seconds`,500);timer=setTimeout(stop,60000);
 }catch{if(own!==generation)return;release();get('record').disabled=false;status.textContent='Microphone unavailable or permission declined. You can still write a caption.';}
};
get('stop').onclick=stop;get('play').onclick=()=>audio.paused?audio.play().catch(()=>status.textContent='Use the audio player to begin playback.'):audio.pause();
get('save').onclick=()=>{if(!blob)return;const anchor=document.createElement('a');anchor.href=url;anchor.download='charmville-voice-note.'+(blob.type.includes('mp4')?'m4a':blob.type.includes('ogg')?'ogg':'weba');anchor.click();};
get('discard').onclick=()=>{discard();status.textContent='Draft discarded · microphone off';};
caption.oninput=()=>get('copy').disabled=!caption.value.trim();
get('copy').onclick=async()=>{try{await navigator.clipboard.writeText(caption.value);status.textContent='Caption copied. Paste it into your post.';}catch{status.textContent='Select the caption text to copy it manually.';}};
const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
get('dictate').disabled=!Speech;if(!Speech)panel.querySelector('.voice-recognition-note').textContent='Dictation is unavailable in this browser. Recording and typed captions remain available.';
get('dictate').onclick=()=>{if(recognition){recognition.stop();return;}if(recorder?.state==='recording'){status.textContent='Stop the recording before dictating a caption.';return;}recognition=new Speech();recognition.lang=navigator.language;recognition.interimResults=false;recognition.onresult=event=>{caption.value=(caption.value+' '+event.results[0][0].transcript).trim().slice(0,500);caption.dispatchEvent(new Event('input'));};recognition.onerror=()=>status.textContent='Dictation unavailable. You can edit the caption directly.';recognition.onend=()=>{recognition=null;get('dictate').textContent='Dictate caption';};get('dictate').textContent='Stop dictation';try{recognition.start();}catch{recognition=null;get('dictate').textContent='Dictate caption';status.textContent='Dictation could not start. Try again or type a caption.';}};
panel.addEventListener('close',()=>{stop();recognition?.abort();audio.pause();open.focus();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();recognition?.abort();}});
addEventListener('pagehide',()=>{disposed=true;stop();recognition?.abort();discard();});
for(const type of ['keydown','keyup'])window.addEventListener(type,event=>{if(panel.open){event.stopImmediatePropagation();if(type==='keydown'&&event.key==='Escape'){event.preventDefault();panel.close();}}},true);
