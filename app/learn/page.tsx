import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import LearnGuide from "@/components/learn/LearnGuide";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Learn",
  description:
    "Learn how RobinWood minting, $PLANK trading, Marketplank, Seaport orders, Instant Swap vaults, and Robinhood Chain fit together.",
  path: "/learn",
  keywords: ["RobinWood guide", "Marketplank guide", "Robinhood Chain tutorial"],
});

export default function LearnPage() {
  return (
    <>
      <Nav />
      <main className="flex-1 px-3 py-10 sm:px-5">
        <div className="mx-auto w-full max-w-3xl lg:max-w-4xl">
          <LearnGuide />
        </div>
      </main>
      <Footer />
    </>
  );
}
