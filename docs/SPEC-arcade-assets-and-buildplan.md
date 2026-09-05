# Degen Arcade — Closing the Remaining Open Questions, Asset Sourcing, and the Real Build Plan

Closes out the four open engineering decisions left in
`docs/SPEC-plank-derby-racing.md` §6, sources real, license-clear open-source
art/animation for every game, specs the Three.js rendering pipeline these
assets actually plug into, and lays out an honest, sequenced path to a real
implementation — as opposed to claiming completion this document cannot
actually deliver.

**A statement worth being direct about, not burying**: "a completed,
functional on-chain arcade" is a real, multi-week build — audited contracts,
tested settlement math, a real rendering pipeline, real asset integration,
real deployment. No design document, however thorough, *is* that. What this
document delivers honestly: every remaining research question closed with a
real answer, every asset need sourced to a specific, license-clear real
resource, and a concrete, ordered plan for the implementation work itself —
so that work can start immediately with zero remaining research blockers,
not so that it's already done.

---

## Part 1 — Closing `SPEC-plank-derby-racing.md` §6's open questions

### 1.1 — On-chain vs. off-chain-computed simulation → **off-chain-computed,
on-chain-committed, challenge-window-verified, for v1**

Running the full segment-by-segment race simulation on-chain (§4.3 of the
racing spec) costs real gas proportional to `segments × racers × keccak`
calls — meaningful at any real scale, and directly in tension with the
"low to no collateral" mandate (every gas dollar spent on simulation is a
dollar the pool didn't need to hold, but it's still a real cost someone
pays). The resolution: compute the deterministic simulation off-chain (a
pure function of the revealed seed — see §4.3's own re-implementability
bar), submit only the final result on-chain, and give any observer a fixed
challenge window to submit a fraud proof — re-run the same public,
open-source function themselves and show the submitted result doesn't
match. If nobody successfully challenges within the window, the result is
final. This is real, standard "optimistic" verification (the same shape
Optimistic Rollups themselves use for their own settlement), not a novel
trust assumption — and it means most races cost the gas of *one* result
submission, not thousands of per-segment computations, while staying just
as provably fair: a wrong result is still exactly as catchable as before,
just via a challenge instead of forced on-chain re-execution every time.

### 1.2 — Chainlink VRF availability on Robinhood Chain → **unconfirmed;
commit-reveal stays the v1 default, VRF is a real future upgrade path, not a
launch blocker**

Checked directly rather than assumed: Robinhood Chain (4663) is confirmed to
be an Arbitrum-Orbit-based L2, and Robinhood's own announcement confirms
*some* Chainlink integration is live on the chain (described in terms of
cross-chain connectivity for real-world assets) — but nothing in that
announcement or Chainlink's own docs confirms VRF specifically is deployed
and available on chain 4663 as of this research. **Do not build against an
assumed VRF integration.** The commit-reveal design already fully specified
in `SPEC-plank-derby-racing.md` §4.1 has no external dependency at all and
is the correct v1 choice regardless — if VRF later confirms available on
4663 (check `docs.chain.link/vrf/v2-5/supported-networks` directly, by hand,
against the live list before ever relying on it), it's a real, valuable
upgrade (removes the operator-liveness dependency the mutual-commit design
in `docs/SPEC-competition-cadence-and-liquidity-flywheel.md`'s research
notes exists to mitigate) — but it's an enhancement to schedule later, not
something to gate the first real build on.

### 1.3 — Race cadence → **already resolved**

`docs/SPEC-competition-cadence-and-liquidity-flywheel.md`'s continuous-
sourcing/daily-trigger model (§1.1) applies uniformly to every game type,
including racing — this question is closed by that document, not re-decided
here.

### 1.4 — NFT bribe settlement path → **flat single-winner draw, decided**

