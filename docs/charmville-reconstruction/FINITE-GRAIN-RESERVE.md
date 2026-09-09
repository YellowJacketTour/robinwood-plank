# Finite Grain reserve

Migration 107 creates a one-time development allocation of 1,000,000 simulated Grain. This is an explicit provisional balancing parameter, not a valuation or on-chain asset. Existing player balances are preserved and included in opening supply. Migration replay does not replenish the reserve.

Authenticated garden claims, harvests and tending now debit that reserve in the same database transaction as player credits and idempotent receipts. Planting fees credit it. Exhaustion rolls back the whole action, including seeds, crop changes and starter state. Replayed receipts do not touch the reserve again. This deliberately preserves current reward quantities while ending unbounded currency creation in this path.

This does not make all commodities finite: crop output and seed regeneration still require species definitions and renewable production budgets. It does not implement the exchange, purchased Grain, cash payments, native guest settlement or treasury administration. There is no automatic reserve refill.

Deployment requires migration before new code and retiring all old writers before claiming conservation. The immediately previous application remains schema-compatible but does not debit this reserve. Database administrators and other direct writers can also bypass application accounting. No production deployment has been performed here.

Verification: PostgreSQL lifecycle checks assert conservation across claim, retry, migration replay, concurrent harvest and tending, and complete rollback of an unfunded claim. Existing historical tests that alter balances directly remain fixture setup rather than legitimate economic operations.
