# EVM provider capability matrix — 2026-08-22

Status: research snapshot for Marketplank's data fabric. This document is
deliberately conservative: a limit is called **documented** only when the
provider's own current documentation states it. An empty/unknown limit is not
treated as unlimited. Marketing descriptions such as “free”, “public”, and
“archive” are not evidence that a provider can sustain historical
`eth_getLogs` in production.

## Decision

There is no credible unlimited free EVM RPC. The scalable design is:

1. Use Envio HyperSync for historical transfer and Seaport-event retrieval on
   supported chains.
2. Keep Alchemy first-class for NFT APIs, archive reads, validation, and small
   recent gaps, while enforcing its account-wide monthly budget durably.
3. Add at least one independently keyed general RPC account (Ankr is the best
   currently documented complement; Infura is useful where its chain coverage
   matches).
4. Keep PublicNode and chain-operated endpoints as last-resort head/call/recent
   gap endpoints, never as promised production capacity.
5. Select endpoints by **operation capability**, not by a single ordered URL
   array. `eth_blockNumber`, `eth_call`, recent logs, historical logs, archive
   state, NFT metadata, and transaction broadcast are different products.
6. Use sequential fallback. Parallel racing spends every provider's quota for
   one logical request. Hedge only explicitly latency-critical reads after a
   delay and reserve capacity for both calls.

## Provider summary

| Provider | Free allowance / throughput (official snapshot) | Key | Archive | `eth_getLogs` reality | Marketplank rank |
|---|---|---:|---:|---|---|
| **Envio HyperSync** | Free development/testing tier is stated, but the public pages reviewed do not publish a numerical production allowance. Token required for authenticated use. | Yes | Historical event index | Purpose-built event query API, not ordinary JSON-RPC; first-class endpoints are published for the relevant chains. | **1 for event history**, subject to an agreed/observed production budget |
| **Alchemy** | 30M CU/month; pricing page says 25 RPS, while the detailed plan documentation expresses throughput as 500–1,000 CUPS. Account limit is shared; method cost varies. | Yes | Yes, including free | `eth_getLogs` costs 60 CU. Current reference caps Free queries to **10 blocks** on Ethereum, Polygon, Arbitrum, Base, Optimism, BNB and Robinhood; the same table puts other free chains at 10 blocks too. 150 MB response cap. | **1 for enriched/NFT and precision RPC**, not bulk logs |
| **Ankr** | 200M API credits/month, 30 Node API RPS on Freemium; temporary exhaustion returns 429 / `-32090`. | Yes for a private accountable endpoint; shared demo exists | Archive availability is endpoint/network dependent | Chain RPC documents support. Exact free `eth_getLogs` block range is not published in the reviewed docs; errors include a specific “block range too large” response. Must probe and adapt. | **2 general RPC**; strongest quantified independent free complement |
| **Infura** | Core: 3M credits/day and 500 credits/sec in the comparison table. One key. (A pricing-page FAQ contains contradictory 6M/2,000 language; use the comparison table/dashboard as authoritative and detect plan at runtime.) | Yes | Free archive advertised | Supported on its available networks; no universal current log-range ceiling was found in primary docs. Credit cost and chain availability must be read from the account/current method table. | **2–3 where chain supported**; daily reset diversifies Alchemy's monthly failure mode |
| **dRPC** | 210M CU/30 days; normally 120k CU/min/IP, may fall to 50,400; 2-second free timeout; batch max 3; 10k returned-log cap. | Signup/key for account allowance | Archive product exists, but free public nodes are lower reliability | Critically, dRPC chain event-log documentation can mark `eth_getLogs` **paid-only** (confirmed on Base). Do not infer it from the generic 20-CU table. | **Useful for cheap non-log reads**; not selected for free Seaport scanning |
| **Chainstack** | Signup required. Developer is the free/start tier; current docs cap `eth_getLogs` to **100 blocks**. | Yes | Plan/node dependent | Developer 100 blocks; paid plans 10k. Their performance guidance is 5k Ethereum/BNB, 3k Polygon, 10k Arbitrum, 100k Avalanche, but that guidance does not override the Developer-plan 100-block cap. | **Development/secondary**, not genesis scans |
| **QuickNode** | “Free trial”, not a permanent free production tier: 10M credits, 15 RPS, one endpoint, one month, no overage. | Yes | Pricing table advertises archive data | Current `eth_getLogs` reference: **5 blocks on Free Trial**, 10k paid. | **Reject as sustainable free fallback**; useful only for evaluation |
| **GetBlock** | Current official free-package material: 5 RPS and 5,000 requests/day; newer CU migration material says 50k CU/day and two access tokens. Dashboard is the final authority. | Yes | Product/plan dependent | Method supported; reviewed official reference does not state a universal block range. Treat errors `-32603`/`-32005` as shrink-range signals. | **Tertiary keyed reserve** after live capability probe |
| **PublicNode** | Free, no key. No numerical SLA, quota, archive guarantee, or log-range contract found in its public material. | No | Unspecified | Works as a public JSON-RPC gateway but must be treated as dynamically constrained. | **Emergency reserve only**, despite broad coverage |
| **Foundation/public RPCs** | Free and keyless, normally explicitly rate-limited. | No | Do not assume | Method/range varies by chain and node implementation. Base and Optimism explicitly say their public endpoints are not for production. | **Emergency head/call and small recent-gap repair only** |

