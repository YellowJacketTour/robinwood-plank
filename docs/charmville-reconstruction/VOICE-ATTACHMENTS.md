# Reviewed voice attachments

The existing PlankSpace media composer accepts reviewed local voice recordings. It uploads only after file selection through `/api/plankspace-media`, using the existing verified wallet session. Publishing remains the separate existing post/comment action; recording is not posting.

Accepted audio: `audio/webm` with `.webm` or `.weba`, `audio/ogg` with `.ogg`, and `audio/mp4` with `.mp4` or `.m4a`. MIME codec parameters are accepted. Audio is capped at 3 MiB. Stored WebM audio uses `.weba`; MP4 audio uses `.m4a`, preserving audio response types without changing video semantics. `/api/media/[name]` already supports byte ranges. Audio attachments use native playback controls and do not autoplay.

Files become public on upload, before post publication. Review recordings locally before selecting them. There is no private draft storage, deletion lifecycle, transcription service, or proximity voice service in this change. MIME/extension agreement is checked; the existing storage service does not decode or transcode uploaded media. Existing video upload accepts MP4/WebM upstream but the storage whitelist still rejects those video extensions; this pre-existing mismatch is not broadened by the audio change.

Posts still require a 1–500-character body and an existing profile. No authentication, database schema, or cross-post policy changes were made.

Verification: `npx tsx --test test/market/voice-media.test.ts` (3 passing); `npx tsc --noEmit` passed. Tests cover audio normalization/playback MIME, unsafe URL/path rejection, and preserved video/empty attachment behavior.
