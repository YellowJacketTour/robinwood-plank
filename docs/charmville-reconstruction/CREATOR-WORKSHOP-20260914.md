# Creator workshop: review before world changes

The workshop is a working local proposal author, not a live source-code editor or publishing service. It is available at `/charmville/workshop` and as the reusable `ContributionPanel` inside the game's menu. The standalone route follows the game's disabled-mode gate; it reveals no account data and provides no server mutations.

## Working flow

1. Name the proposal using `creator.change-name` and pin a 40-character base Git commit.
2. Describe the player-visible result in one short paragraph.
3. Choose 1–16 pack JSON manifests. The browser reads bounded bytes and calculates SHA-256 fingerprints. Duplicate pack identities are rejected.
4. Optionally add up to 32 PNG, JSON or Markdown evidence files, classified as visual proof, artwork rights or compatibility checks. Paths are limited to safe `evidence/` filenames and files are fingerprinted locally.
5. Check the envelope, then export a JSON proposal for repository review. Editing the draft invalidates its checked state. Existing bounded proposals can be imported.

The browser and CLI use the same `contribution-schema.mjs` parser. It accepts no scripts, URLs, capability grants, approval flags or economy commands. Uploaded bytes are never executed or rendered as HTML. No wallet signing, network upload, repository write, account impersonation or publication occurs. Imports reference files; they do not prove possession or validate their content.

## Reviewer responsibilities

`node scripts/charmville/contribution-validate.mjs proposal.json` checks the envelope only. `verifyContributionPacks` checks original manifest bytes against pins and validates pack content. Reviewers still need the original evidence files, asset rights, compatibility checks, visual review, trusted build checks and release approval. The workshop export is not release authorization.

## Remaining integration

Authenticated team proposal storage, comments, Git-provider pull requests, preview builds, automated evidence verification, reviewer roles and approved-release activation remain separate work. Adding those must retain the same pinned proposal boundary; contributors and their AI tools must never gain authority over balances, custody or the live simulation through a content proposal.

## Verification

The existing contribution validator tests pass after extracting the browser-safe parser. TypeScript and focused ESLint pass. The workshop needs a live browser review at handheld and desktop widths before visual acceptance is claimed.