## Chain coverage and recommended lanes

Legend: **P** preferred; **S** independently metered secondary; **R** public
reserve; **H** HyperSync historical event plane; `?` means the provider must be
confirmed in its dashboard/current supported-network list before configuration.

| Marketplank chain | Historical events | Precision/keyed RPC | Independent keyed fallback | Keyless reserve |
|---|---|---|---|---|
| Ethereum (`1`) | Envio **H** | Alchemy **P** | Ankr **S**, Infura **S** | PublicNode **R**; public Ethereum gateways only as configured/probed |
| Polygon (`137`) | Envio **H** | Alchemy **P** | Ankr **S**, Infura **S** | PublicNode **R**; Polygon public aggregator **R** |
| Arbitrum One (`42161`) | Envio **H** | Alchemy **P** | Ankr **S**, Infura **S** | PublicNode **R**; Arbitrum public RPC **R** |
| Base (`8453`) | Envio **H** | Alchemy **P** | Ankr **S**, Infura/dRPC non-log reads **S** | PublicNode **R**, `mainnet.base.org` **R** |
| OP Mainnet (`10`) | Envio **H** | Alchemy **P** | Ankr **S**, Infura **S** | PublicNode **R**, `mainnet.optimism.io` **R** |
| BNB Smart Chain (`56`) | Envio **H** | Alchemy **P** | Ankr **S**, Infura if dashboard-supported **S** | PublicNode **R**, BNB public dataseed **R** |
| Avalanche C-Chain (`43114`) | Envio **H** | Alchemy **P** | Ankr **S**, GetBlock/Chainstack **S** | PublicNode **R**, `api.avax.network/ext/bc/C/rpc` **R** |
| zkSync Era (`324`) | Envio **H** | Alchemy **P** | Ankr/Infura only after dashboard verification **S?** | PublicNode **R**, zkSync public RPC **R** |
| Robinhood Chain (`4663`) | Envio lists Robinhood Chain; qualify endpoint/token before promotion **H** | Existing private `RPC_URL` and Alchemy **P** | No broadly documented independent keyed provider confirmed | Official Robinhood RPC(s) **R** and Blockscout for narrowly supported queries |

Envio's current supported-chain material lists Ethereum, Polygon, Arbitrum One,
Base, OP Mainnet, BNB Smart Chain, Avalanche C-Chain, zkSync Mainnet, and
Robinhood Chain. That uniquely matches the app's EVM estate. Its published
per-chain pages expose endpoints such as `https://eth.hypersync.xyz`,
`https://polygon.hypersync.xyz`, `https://base.hypersync.xyz`, and
`https://optimism.hypersync.xyz`; code should continue using Envio's supported
network registry instead of constructing hostnames by guesswork.

## `eth_getLogs`: concrete implications

