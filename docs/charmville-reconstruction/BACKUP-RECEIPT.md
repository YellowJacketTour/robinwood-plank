# Backup receipt

Status: application checkpoint pushed; **all 41 source-collection archives uploaded and verified against GitHub SHA-256 digests** at 2026-09-09 12:22 UTC. The private release is published (not draft): https://github.com/YellowJacketTour/charmville-reconstruction-vault/releases/tag/checkpoint-2026-09-09 . Vault documentation checkpoint: `057cd17`; subsequent documentation may advance without changing the immutable archive snapshot.

- Application checkpoint: `28306183a7dfd328761fcf2b9232d36eab29d798` on `feat/charmville-slice-1`, verified against the GitHub remote branch.
- 699 files in that commit: implementation, editable art, source indexes, research, tests and context-free handoff.
- Private archive repository: https://github.com/YellowJacketTour/charmville-reconstruction-vault
- Release tag: `checkpoint-2026-09-09`; release ID `385481318`.
- Archives total **6,139,960,649 bytes** (about 6.14 GB / 5.72 GiB compressed). Every current top-level source collection is represented, including tooling, full acquired Git/LFS bytes, original editable art, quest snapshots and the adapted browser runtime.
- `archive-manifest.json` records each archive's source, revision/remote where available, byte length and SHA-256. `archive-verification.json` records successful comparison of all 41 uploaded sizes/digests to that manifest. Both are committed here and in the private vault and attached to the release.
- Main app validation: lint:inmotion passed; TypeScript passed; 212 contract tests passed; 1,326 market tests passed, 50 skipped; production build passed. Scoped new code lint passed after correcting the local-host React subscription.
- Recovery verification: sample archive restored successfully; nonempty destination and corrupted archive were rejected. Full multi-gigabyte restore was not executed; all uploaded archives passed remote size and SHA-256 comparison. This is byte-integrity verification, not proof every archived third-party engine builds.
- Excluded: environment files, credentials, database contents, browser sessions/saves and rebuildable node/Next/Python caches. This is a source/assets/project continuity backup, not a production database backup.
- The original game runtime reaches name entry and story in test browsers. The full integrated game is not complete. Read CURRENT-STATE.md for limitations.

The main branch and living handoff may advance after this receipt. Always inspect their latest state instead of resetting to the application checkpoint hash above.

Development resumed after archive completion: the runtime now serves preserved local quest content, verified with external network blocked; a 435-definition source item catalog now connects original IDs/artwork/usage entry points/palettes/scripts. These app-code changes and derived source assets are preserved by later work-branch commits and the updated living handoff, without rewriting the original release archives.

Animation audit supplemental backup, 2026-09-09: nine archives, 497,010,349 compressed bytes. Every remote size and SHA256 digest matched the local manifest. Includes seven source repositories, three art packs in one collection, and one failed engine-compatibility evidence collection. Release: https://github.com/YellowJacketTour/charmville-reconstruction-vault/releases/tag/animation-audit-2026-09-09 . Restore instructions and hashes: source-evidence/animation-archive-manifest.json. Original checkpoint archives remain unchanged.

Native homestead checkpoint: two supplemental archives totaling 91,730,468 compressed bytes verified against remote SHA256 and size. Release: https://github.com/YellowJacketTour/charmville-reconstruction-vault/releases/tag/homestead-2026-09-09 . Includes native-212 tools, editable tutorial template/output, source script and browser evidence. See HOMESTEAD-PLAYTEST.md for rebuild instructions and limitations.
