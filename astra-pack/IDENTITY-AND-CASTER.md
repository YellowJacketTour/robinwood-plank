# Profile identity and PlankCaster

## Ownership

Stable `plankspace_profiles.id` owns Charmville, balances, receipts, drafts, and linked keys.
Do not use a provider's current account as that primary key. Existing profiles.wallet is a
compatibility field for the existing EVM primary during additive migration; old receipts retain
their historical signing key. Primary rotation never moves inventory to a different profile.

One profile has one active primary and many linked keys. A verified key belongs to at most one
profile. A provider label is display metadata, not identity or proof. Wallet connection,
cryptographic link, and current application session are three different states in the UI.

Linking requires authorization from the current primary plus proof from the candidate key over
one server-issued challenge binding profile id, primary id, candidate canonical account, domain,
chain, action, nonce, issued time, expiry, and schema version. Nonces are consumed atomically.
Changing primary requires the current primary and candidate signatures and revokes old sessions
and pending unsigned operations. Never change primary in accountsChanged/networkChanged handlers.
Unlink requires primary or the linked key; primary removal requires an explicit replacement transaction.
Do not automatically merge two existing profiles when someone tries to link their primary keys.

Keep namespace, chain reference, canonical address, and full CAIP-10 separately. EVM addresses can
be normalized to lowercase for lookup; never lowercase Solana addresses. Contract-account control
is chain-specific: proving a Safe on one chain does not prove its same-address deployment elsewhere.
The product's namespace/address uniqueness prevents claiming the same key in multiple profiles;
separate chain-proof rows determine where that linked account is actually authorized.
Bitcoin script/address normalization and message-signing support need explicit adapter tests.

Privacy: hidden links must be omitted from all public responses, HTML, caches, and analytics exports.
Proofs and binding history stay private; public profile pills show only opted-in verified accounts.
Delegation is an inventory read permission with expiry/revocation checks, never implied primary control.

## Shared sign-in

One root session provider handles PlankSpace, porch, bag, local pining, and draft access. WoodAmp
playback does not require wallet auth. Server sessions bind profile id, primary link id, primary
generation, expiration, and explicit scopes. Porch writes derive owner from server session and
check action-level authorization; a request body wallet never determines ownership.

Ordinary actions produce authenticated server receipts; those are not falsely described as a
fresh wallet signature for each click. Pine-out, listings, wrap, linking, and primary rotation
retain explicit action signatures. Login is not a token approval or blanket transaction permission.

Use SIWE for EVM, with a server nonce and canonical origin; support deployed contract verification
via ERC-1271 and counterfactual accounts via a reviewed ERC-6492 verifier. Verify a Safe address,
not an owner's EOA. Resolve RPC through existing budgeted routing. Do not run arbitrary verification
calls with an unlimited gas/RPC budget. Non-EVM accounts require their own verified SIWX/message
format; a connector's support for an address is not proof its wallet implements the necessary signature.

Current findings: auth-client.ts persists a 12-hour bearer token in localStorage. Session POST uses
lib/wallet-proof.ts (ethers EOA recovery), while the separate challenge route is not used by that
client login path. Existing shared wallet bridge is provider plumbing, not multi-key profile ownership.
Replace the insufficient auth contract deliberately; do not call it already SIWE/1271/6492 compliant.

Proposed web session transport: Secure HttpOnly SameSite cookie with origin/CSRF checks for writes,
scoped server revocation, single-flight client login, and explicit expired-session UI that retains drafts.
Do not expose a general-purpose bearer to profile customization or arbitrary remote frames.
Preserve old login compatibility only behind a bounded migration path; new sensitive actions must
not fall back to an older verifier when stronger verification fails.

## Connectors

AppKit is flag-gated connector acquisition, with the ethers adapter for EVM; no wagmi rewrite.
lib/wallet.ts keeps destination allowlists, simulation, correct provider selection, and chain checks.
EIP-6963 and WalletConnect QR cover different connection paths. Register supported networks at
initialization, lazy-load on connect, and disable embedded/social wallet, swaps, and onramp surfaces.
Solana/Bitcoin adapters are enabled only with verified downtown support and tested message capabilities.

