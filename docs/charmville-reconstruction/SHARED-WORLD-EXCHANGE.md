# Shared account world and exchange checkpoint

The account shell at `/charmville/world` combines approved profile identity, region membership, saved inventory and explicitly accepted fixed-price offers. In local development it also embeds the native reference camera cross-origin. The camera is not yet a renderer of the account region: neither movement nor native harvests settle into account balances.

## Persistent region membership

Migration108 records one current location per profile, with a revision and 90-second lease. Entry checks permissions and uses stable home owner IDs. The public region and different private homes have separate presence lists. Revoked visitors are excluded and cannot pass authoritative home-action checks. The browser renews active membership every30seconds while visible. Background/expired sessions must re-enter; presence is not a physical position or combat authority.

## Fixed-price offers

Migration109 reserves existing charms for sell offers or existing Grain for buy offers. Another approved account can accept a whole or partial quantity. Cancellation returns only the unfilled escrow. Profile locks, offer locks, and unique request receipts serialize competing fills and retry safely. Self-fills are rejected. The seven current durable Satchel definitions are the only tradable definitions; the discovery catalogue does not become money simply by being indexed.

This is a direct acceptance offer board, not automatic matching, AMM, perps or price prediction. Prices are chosen by players. No fee or extra currency is minted. The public read returns aggregate reserve, circulating and escrowed Grain from one consistent database snapshot. Conservation includes all three compartments, including escrow on offers hidden from public listing by moderation.

The UI shows quantity, unit price and total before confirmation. If a submitted request loses its response, it retains the request ID and requires retrying that same confirmation before a different action. Browser verification deliberately loses a response after commit, verifies one offer only, then partially fills and cancels its remainder with two synthetic accounts.

## Deployment boundary

Migrations108 and109 have been applied only to the isolated local PostgreSQL instance. Production deployment requires the normal release process. Native document embedding changes apply only to the local account shell; account bearers are never sent to native source scripts, URLs or guest sockets. The source runtime has document-specific cross-origin resource headers to permit its isolated iframe. Future shared movement requires a server world host and explicit map bindings rather than trusting a guest pose stream.
