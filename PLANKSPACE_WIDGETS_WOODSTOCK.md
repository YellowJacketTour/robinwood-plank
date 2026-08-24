# PlankSpace Widgets + Woodstock Live

## Deploy

1. Extract this project over the existing workspace.
2. Configure `NEXT_PUBLIC_JITSI_DOMAIN` (use `meet.jit.si` for testing; use a controlled Jitsi/JaaS deployment for production).
3. Configure only the RPC URLs for chains allowed by Toss a Chip receipt verification. Never use wallet private keys.
4. Run `npm run db:migrate` once, then `npm run build`.

Migration `034_plankspace_widgets_woodstock.sql` adds profile widgets, verified tips, live rooms, and live-room membership. It is append-only.

## Security boundaries

- Custom widgets accept sanitized HTML and CSS only. Script, event-handler, form, embed, object, and iframe markup is stripped.
- Wallet sends only originate from the trusted Toss a Chip component after an explicit summary and user confirmation.
- PlankSpace never holds tip funds. A server route checks the mined transaction sender, recipient, value, chain, and success status before it appears.
- Portfolio data is hidden by default. Only manually listed assets and wallets are stored; hidden portfolio details are removed from public API responses.
- Public live-room responses expose profile handles and opaque member IDs, not wallet addresses or auth data.

## Woodstock production note

Public Jitsi is suitable for testing. Strong media-layer enforcement (moderator JWTs, server-side participant ejection, and anti-impersonation) requires a controlled Jitsi or JaaS deployment. PlankSpace role and moderation state is already isolated from the Jitsi adapter so that upgrade does not require rebuilding the lounge UI or widget system.
