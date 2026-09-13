# Approved global game completion contract

## Authority and scope

The design in this document was approved on September 13, 2026. It is additive to USER-INTENT.md, WORLD-MASTER-SPEC.md, REQUIREMENT-COVERAGE-AUDIT.md and the complete product vision. It does not replace the previously requested combat, farming, economy, art, accessibility, community, and social features with a smaller product. Any reduction requires an explicit product decision rather than quietly removing a checklist item.

The project must not be called complete while these required experiences lack implementation and acceptance evidence. An alpha can be named and released honestly with unfinished features identified. Documentation is a durable requirement, not a guarantee of delivery or proof of implementation. “State of the art” is an aspiration assessed against named comparison systems and reproducible measurements, not a status conferred by the author or model.

Current joined-world work is bounded local integration. Four source screens are joined, and a six-companion local farming cycle has been exercised. This does not establish the complete world, durable joined-world economy, large-scale multiplayer, profile streaming, or the workshop described here.

## Common invariants

1. Every durable actor, creature, item instance, place and encounter has a stable identity independent of renderer, camera, worker or menu.
2. Every position specifies world, place/instance, floor and coordinates. Visual coordinates never substitute for authoritative positions.
3. Only one current authority can commit an actor or encounter transition. Retries cannot repeat capture, loot, harvest or transfer settlement.
4. Watching, visiting, joining a party, editing and collecting are different permissions.
5. Camera changes do not change simulation speed, activation, loot or combat outcomes.
6. A source asset, catalogue entry, script stub or passing unit test cannot be reported as a complete player experience.
7. Theme and artwork changes cannot change hitboxes, item custody, stat authority or economic rules without a separately approved gameplay change.
8. Every journey has a valid return path and a recovery policy for disconnection, denial and version change.

## Required experiences and acceptance

