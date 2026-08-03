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
  title: "Terms",
  description:
    "The plain-language terms for using plank.love: risk, no promised return, self-custody, user submissions, and third-party services.",
  path: "/terms",
  keywords: ["RobinWood terms", "$PLANK terms of use"],
});

const LAST_UPDATED = "August 2, 2026";

export default function TermsPage() {
  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1 px-3 py-10 sm:px-5">
        <article className="wood-ledger mx-auto w-full max-w-3xl space-y-1 rounded-2xl p-5 sm:p-8">
          <LegalHeader
            eyebrow="The fine print"
            title="Terms of Use"
            dek="Read this before you touch anything gold-colored. It&apos;s a meme project with a real wallet attached, so the jokes stop where the money starts."
            lastUpdated={LAST_UPDATED}
          />

          <LegalH2 id="what-this-is">1. What RobinWood is (and isn&apos;t)</LegalH2>
          <LegalClause>
            RobinWood, $PLANK, and every surface of plank.love (mint, Trade, Marketplank,
            Instant Swap, the Gallery, Memes, and everything else on this domain) are a meme
            project. There is no promised return, no guaranteed price, and no expectation of
            profit attached to holding, trading, minting, or providing liquidity for anything
            here.
          </LegalClause>
          <LegalClause>
            Nothing on this site is financial advice, investment advice, legal advice, or tax
            advice, and nothing here is an offer or solicitation to buy or sell a security. Do
            your own research. If you need advice, get it from a licensed professional, not from
            a cartoon plank.
          </LegalClause>

          <LegalH2 id="smart-contracts">2. Smart contracts don&apos;t get a redo</LegalH2>
          <LegalClause>
            The RobinWood NFT contract, the $PLANK token, Seaport (Marketplank&apos;s order
            protocol), and every Instant Swap vault are on-chain smart contracts. They are
            <strong> immutable</strong> once deployed — nobody, including us, can quietly patch a
            bug after the fact — and they have <strong>not been audited by an independent
            third-party security firm</strong>. Code that looks fine can still contain a bug or
            an exploit that neither we nor you can undo.
          </LegalClause>
          <LegalClause>
            Every transaction you sign on this site — a mint, a swap, a listing, an offer, a
            deposit, a redemption — is <strong>irreversible</strong> once it confirms on chain.
            There is no support ticket that reverses a transaction. You are solely responsible
            for your own wallet, private keys, and seed phrase; we never have access to them and
            cannot recover them for you.
          </LegalClause>
          <LegalNote>
            Total loss is a real possible outcome, not a disclaimer for show. Only ever risk what
            you can afford to lose completely.
          </LegalNote>

          <LegalH2 id="no-custody">3. We don&apos;t hold your wood (or your funds)</LegalH2>
          <LegalClause>
            plank.love is non-custodial. We do not hold, control, or have access to your ETH,
            $PLANK, NFTs, or LP position at any point. Marketplank orders are signed by your
            wallet and only ever executed by contracts you approve; Instant Swap deposits and
            redemptions move directly between your wallet and the vault contract. If a vault, the
            token contract, or your own wallet is compromised, we cannot reach in and make you
            whole.
          </LegalClause>

          <LegalH2 id="no-warranty">4. As-is, no warranty</LegalH2>
          <LegalClause>
            The site, the contracts, and everything on them are provided <strong>&quot;as
            is&quot;</strong> and <strong>&quot;as available,&quot;</strong> without warranty of
            any kind, express or implied — including, without limitation, any warranty of
            merchantability, fitness for a particular purpose, title, or non-infringement. We do
            not warrant that the site or any contract will be uninterrupted, error-free, or
            secure.
          </LegalClause>
          <LegalClause>
            To the fullest extent permitted by law, we disclaim liability for any loss arising
            from your use of the site, a smart contract, a third-party service linked from the
            site, or a bug, exploit, outage, or price movement — including total loss of funds.
          </LegalClause>

          <LegalH2 id="eligibility">5. Who can use this</LegalH2>
          <LegalUl
            items={[
              "You must be of legal age to enter into a binding contract where you live.",
              "You must not be located in, or a resident of, a country or region where using a site like this, or acquiring or trading a token or NFT like this, is prohibited by law or sanctions.",
              "You are responsible for knowing and following the law that applies to you — we don't and can't vet every visitor's jurisdiction.",
            ]}
          />

          <LegalH2 id="changes">6. Things may change or go away</LegalH2>
          <LegalClause>
            We may add, change, pause, or discontinue any feature of the site — Trade, Instant
            Swap, Marketplank, minting, WoodAmp, Memes, or anything else — at any time, with or
            without notice. Features described here or elsewhere on the site (fee rates, vault
            availability, supported chains) reflect how things work today and are not a promise
            of how they will work tomorrow.
          </LegalClause>

          <LegalH2 id="ip">7. Owning a Plank doesn&apos;t buy you the lumber yard</LegalH2>
          <LegalClause>
            Owning a RobinWood NFT does not, by itself, transfer any intellectual-property
            rights beyond what is expressly stated on this site. Specifically, ownership of an
            NFT does not grant you rights to the RobinWood brand, the plank character art, the
            RobinWood name or logo, or any trademark, except as separately and explicitly
            granted. The underlying artwork and metadata remain subject to the rights described
            for the collection; NFT ownership is ownership of the token, not an automatic license
            to everything associated with it.
          </LegalClause>

          <LegalH2 id="submissions">8. User submissions (Memes)</LegalH2>
          <LegalClause>
            The Memes page lets visitors submit images and video to the Community Meme Vault, a
            third-party service operated at <code className="rounded bg-black/30 px-1 py-0.5 text-[0.85em]">memes.smoothbrain.app</code>{" "}
            (not run by us). By submitting anything there, you agree to the following:
          </LegalClause>
          <LegalUl
            items={[
              "You own what you submit, or you have the legal right to submit it. Don't upload someone else's art, footage, or likeness without permission.",
              "By submitting, you grant us and the Community Meme Vault permission to display, distribute, and reproduce your submission on plank.love, the Community Meme Vault, and related promotional surfaces.",
              "Do not upload other people's copyrighted work without a right to use it, illegal content, or anything infringing, defamatory, or otherwise unlawful.",
              "Submissions are moderated by a third party (the Community Meme Vault) and may be rejected or removed at their discretion or ours — nothing you submit is guaranteed to be published, and publication is not immediate.",
              "We are not responsible for content submitted by other users, and we do not pre-screen every submission before it reaches the moderation queue.",
            ]}
          />
          <LegalClause>
            To report a submission or request removal of your own content,{" "}
            <LegalTodoInline>
              insert an abuse/takedown contact (email address or form) once one exists.
            </LegalTodoInline>
          </LegalClause>

          <LegalH2 id="third-party">9. Third-party services we don&apos;t control</LegalH2>
          <LegalClause>
            plank.love links to, embeds, or depends on services we don&apos;t operate and can&apos;t
            control the uptime, accuracy, or policies of, including:
          </LegalClause>
          <LegalUl
            items={[
              "IPFS gateways (used to load NFT metadata and images)",
              "Blockscout (the block explorer for Robinhood Chain)",
              "OpenSea (referenced for order compatibility / discovery)",
              "Uniswap (quotes and swap routing on the Trade page)",
              "0x (used for certain swap routing)",
              "WalletConnect / Reown (wallet connection)",
              "The Community Meme Vault (memes.smoothbrain.app)",
            ]}
          />
          <LegalClause>
            Your use of any of these is subject to that service&apos;s own terms and privacy
            policy, and we are not responsible for their availability, content, or conduct.
          </LegalClause>

          <LegalH2 id="disputes">10. Governing law &amp; disputes</LegalH2>
          <LegalTodo>
            Insert governing law / jurisdiction and dispute-resolution terms (and the operating
            entity name, if one exists) once decided with counsel. Left blank rather than
            guessed.
          </LegalTodo>

          <LegalH2 id="contact">11. Contact</LegalH2>
          <LegalTodo>
            Insert a real contact address once one exists (support/legal email or a form).
          </LegalTodo>

          <LegalClause>
            Related reading: our{" "}
            <Link href="/privacy" className="text-gold-300 underline underline-offset-2">
              Privacy Policy
            </Link>{" "}
            covers what data plank.love actually touches.
          </LegalClause>
        </article>
      </main>
      <Footer />
    </>
  );
}

/** Inline variant of LegalTodo for a TODO that sits mid-sentence rather than
 * as its own block. */
function LegalTodoInline({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-amber-400/50 bg-amber-400/10 px-1.5 py-0.5 text-[0.85em] font-bold text-amber-200">
      TODO: {children}
    </span>
  );
}
