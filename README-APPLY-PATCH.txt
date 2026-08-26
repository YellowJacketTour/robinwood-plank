PLANKSPACE FINAL UI PATCH
Target repo: YellowJacketTour/robinwood-plank
Target branch: plankspace-integration

WHAT THIS PATCH DOES
- Keeps the existing plank.love/RobinWood Nav at the top of PlankSpace routes.
- Adds a dedicated PlankSpace second-level navigation directly below it.
- Does NOT modify components/Nav.tsx or Robinwood master navigation.
- Replaces the bare Woodstock Coming Soon placeholder with a polished themed screen.
- Leaves PlankSpace on Robinwood's existing shared PostgreSQL pool. The current integration already imports postgresPool() from lib/postgres.ts, so no second PlankSpace DB config is introduced.

HOW TO APPLY
1. In GitHub Desktop make sure Current Branch = plankspace-integration.
2. Extract this ZIP.
3. Copy the CONTENTS of the extracted folder into your local robinwood-plank repo.
4. Allow Windows to replace the matching files.
5. Run:
     npm run dev
   Open:
     http://localhost:3000/plankspace
     http://localhost:3000/woodstock
6. Then run:
     npm run build
7. If build passes, commit and push the changed files on plankspace-integration only.

EXPECTED FILES CHANGED
- app/(plankspace)/layout.tsx
- app/plankspace/layout.tsx
- integrations/plankspace-app/app/woodstock/page.tsx

NEW FILE
- integrations/plankspace-app/app/plankspace-subnav.tsx

MASTER SAFETY
This patch does not replace components/Nav.tsx, app/layout.tsx, lib/postgres.ts,
wallet-context, market code, or other Robinwood master infrastructure.
