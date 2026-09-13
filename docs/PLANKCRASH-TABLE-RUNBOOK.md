# PlankCrash invite table on plank.love — host runbook

The table is the green-board arcade in front of its own free chain, invite-only.
Nothing on it has value. Everything below is done from the GitHub **Actions**
tab (workflow "InMotion Passenger CI/CD" → **Run workflow**) or from the table
itself; none of it needs a shell.

## What is live

| Surface | URL | Who |
|---|---|---|
| The table | `https://plank.love/table#invite=<token>` | anyone holding the link |
| Host credentials | `https://plank.love/playtest` | host / invited identities; opening the game sends you to the table |
| Copy the invite | **↗ Invite** in the table's dock | copies the current `/table#invite=…` link |

A guest who opens the link gets a browser-held wallet funded with test ETH and
PLANK, plays with the dock (stake, target, **Play**, **↻ Repeat**), and can top
up with **Refill test ETH** in Game tools. Returning to the same link on a
rebuilt chain re-funds the wallet automatically.

## Launch a fresh table (new chain, new guests, new link)

1. Actions → *InMotion Passenger CI/CD* → **Run workflow**
2. `operation` = `provision-plankcrash-table`
3. tick **`fresh_table`**
4. Run. When the job finishes, open its log and copy the line
   `PLANKCRASH_INVITE_URL=https://plank.love/table#invite=…`

What it does: stops the table, deletes the chain state, every guest session and
the invite token, seeds the chain from the current release, restarts, and
prints the new link. **Every old link stops working at the gate** — that is the
point of a fresh table. Takes about three minutes.

## Restart or repair without losing the economy

Same as above with **`fresh_table` unticked**. If the table is serving, it is
left alone. If it is down, it is restarted with its existing chain: vault,
prize pool, round history and guest balances all survive. The link is unchanged.

## What a deploy does to the table

Every push to `master` deploys the site and restarts the table on the new
release (about a minute of `/table` answering 500). The chain is **kept** unless
the contract set changed (a fingerprint of `contracts/`, the deploy script and
the hardhat config); only then is it reseeded, and the same link re-funds every
guest on their next join.

## Sharing the invite

Post the `/table#invite=…` link. It is the whole gate: no wallet, no sign-up,
no gas. Do not post the `/playtest` host page — that is your credentials
surface. If a link leaks somewhere you did not intend, run **Launch a fresh
table** and share the new one; the old one is dead the moment the job finishes.

## If something looks wrong

- `/table` answering 500 for more than two minutes: run the provision op
  (unticked). Its log ends with the supervisor's last lines — `anvil up`,
  `casino present`, `preview up`, `gateway up`, `table up; supervising` is
  healthy; anything else names the cause.
- "Prize is building · No funded draw this round": a round with no real
  stake funds no draw. The seeded pot and the simulated crew make this rare;
  it is expected on the first round after a fresh table.
- The result card after a crash is Astra's 2.6-second finale, then the lottery
  takes over. A round you did not stake shows no card.
