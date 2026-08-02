import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import LearnGuide from "@/components/learn/LearnGuide";
import { createPageMetadata } from "@/lib/seo";
import { getContent } from "@/lib/content-store";
import type { LearnDoc } from "@/lib/content-docs";

export const dynamic = "force-dynamic";

export const metadata = createPageMetadata({
  title: "Learn",
  description:
    "Learn how RobinWood minting, $PLANK trading, Marketplank, Seaport orders, Instant Swap vaults, and Robinhood Chain fit together.",
  path: "/learn",
  keywords: ["RobinWood guide", "Marketplank guide", "Robinhood Chain tutorial"],
});

export default async function LearnPage() {
  const learn = (await getContent("learn")) as LearnDoc;

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1 px-3 py-10 sm:px-5">
        <LearnGuide hidden={learn.hidden} overrides={learn.overrides} />
      </main>
      <Footer />
    </>
  );
}
