# PlankSpace: profiles, game, publishing and charms

## Product decision

Preserve the familiar profile layout and personal-page character. Unify the infrastructure beneath it: one stable PlankSpace identity, one content model, one game inventory authority, and explicit connections to external publishing destinations. Profiles, the in-game Charmdex and mobile composer expose the same services. The first release path remains family homestead → growing → owned charm → friend's post → shared town. Expanding combat is not a prerequisite.

This is a proposed architecture informed by a September 13, 2026 source review. It does not certify live multi-platform publishing, passkey enrollment, arbitrary HTML isolation or completed game onboarding.

## What already exists

The inspected checkout has an X provider and OAuth callback under `integrations/plankspace-app/app/x` and `app/api/x`, encrypted credential helpers, a scoped profile CSS compiler, game account sessions, account inventory, and receipt-derived social reputation. These are useful starting points, not proof of deployment or a complete security audit.

The current X formatter adds a footer and truncates text. A new composer must show the exact per-destination rendering before approval. The provider sends an idempotency header; that alone is not evidence that the remote service deduplicates requests. Unknown delivery outcomes require reconciliation, not blind retries. Existing game authentication resolves a profile through a wallet association. Multi-wallet identity must be introduced without changing existing profile ownership or duplicating inventories.

No exact Xcaster project was identified in the searches or inspected local paths. Do not attribute a design, reverse engineering result or implementation to an unidentified product. A separately verified reference is [humanwhocodes/crosspost](https://github.com/humanwhocodes/crosspost), which demonstrates per-network adapters; it is not an account authority or substitute for platform permission.

## Identity and deliberate authority

Use an immutable internal account ID. Attach wallet credentials, passkeys and external provider identities through separate verified links. Display names and wallet addresses are not interchangeable primary keys. Linking another wallet must prove ownership and must not silently merge two existing people. Recovery, revocation and last-credential removal need explicit flows.

Wallet sign-in can establish a PlankSpace session. It cannot authorize Instagram or X. Each destination requires its own grant, scopes and revocation state. A passkey can approve a specific publishing intent within PlankSpace; its local verification may use a fingerprint, face or device PIN. The site does not receive fingerprint data. [W3C WebAuthn](https://www.w3.org/TR/webauthn-3/).

Bind approval to the account, exact content revision, selected destination accounts and a short-lived server challenge. Editing the content or destination invalidates that approval. Verify the origin, relying-party ID and user-verification result. Use an established WebAuthn implementation rather than custom cryptography. Store external tokens server-side with encryption and restricted access; never pass them into profile HTML, the game frame, exports or analytics. A wallet-only account remains usable without an external social connection.

## Compatible publishing, not universal access

| Destination | Verified reference | Integration boundary |
|---|---|---|
| X | [Create posts](https://docs.x.com/x-api/posts/manage-tweets/quickstart), [OAuth](https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token) | Approved app and user authorization; inspect current scopes and content limits per adapter. |
| Bluesky | [OAuth guide](https://bsky.network/docs/oauth-client/), [post records](https://docs.bsky.app/blog/create-post) | Provider account authorization and correctly formed records/media; prefer maintained SDK. |
| Instagram | [Meta's API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) | Professional-account publishing support; exact login path, review and media requirements must be verified before enabling. |
| TikTok | [Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-get-started), [sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines) | Scope approval and audit requirements; unaudited clients have private-viewing restrictions. |
| Facebook | [Pages API reference](https://developers.facebook.com/docs/pages-api/posts/) | Reference could not be retrieved in this review (rate limited). Do not promise arbitrary personal-profile publishing. Validate supported Page workflow before enabling. |

Other services remain candidates until their official integration contracts are checked. Do not equate outbound publishing support with access to every feed, direct message or analytics metric. A single interface can organize supported capabilities while clearly identifying unavailable ones.

Model a canonical post with typed blocks: text, image, video, audio, link, game capture and local charm attachments. Each adapter returns a preview plus incompatibility reasons. Do not silently discard audio, crop imagery, truncate prose or flatten a charm into a new economic unit. Keep destination selections opt-in. A local charm can render as artwork in a compatible outbound image, but ownership and counts remain in PlankSpace.

Persist an outbox with one delivery per destination and content revision: pending, sending, confirmed, rejected or outcome unknown. Persist remote IDs and retry history. On ambiguous timeout, reconcile or ask for review before another send. One failed destination must not hide successful deliveries. Deletion and edits require their own supported per-provider operations; deleting locally cannot guarantee removal of external copies.

## Personal HTML without surrendering account security

Keep the navigation, authentication controls, purchases and sending confirmations in trusted application chrome. Offer visual editing and a source editor for the personal canvas, with version history, preview and reset. Preserve familiar profile regions while letting their contents and theme evolve.

Render authored HTML on an isolated origin in a sandboxed frame, with a restrictive content policy and an allowlisted widget bridge. The current CSS scoping mechanism is not sufficient isolation for arbitrary scripts. Do not combine same-origin privileges and executable untrusted content. Restrict popups, navigation, forms and network capabilities according to the authored-content tier. See the browser's [iframe sandbox behavior](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).

Use trusted widgets for the Satchel, post basket, game feed and visitor controls. The page may place and theme them, but cannot forge balances, move confirmation buttons over unrelated links, or issue economic commands. On narrow screens the personal canvas can reflow while essential account controls remain accessible.

## Charm identity, data and intelligence

Use separate records for item definition, art revision, owned quantity or unique instance, production recipe, ledger entry, post stamp and discovery. An emoji code point is an optional search alias, not an item primary key. Species, quality, provenance and recipes can distinguish many items with the same symbol. Plants, foods, animals and equipment take priority over face glyphs.

Harvest, feeding, crafting, trade escrow and social spending must share conservation rules. A post stamp consumes the declared quantity into a durable non-spendable manifestation. Reputation derives from accepted receipts. Crossposting does not mint another charm; a decorative sticker does not imply custody. Keep unsupported catalogue references out of the owned basket.

Maintain a transactional ledger and an outbox for analytics projections. Track production, sinks, circulation, unique contributors, item-specific counts and source recipes. Distinguish current counts, historical totals, moderated content and missing data. Do not turn scraped external likes into PlankSpace balances or pretend incompatible platform metrics are equivalent. Intelligence views must respect visibility and avoid exposing private inventories or relationships.

Durability means backups, point-in-time recovery, restore drills, checksums, versioned definitions and rebuildable projections. It cannot mean guaranteed eternal retention. Separate minimal economic audit records from removable personal content; define retention and deletion behavior explicitly.

## Build order and acceptance

1. Complete an account-bound homestead opening and one honest crop loop. Keep current Oran identity until Burning Heart is implemented separately.
2. Wire one supported harvested item to a friend's authorized post, including concurrent-spend and retry verification. The test must show the same balance before and after in game and profile.
3. Add an art manifest and item-first basket with reviewed sources, anchors, reduced-motion variants and clear quantities. See FIRST-SOCIAL-CHARM-BASKET.md and SOCIAL-ITEM-ART-SOURCES.md.
4. Introduce stable credential links and passkey flows through compatible migrations. Validate recovery and revoked sessions before enabling connected publishing.
5. Replace hidden X transformations with reviewed previews and durable delivery tracking, then add adapters individually.
6. Ship isolated profile authoring and trusted widgets with mobile, keyboard and malicious-content checks.
7. Expand shared-town visits and permissioned live streams while preserving the same account, item and content contracts.

Each gate needs a demonstrated user flow. Documentation and API scaffolding are not completed gameplay, a deployed integration, or verified global scale.
