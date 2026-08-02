import { SkeletonCardGrid, SkeletonStatus } from "@/components/Skeleton";

/**
 * Shown while orders load. Without it the grid renders "No listings yet — be
 * the first to sell" for a beat on every visit, so a populated marketplace
 * flashes as empty.
 */
export default function ListingSkeleton() {
  return (
    <>
      <SkeletonStatus>Loading listings</SkeletonStatus>
      <SkeletonCardGrid
        columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
        action
      />
    </>
  );
}
