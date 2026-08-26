import Link from "next/link";
import Image from "next/image";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

/**
 * Site-wide 404. Keeps the shared header and footer mounted so a mistyped
 * URL never drops a visitor onto a bare, unbranded page.
 */
export default function NotFound() {
  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 items-center px-4 py-16 sm:px-6"
      >
        <div className="wood-ledger mx-auto grid w-full max-w-3xl items-center gap-8 rounded-2xl p-6 sm:grid-cols-[auto_1fr] sm:p-10">
          <Image
            src="/images/plank-logo.webp"
            alt=""
            width={160}
            height={160}
            priority
            className="mx-auto h-32 w-32 object-contain sm:h-40 sm:w-40"
          />
          <div>
            <h1 className="font-display text-3xl text-gold-300 sm:text-4xl">
              This board isn&apos;t here.
            </h1>
            <p className="mt-3 max-w-prose text-cream/80">
              The page you asked for doesn&apos;t exist, moved, or was never nailed
              up in the first place.
            </p>
            <nav
              aria-label="Where to go instead"
              className="mt-6 flex flex-wrap gap-2"
            >
              <Link
                href="/"
                className="inline-flex min-h-11 items-center rounded-md bg-gold-500 px-4 font-bold text-wood-950 hover:bg-gold-400"
              >
                Back to plank.love
              </Link>
              <Link
                href="/market"
                className="inline-flex min-h-11 items-center rounded-md border border-line-strong px-4 font-bold text-gold-300 hover:bg-gold-500/10"
              >
                Marketplank
              </Link>
              <Link
                href="/plankspace"
                className="inline-flex min-h-11 items-center rounded-md border border-line-strong px-4 font-bold text-gold-300 hover:bg-gold-500/10"
              >
                PlankSpace
              </Link>
            </nav>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
