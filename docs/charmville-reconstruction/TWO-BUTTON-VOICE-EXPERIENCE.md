# Two-button social and voice experience

## Delivered controls
The native game retains its combat mapping. View/Back button 8 opens Charmdex; inside an open Charmdex or voice-note dialog, South confirms, East closes, and directions move focus. Left/right change a focused category selector. Activation is edge-triggered: holding a button cannot repeatedly click. Dialog transitions, focus loss and reconnect require neutral controls before gameplay resumes. Native movement is released before the modal opens.

Keyboard users retain Tab, Enter and Escape for ordinary dialog controls. Microphone capture is never initiated by page load, opening the menu, or merely focusing Record. The physical controller experience still needs hardware testing; current verification uses synthetic standard gamepad events.

## Delivered voice draft and attachment path
Voice notes open from the header or Charmdex, including fullscreen via Menu. Record explicitly requests microphone access. Stop releases tracks; playback is explicit; Discard revokes the draft URL. Closing, hiding the page and navigation stop capture. Recordings are limited to 60 seconds and 3,000,000 bytes so they fit the existing composer's limit. WebM audio downloads as .weba to preserve audio MIME classification; Ogg and MP4 audio use .ogg and .m4a.

The recording remains in browser memory until saved. It is not a durable private cloud draft. The player can save it and select it in the existing authenticated PlankSpace media composer. Selecting a file uploads it publicly; publishing the post remains a separate action. The composer now renders audio attachments with playback controls and validates allowed MIME/extension pairs. There is no automatic posting or direct native-account upload bridge.

Optional browser dictation writes an editable caption; Copy caption supports pasting it into the existing post body. The UI indicates that browser dictation may use the browser's speech service. Unsupported browsers retain recording and typed captions. This fallback has not been benchmarked for transcription quality, accents, languages or noise, and is not described as best-in-class.

Sources: [MDN MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder), [format capability detection](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static), [microphone secure-context behavior](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [SpeechRecognition compatibility](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition). Browser capture and recording formats require capability detection; speech recognition availability varies and can involve a remote service.

## Proximity voice architecture still to implement
Use an authenticated realtime media service with an SFU and TURN support rather than broadcasting microphone packets through the guest pose relay. LiveKit is a candidate with room grants, server subscription controls and optional E2EE, not an installed dependency in this checkpoint. Sources: [subscription controls](https://docs.livekit.io/guides/room/receive), [room permissions](https://docs.livekit.io/reference/other/roomservice-api/), [token grants](https://docs.livekit.io/frontends/reference/tokens-grants/), [encryption](https://docs.livekit.io/transport/encryption/).

Room membership must derive from authenticated account identity, private/public region permission and authoritative position. Disable broad automatic subscriptions. Enforce who may receive a track on the server; client volume attenuation alone is not privacy. Apply distance, floors, walls, party choice, blocks and mutes. Revoke subscriptions and rotate private-room membership on warps, disconnects and access changes. Admission and capacity controls are necessary for large events. E2EE requires an explicit key distribution design; server transcription cannot invisibly read end-to-end encrypted audio.

Player controls should be opt-in voice, push-to-talk, visible microphone state, mute/deafen, per-speaker volume and report/block access. Recordings and transcripts are separate features with distinct consent and retention. Do not automatically archive proximity conversations as posts. Text chat needs the same authenticated membership, rate limiting and moderation boundaries.

A production transcription adapter needs explicit language selection, speaker/segment timestamps, interim/final handling, correction before publication, retry semantics, retention controls and failure fallback. Evaluate candidate engines on measured accuracy, latency and real player hardware/noise conditions before choosing one. No transcription backend, authenticated live chat or proximity voice is connected yet.

## Verification and acceptance gap
Synthetic microphone test: no capture on opening, explicit record/stop, playable blob, ended tracks, discard, close cleanup and mobile layout. Synthetic controller test: focus, selection, single confirm, back, dialog transitions, no held-confirm recording, no native input leakage and reconnect neutral guard. Existing display/controller and Charmdex regressions pass. Audio attachment unit tests preserve media normalization and reject unsafe URLs.

Still required for the full experience: native authenticated posting without manual file handoff, private draft lifecycle, content decoding/transcoding, real-device microphone and controller testing, evaluated transcription, live text rooms, proximity voice transport, and the broader persistent economy/encounter integration. These are explicit remaining tasks, not implemented features.
