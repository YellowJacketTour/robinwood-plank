# plank.love DNS — Porkbun + Cloudflare (2026-07-29)

## What is correct right now (registry / public internet)

| Layer | Value |
|-------|--------|
| Registrar | **Porkbun LLC** (owns the domain registration) |
| Registry nameservers (authoritative) | `arushi.ns.cloudflare.com`, `rick.ns.cloudflare.com` |
| Registry last NS change | **2026-07-29 ~15:37 UTC** (today) |
| Public A (Google/CF DoH) | `104.21.11.182`, `172.67.166.238` (Cloudflare) |
| App host | Cloudflare Worker `plank-love` (OpenNext) |

Public resolvers that honor the registry → **site works**.

## What is broken (Porkbun’s *old* DNS zone)

If you **query Porkbun nameservers directly** (`curitiba.ns.porkbun.com` etc.):

- They still **claim** NS = Porkbun’s four servers
- They return **no A / no AAAA** for `plank.love` (empty answer)
- Earlier they returned Vercel `76.76.21.21` (since removed)

So:

1. Phones/carriers that still **cache Porkbun as NS** (from before today’s switch, or long TTL) ask Porkbun.
2. Porkbun has **no host address** → connection fails / odd 404s / blank.
3. That is **not** “mobile hosting off” — it is a **stale nameserver cache + empty Porkbun zone**.

`workers.dev` works on the same phone because it never went through Porkbun DNS.

## Correct architecture (do not use GitHub Pages)

```
Phone → DNS → Cloudflare NS → CF Worker (Next.js + APIs + vault)
                ↑
         Registry (Porkbun as registrar only)
```

GitHub Pages cannot run API routes / vault / SSE / wallet. Keep Cloudflare.

## Fix in Porkbun dashboard (do both)

### A) Nameservers (must be Cloudflare only)

1. https://porkbun.com/account/domains  
2. **plank.love** → **Details** → **Nameservers** → Edit  
3. Set **only**:

```text
arushi.ns.cloudflare.com
rick.ns.cloudflare.com
```

4. Save. Remove any Porkbun default NS and any `vercel-dns.com` NS.

### B) DNS records at Porkbun (safety net for sticky NS cache)

Even with Cloudflare NS, fill the **Porkbun DNS zone** so leftover caches don’t get NODATA:

1. Same domain → **DNS Records**  
2. **Delete** anything pointing at Vercel, pixie.porkbun.com, or empty junk.  
3. **Add**:

| Type | Host | Answer |
|------|------|--------|
| A | *(blank / @)* | `104.21.11.182` |
| A | *(blank / @)* | `172.67.166.238` |
| A | `www` | `104.21.11.182` |
| A | `www` | `172.67.166.238` |
| AAAA | *(blank)* | `2606:4700:3031::ac43:a6ee` |
| AAAA | *(blank)* | `2606:4700:3034::6815:bb6` |
| AAAA | `www` | `2606:4700:3031::ac43:a6ee` |
| AAAA | `www` | `2606:4700:3034::6815:bb6` |

TTL: 600 if offered.

These IPs are the live Cloudflare anycast addresses for the zone. With `Host: plank.love`, CF still serves the Worker.

### C) Turn off Porkbun “URL Forwarding” / parking

Details → **URL Forwarding**: disable any redirect/park that could intercept HTTP.

## After saving

1. Phone: airplane mode on 15s → off (or reboot).  
2. Open Safari first: `https://plank.love/market`  
3. Then wallet browser.

Optional: set phone DNS to `1.1.1.1` to force Cloudflare resolvers.

## Verify (from any machine)

```bash
# Must show Cloudflare NS
nslookup -type=NS plank.love 8.8.8.8

# Must show 104.21 / 172.67
nslookup -type=A plank.love 8.8.8.8

# Must 200
curl -sI https://plank.love/market
```

## Temporary bridge

If a client still hits old Vercel anycast for `plank.love`, Vercel project `plank-love-bridge` **302**s to:

`https://plank-love.garden-equity-field-0042.workers.dev/...`

That is a band-aid. Fix A+B above so everyone uses Cloudflare DNS only.
