import { getTrendingCollections } from "@/lib/market/trending";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const limited = rateLimit(req, { key: "discover:trending", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  try {
    const collections = await getTrendingCollections();
    return publicJson({ collections });
  } catch (error) {
    return publicError(error, "Trending collections unavailable.");
  }
}
