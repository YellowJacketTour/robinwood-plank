# Private candidate promotion

Run only after the operator has reviewed actual local browser evidence. This step does not invent acceptance or test the browser automatically.

`node scripts/charmville/promote-private-runtime.mjs --mirror <local-candidate> --target <https-candidate> --acceptance <review.json> --output <new-private-release-folder>`

The review JSON requires schemaVersion 1, kind `charmville-runtime-browser-acceptance`, reviewedBy, ISO reviewedAt, a nonempty artifacts array of evidence references, localTestedInventorySha256 and targetInventorySha256. Its checks object must explicitly set coldStart, movement, farmingHarvest, reloadPersistence, socialPin, ticketRenewal, unauthorizedDenied, and revokedDenied to true. Do not set unobserved checks to true.

Both inventories and every entry are rehashed. The mirror must use http://localhost:3018 and the target must use HTTPS. File sets, routes, and roles must match. Binary content must match exactly; only allowlisted adapter text may differ, and only by the exact configured account origin and runtime release prefix. Any behavior difference requires rebuilding and repeating relevant browser acceptance.

The source candidates remain unmodified. The new output contains the exact target inventory, a local BROWSER-ACCEPTANCE.json copy, and a final accepted PACKAGE-COMPLETE.json marker embedding the full review record. The embedded record survives the archive pipeline, which intentionally packages only inventory entries and package metadata. Promotion is local artifact preparation; remote authorization and smoke checks remain separate release gates.
