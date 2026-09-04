# PlankSpace + X integration options

PlankSpace keeps X optional. A profile works without an X account, importing is
explicit, and posting to X remains off unless the owner selects it for that post.

## Recommended: official X OAuth with controlled imports

Use the live OAuth 2.0 PKCE flow already implemented in PlankSpace. After an owner
connects X, the **Import latest X posts** action reads their author timeline and
deduplicates imported posts. The Lumberyard composer can optionally publish the
same message to X.

X access, pricing, quotas, and available plans can change. Confirm the current
terms in the X Developer Console before funding or opening a public rollout.

1. Create a Project and App in the [X Developer Console](https://developer.x.com/en/portal/dashboard).
2. Enable OAuth 2.0 for **Web App, Automated App or Bot** and add exact callback URLs:
   - Local: `http://localhost:3000/api/x/callback`
   - Production: `https://plank.love/api/x/callback`
3. Grant `tweet.read`, `tweet.write`, `users.read`, and `offline.access`.
4. Rotate any X credentials that have previously been pasted into chat,
   screenshots, terminals, or other untrusted locations.
5. Add these GitHub Actions secrets:

   - `X_CLIENT_ID`
   - `X_CLIENT_SECRET`
   - `PLANKSPACE_X_TOKEN_ENCRYPTION_KEY`

   Generate the encryption key once with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   Do not reuse a database, wallet, session, or application secret.
6. Optionally set repository variable `X_REDIRECT_URI`; it defaults to the
   exact production callback above and rejects any other value.
7. Run **InMotion Passenger CI/CD** manually with operation
   `configure-plankspace-x`. The job writes only these server-side values to
   the shared mode-600 production environment, restarts Passenger, verifies
   `/api/health`, and restores the previous environment if verification fails.

The resulting server-only configuration is:

   ```text
   PLANKSPACE_X_PROVIDER=live
   X_CLIENT_ID=...
   X_CLIENT_SECRET=...
   X_REDIRECT_URI=https://plank.love/api/x/callback
   PLANKSPACE_X_TOKEN_ENCRYPTION_KEY=<32 random bytes, base64 encoded>
   ```

8. Purchase a small credit balance, connect a test X account, import a small
   batch, and confirm the usage ledger before opening the feature to testers.

Recommended launch guardrails: import on button-click first, cache and deduplicate
post IDs, default to 10–20 posts, cap spend per day, and show a clear failure when
credits or rate limits are exhausted. Add scheduled syncing only after real usage
and cost are understood.

Official references:

- [X API pricing](https://docs.x.com/x-api/getting-started/pricing)
- [OAuth access and credentials](https://docs.x.com/x-api/getting-started/getting-access)
- [User timeline integration](https://docs.x.com/x-api/posts/timelines/integrate)
- [X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)

## No-API demo workaround

For a tester demo that must not spend API credits, keep the current development
provider clearly labeled **Demo connection** and load deterministic sample posts.
It demonstrates consent, import, deduplication, disconnect, and optional
cross-post controls, but it must never be presented as a live X connection.

For real public content without account synchronization, a profile owner can add
an approved click-to-load X embed or paste individual X post URLs into a custom
widget. This is a display-only option: it does not import posts into the
Lumberyard, grant posting access, or silently track visitors before consent.

## Potential rollout plans

| Plan | What testers receive | Cost/risk | Best use |
| --- | --- | --- | --- |
| Demo provider | Complete UI with seeded posts; no X traffic | No API cost; not live | Early design and workflow testing |
| Manual live import | OAuth plus owner-clicked timeline imports and optional posting | Predictable pay-per-use | Recommended first public beta |
| Scheduled sync | OAuth plus background polling | Higher read cost and operational load | Later, after budgets and demand are measured |
| Display-only embed | Click-to-load X widget or post URL | Limited integration; third-party content | Profiles that only need an X presence |
