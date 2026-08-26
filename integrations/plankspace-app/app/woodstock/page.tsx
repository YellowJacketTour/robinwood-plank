import Link from "next/link";

export const dynamic = "force-static";

export default function WoodstockComingSoon() {
  return (
    <main className="min-h-[70vh] grid place-items-center px-4 py-16">
      <section className="max-w-2xl text-center plank-card">
        <p className="eyebrow">PlankSpace</p>
        <h1>Coming Soon</h1>
        <p>Woodstock is being rebuilt. The old live-room provider is not active in this release.</p>
        <Link href="/plankspace">Back to PlankSpace</Link>
      </section>
    </main>
  );
}
