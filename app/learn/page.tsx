import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import LearnGuide from "@/components/learn/LearnGuide";
import { SITE_URL } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Learn — RobinWood, Marketplank, Vault & Platforms",
  description:
    "Tutorial-level guide to plank.love: mint, market, Instant Swap vault math, LP, Seaport, Robinhood Chain, and how every system fits together. Written for humans and AI readers.",
  openGraph: {
    title: "Learn RobinWood & Marketplank",
    description: "Complete logical progression through every facet of plank.love and its dependencies.",
    url: `${SITE_URL}/learn`,
  },
};

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
