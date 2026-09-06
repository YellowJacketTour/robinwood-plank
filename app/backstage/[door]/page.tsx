import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { doorSlug } from "@/lib/market-preview-door";
import DoorForm from "./DoorForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Backstage", robots: { index: false, follow: false } };

/**
 * The private entrance to the gated Marketplank. Any slug other than the
 * configured one is a plain 404, so the page is undiscoverable by guessing
 * paths. See lib/market-preview-door.ts.
 */
export default async function BackstagePage({ params }: { params: Promise<{ door: string }> }) {
  const { door } = await params;
  if (door !== doorSlug()) notFound();
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <DoorForm />
    </main>
  );
}
