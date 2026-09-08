# Additive schema draft

Design only. Do not install as a numbered migration until full existing-schema and migration-neighbor
review is complete. Use existing integer plankspace_profiles.id and plankspace_posts.id foreign keys.
New temporal columns use timestamptz even where old integrated tables use ISO text; compatibility reads
must handle both explicitly. Counts are bigint with nonnegative checks; serialize as decimal strings.

| Proposed table | Keys and columns | Database invariants |
|---|---|---|
| plankspace_wallet_links | id UUID; profile_id FK; namespace; canonical_address; provider_label; role; visibility; verified_at; revoked_at | Unique active namespace/address; at most one active primary/profile; visibility public or hidden |
| plankspace_wallet_chain_proofs | link_id FK; chain_reference; caip10; verification_kind; signature; challenge_id; verified_at | Unique link/chain; proof required for each contract-account chain |
| plankspace_identity_challenges | nonce UUID; profile_id; action; candidate; primary_generation; payload_digest; expires_at; consumed_at | Consume once in the same transaction as authorized mutation |
| plankspace_profile_sessions | token_hash; profile_id; primary_link_id; generation; scopes; expires_at; revoked_at | No raw token at rest; exact primary generation validation |
| plankspace_charmville_lots | profile_id PK/FK; width; height; revision; starter_claimed_at; rules_version | One lot per profile; dimensions positive and bounded |
| plankspace_yard_objects | id UUID; profile_id FK; kind; x; y; rotation; footprint; cosmetic_config | Ground geometry validated under lot row lock |
| plankspace_yard_cells | profile_id; x; y; object_id FK; permanently_tilled | PK profile/x/y prevents overlapping footprints; initial six remain open |
| plankspace_glyph_registry | glyph_id PK; display_name; art_manifest; grow_seconds; enabled; recipe_version | Seven stable ids; only Stalk/Splinter enabled initially |
| plankspace_planted_crops | crop_id UUID; profile_id FK; plot_object_id; glyph_id; planted_at; ready_at; expires_at; resolved_at; resolution | Unique unresolved crop/plot; ordered timestamps; resolution harvest or compost |
| plankspace_satchel_balances | profile_id; item_id; available; escrowed; wrapped_locked; revision | PK profile/item; all quantities nonnegative; seed ids distinct from face ids |
| plankspace_grain_balances | profile_id PK; quantity; revision | Nonnegative; never aggregated with posts or satchel face counts |
| plankspace_charmville_receipts | id UUID; profile_id; actor_link_id; kind; idempotency_key; payload_digest; deltas; rules_version; created_at; previous_digest; receipt_digest | Unique profile/idempotency_key; retry with different payload rejects |
| plankspace_charmville_tends | actor_profile_id; target_profile_id; day_utc; crop_id; receipt_id | Unique actor/target/day; reject self; daily reward cap updated transactionally |
| plankspace_face_uses | id UUID; profile_id; target_post_id FK nullable; glyph_id; quantity; use_kind; receipt_id | Positive quantity; each use linked to atomic debit |
| plankspace_rings_events | recipient_profile_id; giver_profile_id; post_id; period; receipt_id | Distinct giver accounting; no spendable balance; self excluded |
| plankspace_land_value_snapshots | profile_id; season; measured_at; value; inputs; rules_version | Value between floor and 1; distinguish actual metrics from tuning priors |
| plankspace_ge_offers | id UUID; profile_id; glyph_id; side; price_grain; quantity; remaining; status; authorization_digest; created_at | Positive price/qty; remaining between 0 and qty; no public endpoints initially |
| plankspace_ge_fills | id UUID; buy_offer_id; sell_offer_id; quantity; price; receipt_id | Immutable fill; locks acquired in deterministic order; no self-demand credit |
| plankspace_ge_collections | profile_id; offer_id; item_id; uncollected | Nonnegative; collection moves existing escrow, never issues goods |
| plankspace_glyph_rituals | id UUID; profile_id; proposed_glyph_id; recipe; curve_parameters; stake_receipt_id; status; cooldown_until | Registry activation transaction; disabled initially |
| plankspace_inventory_roots | epoch; chain_id; root; receipt_highwater; status; published_tx | Snapshot reproducible; publication is not proof of wrap eligibility alone |
| plankspace_wrap_reservations | id UUID; profile_id; glyph_id; quantity; epoch; nullifier; venue_status; tx_hash | Unique nullifier; lock before mint; release only after finalized burn proof |
| plankspace_devices | id UUID; profile_id; signing_public_key; encryption_public_key; enrollment_receipt; revoked_at | Only enrolled devices can sync/dequeue; no platform cookies |
| plankspace_device_key_envelopes | profile_id; device_id; key_epoch; encrypted_key | Scoped encrypted key distribution; old epochs retained as recovery policy allows |
| plankspace_pine_drafts | id UUID; profile_id; head_revision; tombstone_at | Profile-scoped reads; mutable head with compare-and-swap |
| plankspace_pine_draft_revisions | draft_id; revision UUID; parent_revisions; writer_device; encrypted_blob; digest; server_sequence; created_at | Append-only; unique operation id; conflict branches preserved |
| plankspace_pine_media_chunks | upload_id; chunk_index; profile_id; ciphertext_ref; digest; size; committed_at | Unique upload/chunk; digest validated before durable acknowledgement |
| plankspace_pine_intents | id UUID; profile_id; primary_link_id; primary_generation; nonce; payload_digest; signature; encrypted_envelope; accepted_receipt; expires_at | Unique nonce; immutable signed payload; atomic stamp acceptance |
| plankspace_pine_deliveries | intent_id; destination_id; opaque_account_ref; status; lease_device; lease_generation; lease_until; submitting_at | Unique intent/destination; monotonic fence; uncertain submit never auto-released for resend |
| plankspace_pine_delivery_events | event_id UUID; intent_id; destination_id; generation; device_id; signed_evidence; status; received_at | Append-only evidence; reject stale device/fence transitions |

