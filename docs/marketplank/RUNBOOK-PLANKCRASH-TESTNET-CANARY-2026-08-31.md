# PlankCrash Robinhood testnet canary

The canary is read-only by default. It verifies RPC identity/head freshness and downloads a contiguous run of block headers. Optional signed mode sends exactly one zero-value self-transaction and refuses any chain ID except Robinhood testnet `46630`.

## Local read-only run

```powershell
$env:ROBINHOOD_TESTNET_RPC_URL='https://rpc.testnet.chain.robinhood.com'
$env:PLANKCRASH_CANARY_BLOCKS='8'
npm run plankcrash:canary -- --out=plankcrash-canary.json
```

`--out` uses create-new semantics and refuses to overwrite existing evidence. Omit it to print JSON only.

For a standard JSON-RPC WebSocket provider, set `ROBINHOOD_TESTNET_WS_URL`. Robinhood’s public `wss://feed.testnet.chain.robinhood.com` is a Nitro sequencer feed, not a standard Ethereum JSON-RPC WebSocket endpoint, and must not be passed to `ethers.WebSocketProvider`. Use an Alchemy/provider WebSocket endpoint or a dedicated Nitro feed consumer.

## Signed testnet inclusion run

Provision a gas-only testnet key as `PLANKCRASH_CANARY_PRIVATE_KEY`. The script derives the sender and can send only `{to: sender, value: 0}`. Its structural chain guard rejects mainnet `4663` and every other chain.

```powershell
$env:PLANKCRASH_CANARY_PRIVATE_KEY='<testnet-only secret>'
npm run plankcrash:canary -- --out=plankcrash-signed-canary.json
```

Never put this key in Passenger or a committed environment file. The scheduled GitHub workflow is read-only; signed mode is available only through an explicit manual checkbox and repository secret.

## First verified observation

On 2026-08-31, the official public testnet RPC reported:

- chain ID `46630`;
- Nitro client `v3.11.3-rc.9-beb2108`;
- head age 2 seconds;
- monotonically advancing sampled headers;
- observed polling intervals of 357–757 ms in that short run;
- chain timestamp steps of 0–1 seconds.

This is one observation, not an SLO or finality guarantee. Scheduled artifacts establish a distribution over time. The public endpoint is rate-limited and Robinhood recommends a provider endpoint for production ([official connection documentation](https://docs.robinhood.com/chain/connecting/)).

## Evidence interpretation

- `included` means a successful receipt in an L2 block; it does not mean Ethereum finality.
- Header continuity over a short sample detects immediate inconsistencies, not every possible reorg.
- A WebSocket event measures notification latency, not authoritative transaction acceptance.
- Failed or stale samples block launch investigation; they never trigger client-side financial progression.

Retain workflow artifacts for at least 90 days. Before mainnet consideration, run controlled sequencer/provider outage, duplicate submission, delayed inclusion, and reorg simulations and attach their artifacts to the incident-drill reference consumed by `plankcrash:launch-gate`.

