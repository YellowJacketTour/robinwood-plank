# Pining continuity: cross-device drafts and resume

CONTINUITY-BOUNDARIES.md is authoritative. Sync may preserve prose and layout draft conflicts;
it must never merge ledger state, replay offline economy actions, or transfer caster/WalletConnect/
OAuth credentials. Accepted delivery identity is immutable and idempotent, never forked.

Owner requirement, 2026-09-07: premium cross-device draft and resume are core product behavior.
This supersedes the earlier device-only outbound queue limitation for encrypted draft/intent transport.
It does not authorize server-held foreign platform sessions or a server-side posting browser.

## Product contract

Start on a phone, continue on desktop, attach a Stalk, pick docks, sign, close the device,
and see the same draft or accepted pine when returning. Writing never depends on the caster being open.
An accepted outbound intent survives application restarts. A disconnected phone can write locally;
it cannot truthfully claim cross-device sync before reaching the relay.

No system can guarantee that devices, networks, and foreign websites never fail. The contract is instead:
no silent loss after acknowledged durable save, no silent overwrite of competing edits, exactly-once
stamp debit in our ledger, and no automatic blind retry after an ambiguous external submission.
Device loss before any remote save is outside recoverability; the UI must distinguish that condition.

## Everyday experience

- Drafts autosave locally after each edit, with debounced encrypted remote sync and a maximum flush interval.
- Plain statuses: Saving on this device / Saved on this device / Saved across devices / Offline /
  Another device has changes / Storage full. Never show Saved across devices on a local-only write.
- A small Drafts entry beside the composer lists excerpts, destinations, modified time, and attachment state.
- Returning to an unfinished draft offers Continue pining. It restores text, media, alt text, selected
  stamp, destination selection, and per-platform edits. It never sends merely because a device resumed.
- Two devices editing simultaneously retain both branches. Offer Compare and keep mine / keep theirs /
  combine; text-only non-overlapping edits may merge. Media deletion and destination changes require
  explicit conflict handling. Device clocks never decide which edit wins.
- Undo deletion through a recoverable tombstone; version history permits restoring a prior revision.
- Drafts preserve long text; per-dock limits appear before send. No silent truncation, stripped media,
  changed account, or unannounced footer. Store the exact reviewed rendering for each destination.
- Uploads resume by verified chunks. Show per-attachment progress and retry. A missing upload does not
  erase the body or claim the pine is ready. Keep media alt text and order across devices.
- Keyboard shortcut for saving is safe; a send shortcut requires the same review as the send button.
  Screen-reader announcements are polite and debounced. All controls work without dragging.
- Reduced-motion mode, touch-safe controls, focus restoration, and preservation of WoodAmp are required.

## Drafts and signed pines are different objects

Drafts are mutable, cheap to save, and consume no stamps. Signed pines are immutable snapshots.
Editing after signing creates a new draft revision; it cannot change the accepted envelope.
Final review identifies every account, exact body/media variant, stamp quantity, and expiry.
Accepted local publication remains visible even if some external destinations fail.

One signed envelope can contain multiple destination deliveries. A delivery has its own idempotency key,
state, and evidence. Successful destinations never resend merely because another destination failed.
Duplicate acceptance requests return the original receipt; they do not debit inventory again.
Changing destinations after acceptance requires a new explicitly reviewed intent for the added destinations.

## Relay and key boundary

Use InMotion PostgreSQL for opaque encrypted draft revisions, encrypted signed-envelope transport,
revision metadata, and acknowledgments. Store encrypted media chunks in the existing durable upload
storage with opaque ids and integrity digests, not in a second cloud datastore. No Redis.
The server necessarily sees minimal routing metadata such as profile, revision size, and timestamps.
Never call this metadata-free encryption.

Device pairing enrolls a device public key under the verified profile. A randomly generated profile
draft-encryption key is wrapped separately for each authorized device. Do not derive encryption keys
from wallet signatures: they may vary by wallet and exposing a signature must not expose drafts.
New-device enrollment requires approval from an existing device or a recovery method defined at setup.
Recommend an encrypted recovery package protected by a separately held recovery secret. Wallet login
alone cannot decrypt end-to-end encrypted drafts on a new machine without such a key-transfer path.
Do not ship encrypted sync without testing enrollment, recovery, revocation, and key rotation.

Use a reviewed authenticated-encryption library and canonical envelope format. Nonces are unique per
key; bind profile id, draft id, revision, device id, and content type as associated data. Media has
separate random keys referenced inside the encrypted draft. Keep content out of analytics/error logs.
The local database must surface quota errors rather than silently dropping writes. Persist before
rendering a successful local-save indicator. Ask the browser for persistent storage when appropriate.

