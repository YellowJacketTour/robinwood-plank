import AppBackdrop from "@/components/AppBackdrop";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import PlankSpaceFrame from "@/components/plankspace/PlankSpaceFrame";
import { PLANKSPACE_URL } from "@/lib/constants";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "PlankSpace",
  description: "Wallet-owned Plank profiles and the Lumberyard.",
  path: "/plankspace",
  index: false,
});

export default function PlankSpacePage() {
  return (
    <>
      <AppBackdrop />
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1 px-2 py-3 sm:px-4">
        <div data-market-shell className="mx-auto w-full max-w-[1500px]">
          <PlankSpaceFrame src={PLANKSPACE_URL} />
        </div>
      </main>
      <Footer />
    </>
  );
}
