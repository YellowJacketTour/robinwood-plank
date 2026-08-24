# PlankSpace Vercel build repair

## Included fixes

- Removed the duplicate `liveRooms` and `liveRoomMembers` exports that stopped Turbopack.
- Kept the Woodstock schema shape used by the live-room API.
- Added append-only migration `035_woodstock_live_schema_repair.sql` so databases
  created from the earlier Woodstock prototype gain the fields used by the V1 API.
- Restored up to eight YouTube links in the profile editor and API.
- Reconnected the existing playlist player to public profiles.
- Preserved the existing `featured_video` database column, so no destructive media
  migration is needed and previously saved single-video profiles continue to work.
- Declared the missing `ethers` and PostgreSQL dependencies used by the new tip API.
- Restored the saved-session helper used by profile visit tracking and aligned the
  standalone TypeScript target with the BigInt-based tip verification code.

## Push from the extracted project folder

```bash
git status
git switch PlankSpace1
git add integrations/plankspace-app/db/schema.ts \
  integrations/plankspace-app/app/api/profiles/route.ts \
  integrations/plankspace-app/app/profile-form.tsx \
  integrations/plankspace-app/app/auth-client.ts \
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