Persistent wallet links belong in Postgres regardless of Reown plan. Simultaneously hot connections
are an optional paid enhancement. Official docs confirm the multiwallet hooks and paid restriction:
https://docs.reown.com/appkit/features/multiwallet-linking
https://docs.reown.com/appkit/react/core/hooks
https://docs.reown.com/appkit/next/core/installation
https://docs.reown.com/appkit/react/core/headless
Reviewed 2026-09-07; pin actual compatible package versions during implementation, not a floating latest.

## Caster boundary

The person logs into actual foreign websites inside PlankCaster. Local persistent partitions per
profile/dock/account keep cookies apart. Suggested names use opaque local ids rather than public handles.
No passwords, platform cookies, credential-export endpoint, or headless posting workers on InMotion.
OAuth badges are optional and disconnected from outbound availability. app/api/x/* is inspected only
for attachment points and legacy behavior, never used as the universal outbound foundation.

Electron main process owns sessions and queue execution. Use current supported Electron,
WebContentsView, context isolation, sandbox, no Node integration for remote pages, minimal IPC,
strict sender/origin checks, explicit navigation rules, and denied-by-default permissions.
Remote sites must never reach privileged shell APIs. Validate intent before any page interaction.
Do not copy xCaster's broad page injection/security overrides into a generalized multi-site shell.
Security reference: https://www.electronjs.org/docs/latest/tutorial/security

WoodAmp is the site's persistent audio owner; dock audio is separately controlled and starts only
with user intent. No hidden autoplay or automatic mix of platform microphone and local playback.

Signed envelope fields: version, intentId, profileId, primaryLinkId, primaryGeneration, pineId,
draftRevision, canonical body digest, ordered media digests, per-destination account and rendered
content digests, stamp allocation, nonce, issuedAt, expiresAt, origin, and chain reference.
Stamp allocation is exactly one stamp for the accepted intent, not per-destination charges.
Signing exact per-dock content prevents an adapter silently changing text or destination after review.
Caster validates the signature and stamp acceptance receipt before execution. A server transport
acknowledgment is not the wallet signature. Pair device keys through primary-authorized enrollment.
Cross-device relay, conflict handling, and retry semantics are defined in PINING-CONTINUITY.md.
CONTINUITY-BOUNDARIES.md limits that relay to drafts/accepted envelopes and status, never credential
material or ledger replication. On resume, reload profile wallet links and validate the primary session;
a newly connected AppKit account cannot become primary through restored device preferences.

## Dock capability register

This is a research gate, not a claim of implemented adapters. The desktop website must be tested
inside the actual packaged app with owner-controlled test accounts before its dock is enabled.

| Dock | Official API reference status | Caster viability to test | Evidence for Sent | Never claim |
|---|---|---|---|---|
| X | Create-post API exists with user auth; not our pipe | xCaster demonstrates a desktop X surface; our send adapter untested | Observed matching account/content and stable post id/permalink | A click alone proves delivery |
| Instagram | Publishing support depends on account/API product; verify exact current eligibility | Login, media composer, upload and account selection in isolated desktop session | Published media id/permalink from the same account | Text-only pine always maps to an IG post |
| Facebook | Page/user publishing capabilities require separate current research | Personal/Page composer distinction, account selection and media uploads | Matching account or Page post permalink | Page support implies personal-profile support |
| TikTok | Direct Post exists; unaudited client visibility is restricted | Desktop upload flow, media requirements, review states | Published item id and actual visibility when observable | Upload accepted means public post |
| Snapchat | Creative Kit supports a sharing handoff | Web product's actual publishing surface still unverified | Confirmed publish evidence if supported; otherwise Opened in platform | Web chat or share-sheet launch equals Story publication |

Sources checked: https://docs.x.com/x-api/posts/create-post ;
https://developers.tiktok.com/docs/en/content-sharing-guidelines ;
https://developers.snap.com/snap-kit/creative-kit/web .
IG/FB primary-document and packaged-browser verification remains pending; do not ship green capability
badges from this table. OAuth denial must not prevent local pining or disable a functioning caster dock.
Site challenges produce blocked-by-site, never anti-detect, fingerprint spoofing, or challenge bypass.

First caster milestone is X only: login persistence, one verified intent, one honest delivery result,
disconnect/revoke, and restart recovery. Add other partitions only after their capability tests pass.
