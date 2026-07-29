/**
 * Shown while orders load. Without it the grid renders "No listings yet — be
 * the first to sell" for a beat on every visit, so a populated marketplace
 * flashes as empty.
 */
export default function ListingSkeleton() {
  return (
    <ul
      className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5"
      aria-hidden="true"
    >
      {Array.from({ length: 10 }, (_, i) => (
        <li key={i} className="dense-card overflow-hidden p-0">
          <div className="aspect-square w-full animate-pulse bg-wood-900/90" />
          <div className="space-y-1.5 p-2.5">
            <div className="h-3 w-1/2 animate-pulse rounded bg-wood-900/90" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-wood-900/90" />
            <div className="h-9 w-full animate-pulse rounded-md bg-wood-900/90" />
          </div>
        </li>
      ))}
    </ul>
  );
}
