# Backup receipt

Status: application checkpoint pushed; reference archive verification in progress. Do not treat the private draft release as complete until this receipt is updated with the final verification results.

- Application checkpoint: `28306183a7dfd328761fcf2b9232d36eab29d798` on `feat/charmville-slice-1`, verified against the GitHub remote branch.
- 699 files in that commit: implementation, editable art, source indexes, research, tests and context-free handoff.
- Private archive repository: https://github.com/YellowJacketTour/charmville-reconstruction-vault
- Release tag: `checkpoint-2026-09-09`; release ID `385481318`.
- Local archive manifest: sibling `charmville-backup-archives/archive-manifest.json`. The committed final manifest and verification receipt will be copied here and into the vault.
- Main app validation: lint:inmotion passed; TypeScript passed; 212 contract tests passed; 1,326 market tests passed, 50 skipped; production build passed. Scoped new code lint passed after correcting the local-host React subscription.
- Recovery verification: sample archive restored successfully; nonempty destination and corrupted archive were rejected. Full multi-gigabyte restore not executed; every final uploaded archive will be compared to GitHub's size and SHA-256 digest.
- Excluded: environment files, credentials, database contents, browser sessions/saves and rebuildable node/Next/Python caches. This is a source/assets/project continuity backup, not a production database backup.
- The original game runtime reaches name entry and story in test browsers. The full integrated game is not complete. Read CURRENT-STATE.md for limitations.

The main branch and living handoff may advance after this receipt. Always inspect their latest state instead of resetting to the application checkpoint hash above.
