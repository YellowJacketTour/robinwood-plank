export type Decoration = { id: number; x: number; y: number };
export const STARTER_DECORATIONS: Decoration[] = [
  {id:0,x:0,y:2},{id:1,x:1,y:0},{id:2,x:3,y:0},{id:3,x:7,y:0},
  {id:4,x:8,y:1},{id:5,x:0,y:5},{id:6,x:1,y:7},{id:7,x:0,y:8},
];
// The six permanently tilled crop footprints occupy x=2..7, y=3..6.
export function sceneryCell(x: number, y: number) {
  return Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&x<=8&&y>=0&&y<=8&&!(x>=2&&x<=7&&y>=3&&y<=6);
}
export function validDecorations(value: unknown): value is Decoration[] {
  if (!Array.isArray(value)||value.length!==8) return false;
  const ids=new Set<number>(),cells=new Set<string>();
  for (const item of value) {
    if (!item||!Number.isInteger(item.id)||item.id<0||item.id>7||!sceneryCell(item.x,item.y)) return false;
    ids.add(item.id);cells.add(`${item.x},${item.y}`);
  }
  return ids.size===8&&cells.size===8;
}
