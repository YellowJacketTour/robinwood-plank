# PlankSpace Vercel build repair

## Included fixes

- Removed the duplicate `liveRooms` and `liveRoomMembers` exports that stopped Turbopack.
- Kept the Woodstock schema shape used by the live-room API.
- Added append-only migration `035_woodstock_live_schema_repair.sql` so databases
  created from the earlier Woodstock prototype gain the fields used by the V1 API.
- Restored up to eight YouTube links in the profile editor and API.
- Restored the full eight-slot YouTube editor with separate fields plus add,
  remove, move-up, and move-down controls.
- Reconnected the existing playlist player to public profiles.
- Preserved the existing `featured_video` database column, so no destructive media
  migration is needed and previously saved single-video profiles continue to work.
- Declared the missing `ethers` and PostgreSQL dependencies used by the new tip API.
- Restored the saved-session helper used by profile visit tracking and aligned the
  standalone TypeScript target with the BigInt-based tip verification code.
- Repaired Woodstock lounge response handling so empty/non-JSON server failures
  no longer crash the client, and live-room actions always return JSON errors.
- Restored persistent per-module visibility controls. Every profile module can
  be shown or hidden without deleting its content or losing its position.
- Re-audited the completed Widgets/Woodstock update and preserved the complete
  Wallet, Favorite Token, Token Chart, Portfolio, Toss a Chip, and sanitized
  Custom Widget implementation, APIs, manager, rendering, and safety checks.
- Restored the missing profile spacing/mobile stylesheet import so transparent
  gaps expose the owner-selected page background between modules.
- Moved custom page CSS outside the Welcome module so CSS/HTML customization
  remains active even when Welcome or Custom Space is hidden.
- Reused the last verified wallet address with its server-validated 12-hour
  session token, preventing repeated WalletConnect prompts between features.
- Normalized full-URL or hostname Jitsi settings and added bounded, readable
  script-load failures for Woodstock.

## Push from the extracted project folder

```bash
git status
git switch PlankSpace1
git add integrations/plankspace-app/db/schema.ts \
  integrations/plankspace-app/app/api/profiles/route.ts \
  integrations/plankspace-app/app/profile-form.tsx \
  integrations/plankspace-app/app/auth-client.ts \
  integrations/plankspace-app/app/api/live-rooms/route.ts \
  integrations/plankspace-app/app/woodstock/live-lounge.tsx \
  integrations/plankspace-app/app/globals.css \
  'integrations/plankspace-app/app/u/[handle]/page.tsx' \
  integrations/plankspace-app/package.json \
  integrations/plankspace-app/package-lock.json \
  integrations/plankspace-app/tsconfig.json \
  deploy/inmotion/postgres/migrations/035_woodstock_live_schema_repair.sql \
  PLANKSPACE_FIX_AND_PUSH.md
git commit -m "Fix Woodstock schema build and restore 8-video profiles"
git push origin PlankSpace1
```

Vercel should rebuild automatically after the push. The configured command may
remain `npm run db:migrate && npm run build`; migration 035 is append-only and
safe to rerun because the migration runner records applied filenames.
