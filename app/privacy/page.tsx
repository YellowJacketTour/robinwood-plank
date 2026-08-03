import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { createPageMetadata } from "@/lib/seo";
import {
  LegalClause,
  LegalH2,
  LegalHeader,
  LegalNote,
  LegalTodo,
  LegalUl,
} from "@/components/legal/LegalProse";

export const metadata = createPageMetadata({
  title: "Privacy",
  description:
    "What plank.love actually does and doesn't collect: no accounts, public chain data, PostgreSQL-stored marketplace orders, localStorage caches, and the third parties involved.",
  path: "/privacy",
  keywords: ["RobinWood privacy", "$PLANK privacy policy"],
});

const LAST_UPDATED = "August 2, 2026";

export default function PrivacyPage() {
  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1 px-3 py-10 sm:px-5">
        <article className="wood-ledger mx-auto w-full max-w-3xl space-y-1 rounded-2xl p-5 sm:p-8">
          <LegalHeader
            eyebrow="What actually happens to your data"
            title="Privacy Policy"
            dek="There's no account to make, so there's not much to leak. Here's the honest inventory of what plank.love does and doesn't know about you."
            lastUpdated={LAST_UPDATED}
          />

          <LegalH2 id="no-accounts">1. No accounts, no passwords</LegalH2>
          <LegalClause>
            plank.love has no user accounts, no sign-up, and no password anywhere on the site.
            Everything that identifies you to us is your connected wallet address, and only for
            as long as you keep the wallet connected. Admin access works the same way, by signed
            wallet message, not a login form.
          </LegalClause>

          <LegalH2 id="wallet-data">2. Your wallet address</LegalH2>
          <LegalClause>
            Your wallet address is public information on Robinhood Chain — anyone can look it up
            regardless of whether you ever visit this site. When you connect a wallet, we read
            your address (and public on-chain data associated with it — token balances, NFT
            ownership, order history) to show you your own holdings, listings, and offers.
          </LegalClause>
          <LegalClause>
            We keep a server-side snapshot of which wallet owns which RobinWood NFT (the
            &quot;owner index&quot;), rebuilt periodically from Blockscout/Alchemy so pages don&apos;t have
            to make a live chain call for every visitor. It is display-only — a convenience
            cache, not the authoritative record (the chain is), and not used to build a profile
            of you beyond &quot;this address currently owns these tokens.&quot;
          </LegalClause>

          <LegalH2 id="what-we-store">3. What we store in our database</LegalH2>
          <LegalClause>
            PostgreSQL is the only datastore behind plank.love — there is no separate analytics
            database, CRM, or ad platform integration.
          </LegalClause>
          <LegalUl
            items={[
              "Marketplank orders: when you create a listing or an offer, your wallet signs a Seaport order and we store that signed order (the offer/consideration terms and your signature) so it can be shown to other visitors and fulfilled on chain. This is store-and-forward, not custody — we never hold your NFT or your funds, only the signed instructions.",
              "Site content managed by admins (the Learn page, feature flags, the WoodAmp playlist) — not personal data about visitors.",
              "Admin action logs, for wallets that hold admin access — again, not visitor data.",
            ]}
          />

          <LegalH2 id="local-storage">4. What stays on your device</LegalH2>
          <LegalClause>
            Some things never leave your browser. We use{" "}
            <code className="rounded bg-black/30 px-1 py-0.5 text-[0.85em]">localStorage</code>{" "}
            for things like your WoodAmp mute preference, and local caches of NFT metadata,
            rarity data, and chain reads so pages load faster on a repeat visit. These caches are
            performance optimizations only — they are not sent to us and we cannot read another
            visitor&apos;s browser storage.
          </LegalClause>

          <LegalH2 id="uploads">5. Uploads</LegalH2>
          <LegalUl
            items={[
              "Meme submissions (the Memes page): if you submit an image or video, it is sent from your browser through our server to a third party, the Community Meme Vault (memes.smoothbrain.app), along with whatever title/creator name/description/tags/source URL you provide. It sits in their moderation queue and is not published until approved. See our Terms for what you're agreeing to when you submit something.",
              "Admin media uploads (music/playlist files): restricted to wallets with admin access, verified by a signed message — not something a regular visitor can trigger, and not personal data collection.",
            ]}
          />

          <LegalH2 id="edge-and-logs">6. Cloudflare and request logs</LegalH2>
          <LegalClause>
            Cloudflare sits in front of plank.love as the network edge (DNS, TLS, and basic abuse
            protection) — the same as it does for most modern sites. It sees standard connection
            metadata (like your IP address) the way any site behind Cloudflare&apos;s network does.
          </LegalClause>
          <LegalClause>
            Our own server uses your IP address for short-lived, in-memory rate limiting only —
            to stop one visitor from spamming an endpoint (like meme submissions or quote
            requests). These rate-limit counters are not written to our database and are not
            retained as a log of who visited what.
          </LegalClause>

          <LegalH2 id="third-parties">7. Third parties that see a request when you use the site</LegalH2>
          <LegalClause>
            Depending on what you do on the site, a request can reach one of these services (each
            has its own privacy practices, outside our control — see our Terms):
          </LegalClause>
          <LegalUl
            items={[
              "IPFS gateways — to load NFT metadata and artwork.",
              "Blockscout / Alchemy — to read Robinhood Chain data (balances, ownership, activity).",
              "Uniswap Trading API and 0x — to get swap quotes and route trades on the Trade page.",
              "WalletConnect / Reown — to establish and maintain your wallet connection.",
              "The Community Meme Vault (memes.smoothbrain.app) — to load and accept meme submissions on the Memes page.",
            ]}
          />
          <LegalClause>
            We do not use these to build advertising profiles, and we do not sell your data to
            anyone.
          </LegalClause>

          <LegalH2 id="no-ads">8. No ad trackers, nothing sold</LegalH2>
          <LegalClause>
            plank.love does not run third-party advertising trackers or analytics pixels, and we
            do not sell visitor data. The only data we handle beyond what&apos;s described above is
            what&apos;s necessary to operate the marketplace, mint, and trade features you actually
            use.
          </LegalClause>
          <LegalNote>
            This section describes what the code in this repository actually does as of the date
            above. If that ever changes — a new analytics tool, a new integration that sends
            visitor data somewhere new — this page needs to be updated in the same change, not
            after the fact.
          </LegalNote>

          <LegalH2 id="changes">9. Changes to this policy</LegalH2>
          <LegalClause>
            If how we handle data changes, we&apos;ll update this page and its &quot;last updated&quot;
            date. Material changes may also be announced elsewhere on the site.
          </LegalClause>

          <LegalH2 id="contact">10. Contact</LegalH2>
          <LegalTodo>
            Insert a real contact address once one exists (support/privacy email or a form).
          </LegalTodo>

          <LegalClause>
            Related reading: our{" "}
            <Link href="/terms" className="text-gold-300 underline underline-offset-2">
              Terms of Use
            </Link>{" "}
            covers risk, self-custody, and the rules for using the site.
          </LegalClause>
        </article>
      </main>
      <Footer />
    </>
  );
}
