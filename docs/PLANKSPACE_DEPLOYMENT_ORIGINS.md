# PlankSpace deployment origins

PlankSpace is the standalone application in `integrations/plankspace-app`. It
uses Cloudflare D1 and R2 and must be deployed with those bindings. The root
Plank.love application only embeds the reviewed standalone origin.

No test or developer-owned hostname is committed to source control.

## Plank.love environment

Set this on the Plank.love deployment:

```text
NEXT_PUBLIC_PLANKSPACE_URL=https://<standalone-plankspace-origin>
```

If it is unset, `/plankspace` displays a configuration notice instead of
loading an obsolete or unintended deployment.

## Standalone PlankSpace environment

Set these on the standalone PlankSpace deployment:

```text
NEXT_PUBLIC_SITE_URL=https://<standalone-plankspace-origin>
NEXT_PUBLIC_PLANKSPACE_PARENT_ORIGINS=https://<test-plank-love-origin>
PLANKSPACE_PARENT_ORIGINS=https://<test-plank-love-origin>
```

Multiple test parents may be supplied as a comma-separated list. Only add
origins controlled by the project because an authorized parent can request a
wallet signature through the bridge. `https://plank.love` and its HTTPS
subdomains are trusted by default.

## Vercel

Deploying the repository root to Vercel deploys Plank.love, not the standalone
PlankSpace service. The standalone package currently depends on Cloudflare D1,
R2, Worker bindings, and Vinext. It must not be represented as Vercel-compatible
until those backend dependencies are deliberately migrated.
