# PlankSpace Mobile, Video, and Production X OAuth Design

## Objective

Make PlankSpace profiles efficient and legible on phones while retaining their
classic, customizable PlankSpace identity. Fix multi-video discovery on mobile
and restore real per-user X OAuth in production. Nothing in this work may alter
the behavior or styling of Market, Trade, Mint, Gallery, Memes, Learn, the
shared wallet, or other Plank.love product surfaces.

## Release and integration boundary

Development begins from the latest `origin/master` in an isolated branch.
The old `plankspace-integration` checkout is not a merge base because it is
heavily diverged. Before release, fetch `origin/master` again and merge or
rebase its new commits into the feature branch, resolve conflicts explicitly,
run the complete release checks, and only then use the repository's normal
`dev` to `master` release path. Never force-push `master`.

All new responsive selectors must be rooted at `.plankspace-native`,
`[data-plankspace-subnav]`, or `.classic-profile`. Shared `Nav` remains
the owner of Plank.love navigation and wallet state.

## Mobile information architecture

At widths up to 760 px, replace the always-visible horizontal PlankSpace link
rail with a compact disclosure labeled **Board menu**. It contains Lumberyard,
Browse boards, Search, Woodstock, Planks list, Board mail, Edit Profile, and My
Profile. The trigger and rows meet the 44 px touch-target rule. The disclosure
closes after navigation, on Escape, on outside activation, and when the desktop
breakpoint is restored. It returns focus to its trigger.

The public profile retains its recognizable parchment modules and user theme.
The first screen presents compact identity, owner actions, and jump links to
Feed, Videos, Top 8, and About. Social/feed content should appear before long
secondary biography data. On mobile only, URL, interests, and extended contact
actions use native disclosure sections. Their content remains in the document,
keyboard accessible, and customizable by the existing profile CSS boundary.
Desktop ordering and the user's saved module order remain unchanged.

Custom CSS continues to affect the public profile only. The responsive shell
must not use global selectors, must not rewrite user CSS, and must preserve
safe custom profile variables and modules.

## Featured videos

Parse, validate, deduplicate, and retain up to eight supported YouTube IDs from
the saved links. PlankSpace, not YouTube's hidden playlist UI, owns selection.
Render one privacy-enhanced iframe for the selected ID plus a visible list of
all valid videos. Each selector is a real button with its position and selected
state, works with touch and keyboard, and never autoplays merely because a
visitor changes profile sections.

Changing selection updates the iframe title and source. Invalid links are
ignored; no valid links produces the existing empty state. The initial selected
video remains the first saved item, preserving playback order.

## Production X OAuth

Continue using OAuth 2.0 Authorization Code with PKCE. Every profile owner
connects their own X account; no shared user access token is used. Required
scopes remain `tweet.read tweet.write users.read offline.access`. The exact
production callback is:

`https://plank.love/api/x/callback`

Server-only values are:

- `PLANKSPACE_X_PROVIDER=live`
- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `X_REDIRECT_URI=https://plank.love/api/x/callback`
- `PLANKSPACE_X_TOKEN_ENCRYPTION_KEY`

Add a manual GitHub Actions operation that installs these values into the
InMotion shared mode-600 `.env.production` file and restarts Passenger. Secret
values come only from GitHub Secrets; the provider and redirect URI may come
from repository variables with safe production defaults. The workflow must
never echo credentials, include them in build artifacts, or name them
`NEXT_PUBLIC_*`. It must back up the environment file, update values
atomically, validate required non-empty inputs and encryption-key format, run a
health check, and restore the backup if restart or health verification fails.

Previously disclosed X credentials are considered compromised and must be
rotated before installation.

The connection UI distinguishes:

- live and connected;
- live but not configured;
- reconnect required;
- X denial/callback failure;
- API credit or rate-limit failure.

Profiles and all non-X PlankSpace features continue working when X is
unconfigured or unavailable.

## Data and security

PostgreSQL remains the only production datastore. Existing append-only X tables
and encrypted credential envelopes remain in use; no schema migration is
expected for this slice. OAuth state remains single-use and time limited.
Access and refresh tokens are encrypted at rest and never returned by status
routes. Wallet-signed profile ownership remains required before connect,
disconnect, import, or cross-post actions.

No production secret is accepted through a browser form, committed file,
workflow output, or build-time public variable.

## Error handling

- The Board menu remains usable without JavaScript navigation enhancements.
- A malformed video URL cannot break the remaining playlist.
- A failed video embed leaves the selector available so another item can be
  selected.
- Missing OAuth configuration returns a clear operator-facing message without
  exposing which secret is absent.
- Callback failures redirect to Profile Editor with a safe status code and no
  token material in the URL.
- Deployment configuration failure leaves the previous production environment
  and release active.

## Verification

Add regression tests for:

- mobile PlankSpace disclosure semantics and complete destination list;
- CSS scoping that forbids unscoped mobile profile selectors;
- parsing, deduplication, selection, and rendering of multiple YouTube links;
- empty and malformed video inputs;
- production OAuth callback and server-only configuration contract;
- deployment workflow secret names, masking discipline, atomic update, and
  rollback behavior.

Manually verify PlankSpace at 320, 390, 430, 768, and desktop widths in public
profile, editor, and Lumberyard views. Verify menu keyboard behavior, a profile
with eight videos, custom profile CSS, disconnected wallet, connected wallet,
X unavailable, and live OAuth initiation.

Before release run:

- `npm run lint:inmotion`
- `npx tsc --noEmit`
- `npm test`
- `npm run build`
- tracked-file and commit-history secret scans

After reconciling the latest `master`, repeat the entire verification set.