## Transaction contracts

Claim locks existing profile then inserts lot and grant receipt atomically. Starter seed totals include
both pre-planted crops. A retry returns the original grant; adding a linked wallet never issues a kit.

Plant locks lot, balances and plot in deterministic order, checks actual tilled cell, recipe/version,
seed and grain, consumes inputs and records ready/expiry times plus receipt in one commit.
Resolve locks crop and inventory, derives state from database time, writes exactly one resolution,
returns exactly one seed, credits only allowed output and receipt. Concurrent harvest and compost
cannot both succeed. Balance arithmetic is conditional SQL, never read/modify/write in JS alone.

Stamp locks source balance and target post, verifies target visibility and self/distinct rules,
debits face, writes use and optional standing event atomically. Posting a new Grain and its stamp
must not leave a charged stamp attached to a nonexistent post if publication fails.

Accepted external intent locks nonce and inventory. Unique client intent_id binds one immutable
payload digest. Insert intent, per-dock deliveries, exactly one stamp debit/receipt for the whole
intent, and encrypted transport envelope atomically. Caster only runs accepted intents. Draft saves
have no inventory path. A delivery retry references the original accepted debit.

Continuity cannot upload balances, primary roles, crop state, or offline plant/harvest/stamp actions.
Layout revisions are uncommitted decorative proposals, separate from yard_objects and yard_cells.
Applying a layout requires a live primary session, current lot revision, and serialized collision checks.
Cookies, WalletConnect session material, and OAuth refresh tokens are prohibited in sync payloads.

Primary rotation locks profile and both links, validates both proofs, changes roles and generation,
revokes old sessions/device execution authority as policy defines, updates compatibility wallet, and
writes receipt. All legacy profile-wallet joins must be audited before rotation is exposed.

The migration that adds wallet links must backfill existing profiles.wallet as the primary without
changing handles, posts, inventory ownership or connected provider. Preserve previous-release schema;
do not drop profiles.wallet or mutate migration 090–099. Allocate the next migration number only after
checking latest origin/dev at implementation time.

Append-only application receipts are not cryptographically independent of the server until rooted and
published. Distinguish session-authenticated receipts, wallet-signed actions, device-signed observations,
and chain-finalized records in schema and UI. Do not label all four as on-chain proofs.
