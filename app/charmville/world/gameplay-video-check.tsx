'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {captureGameplay} from '@/scripts/charmville/gameplay-capture.mjs';
import {createGameplayBroadcastClient} from '@/scripts/charmville/gameplay-broadcast-client.mjs';
import styles from './gameplay-video-check.module.css';

type Client = Awaited<ReturnType<typeof createGameplayBroadcastClient>>;
type Run = {closed: boolean; clients: Client[]; capture: ReturnType<typeof captureGameplay> | null; tracks: MediaStreamTrack[]; timeout: ReturnType<typeof setTimeout> | null; sample: ReturnType<typeof setInterval> | null; frameCallback: number | null};

/** Development-only self-view proof. No discovery, recording or public stream. */
export default function GameplayVideoCheck({getCanvas, token}: {getCanvas: () => HTMLCanvasElement | null; token: string | null}) {
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef<Run | null>(null);
  const mounted = useRef(false);
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const running = Boolean(token && activeToken === token);
  const [frames, setFrames] = useState(0);
  const [decoded, setDecoded] = useState<number | null>(null);
  const [status, setStatus] = useState('Send your game canvas through a local WebRTC connection and view the received footage here.');
  const stop = useCallback((reason: string, update = true) => {
    const run = current.current;
    if (!run || run.closed) return;
    run.closed = true; current.current = null;
    if (run.timeout) clearTimeout(run.timeout);
    if (run.sample) clearInterval(run.sample);
    if (run.frameCallback !== null) video.current?.cancelVideoFrameCallback?.(run.frameCallback);
    for (const client of run.clients) client.close();
    run.capture?.stop();
    for (const track of run.tracks) track.stop();
    if (video.current) {video.current.pause(); video.current.srcObject = null;}
    if (update && mounted.current) {setActiveToken(null); setStatus(reason);}
  }, []);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; stop('Preview closed', false);};}, [stop]);
  useEffect(() => () => stop('Session changed', false), [token, stop]);

  async function start() {
    if (current.current || process.env.NODE_ENV === 'production') return;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {setStatus('This check only runs on the local development site.'); return;}
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {setStatus('Sign in to your admitted local test profile first.'); return;}
    const canvas = getCanvas();
    if (!canvas) {setStatus('Start the game first so its canvas is available.'); return;}
    const run: Run = {closed: false, clients: [], capture: null, tracks: [], timeout: null, sample: null, frameCallback: null};
    current.current = run; setActiveToken(token); setFrames(0); setDecoded(null); setStatus('Connecting two admitted local sessions…');
    const fail = (reason: string) => {if (current.current === run) stop(reason);};
    run.timeout = setTimeout(() => fail('The 60-second local check finished. Capture and peer connections are stopped.'), 60000);
    try {
      run.capture = captureGameplay(canvas, {frameRate: 15, onStop: () => fail('Game capture ended or rendering was interrupted.')});
      const owner = await createGameplayBroadcastClient({url: 'ws://127.0.0.1:3035/broadcast', token, onEnded: () => fail('Local publication ended.'), onError: () => fail('Local media negotiation failed.')});
      if (run.closed) {owner.close(); return;} run.clients.push(owner);
      const receiver = await createGameplayBroadcastClient({url: 'ws://127.0.0.1:3035/broadcast', token,
        onEnded: () => fail('Local viewing authorization ended.'), onError: () => fail('Local media negotiation failed.'),
        onTrack: (_id, track) => {
          if (run.closed || track.kind !== 'video' || run.tracks.length > 0) {track.stop(); return;}
          run.tracks.push(track); track.addEventListener('ended', () => fail('Received video ended.'), {once: true});
          const element = video.current;
          if (!element) {fail('The preview display was closed.'); return;}
          element.srcObject = new MediaStream([track]); element.muted = true;
          void element.play().catch(() => {if (!run.closed) setStatus('Video received. Press Play on the preview to start playback.');});
          const countFrame: VideoFrameRequestCallback = (_now, metadata) => {
            if (run.closed) return;
            setFrames(metadata.presentedFrames); setStatus('Live footage received through local WebRTC.');
            run.frameCallback = element.requestVideoFrameCallback(countFrame);
          };
          if (typeof element.requestVideoFrameCallback === 'function') run.frameCallback = element.requestVideoFrameCallback(countFrame);
          run.sample = setInterval(() => {
            if (run.closed) return;
            const quality = element.getVideoPlaybackQuality?.();
            const decodedCount = (element as HTMLVideoElement & {webkitDecodedFrameCount?: number}).webkitDecodedFrameCount;
            if (Number.isFinite(decodedCount)) setDecoded(decodedCount!);
            if (quality && !element.requestVideoFrameCallback) setFrames(Math.max(0, quality.totalVideoFrames - quality.droppedVideoFrames));
          }, 500);
        },
      });
      if (run.closed) {receiver.close(); return;} run.clients.push(receiver);
      const publicationId = await owner.publish(run.capture.stream);
      if (run.closed) return;
      await receiver.subscribe(publicationId);
      if (!run.closed) setStatus('Connected. Waiting for the first received video frame…');
    } catch {fail('Local video check could not connect. Confirm that the admitted development signaling gateway is running on port 3035.');}
  }

  if (process.env.NODE_ENV === 'production') return null;
  return <section className={styles.shell} aria-label="Local gameplay video check">
    <header><strong>Live footage check</strong><span>LOCAL ONLY · 60 SECONDS</span></header>
    <p>Preview your own game canvas at 15 fps through two authenticated sessions. This is a local transport check, not a public broadcast.</p>
    <video ref={video} muted playsInline controls autoPlay className={styles.video} aria-label="Received local gameplay footage" onError={() => stop('Video playback failed. Capture has stopped.')} />
    <div className={styles.readout}><span>Presented frames <strong>{frames}</strong></span><span>Decoded frames <strong>{decoded === null ? 'Not reported' : decoded}</strong></span></div>
    <p role="status" aria-live="polite">{status}</p>
    <div className={styles.actions}><button type="button" disabled={running || !token} onClick={() => {void start();}}>Test live footage</button><button type="button" disabled={!running} onClick={() => stop('Stopped. Game capture and both peer connections are closed.')}>Stop check</button></div>
    <small>Captures only the game canvas. No microphone, camera, desktop, recording or public sharing. Leaving this panel stops the check. Production private viewing needs a revocable media relay.</small>
  </section>;
}