### Why many tiny free calls are not the primary answer

At a two-minute incremental cadence, a 10-block cap can cover the *new tip* on
some chains only if the chain produced no more than ten blocks and every call
returns quickly. It cannot efficiently backfill long histories. For example,
one million blocks at Alchemy Free's documented 10-block range means at least
100,000 calls before retries; at 60 CU per call that is at least 6M CU for just
one filter and chain. QuickNode Free Trial's five-block cap is worse. Chainstack
Developer's 100 blocks is usable for bounded gaps, not a multi-chain genesis
scan.

The number of returned logs and response bytes is a second independent limit.
A block range that succeeds for an obscure contract can fail for Seaport.
Therefore the scheduler must maintain learned limits by
`provider × chain × operation/filter class`, halve ranges on range/result-size
errors, and only grow them slowly after repeated success.

### Correct split

- **Historical and catch-up:** HyperSync query with a durable cursor, bounded
  result pages, finality margin, and idempotent `(chain_id, tx_hash, log_index)`
  inserts.
- **Recent incremental:** HyperSync remains preferred. A keyed RPC may repair a
  small missing interval.
- **Verification:** compare the terminal block hash/head using an independent
  RPC. Periodically sample decoded log counts rather than duplicating every
  historical query.
- **Reorgs:** retain block hash and finality state; rewind a bounded window when
  the stored canonical hash changes.
- **All unavailable/exhausted:** keep last-good snapshots marked stale, emit a
  loud deferred/blocked job state, and make no fabricated zero.

## Router contract for implementation

The provider registry should store these fields instead of only URLs:

```ts
type RpcCapability = {
  providerId: string;
  accountId: string;           // quota scope, not the chain name
  chainSlug: string;
  endpoint: string;
  keyed: boolean;
  operations: Array<
    | "head"
    | "call"
    | "broadcast"
    | "recentLogs"
    | "historicalLogs"
    | "archiveState"
    | "nftMetadata"
  >;
  hardLogBlockRange: number | null;
  learnedLogBlockRange: number;
  maxLogResults: number | null;
  maxBatchItems: number;
  timeoutMs: number;
  priority: number;
  productionClass: "primary" | "secondary" | "public-reserve";
};
```

Provider selection must be preceded by a durable allowance reservation scoped
to `accountId`; eight per-chain workers must not each believe they own the same
Alchemy/Ankr monthly allowance. A chain-specific health circuit is additional,
not a replacement for the global account budget.

Error classification should include:

- quota exhausted: 402/429, Alchemy monthly-capacity text, Ankr `-32090`;
- range/result too large: 413, `-32062`, `-32005`, provider-specific text;
- unsupported method/tier: `-32601`, paid-only response, authentication policy;
- transient upstream: 5xx/timeout;
- deterministic request failure: bad params/address/chain, which must not rotate
  endlessly.

Only the first four may select another provider, and only after recording the
attempt. A malformed request is not cured by spending every fallback's quota.

## Candidate disposition

The research brief also named Blast API, 1RPC, Tenderly, LlamaRPC/LlamaNodes,
and several public gateways. They are **not promoted into the production
rotation by this document** because current official public material reviewed
did not provide all three facts needed for this incident: a durable numerical
free allowance, method-level `eth_getLogs` terms, and current coverage of the
required chain. They can be added after an account/dashboard capability probe,
but “provider appears in a chain directory” is not a capacity contract.

Likewise, PublicNode's existing eight-chain integration is worth retaining, but
the absence of a published numerical quota/SLA means it must not be described as
unlimited or used to size the system.

## Production qualification procedure

Documentation is necessary but insufficient because plan flags and backend
clients change. Each newly configured endpoint should pass a bounded, read-only
probe before becoming eligible:

1. `eth_chainId` equals the configured chain.
2. `eth_blockNumber` and one recent `eth_getBlockByNumber` succeed.
3. A one-block address-and-topic `eth_getLogs` query succeeds.
4. Binary-search the maximum accepted empty/sparse range, never against a dense
   unfiltered topic.
