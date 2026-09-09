import { SkeletonCardGrid, SkeletonStats, SkeletonStatus } from "@/components/Skeleton";

export default function LoadingCollection() {
  return (
    <main className="mx-auto w-full max-w-[1440px] space-y-4 p-4" aria-busy="true">
      <SkeletonStatus>Opening collection</SkeletonStatus>
      <SkeletonStats count={4} columns="grid-cols-2 sm:grid-cols-4" />
      <SkeletonCardGrid columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" action />
    </main>
  );
}
