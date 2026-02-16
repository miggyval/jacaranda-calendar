const UQ_PALETTE = [
  "#51247a",
  "#962a8b",
  "#2ea836",
  "#eb602b",
  "#4085c6",
  "#00a2c7",
  "#e62645",
  "#fbb800",
  "#bb9d65",
  "#999490",
  "#d7d1cc"
];

const courseColorMap = new Map<string, string>();
let nextColorIndex = 0;

export function courseToColor(courseCode: string): string {
  if (!courseColorMap.has(courseCode)) {
    const color = UQ_PALETTE[nextColorIndex];
    courseColorMap.set(courseCode, color);
    nextColorIndex = (nextColorIndex + 1) % UQ_PALETTE.length;
  }

  return courseColorMap.get(courseCode)!;
}


export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