| ID | Required experience | Acceptance before completion |
|---|---|---|
| GLOBAL-01 | Globally connected geography | Public routes use coherent addresses and coordinates. Walk both directions through every published seam; terrain, actors, projectiles and activity locations remain aligned. Copies of a place are never misrepresented as the same encounter. |
| GLOBAL-02 | Real camera zoom | Wheel, pinch, keyboard and controller change visible world extent with stable HUD and canvas. Collision, action timing and authoritative outcomes are invariant under zoom. No CSS scaling substitution. |
| GLOBAL-03 | Permanent home address | Profile, world map and physical entrance resolve to the same property. Logout and worker replacement preserve its state. Home supply policy fulfills the promise of a home for each eligible account. |
| GLOBAL-04 | Floors and interiors | Doors, stairs, basements and upper floors connect authored safe landings. Identical X/Y on different floors do not collide, share proximity audio, reveal hidden actors or allow attacks through ceilings. |
| GLOBAL-05 | Twenty-friend social visit | Exercise owner plus twenty authenticated visitors, rights, invites, arrivals, departures and return travel. Record device/server limits. Indoor companion presentation preserves roster identity without blocking circulation. |
| GLOBAL-06 | Outdoor six-creature party | Distinct creatures navigate corners, doorways and terrain. Formation compression/re-expansion, facing, depth and command feedback are legible. Deployment restrictions are disclosed, not silent disappearance. |
| GLOBAL-07 | Safe travel transaction | Reserve destination, validate permissions and geometry, commit one ownership epoch, then accept destination input. Test retry, timeout, crash, disconnect, full destination and invitation expiry. Failed travel preserves source custody. |
| GLOBAL-08 | Progress-preserving cooperation | Joining never resets health, gear, roster, crops or quest progress. Shared credit uses recorded eligibility. A newcomer does not receive completed history merely by joining. |
| GLOBAL-09 | Story phase continuity | Personal dialogue can vary without conflicting shared geometry. Materially different story instances are explicit. Friends understand why they cannot see or join a story phase. |
| GLOBAL-10 | Unified action/staged encounter | One creature and encounter carry HP, status, cooldowns, eligibility and contributions across views. Switching modes gives no extra actions, duplicate target or reset. |
| GLOBAL-11 | Solo/party turn-based mode | All affected participants consent to the mode's timing. Disconnect, idle-player and timeout rules complete the encounter without deadlock or indefinite hostage turns. |
| GLOBAL-12 | Public hybrid combat | Real-time participants and command-window participants settle on the same encounter timeline. Public combat does not pause because one viewer enters a staged interface. Duplicate command and reconciliation tests preserve outcomes. |
| GLOBAL-13 | Capture and loot custody | Capture commits once; competing attempts receive explicit results and declared resource settlement. Party loot eligibility and non-party rules follow the approved economic contract. Replays and reconnects do not remint rewards. |
| GLOBAL-14 | Battle presentation | Background allies reflect permitted real participants and committed actions. Correct anchors, facing, depth, contact frames, interruption and status effects work in every supported view. Flat sprites are not advertised as complete arbitrary-angle 3D. |
| GLOBAL-15 | Actual profile footage | A second device receives actual gameplay video and selected game audio. Live/offline/reconnecting/restricted states are accurate. Profile navigation does not stop the publisher's gameplay. |
| GLOBAL-16 | Broadcast privacy | Public/private/allowlist admission and active revocation work. Watching grants no game control. Private UI and unselected voice are excluded. Recording has separate consent, retention and access rules. |
| GLOBAL-17 | Shared theatres | Profile and theatre subscribe to the same publication. Late joins, buffering, voice controls and angle switching remain coherent. Theatre controls never pause the actual game. Prevent accidental recursive self-capture. |
| GLOBAL-18 | Watch-to-play transition | Watch a friend, request/accept a party invitation, reserve capacity, arrive safely, complete an activity and return while retaining social context. Denials preserve watching and explain the available next action. |
| GLOBAL-19 | Population and scale | Publish separate measured limits for global connections, world population, local combatants, companions, entities and spectators. Load-test representative exploration, towns, farms and raids, including failure recovery. Millions of accounts is not millions of simultaneous combatants. |
| GLOBAL-20 | Global economy continuity | All worlds share declared issuance/custody rules. Inventory, satchel, Charmdex manifestations, reactions, market and production cannot create duplicate units through transfers or view changes. Purchases of Grain do not mint additional supply. |
| GLOBAL-21 | Collaborative workshop | Friends can propose maps, art, scripts and code through versioned branches, diffs, review and isolated playable previews. Contributions and dependencies retain provenance; released versions are identifiable and recoverable. |
| GLOBAL-22 | Agent contribution access | An external coding agent has scoped, revocable repository/preview capabilities. It receives no production secrets or implicit release/minting authority. Logs attribute proposals, approvals and deployed versions. |
| GLOBAL-23 | Safe extensibility | Art, content, sandboxed behavior and privileged server changes have separate capability boundaries. Enforce CPU/memory/entity/spawn limits. Test malicious and malformed content. No “hack impossible” guarantee. |
| GLOBAL-24 | Versioned live upgrades | Validate schema, assets, collision, economy changes and migrations before release. Existing homes, parties and encounters have version compatibility rules. Rollback does not duplicate rewards or blindly undo settled player trades. |
| GLOBAL-25 | Complete experience quality | Visual, audio and interaction acceptance covers PC, mobile, gamepad, accessible navigation, loading, errors, recovery, localization layout and reduced motion. A functional button is insufficient if its purpose, state or feedback is unclear. |

## Spatial and household design

The preferred initial topology is a shared neighborhood with persistent home entrances and permission-controlled private interiors or expandable grounds. It must remain possible to walk to a nearby friend's address. Invitations can provide transport to distant friends, but should identify whether they lead to the home or the friend's current activity. Islands are an optional geography, not a compulsory separation of every player.

An occupied household has roles for ownership, co-editing, tending, collecting and storage access. Public-facing exterior changes have separate rules. A social visitor can be admitted without harvest permission. Twenty friends and their potential 120 companions require a deliberate indoor presentation: rest areas or a compact representation, with clear return to outdoor formation. This cannot conceal a combat deployment restriction.

Unoccupied homes retain durable state without full per-frame simulation. Crop timestamps can resolve eligible growth; active combat cannot be fabricated from the same shortcut. Home activation must reconstruct the same logical state irrespective of how often the owner or spectators open a profile.

## Progression and encounter protocol

Invitations carry destination identity, expiry and permission scope. Destination reservation is not arrival. A transition has prepared, committed, acknowledged and recovered states, with a unique transition ID and ownership epoch. Resume follows the committed state. Source and destination cannot both settle the same input.

Story credit is tied to actual objectives and eligibility. Separate personal milestones, household work and shared encounter achievements. A staged encounter changes presentation and command timing, not creature identity. Solo/consenting party encounters may use discrete turns; public encounters use bounded command windows alongside action combat. Define timeout behavior, resource reservation, interruption, status tick ordering, simultaneous defeat/capture and loss of a participant before implementation.

