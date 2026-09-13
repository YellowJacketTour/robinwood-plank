export const TILE_WIDTH = 80;
export const TILE_HEIGHT = 40;
export function projectCell(x: number, y: number) {
  return { x: 360 + (x - y) * TILE_WIDTH / 2, y: 70 + (x + y) * TILE_HEIGHT / 2 };
}
export function unprojectPoint(x: number, y: number) {
  const dx = (x - 360) / (TILE_WIDTH / 2);
  const dy = (y - 70) / (TILE_HEIGHT / 2);
  return { x: (dx + dy) / 2, y: (dy - dx) / 2 };
}
export type CropStage = "empty" | "seedling" | "growing" | "ripe" | "compost";
export type ScenePlot = { plotIndex: number; crop: string | null; ripeAt: string | null; compostAfter: string | null; revision: string; tended?: boolean };
export function cropStage(plot: ScenePlot, now: number): CropStage {
  if (!plot.crop || !plot.ripeAt || !plot.compostAfter) return "empty";
  if (now >= Date.parse(plot.compostAfter)) return "compost";
  if (now >= Date.parse(plot.ripeAt)) return "ripe";
  const duration = (plot.crop === "stalk" ? 4 : 16) * 3600000;
  return now < Date.parse(plot.ripeAt) - duration * 0.65 ? "seedling" : "growing";
}
export function plotCell(index: number) { return { x: 2.5 + (index % 3) * 2, y: 3.5 + Math.floor(index / 3) * 2 }; }