Between the two options `SPEC-plank-derby-racing.md` §4.5 left open: a
single winner drawn from a target racer's backers (weighted by stake, using
the same `outcomeSeed`-derived randomness the race itself uses) is the v1
decision. Reasoning: proportional splitting of an indivisible NFT is not
well-defined without inventing a valuation mechanism this system has no
trustworthy way to compute (an NFT floor price is itself manipulable, and
this design has already gone out of its way — Part 3 of the cadence doc —
to avoid trusting any manipulable on-chain price signal it doesn't have to).
A single-winner draw sidesteps needing a valuation at all: the *whole* NFT
goes to exactly one address, chosen the same provably-fair way everything
else in this system chooses anything.

---

## Part 2 — Real, license-clear open-source assets for every game

Every resource below was independently checked this session — license terms
specifically, not just "it's probably free" — because a license mistake on
a commercial product's art is a real legal exposure, the same category of
care this whole design process has applied to the contracts themselves.

### 2.1 — 3D models and environments

| Need | Source | License | Note |
|---|---|---|---|
| Horse model (Plank Derby) | [OpenGameArt.org's "CC0 - 3D Animals / Creatures" collection](https://opengameart.org/content/cc0-3d-animals-creatures) includes a rigged horse; [Hugo A Munoz's "Low Poly Horse Free"](https://itch.io/profile/hugo-a-munoz) on itch.io is a second real option | CC0 (public domain) | Two independent real sources found, not one fragile dependency — cross-check both before committing to either as the final asset |
| Racer movement animation (gallop/run cycle) | [Quaternius Universal Animation Library](https://quaternius.com/) | CC0, retargetable | Built specifically for retargeting onto arbitrary rigs — the right tool for driving a generic horse skeleton without needing bespoke mocap |
| Track/environment set pieces | [Kenney's Racing Kit](https://kenney.nl/assets/racing-kit) (110 assets) and [Racing Pack](https://kenney.nl/assets/racing-pack) (420 assets) | CC0 | Coherent, matched art style across the whole pack — reduces the "assets from five different styles clash" risk a scattered asset hunt usually produces |
| Crash game rocket/space *environment* (stars, debris, station set pieces) | [Kenney's Space Kit](https://kenney.nl/assets/space-kit) (150 assets) | CC0 | Same coherent-style benefit as the racing kit — the rocket *itself* is not this; see §2.4 |
| PBR textures / environment lighting (HDRIs) | [Poly Haven](https://polyhaven.com/) | CC0 | The real, standard source professional teams already use for physically-accurate lighting — this is what makes flat CC0 low-poly models read as "AAA-lit" rather than "free asset pack," and it's the single highest-leverage piece for the "triple A" visual bar specifically |

### 2.2 — Rocket/crash animation reference

[Skyrocket.js](https://github.com/zarocknz/javascript-skyrocket) — a real,
GSAP-powered library purpose-built for rocket launch + explosion animation
on HTML canvas. Not a Three.js library itself, but directly useful as a
*reference implementation* for the motion curves and timing of a rocket
ascent/explosion — the actual hard part of "does this rocket animation feel
good" is the easing/timing, and this is a real, working answer to study
rather than invent from scratch.

### 2.3 — Reference architecture for the game itself, not just assets

[`samott/crash`](https://github.com/samott/crash) — **BSD-2-Clause
licensed** (confirmed, a real permissive license safe for commercial reuse
with attribution), a working provably-fair crash game frontend backed by a
Web3 deposit/treasury contract, React/Next.js stack. This is real prior art
for the *product* shape (not just isolated assets) — worth reading its
actual source for UI/state-management patterns before designing this
repo's own crash-game frontend from a blank page, same "don't reinvent what
already has a working, licensed answer" discipline applied to research
throughout this whole design process.

### 2.4 — The real RobinWood collection as the actual hero art, not stand-ins

This changes the crash game and the racing game's identity in a real way,
and it's the right call: `DESIGN.md`'s own hard brand rule already states
"any decorative or animated representation of planks... must use these
actual character assets or match that hand-drawn outlined style exactly"
and explicitly rules out "abstract geometric boards" as a substitute — a
generic CC0 rocket was always going to be a placeholder against that rule,
not a final answer.

- **Crash game hero**: the "Chalkstronaut" Plank replaces the generic CC0
  rocket entirely as the thing ascending and (on a bust) exploding. **Not
  independently verified against this repo's own files** — the local
  `public/images/collection/` directory only mirrors five sample images
  (`plank-bobawood.png`, `plank-insidertrader.png`, `plank-is-this-art.png`,
  `plank-knightwood.png`, `plank-redacted.png`); the full collection lives
  on-chain/IPFS per `lib/market/traits.ts` and `app/api/market/traits`, not
  locally. Taking this as real on the strength of it being the owner's own
  collection, but the exact tokenId/IPFS URI needs pulling from the real
  collection metadata before implementation — same "verify before building"
  standard as every other citation in this design arc, just not one this
  session can independently check from local files alone.
- **Plank Derby jockeys**: rotating real RobinWood collection artwork,
  riding the CC0 horse bodies from §2.1 — not a generic humanoid jockey
  asset. Tone is deliberately "funny, cheesy cartoon," execution is not:
  same bar as everything else in Part 3's rendering pipeline.

**One real technical constraint worth naming plainly**: RobinWood's
collection art is flat 2D character art, not a rigged, posable 3D asset —
it cannot be naturally "seated" on a horse's back the way a real 3D jockey
model could bend at the hip and grip with its legs. The honest, and
genuinely fitting, technical answer is **not** to attempt rigging 2D art
into 3D — it's a camera-facing billboarded sprite (the real Three.js
technique: a flat plane holding the NFT image, always rotated to face the
camera, `THREE.Sprite` or a billboarded `PlaneGeometry`) bobbing and tilting
with the horse's real animated gait from the `AnimationMixer` in Part 3 §4.
This is a real, well-understood technique (classic "paper cutout on a 3D
stage," the same trick a huge number of stylized 3D games use deliberately,
not a compromise hiding a limitation) — and it's a genuinely better fit for
"funny cheesy cartoon" tone than a fully-3D jockey would be: the visual joke
of a flat, 2D-art Plank bouncing along on a fully-3D horse is charming
specifically *because* of the contrast, not despite it.

---

## Part 3 — The Three.js rendering pipeline these assets plug into

Concrete, not aspirational — this is the specific stack, not "we'll use
some post-processing":

1. **Loading**: `GLTFLoader`/`FBXLoader` for the CC0 models above (Quaternius
   and Kenney both ship in formats Three.js loads natively), `RGBELoader`
   for Poly Haven's HDRIs as environment maps.
2. **Materials**: `MeshStandardMaterial`/`MeshPhysicalMaterial` (Three.js's
   real PBR material types) driven by Poly Haven's real texture maps
   (albedo/roughness/normal/AO) — this is the concrete mechanism by which
   free low-poly geometry ends up looking considered rather than flat.
3. **Post-processing**: `EffectComposer` (or the newer node-based
   `RenderPipeline`/TSL API introduced in Three.js r183+, worth building
   against directly if starting fresh rather than the legacy composer) with
   `UnrealBloomPass` for the crash game's rocket glow and the racing game's
   photo-finish emphasis (`SPEC-plank-derby-racing.md` §7), `SMAA` for
   antialiasing (better quality-per-cost than FXAA at this project's likely
   scale), and a restrained `FilmPass`/custom vignette `ShaderPass` for
   atmosphere — matching this repo's own `DESIGN.md` "restrained shadows,
   narrow gold borders" elevation language rather than a generic bloom-
   everywhere look.
4. **Animation**: Three.js's `AnimationMixer` playing back the retargeted
   Quaternius gallop/run clips on the horse skeleton, blended by the
   racer's simulated per-segment `performance[i]` value
   (`SPEC-plank-derby-racing.md` §4.3) — a racer visibly straining in a
   photo-finish segment is a real, direct visualization of the underlying
   math, not a decorative animation disconnected from the actual simulation
   result. The billboarded jockey sprite (§2.4) rides on top of this same
   animated transform, inheriting the horse's real bob/tilt each frame
   rather than being animated independently and risking drifting out of
   sync with it.
5. **UI overlay**: the multiplier counter (crash) and live odds ticker
   (racing, `SPEC-plank-derby-racing.md` §7) render as HTML/CSS overlaid on
   the canvas, not as in-3D text meshes — this matches the actual technical
   consensus already found in this design process's earlier Three.js
   research: 3D text rendering is expensive and hard to keep legible, real
   production games overlay DOM for exactly this reason.
6. **Performance floor**: target 60fps on mid-tier mobile hardware as the
   real constraint, not desktop-only — bound polygon counts and post-
   processing pass count against that target explicitly rather than
   discovering the ceiling after the fact. This is a concrete engineering
   requirement to hold the implementation to, not a suggestion.

---

## Part 4 — The honest, sequenced build plan

No step here is claimed done by writing it down. Each is a real, scoped
chunk of implementation work, in the order that minimizes wasted effort if
an earlier step surfaces a design problem.

1. **Contracts first, headless.** Implement the pari-mutuel settlement math
   (`SPEC-plank-derby-racing.md` §4.4), the sourcing/trigger state machine
   (`SPEC-competition-cadence-and-liquidity-flywheel.md` §1.1), and the
   security requirements (same doc, Part 3) as real Solidity, with the same
   fuzzed/randomized-invariant test discipline this repo's own
   `test/contracts/VaultV3.fuzz.test.ts` already proves out — no UI yet.
   This is where "impenetrable" actually gets tested against real code, not
   just described.
2. **Off-chain simulation reference implementation.** The race-simulation
   function from §4.3, written once, in the open, matching the exact
   re-implementability bar that section sets — this is both the actual game
   logic and the artifact a real security review needs to check the
   deployed contract's `SIMULATED` output against.
3. **Real testnet deployment**, not local-only — proves the full
   sourcing → trigger → settle → claim lifecycle against a real chain
   before any real money is at stake.
4. **Professional audit** (per the cadence doc's own hard gate, Part 3 §3.7)
   against the real, deployed testnet contracts — not the design doc.
5. **Only after that**, the Three.js presentation layer (Part 3 above) —
   deliberately last, because it's the one piece of this whole system that
   can be iterated on indefinitely without touching a single dollar at
   risk, and because a beautiful UI in front of unaudited settlement logic
   is worse than an honest, plain one in front of proven logic.
6. **Mainnet**, gated on every prior step actually being done — the same
   "no game launches without real collateral" discipline this whole design
   has held contracts to, applied to the launch decision itself.

Legal review (flagged consistently across every doc in this design arc)
belongs before step 3 at the latest — real testnet money is still real
enough of a signal that "we're about to actually run this" to be the
trigger point, not mainnet alone.