Revocation stops future access and cancels outstanding execution leases. It cannot erase plaintext or
keys already copied to a previously trusted device; rotate keys for future revisions. Disconnecting
a foreign dock removes that dock's local session independently of draft sync or OAuth badges.

## Sync protocol

Create draft UUID locally. Each revision carries parent revision(s), writer device, payload digest,
encrypted payload reference, and server sequence on acceptance. Upload with If-Match/base revision and
a stable operation id. Server transaction appends revision and advances head only if parent matches.
On mismatch, retain a conflict branch and return current head; never overwrite by last arrival.

Sync on edit debounce, reconnect, foreground, and explicit Save; flush before navigating within the app.
Page-close handlers are best-effort, never the sole save path. Use bounded backoff with jitter and
retry hints. No permanent poll when the composer/caster is inactive. Visibility-driven catch-up reads
and short active-session polling fit Passenger; a WebSocket service is not assumed.

Remote acknowledgment means both ciphertext storage and revision metadata are durably committed.
Downloading verifies integrity before replacing local state. A newer revision from another device does
not replace dirty local edits. Retain the previous known-good revision until the new revision validates.
Support resumable attachment uploads, orphan-chunk cleanup with a grace period, and user-visible quotas.
Proposed default: keep the last 30 revisions and deleted drafts for 30 days; disclose retention and allow
export before cleanup. Signed receipts follow the economy retention policy, separate from draft cleanup.

## Acceptance, execution, and crash recovery

1. Client freezes exact signed snapshot and ensures required media is durably available.
2. Server verifies primary authorization, profile ownership, expiry, nonce, and stamp balance.
3. A single transaction consumes the authorization nonce, debits exactly one stamp per intent_id, records immutable receipt,
   and creates opaque relay work. A unique intent id binds one payload digest; changed payload rejects.
4. Only a paired device with the required local dock can acquire a short execution lease. Lease has a
   fencing generation; another device cannot acknowledge using an old generation.
5. Caster decrypts, checks signature and acceptance receipt, confirms the exact logged-in destination
   account, then journals a durable submitting record before touching the external site's submit action.
6. Caster records observed result and synchronizes its signed acknowledgment. A platform permalink/id
   is stronger evidence than a click. Account mismatch, login challenge, or changed UI blocks execution.

External websites generally do not honor our idempotency keys. Therefore exactly-once external delivery
cannot be guaranteed solely by a relay lease. A crash after click but before confirmation moves to
needs-check. The next caster reconciles against observed platform history or asks the user to inspect;
it must not retry automatically. Lease expiry after submission likewise does not permit blind takeover.

States: draft -> ready-for-review -> accepted -> queued -> submitting -> sent.
Branches: caster-offline, dock-disconnected, blocked-by-site, needs-check, expired, canceled, failed.
Sync status is independent of delivery status. Offline does not mean failed; a queued pine is not sent.
Retries of the same accepted delivery do not burn again. A newly authorized attempt with changed content
has a new intent and previews its cost. Cancel after acceptance stops unsent work but does not refund
the stamp. If already submitting, say cancellation is pending confirmation, not guaranteed.

The public UI may say Sent to X only after the adapter has reliable success evidence. A local page click
is Attempted; manual share-sheet launch is Opened in platform. A sent record is a delivery receipt,
not a promise that the platform will preserve the post or prevent later moderation/deletion.

## Acceptance tests that gate this feature

- Type offline, restart browser, resume locally, reconnect, verify remote revision and second-device body.
- Phone signs and queues with desktop closed; desktop later retrieves the same immutable envelope.
- Two devices edit the same revision; both texts and destination choices survive conflict resolution.
- Crash before/after every save acknowledgment and every transaction boundary; inspect durable recovery.
- Duplicate taps, network retries, and two casters cause one stamp debit and one execution lease.
- Kill caster after platform submission; recovery reports needs-check and does not duplicate blindly.
- Revoke device or switch primary during lease; stale device cannot obtain new work or mutate profile.
- Expired wallet session retains draft and prompts only when authorization is required.
- Upload interruption, corrupt chunk, full disk, browser quota, and server outage retain recoverable text.
- Destination account differs from reviewed account: block without posting to the wrong identity.
- One of five destinations fails: retain four successes, one total stamp debit, and retry only the
  unresolved delivery under the same intent_id after reconciling any ambiguous submission.
- Export/recovery package restores drafts on a clean authorized device; bad recovery secret fails closed.
- Foreground/background and board expansion never remount or restart WoodAmp.

These are required tests, not results already obtained. Implementation and fault-injection runs remain pending.