A claimed capture removes the target from further capture settlement and resolves outstanding attempts predictably. Inventory capacity and party capacity are separate: a capture can route to permitted storage if the belt is full. The camera transition must never be used as an implicit ownership transfer.

## Workshop and external-agent architecture

The workshop is a friendly interface over a real version-control and build system, not a second incompatible repository format. Accounts can create proposals and invite collaborators. Each proposal identifies its base release, dependency versions, affected content and capability requests. Preview worlds have isolated test inventories and cannot export rewards into production.

Asset changes pass format, provenance, palette, animation-anchor, file-size and performance checks. Maps pass topology, collision, safe-arrival and return-path validation. Behavior extensions run with restricted APIs and quotas. Identity, market, issuance and authority code require privileged review and cannot be replaced by a creator package.

External agents authenticate through scoped service credentials whose authority is limited to the contribution workflow. No wallet seed, private key or production signing material is needed. A reviewed proposal can produce a signed release artifact, but a signature proves artifact origin, not safety. Live deployment still needs compatibility checks, bounded rollout, observability and recovery.

## Advanced experiments worth pursuing

These are proposed combinations, not established inventions or verified improvements. Each must outperform a named simpler baseline without weakening correctness.

| Experiment | Baseline and hypothesis | Promotion gate |
|---|---|---|
| Shared place manifest | Compare separate map/menu/social identifiers against a single versioned place identity with distinct permission scopes. Hypothesis: fewer broken joins and mismatched destinations. | Reduced integration failures; no permission widening; reproducible migrations. |
| Predictive border preparation | Compare loading after crossing with bounded prefetch based on movement intent and party destinations. | Lower p95 arrival stall without changing simulation/custody, excessive mobile bandwidth or exposing private areas. |
| Encounter authority groups | Compare fixed geographic partitioning with keeping highly interacting combatants under one encounter authority. | Lower cross-worker traffic and consistent outcomes under crowd concentration; bounded migration cost. |
| Tiered simulation scheduling | Compare every entity updated at full rate with deterministic scheduled crops, sleeping households and active combat scheduling. | Equivalent economic results and recovery; measured CPU reduction; no rewards from repeated activation. |
| Unified event references for media | Compare loosely coupled broadcasts with authorized encounter/time references shared across angles and join invitations. | Accurate view switching and admission; no hidden tactical data leaks; measured synchronization error. |
| Adaptive spectator delivery | Compare WebRTC baseline with a replaceable large-audience media path or MoQ experiment. | Better measured latency/cost/quality on supported devices; active revocation and fallback preserved. |
| Automated content proof reports | Compare manual-only authoring review with AI-assisted topology, frame, and economy checks plus deterministic validators. | Detect seeded defects with recorded false-positive/negative rates; no automatic privileged publication. |

“More advanced” is not an objective by itself. Keep the simpler design when a proposed improvement is harder to recover, less predictable or unmeasurably better. AI may accelerate generation and inspection; production authority remains explicit and auditable.

## Evidence and release decision

Each GLOBAL requirement needs an implementation reference, version/commit, test procedure, actual result, environment, limitations and review outcome. Allowed states are planned, implementing, blocked, verifying and accepted. None are accepted by creation of this document. Historical local tests can support a subset but cannot certify unrelated multiplayer, device or security behavior.

Completion requires every GLOBAL gate and every retained earlier product requirement to be accepted. Preserve explicit unresolved defects. Maintain a release checklist from these records rather than estimating completion from file counts, line counts, generated art volume or optimistic percentages. Performance evidence must include workload, hardware, geography, latency distribution, failures and operating cost; no fixed maximum is approved here without measurement.

## Dependency order

1. Stable coordinates, camera/presentation separation and source-faithful interaction.
2. Authenticated durable place admission, floors, homes and return travel.
3. Unified encounter identity, action timing and economic settlement.
4. Two-device footage, privacy and theatre continuity, developed alongside the bounded world integration.
5. Watch-to-join end-to-end acceptance with friends.
6. Capacity measurement and distributed handoff under real representative workloads.
7. Creator previews and validation, followed by constrained live releases and external-agent collaboration.
8. Complete retained feature breadth, visual/audio polish and supported-device acceptance.

Parallel work should follow these interfaces, not create competing identity, movement or inventory authorities. Consult GLOBAL-SOCIAL-WORLD-RESEARCH.md for sources, RENDERER-CUTOVER.md for the current camera constraints, and CURRENT-STATE.md for actual implementation evidence.