5. Test a known dense Seaport window and record result/byte limits.
6. Test one historical `eth_call` to classify archive state separately.
7. Record batch maximum, timeout, latency percentiles, and exact failure codes.
8. Keep a provider in shadow/secondary mode for 24 hours before promotion.

The probe must spend a tiny fixed budget, persist its result with an expiry, and
never run from a user request.

## Primary sources

- Alchemy pricing and free allowance: <https://www.alchemy.com/pricing>
- Alchemy plan comparison: <https://www.alchemy.com/docs/reference/pricing-plans>
- Alchemy `eth_getLogs` CU and current plan range table:
  <https://www.alchemy.com/docs/chains/stable/stable-api-endpoints/eth-get-logs>
- Alchemy log response/range discussion:
  <https://www.alchemy.com/docs/deep-dive-into-eth_getlogs>
- Ankr Freemium monthly credits and exhaustion behavior:
  <https://www.ankr.com/docs/rpc-service/charging-policy/>
- Ankr plan rates: <https://www.ankr.com/rpc/pricing/>
- Ankr chain RPC/key guidance: <https://www.ankr.com/docs/api-reference/>
- Ankr range/rate error contract:
  <https://www.ankr.com/docs/rpc-service/errors/overview/>
- Infura current pricing comparison: <https://www.infura.io/pricing>
- Infura daily-limit behavior:
  <https://support.metamask.io/develop/account/limits/daily-limits/>
- dRPC free-tier limits: <https://drpc.org/docs/howitworks/ratelimiting>
- dRPC free-versus-paid behavior: <https://drpc.org/docs/pricing/requests>
- dRPC method CU table: <https://drpc.org/docs/pricing/compute-units>
- dRPC Base event-log tier availability:
  <https://drpc.org/docs/base-api/eventlogs>
- Chainstack plan and EVM range limits:
  <https://docs.chainstack.com/docs/limits>
- Chainstack log-range guidance:
  <https://docs.chainstack.com/docs/understanding-eth-getlogs-limitations>
- QuickNode plan limits: <https://www.quicknode.com/pricing>
- QuickNode current free/paid log ranges:
  <https://www.quicknode.com/docs/data/eth_getLogs>
- GetBlock free package: <https://getblock.io/blog/getblock-adjusted-free-package-details/>
- GetBlock CU-plan transition: <https://getblock.io/blog/getblock-switches-to-cu/>
- GetBlock `eth_getLogs` reference:
  <https://docs.getblock.io/api-reference/base/eth_getlogs-base>
- Envio documentation and product split: <https://docs.envio.dev/>
- Envio supported-chain pages/endpoints: <https://envio.dev/chains/eth>,
  <https://envio.dev/chains/polygon>, <https://envio.dev/chains/base>, and
  <https://envio.dev/chains/optimism>
- Base official public endpoint warning:
  <https://docs.base.org/base-chain/quickstart/connecting-to-base>
- Optimism public endpoint warning/directory:
  <https://docs.optimism.io/app-developers/reference/rpc-providers>
- Avalanche official C-Chain log method:
  <https://build.avax.network/docs/rpcs/c-chain/eth/eth_getLogs>

## Final ranking for this app

1. **Envio HyperSync** for event discovery/history on every supported app EVM
   chain, with its actual account entitlement represented in the durable budget.
2. **Alchemy retained** for NFT/metadata, archive/precision calls, and small
   repair windows; never again spend it on broad history by default.
3. **Ankr keyed Freemium** as the first independent general-RPC complement,
   because its current allowance and throughput are both explicitly documented.
4. **Infura Core** on the subset of required networks confirmed in the created
   project, valuable particularly because its allowance resets daily rather than
   sharing Alchemy's monthly cliff.
5. **GetBlock or Chainstack** as a tertiary keyed reserve after a live method and
   chain probe; Chainstack Developer's 100-block log cap is explicit.
6. **PublicNode plus official chain endpoints** for emergency lightweight reads
   and bounded gap repair only.

QuickNode Free Trial is not a sustainable free dependency, dRPC Free must not be
assumed to include logs, and no candidate with unpublished limits should be
called unlimited.
