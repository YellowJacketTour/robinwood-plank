import { ImageResponse } from "next/og";

export const alt = "RobinWood ($PLANK) — Plank is Plank.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #1b120a 0%, #14100b 45%, #0d1f16 100%)",
          color: "#f3e8d0",
          fontSize: 90,
          fontWeight: 700,
        }}
      >
        <div style={{ display: "flex", fontSize: 48 }}>🪵</div>
        <div style={{ display: "flex", color: "#eec164" }}>RobinWood ($PLANK)</div>
        <div style={{ display: "flex", fontSize: 40, color: "#f3e8d0", marginTop: 20 }}>Plank is Plank.</div>
      </div>
    ),
    { ...size }
  );
}
