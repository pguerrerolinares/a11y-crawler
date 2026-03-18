/**
 * Pure WCAG contrast math — no browser dependencies.
 * Reference: https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
 */

export function parseRgba(css: string): [number, number, number, number] | null {
  // Match both comma-separated: rgb(255, 0, 128) rgba(255, 0, 128, 0.5)
  // and space-separated:        rgb(255 0 128)   rgb(255 0 128 / 0.5)
  const m = css.match(
    /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/,
  );
  if (!m) return null;
  let alpha = 1;
  if (m[4] !== undefined) {
    alpha = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  }
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), alpha];
}

export function alphaBlend(
  fg: [number, number, number, number],
  bg: [number, number, number],
): [number, number, number] {
  const a = fg[3];
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
  ];
}

export function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(rgb: [number, number, number]): number {
  return (
    0.2126 * srgbToLinear(rgb[0]) +
    0.7152 * srgbToLinear(rgb[1]) +
    0.0722 * srgbToLinear(rgb[2])
  );
}

export function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
