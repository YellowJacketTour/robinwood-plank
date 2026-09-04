import { rateLimit } from "@/lib/security";
import { saveUpload } from "@/lib/uploads";
import { type Proof, verifyAndConsumeProof } from "../auth/verify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const ALLOWED: Record<string, { kind: "image" | "video"; extensions: string[] }> = {
  "image/png": { kind: "image", extensions: ["png"] },
  "image/jpeg": { kind: "image", extensions: ["jpg", "jpeg"] },
  "image/webp": { kind: "image", extensions: ["webp"] },
  "image/gif": { kind: "image", extensions: ["gif"] },
  "video/mp4": { kind: "video", extensions: ["mp4"] },
  "video/webm": { kind: "video", extensions: ["webm"] },
};

export async function POST(request: Request) {
  const limited = rateLimit(request, { key: "plankspace-media-upload", limit: 15, windowMs: 60_000 });
  if (limited) return limited;

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES + 128 * 1024) {
    return Response.json({ error: "File is too large." }, { status: 413 });
  }

  let form: FormData;
  try { form = await request.formData(); }
  catch { return Response.json({ error: "Send multipart/form-data." }, { status: 400 }); }

  const file = form.get("file");
  const wallet = form.get("wallet");
  const sessionToken = form.get("sessionToken");
  if (!(file instanceof File) || typeof wallet !== "string" || typeof sessionToken !== "string") {
    return Response.json({ error: "Wallet session and file are required." }, { status: 400 });
  }

  const allowed = ALLOWED[file.type];
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!allowed || !allowed.extensions.includes(extension)) return Response.json({ error: "Use PNG, JPEG, WebP, GIF, MP4, or WebM media." }, { status: 415 });
  const kind = allowed.kind;
  const cap = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size <= 0 || file.size > cap) {
    return Response.json({ error: kind === "video" ? "Videos must be under 20 MB." : "Images and GIFs must be under 3 MB." }, { status: 413 });
  }

  const proof: Proof = { wallet, sessionToken };
  const verified = await verifyAndConsumeProof(proof, "media:upload", "plankspace", "");
  if (!verified) return Response.json({ error: "Connect and verify your wallet before uploading media." }, { status: 403 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const saved = await saveUpload(bytes, file.name);
  if ("error" in saved) return Response.json({ error: saved.error }, { status: 400 });
  return Response.json({ upload: { url: saved.url, mediaType: kind, bytes: saved.bytes } }, { status: 201 });
}
