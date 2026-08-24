/**
 * Same-origin, live on-chain proxy for a single CryptoPunk's real image --
 * read directly from Larva Labs' own CryptoPunksData contract
 * (punkImageSvg(uint16), selector 0x74beb047, live-verified against the
 * deployed contract at 0x16f5a35647d6f03d5d3da7b35409d65ba03af3b2), not
 * hotlinked from larvalabs.com.
 *
 * Why this exists instead of storing the ~14-18KB SVG payload directly as a
 * `data:` URI in plank_collection_tokens.image_url: that would embed the
 * full SVG in every /api/market/multichain/tokens browse response (an
 * 800-token page would balloon to ~13MB). This route stores a short,
 * cacheable URL instead and does the real chain read once per punk index,
 * ever -- the response is content-addressed (the image at index N never
 * changes) so the cache profile is the same "immutable" one
 * app/api/ipfs/image uses for content-addressed art.
 */
import { Interface } from "ethers";
import { cachedBinary } from "@/lib/http-cache";
import { publicError, publicJson, rateLimit } from "@/lib/security";
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CRYPTOPUNKS_DATA_CONTRACT = "0x16f5a35647d6f03d5d3da7b35409d65ba03af3b2";
const CHAIN_SLUG = "eth-mainnet";

const punksData = new Interface(["function punkImageSvg(uint16 index) view returns (string svg)"]);

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "onchain-cryptopunks-image", limit: 3000, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("index");
  const index = raw == null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 0 || index > 9999) {
    return publicJson({ error: "BAD_INDEX", message: "index must be an integer 0-9999." }, 400);
  }

  try {
    const callData = punksData.encodeFunctionData("punkImageSvg", [index]);
    const { result } = await rpcCall<string>(CHAIN_SLUG, "eth_call", [{ to: CRYPTOPUNKS_DATA_CONTRACT, data: callData }, "latest"]);
    const [svg] = punksData.decodeFunctionResult("punkImageSvg", result);
    if (typeof svg !== "string" || !svg.startsWith("data:image/svg+xml")) {
      return publicError(new Error("Unexpected on-chain payload shape"), "Could not load this punk's image right now.");
    }
    const commaIndex = svg.indexOf(",");
    const markup = commaIndex === -1 ? svg : svg.slice(commaIndex + 1);
    const bytes = new TextEncoder().encode(markup);
    return cachedBinary(bytes.buffer as ArrayBuffer, "image/svg+xml", "immutable");
  } catch (error) {
    return publicError(error, "Could not load this punk's image right now.");
  }
}
