import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { profileWidgets, profiles } from "../../../db/schema";
import { hashJson } from "../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../auth/verify";
import { sanitizeWidget, widgetValidationErrors } from "../../widgets/widget-safety";

const handle = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
const read = (row: typeof profileWidgets.$inferSelect) => ({
  id: row.id,
  type: row.type,
  title: row.title,
  config: JSON.parse(row.configJson || "{}"),
  style: JSON.parse(row.styleJson || "{}"),
  sortOrder: row.sortOrder,
  visible: row.visible,
  desktopVisible: row.desktopVisible,
  mobileVisible: row.mobileVisible,
});
const publicRead = (row: typeof profileWidgets.$inferSelect) => {
  const widget = read(row);
  if (widget.type === "portfolio" && widget.config.mode === "hidden")
    widget.config = { mode: "hidden" };
  return widget;
};

export async function GET(request: Request) {
  const h = handle(new URL(request.url).searchParams.get("handle") || "");
  if (!h)
    return Response.json({ error: "Profile handle required" }, { status: 400 });
  const rows = await getDb()
    .select()
    .from(profileWidgets)
    .where(eq(profileWidgets.profileHandle, h))
    .orderBy(asc(profileWidgets.sortOrder));
  return Response.json({
    widgets: rows
      .filter((row) => row.visible && (row.desktopVisible || row.mobileVisible))
      .map(publicRead),
  });
}

export async function PUT(request: Request) {
  const payload = (await request.json()) as Proof & { handle?: string },
    h = handle(payload.handle || ""),
    wallet = await verifyAndConsumeProof(
      payload,
      "widgets:read",
      h,
      await hashJson({ handle: h })
    );
  if (!wallet)
    return Response.json(
      { error: "Signed profile-owner proof required" },
      { status: 403 }
    );
  const db = getDb(),
    [profile] = await db
      .select({ wallet: profiles.wallet })
      .from(profiles)
      .where(eq(profiles.handle, h))
      .limit(1);
  if (!profile || profile.wallet !== wallet)
    return Response.json(
      { error: "Only the profile owner may load private widget settings" },
      { status: 403 }
    );
  const rows = await db
    .select()
    .from(profileWidgets)
    .where(eq(profileWidgets.profileHandle, h))
    .orderBy(asc(profileWidgets.sortOrder));
  return Response.json({ widgets: rows.map(read) });
}

export async function POST(request: Request) {
  const payload = (await request.json()) as Proof & {
      handle?: string;
      widgets?: unknown[];
    },
    h = handle(payload.handle || ""),
    raw = Array.isArray(payload.widgets) ? payload.widgets.slice(0, 24) : [];
  const validationErrors = widgetValidationErrors(raw);
  if (validationErrors.length)
    return Response.json(
      { error: validationErrors.join(" "), validationErrors },
      { status: 400 }
    );
  const hash = await hashJson({ handle: h, widgets: raw }),
    widgets = raw.map(sanitizeWidget).filter(Boolean);
  const wallet = await verifyAndConsumeProof(payload, "widgets:save", h, hash);
  if (!wallet)
    return Response.json(
      { error: "Signed profile-owner proof required" },
      { status: 403 }
    );
  const db = getDb(),
    [profile] = await db
      .select({ wallet: profiles.wallet })
      .from(profiles)
      .where(eq(profiles.handle, h))
      .limit(1);
  if (!profile || profile.wallet !== wallet)
    return Response.json(
      { error: "Only the profile owner may change widgets" },
      { status: 403 }
    );
  await db.transaction(async (tx) => {
    await tx.delete(profileWidgets).where(eq(profileWidgets.profileHandle, h));
    if (widgets.length)
      await tx
        .insert(profileWidgets)
        .values(
          widgets.map((widget, index) => ({
            ownerWallet: wallet,
            profileHandle: h,
            type: widget!.type,
            title: widget!.title,
            configJson: JSON.stringify(widget!.config),
            styleJson: JSON.stringify(widget!.style),
            sortOrder: index,
            visible: widget!.visible,
            desktopVisible: widget!.desktopVisible,
            mobileVisible: widget!.mobileVisible,
            updatedAt: new Date().toISOString(),
          }))
        );
  });
  return Response.json({ widgets });
}
