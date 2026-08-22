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
          {PLANKSPACE_URL ? (
            <PlankSpaceFrame src={PLANKSPACE_URL} />
          ) : (
            <section className="rounded-xl border border-amber-500/40 bg-black/70 p-8 text-amber-50">
              <h1 className="text-2xl font-bold">PlankSpace is not configured</h1>
              <p className="mt-3 max-w-2xl text-amber-100/80">
                Set <code>NEXT_PUBLIC_PLANKSPACE_URL</code> to the reviewed
                PlankSpace deployment origin for this environment.
              </p>
            </section>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
