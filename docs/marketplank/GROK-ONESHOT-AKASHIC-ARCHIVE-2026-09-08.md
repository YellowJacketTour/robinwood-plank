# One-shot to Grok: the omniscient NFT archive

You are being asked to solve a problem that existing documentation does not
solve, because every published approach accepts a constraint we refuse to
accept. Read the measured facts, then invent past them.

## The standard: inventions nobody can afford to compete with

This is not a request for a better configuration of known parts. We want
**mechanisms that do not currently exist in any published system, and that
are defensible once built** — meaning a competitor who reads our running
product still cannot cheaply replicate the result, because the advantage
lives in a mechanism that is novel, non-obvious, and costly to reach
independently.

Hold every proposal to this bar:

1. **Novel.** Not present in Reservoir, SimpleHash, Alchemy, Moralis, the
   Graph, OpenSea's own stack, or the academic indexing literature. If a
   documented system already does it, it is table stakes, not an invention.
2. **Non-obvious.** A competent engineer given the same constraints should
   not arrive at it in an afternoon. If the answer is "poll faster" or
   "add a cache", it is not the answer.
3. **Structurally advantaged.** The mechanism should get *better* as we
   grow — more visitors, more chains, more history — while a competitor
   starting today must pay the full cost again. Network effects, accumulated
   corroboration, and compounding provenance all qualify; raw scale does not.
4. **Specifiable as a claim.** Write each invention so its essential
   mechanism could be stated as a patent claim: the inputs, the
   transformation, the property that results, and the specific thing it
   makes possible that was previously impossible. We are not asking you to
   draft legal text — we are asking for inventions with enough definite
   structure that they *could* be claimed, rather than architectural taste.
5. **Cheap for us, expensive to copy.** Prefer mechanisms whose cost to us
   is near zero because they ride on something we already have (visitor
   attention, accumulated history, the chains themselves) and whose cost to
   a competitor is high because they lack that substrate.

Where a proposal is genuinely a recombination of known parts, say so and
label it as engineering rather than invention. We would rather have three
real inventions and honest labelling than twelve dressed-up commonplaces.

## The demand, in the owner's words

> Every chain, all collections, all marketplace listings, all offers, all
> metadata, all traits, all rarities, all activity, all provenance. Near
> instantaneous, total, akashic-record-level archive omnipotence. All
> visitors act as one persistent fingerprint or attention gaze, fleshing out
> the entire catalog with just-in-time provisions wherever archived data
> does not already exist.

Not a faster crawler. An archive that **knows everything that exists the
moment it exists**, and whose completion is driven by where human attention
falls.

## What is already true (measured 2026-09-08, do not re-derive)

- 251,000+ collections across 11 chains, growing.
- The attention beam **works**: visible rows publish demand signals; the
  mesh prioritises what is on screen. Verified in a live browser.
- Native trading is proven with real money. Foreign trading is built and
  deliberately gated behind a canary kill switch pending an audit.
- Solana went 184 → ~9,800 in a day once its catalog walk was scheduled.

## The three ceilings, measured, that block the demand

**1. Source ceiling.** A chain grows only as fast as the best catalog anyone
publishes. Bitcoin: OrdinalsWallet's `total` claims 425,201, but real
non-BRC-20 collections number ~1,837 (499/490/483/363 per 500 at offsets
0/500/1000/1500, then 2 at offset 2000). We already hold 19,601. Every
alternative is closed: Ordiscan `402 Payment Required`, Magic Eden `503`,
UniSat `404` without a key.

**2. Vendor-dependency ceiling.** EVM discovery ran through one keyed vendor
(HyperSync). Measured: 5 of 8 chains in backoff, Optimism dark 9 hours,
Polygon 8 hours, errors `timeout exceeded when trying to connect`.

**3. Compute ceiling.** 154 standing lanes, ~26 of which discover, on one
shared host.

## Why published approaches do not reach the demand

Every documented NFT-indexing architecture — Reservoir, SimpleHash,
Alchemy, Moralis, the Graph — is a **pull** system: poll a source, diff,
store. That design has an irreducible property: *you learn about a thing
after you ask about it*. "Near instantaneous total omniscience" is
unreachable by polling, because polling's latency floor is the poll
interval times the number of things to ask about.

Worse, every one of them is *somebody's curated list*. Reservoir and
SimpleHash both shut down their public APIs in 2025. Building on curated
lists means inheriting both their gaps and their mortality.

## The four inventions we want you to attack

### I. Existence without enumeration

