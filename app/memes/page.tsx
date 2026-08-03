import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import MemeVault from "@/components/memes/MemeVault";
import { createPageMetadata } from "@/lib/seo";

/**
 * Community meme vault, filtered to the RobinWood project.
 *
 * Added to NAV_LINKS (2026-08) alongside the footer's "Keep exploring" list —
 * see lib/constants.ts. It stays indexable so a shared link still resolves
 * and previews properly; leave `index` alone unless that changes.
 */
export const metadata = createPageMetadata({
  title: "Memes",
  description:
    "Community-made RobinWood Plank memes, art, and videos from the Community Meme Vault.",
  path: "/memes",
  keywords: ["RobinWood memes", "Plank memes", "RobinWood community art"],
});

export default function MemesPage() {
  return (
    <>
      <AppBackdrop />
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <MemeVault />
      </main>
      <Footer />
    </>
  );
}
