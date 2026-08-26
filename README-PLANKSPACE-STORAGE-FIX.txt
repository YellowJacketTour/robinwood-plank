PLANKSPACE SHARED STORAGE + PROFILE RESTORE FIX
Target: YellowJacketTour/robinwood-plank
Branch: plankspace-integration

WHAT WAS ACTUALLY WRONG
-----------------------
PlankSpace itself is already correctly wired to Robinwood's shared PostgreSQL
pool:

  integrations/plankspace-app/db/index.ts
      -> imports postgresPool()
      -> lib/postgres.ts

lib/postgres.ts does NOT consume POSTGRES_URL or DATABASE_URL. It consumes:
  PGHOST
  PGDATABASE
  PGUSER
  PGPASSWORD
and optionally PGPORT / PGSSLMODE / PGPOOL_MAX.

The old PlankSpace error message still referenced Vercel and
POSTGRES_URL/DATABASE_URL, which was stale and misleading.

The reason the previous canonical profiles looked missing locally was that the
shared PostgreSQL database had not started/configured, so the migrations that
create and seed PlankSpace had never run.

PROFILE DATA ALREADY PRESERVED IN THE REPO
------------------------------------------
The integration branch already has:
  deploy/inmotion/postgres/migrations/033_plankspace_profile_seed_repair.sql

It restores the canonical wallet-owned seed profiles WITHOUT overwriting an
existing profile owner's edits (ON CONFLICT DO NOTHING and guarded field fills).

That migration contains the canonical records for:
  DegenWaffle
  Sawtoshi Knotamoto
  BFL
  ByronStyles
  illL_umiN8
  GeneralDeez
  Bullish 0x
  aster_cast
  Naz Khan
  Imiro.wav
  IbenPharmin

It also restores the canonical default friendships and DegenWaffle Top Eight.

IMPORTANT DATA DISTINCTION
--------------------------
Git migrations can restore the canonical seeded data above.

Any later posts, comments, Board Mail, custom profile edits, friendship changes,
widgets, etc. that existed ONLY as rows in an older hosted PostgreSQL database
are not stored in Git. Those need to be exported from that old database and
merged into the plank.love PostgreSQL database. Do not overwrite an old
database if that live data still matters.

HOW TO APPLY
------------
1. Make sure GitHub Desktop Current Branch = plankspace-integration.
2. Extract this ZIP.
3. Copy the CONTENTS into the root of your local robinwood-plank repo.
4. Allow replacement of the one matching route file.

Then STOP your current npm run dev with Ctrl+C.

Run:
  START-PLANKSPACE-LOCAL.bat

That script:
  - starts the existing postgres service from docker-compose.inmotion.yml
  - sets the exact PG* variables Robinwood's lib/postgres.ts expects
  - runs npm run db:migrate
  - prints the seeded PlankSpace profiles
  - starts npm run dev with the same shared DB variables

Then visit:
  http://localhost:3000/plankspace

To inspect saved data later:
  VERIFY-PLANKSPACE-STORAGE.bat

To stop only the PostgreSQL container without deleting its data:
  STOP-PLANKSPACE-LOCAL-DB.bat

DO NOT RUN:
  docker compose ... down -v

The -v option deletes the local PostgreSQL data volume.

PRODUCTION
----------
Do NOT use the local password in production.

Production PlankSpace should inherit the SAME PGHOST/PGDATABASE/PGUSER/
PGPASSWORD configuration already used by plank.love. There should be no
PLANKSPACE_DATABASE_URL and no second PlankSpace database.

MASTER SAFETY
-------------
This patch does NOT modify:
  lib/postgres.ts
  app/layout.tsx
  components/Nav.tsx
  wallet-context
  Robinwood market code
  package.json
  production secrets

The only app code replacement is the PlankSpace auth challenge error message.
Everything else in this patch is local developer tooling/documentation.
