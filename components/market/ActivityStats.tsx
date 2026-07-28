import { formatTokenAmount } from "@/lib/trade";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";

type SaleLike = {
  tokenId: string;
  priceWei: string | null;
  timestamp: string | null;
};

type Props = {
  sales: SaleLike[];
  rarity: Map<string, RarityLookup>;
  onSelectToken?: (tokenId: string) => void;
};

function stat(label: string, value: string, accent?: string) {
  return (
    <div className="rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5">
      <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">
        {label}
      </dt>
      <dd
        className="mt-0.5 font-display text-lg tabular-nums"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Priced-sale stats + a dependency-free price-history sparkline, computed
 * entirely from the same activity feed the list already fetched — no
 * separate data source, so this can never drift from what's shown below it.
 * This is the desktop sidebar that turns the wide empty column next to a
 * narrow activity list into the volume/floor-trend data every established
 * marketplace (OpenSea, Blur, Magic Eden) leads with.
 */
export default function ActivityStats({ sales, rarity, onSelectToken }: Props) {
  const priced = sales
    .filter((s): s is SaleLike & { priceWei: string } => s.priceWei != null)
    .map((s) => ({ ...s, wei: BigInt(s.priceWei) }));

  if (priced.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gold-500/25 bg-black/10 px-3 py-6 text-center text-xs text-foreground/45">
        No priced sales yet — stats appear once trades settle.
      </div>
    );
  }

  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const last24h = priced.filter((s) => s.timestamp && new Date(s.timestamp).getTime() >= dayAgo);

  const sumWei = (rows: typeof priced) => rows.reduce((acc, r) => acc + r.wei, BigInt(0));
  const totalVolumeWei = sumWei(priced);
  const volume24hWei = sumWei(last24h);
  const avgWei = priced.length ? totalVolumeWei / BigInt(priced.length) : BigInt(0);

  const top = priced.reduce((best, r) => (r.wei > best.wei ? r : best), priced[0]);

  // Oldest → newest, last 24 points, for the sparkline — matches how the
  // feed itself reads top-to-newest, just reversed for a left-to-right chart.
  const series = [...priced].reverse().slice(-24);
  const maxWei = series.reduce((m, r) => (r.wei > m ? r.wei : m), BigInt(1));
  const points = series
    .map((r, i) => {
      const x = series.length > 1 ? (i / (series.length - 1)) * 100 : 100;
      const ratio = Number(r.wei) / Number(maxWei || BigInt(1));
      const y = 32 - ratio * 28 - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const topRarity = rarity.get(top.tokenId);

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2">
        {stat("24h volume", `${formatTokenAmount(volume24hWei, 18, 3)} Ξ`)}
        {stat("Total volume", `${formatTokenAmount(totalVolumeWei, 18, 2)} Ξ`)}
        {stat("Priced sales", String(priced.length))}
        {stat("Avg price", `${formatTokenAmount(avgWei, 18, 4)} Ξ`)}
      </dl>

      <div className="rounded-lg border border-gold-500/20 bg-black/20 p-3">
        <p className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">
          Price history · last {series.length} sales
        </p>
        <svg viewBox="0 0 100 32" className="mt-2 h-16 w-full" preserveAspectRatio="none">
          <polyline
            points={points}
            fill="none"
            stroke="#f8d98a"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      <button
        type="button"
        onClick={onSelectToken ? () => onSelectToken(top.tokenId) : undefined}
        disabled={!onSelectToken}
        className="w-full rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5 text-left transition hover:border-gold-400 disabled:cursor-default disabled:hover:border-gold-500/20"
      >
        <p className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">
          Top sale
        </p>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-bold text-foreground">
            #{top.tokenId}
            {topRarity && (
              <span
                className="tier-badge rounded-full px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide text-wood-950"
                style={{ backgroundColor: tierColor(topRarity.tier) }}
              >
                {topRarity.tier}
              </span>
            )}
          </span>
          <span className="font-mono text-sm font-bold text-gold-300">
            {formatTokenAmount(top.wei, 18, 4)} Ξ
          </span>
        </div>
      </button>
    </div>
  );
}
