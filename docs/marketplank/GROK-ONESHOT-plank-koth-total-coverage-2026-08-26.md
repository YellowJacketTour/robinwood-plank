# One-shot research brief: catching *every* real buy of a live ERC-20, on any venue, with fraud-grade certainty AND a more reliable data plane

You are being handed this with **zero prior context** about any specific codebase. Treat it as a fresh, first-principles research and design problem for a real, live, real-money competition. Research broadly, cite real current sources (docs, audits, post-mortems) wherever you claim a real system's real behavior, and then design a bespoke, best-imaginable solution — don't just survey.

## The situation, plainly

We run a small ERC-20 token ("$PLANK") on an EVM-compatible L2 ("Robinhood Chain" — real finality profile: ~1s soft confirmation, ~13 minutes to L1-anchored hard finality; treat any transfer as reversible until hard finality). We are running a **live, real-money contest**: whoever makes the single largest real buy of $PLANK during a ~31-day window wins a real prize (a fixed allocation of the token, real dollar value). The leaderboard and the current "leading buy" are shown publicly and update automatically.

This is a **fraud-adversarial, real-value, real-time detection problem**, not just an indexing problem: the system must (a) find every real buy so the contest is fair to honest players, while (b) never letting a fake/manipulated "buy" (wash trade, flash-loan round-trip, self-funded decoy) rank or win.

## Part 1: what exists today, and where it breaks

Our current implementation reads exclusively from **one third-party REST block explorer API** (a Blockscout instance) to (a) discover candidate buy transactions by polling each of 3 hand-verified canonical liquidity pools' own token-transfer history, and (b) fetch each candidate transaction's full transfer list and status for fraud evaluation.

Confirmed real, live problems with this, in order of severity:

1. **The explorer is unreliable and we cannot tell when it's lying to us.** We've directly reproduced real HTTP 500s from this explorer mid-pagination. Worse: our own fetch wrappers **swallow every failure into an empty result** (`catch { return [] }` / `catch { return null }`), so a transaction that genuinely has real, on-chain buy activity and one that merely failed to fetch are **indistinguishable** to every downstream consumer — both look like "not a real buy." We directly confirmed this live: a transaction proven (via a fresh, independent fetch) to contain a real qualifying buy was evaluated as "not a buy" when run from our own production host, at multiple concurrency levels, while succeeding instantly from an unrelated network origin — strongly suggesting our production host's outbound IP is itself rate-limited or degraded against this one upstream dependency (which also serves ALL of our other real-time polling against the same explorer, all day, every 2 minutes), and we have no way to distinguish "genuinely no buy happened" from "our one upstream dependency silently failed" anywhere in the pipeline.

2. **Zero external observability into any long-running backfill/reprocessing job.** When we needed to re-evaluate a backlog of ~20-90 previously-misclassified candidate transactions, our only way to see progress was tailing a CI log after the fact — no durable, queryable, incrementally-updated progress record exists anywhere (row counts, per-item status, throughput). We had no way to tell "is this making real progress" from "is this hung" without guessing from elapsed wall-clock time, and it genuinely wasn't obvious whether the job was slow, rate-limited, or truly stuck.

3. **Real classification bugs we already found and partially fixed**, so you have the full picture: our fraud checks originally assumed a buyer's own wallet directly moves the payment (WETH/stablecoin) into the pool, but virtually all real swaps route through a router/aggregator contract (Uniswap's Universal Router / SwapRouter02) that moves funds on the buyer's behalf — we've patched the single-buyer case but do not yet correctly attribute value in a genuinely batched multi-buyer transaction.

4. **Pool coverage is a hardcoded allowlist**, not discovery — a new pool, fee tier, or venue for this token is invisible until a human manually adds it.

## Part 2: what we need from you — two related tracks

### Track A: a fundamentally more reliable way to detect and confirm real buys

1. **Direct on-chain data instead of (or in addition to) a third-party REST explorer.** We have a real, working direct RPC endpoint for this chain. Research: is directly querying `eth_getLogs` for the pools' own native AMM events (Uniswap V2 `Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to)` / V3 `Swap(sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick)` — note these are semantically MUCH more direct for "who bought, how much, at what price" than our current transfer-graph-guessing approach) a more reliable, cheaper, and faster primary data source than any REST explorer? What's the real state of the art (2026) for high-throughput direct log scanning on an EVM L2 with a real, modest-budget RPC provider — batched `eth_getLogs`, a self-hosted light indexer, or a managed low-cost indexing service? (We already have a separate, working direct-on-chain log-scanning pipeline for a different feature in this same app, built on a service in the "hypersync"-style high-throughput indexer category — but it doesn't have coverage for this specific chain; is there a comparable option that does, or is plain batched `eth_getLogs` against our own RPC sufficient at this token's real activity volume?)

2. **Swap-specific aggregator/analytics APIs as a second, corroborating source.** Research real, current (2026) DEX-swap-history APIs (e.g., the kind of service that indexes Uniswap-family swaps specifically, across chains) that could either replace or cross-verify our explorer-based detection. What's real, what's reliable, what's the cost/rate-limit profile for a small project?

3. **Are there other real, official or community-run block explorers for this same chain** beyond the one we're using, that we could use as a fallback or cross-check when our primary source fails or looks suspicious (e.g., returns suspiciously-empty results for a window we independently confirm had real activity)? What's the real state of the art for "explorer redundancy" / "never trust a single indexer" in production Web3 systems?

4. **A principled way to tell "real absence of activity" from "our data source failed us."** What do robust real-time on-chain monitoring systems do to make a silent data-source failure impossible to confuse with a real negative result — e.g., cross-checking against a second independent source, sanity-checking against expected chain-level activity (block production continuing normally), or explicit confidence/staleness flags surfaced all the way to whatever consumes the result?

### Track B: mandatory external observability for any backfill/long-running verification job

We never again want a job whose only signal is "still running" via an external CI log. Research and design a real, lightweight (small-team-budget) pattern for:

- A durable, incrementally-updated progress record (not just a final summary) for any batch/backfill job — queryable from OUTSIDE the job's own process while it's running (a simple status table an admin page or API can poll; a structured heartbeat; whatever's real best practice) — showing at minimum: total items, completed so far, currently-processing item, real per-item outcome tally, and last-heartbeat timestamp so a genuinely stuck job is distinguishable from a slow-but-alive one within seconds, not by staring at wall-clock time and guessing.
- Sane, boring, real patterns for this (a `job_runs`/`job_progress` table pattern, a structured-log-plus-external-log-aggregator pattern, a lightweight external job-queue/observability service appropriate for a small team) — cite what's actually common practice in 2026, don't invent something exotic.

## What to actually produce

Don't just survey — **design a bespoke, adversarially-hardened target architecture** for the whole detection pipeline (Track A) AND a concrete, minimal observability pattern (Track B) we could implement in a day or two, not a quarter. Be concrete: name real services/techniques/RPC methods, give a real recommended data flow, and explicitly call out every place your design could still be gamed, could still miss a real buy, or could still fail silently — with your own severity assessment for each residual gap, so we know our real, remaining exposure precisely rather than being told a design is "complete."
