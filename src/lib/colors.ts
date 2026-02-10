const UQ_PALETTE = [
  "#51247a", // uq purple
  "#962a8b", // magenta
  "#2ea836", // green
  "#eb602b", // orange
  "#4085c6", // blue
];

export function courseToColor(courseCode: string): string {
  // stable hash -> stable palette index
  let h = 0;
  for (let i = 0; i < courseCode.length; i++) h = (h * 31 + courseCode.charCodeAt(i)) >>> 0;
  return UQ_PALETTE[h % UQ_PALETTE.length];
}

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
