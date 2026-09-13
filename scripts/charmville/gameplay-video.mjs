import {captureGameplay} from './gameplay-capture.mjs';

/** Local source monitor. Publishing requires a separately authorized transport. */
export function mountGameplayVideo(root, container) {
  const panel = root.createElement('details');
  panel.innerHTML = '<summary>Gameplay video</summary><p>Preview your game picture and game audio source locally. This does not broadcast to profile visitors. Game menus drawn inside the canvas are included. No microphone or desktop is captured. The preview is muted so you hear the game only once.</p><button type="button">Preview game video</button><p role="status" aria-live="polite">Video is off.</p><video muted playsinline hidden aria-label="Local gameplay video preview"></video>';
  const button = panel.querySelector('button');
  const status = panel.querySelector('[role="status"]');
  const video = panel.querySelector('video');
  video.muted = true;
  Object.assign(video.style, {width:'100%',maxWidth:'480px',imageRendering:'pixelated'});
  let source = null;
  let generation = 0;
  let disposed = false;
  let capturedCanvas = null;
  const waitingForArrival = () => Boolean(root.querySelector('.charm-runtime-enter') || root.documentElement.classList.contains('charm-arrival-pending') || root.body?.classList.contains('charm-arrival-pending'));
  const stopped = (reason) => {
    generation++;
    source = null;
    capturedCanvas = null;
    video.pause();
    video.srcObject = null;
    video.hidden = true;
    button.textContent = 'Preview game video';
    status.textContent = reason === 'rendering-interrupted' ? 'Rendering stopped. Restart the game before previewing again.' : reason === 'world-changing' ? 'Video stopped while your game is being prepared. Preview again after arriving.' : 'Video is off.';
  };
  button.addEventListener('click', async () => {
    if (disposed) return;
    if (source) { source.stop(); return; }
    if (waitingForArrival()) {
      status.textContent = 'Enter the world and wait for your character to arrive first.';
      return;
    }
    const attempt = ++generation;
    try {
      capturedCanvas = root.querySelector('canvas');
      // This SDL output is the engine's mixed game audio, not SDL's separate
      // capture input or the voice-note recorder. Unsupported engines stay video-only.
      const audioOutput=root.defaultView.Module?.SDL2?.audio?.scriptProcessorNode??null;
      source = captureGameplay(capturedCanvas, {audioOutput,onStop:stopped});
      video.srcObject = source.stream;
      video.hidden = false;
      button.textContent = 'Stop video preview';
      status.textContent = 'Starting local video preview…';
      await video.play();
      if (disposed || attempt !== generation) return;
      status.textContent = source.hasGameAudio ? 'Local game video and audio source active. Preview muted; nothing is being published.' : 'Local video preview active without game audio. Nothing is being published.';
    } catch (error) {
      if (disposed || attempt !== generation) return;
      source?.stop();
      status.textContent = error instanceof Error ? error.message : 'Video preview could not start.';
    }
  });
  panel.addEventListener('toggle', () => { if (!panel.open) source?.stop(); });
  const unload = () => source?.stop();
  root.defaultView.addEventListener('pagehide', unload);
  // CSS hiding the game does not hide its captured pixels. Stop the track
  // immediately when admission restarts or the engine replaces its canvas.
  const Observer = root.defaultView.MutationObserver;
  const observer = Observer ? new Observer(() => {
    if (!panel.isConnected) { dispose(); return; }
    if (!source) return;
    if (waitingForArrival() || !capturedCanvas?.isConnected || root.querySelector('canvas') !== capturedCanvas) source.stop('world-changing');
  }) : null;
  observer?.observe(root.documentElement, {subtree:true,childList:true,attributes:true,attributeFilter:['class']});
  container.append(panel);
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    source?.stop();
    observer?.disconnect();
    root.defaultView.removeEventListener('pagehide', unload);
    panel.remove();
  }
  return dispose;
}