**Problem.** "All collections" is undefined per chain. EVM has no registry.
Bitcoin Ordinals collection membership is a *social convention* — a
published list of inscription IDs — with no on-chain registry at all.

**Insight to exploit.** A collection cannot trade without announcing itself
on-chain. An EVM collection emits Transfer logs from a contract; an Ordinals
collection's members are inscriptions with sequential numbers; a Solana
collection has a group key. **Existence is always observable even when
enumeration is not.**

**Invent:** a derivation that turns raw chain events into collection
identity with no vendor list, including the hard case — deciding that a set
of inscriptions constitutes one collection without anyone publishing that
list. Consider: shared reveal-transaction provenance, common funding source,
metadata-schema fingerprinting, mint-timing clustering.

### II. Push instead of pull

**Problem.** Polling's latency floor.

**Insight.** Chains already push: EVM `newHeads` and log subscriptions over
WebSocket, Solana `programSubscribe`, Bitcoin ZMQ. We already run one push
consumer (the OpenSea Stream, ~3,600 events/sec sustained).

**Invent:** an architecture where the archive is *told* rather than *asks* —
including how a push-first system stays correct across reconnects, reorgs,
and gaps, and how it degrades to pull only for repair. What is the minimum
pull surface that still guarantees completeness?

### III. Attention as a distributed compute market

**Problem.** One host, 154 lanes. Meanwhile every visitor has an idle CPU, a
distinct IP, and their own rate-limit budget against public gateways.

**Insight.** The attention beam already knows *what* matters. It does not
yet use the visitor's *own machine* to fetch it. A visitor's browser
fetching a tokenURI from their own IP is traffic that rate limits are
designed to permit, and that same fetch from our server is what they are
designed to throttle.

**Invent:** a scheme where visitors compute the archive they are browsing,
such that results are trustworthy without trusting any visitor. We sketched
"two independent reports of the same body hash, or a 1-in-20 server
spot-check". Attack that: what does an adversary with many browsers do to
it, and what is the actually-sound construction? Consider commit-reveal,
verifiable delay, redundancy tuned to observed disagreement rate.

### IV. Provable truth for a stranger

**Problem.** A marketplace replacement must be verifiable by someone who
does not trust it. We have a parity oracle comparing our numbers to
independent references, but references die — Hiro's Ordinals API returned
`410 Gone` mid-session, and the denominator had to be re-derived from ord's
recursive endpoints.

**Invent:** a truth layer that survives the death of every external
reference. What is the minimum on-chain-only evidence set that lets a
stranger verify a floor price, a holder count, or a trait distribution
without trusting us *or* any surviving third party?

## Constraints that are real (do not propose around them)

- **No paid vendor on the critical path.** Accelerators are fine; hard
  dependencies are not. Every vendor we relied on has died, throttled, or
  paywalled during this project.
- **One shared host** (a second worker tier is available if justified).
- **Correctness over completeness.** A wrong floor is worse than a missing
  one. A wrong "verified creator" badge is worse than no badge — we shipped
  one, badging a collection with the marketplace's own account, and had to
  actively retract it.
- **Bitcoin listings are venue-held PSBTs.** No keyless order book exists.
  Settlement is observable on-chain; live asks are not.

## What we want back

Not a survey of existing indexers. We have read them; they are pull systems
built on curated lists, and they are why this problem is unsolved.

For each of the four inventions, deliver:

- **The mechanism**, in enough detail to implement: inputs, transformation,
  outputs, and the data structures that make it work.
- **The claim**, stated tightly: what is genuinely new, what property it
  produces, and what becomes possible that was not before.
- **Why it beats the documented approach**, naming the specific system it
  beats and the specific limit it escapes.
- **The failure mode that kills the naive version** — the thing an
  inexperienced implementer gets wrong that makes it collapse in production.
- **The measurement that proves it works**, expressed so it can be run
  against a live system and either passes or does not.
- **The moat**: why a competitor who sees the running result still cannot
  cheaply reproduce it.

Not wanted: a survey of existing indexers. We have read them; they are pull
systems built on curated lists, which is precisely why this problem is
unsolved.

Where you believe a demand is *impossible* rather than merely unsolved, say
so plainly and prove the boundary. A real impossibility result is worth far
more than an optimistic design that fails in production, and it redirects
effort to what can actually be won.

Be ambitious without being fictional. Every mechanism must be buildable on
public chain data, commodity hardware, and browsers that already exist.
"Kryptonian" means the invention is startling and hard to match — not that
it requires technology nobody has. The most valuable answer is one that a
reader finds obvious in hindsight and impossible to have reached on their
own.

Assume the reader will implement this. Be concrete enough to build from.
