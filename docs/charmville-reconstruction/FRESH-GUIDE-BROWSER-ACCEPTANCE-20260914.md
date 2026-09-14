# Fresh account guide acceptance

The real local application at localhost:3018 passed a fresh-account headless browser check using a separately provisioned synthetic profile and the existing local acceptance database. This exercised the actual account APIs and rendered React interface, not mocked journey data.

| Observed behavior | Result |
|---|---|
| Begin my journey opens initial Party setup | Passed |
| Set up home creates the home and routes to Journal | Passed |
| Opening scene is available without selecting a monster | Passed |
| Keyboard A advances; B closes only the reader | Passed |
| Continue the opening restores the saved page | Passed |
| Return home admits the account and shows the soil lesson | Passed |
| Reading grants no companion and no family entitlement | Passed, verified against PostgreSQL |
| 390px viewport avoids horizontal page overflow | Passed |
| Existing profile 26 yard state remains unchanged | Passed |
| Dedicated synthetic profile/session/fixture cleanup | Passed |

The final run used profile 29 and removed it after verification. Earlier cleanup development runs 27 and 28 were explicitly removed after resolving native-resource column and empty-roster foreign-key dependencies. No other existing profile was targeted. Tokens were held only in the private fixture and browser context, never in console evidence.

Reproduction: run `scripts/charmville/verify-fresh-guide-browser.mjs` with the existing explicitly confirmed synthetic local fixture environment. It accepts only the fixed local acceptance database and localhost:3018; it does not target production. Outputs are `work/fresh-guide-browser/evidence.json`, `journal-desktop.png`, and `journal-mobile.png`.

This acceptance covers navigation, reading, saved lesson selection and the absence of implicit grants. It does not establish a native cinematic, a following fairy, girl/boy animation parity, a complete first harvest, four visible players, Kakariko or remote public deployment. The captured mobile Journal remains vertically scrollable; no claim of finished art/layout polish is made from the absence of horizontal overflow.
