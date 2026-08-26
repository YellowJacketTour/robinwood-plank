PLANKSPACE WALLET SIGNATURE FIX
Target branch: plankspace-integration

ROOT CAUSE
----------
PlankSpace session login had drifted into a separate signing protocol:
- custom challenge table
- custom authorization message
- SHA-256 payload hash
- viem.verifyMessage()

plank.love master already has its own canonical proof implementation:
- lib/wallet-proof-client.ts
- lib/wallet-proof.ts
- lib/wallet.ts signMessage()
- EIP-191 personal_sign
- ethers verifyMessage()
- action/domain/payload binding + five-minute freshness window

This patch makes PlankSpace session creation use the MASTER implementation.

FILES CHANGED
-------------
integrations/plankspace-app/app/auth-client.ts
integrations/plankspace-app/app/api/auth/session/route.ts

FILES NOT CHANGED
-----------------
lib/wallet.ts
lib/wallet-context.tsx
lib/wallet-proof.ts
lib/wallet-proof-client.ts
components/Nav.tsx
lib/postgres.ts
Robinwood market/trading code

The old /api/auth/challenge route may remain in the tree for compatibility,
but PlankSpace session creation no longer uses it.

HOW TO APPLY
------------
1. Stop npm run dev with Ctrl+C.
2. Make sure GitHub Desktop says Current Branch = plankspace-integration.
3. Extract this ZIP.
4. Copy the CONTENTS into the root of robinwood-plank and replace matching files.
5. Start the SAME Command Prompt session that has your PG* variables, or set them again.
6. Run:
     npm run dev
7. Open:
     http://localhost:3000/plankspace
8. Click My Space -> Sign to Verify & Load Profile.

IMPORTANT
---------
If you closed the terminal, the Windows `set PG...` variables disappeared.
Set them again before npm run dev.

After successful login, the 12-hour token is saved under:
  plankspace-session:<wallet>
in browser localStorage.

For a clean test, if an old failed session is hanging around, browser DevTools
can remove plankspace-session:* and plankspace-last-verified-wallet, then reload.
Normally this should not be necessary because invalid sessions are rejected and
removed automatically.
