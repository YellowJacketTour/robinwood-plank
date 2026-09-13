# WoodAmp listening continuity

WoodAmp now remembers the selected audio track, position, shuffle and repeat
preferences on the current device. Reload always restores paused. Only an
explicit listener action starts playback; the existing `preload="none"` remains.

Restoration resolves the stored track ID and exact media source against the
current validated playlist, so playlist reordering is safe and replacement or
removed media does not inherit another recording's position. Seeking waits for
metadata. Completed recordings start at zero. Embedded players are not restored.

Progress checkpoints every five seconds and on pause, page hide, or backgrounding.
Unavailable local storage does not prevent listening. This device preference
contains no wallet role, economic state, prose/media draft, or caster credential.

Validation: `npx tsx --test test/market/woodamp-continuity.test.ts` covers reordered,
replaced and removed tracks, embedded media exclusion, malformed storage, and
duration boundaries. Scoped ESLint and `npx tsc --noEmit` pass.

Remaining whole-vision continuity work: authenticated cross-device music restore,
client-encrypted prose/media drafts with a defined key recovery contract, and
explicit cross-device layout draft conflict resolution. This implementation does
not claim to complete those workflows.
