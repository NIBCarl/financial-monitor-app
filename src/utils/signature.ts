import type { SignatureStrokes } from '../db/types';

/**
 * Signature geometry (report §20.6).
 *
 * A signature is stored as normalised pen strokes, never as a bitmap. That keeps it small, keeps it
 * sharp on a printed statement, and means the same data can be drawn by the capture pad, by the
 * receipt card and by the PDF print engine. All three go through the functions here so a signature
 * cannot look like one thing on screen and another on paper.
 *
 * Pure and covered by the verification harness.
 */

/** Anything shorter than this is a stray tap, not a mark. */
const MIN_POINT_DISTANCE = 0.004;

/** Converts captured points to normalised 0..1 coordinates, dropping jitter. */
export function normaliseStrokes(
  points: { x: number; y: number }[][],
  width: number,
  height: number
): SignatureStrokes {
  if (width <= 0 || height <= 0) return [];

  const clamp = (v: number) => Math.min(1, Math.max(0, v));

  return points
    .map((stroke) => {
      const kept: { x: number; y: number }[] = [];
      for (const point of stroke) {
        const normalised = { x: clamp(point.x / width), y: clamp(point.y / height) };
        const last = kept[kept.length - 1];
        if (
          last &&
          Math.abs(last.x - normalised.x) < MIN_POINT_DISTANCE &&
          Math.abs(last.y - normalised.y) < MIN_POINT_DISTANCE
        ) {
          continue;
        }
        kept.push({ x: round4(normalised.x), y: round4(normalised.y) });
      }
      return kept;
    })
    .filter((stroke) => stroke.length > 0);
}

/** True when the strokes are too small to be a real signature (a tap or an accidental swipe). */
export function isSignatureTooSmall(strokes: SignatureStrokes): boolean {
  const points = strokes.reduce((sum, stroke) => sum + stroke.length, 0);
  return points < 4;
}

/** SVG path data for a signature box of `width` x `height`. Empty string when there is nothing. */
export function strokesToSvgPath(strokes: SignatureStrokes, width: number, height: number): string {
  const parts: string[] = [];

  for (const stroke of strokes) {
    if (stroke.length === 0) continue;

    const scaled = stroke.map((p) => ({ x: p.x * width, y: p.y * height }));
    const [first, ...rest] = scaled;

    // A single point is drawn as a dot so a deliberate pen-touch still shows up.
    if (rest.length === 0) {
      parts.push(`M ${fixed(first.x)} ${fixed(first.y)} l 0.01 0`);
      continue;
    }

    parts.push(`M ${fixed(first.x)} ${fixed(first.y)}`);
    for (const point of rest) {
      parts.push(`L ${fixed(point.x)} ${fixed(point.y)}`);
    }
  }

  return parts.join(' ');
}

/**
 * Standalone SVG document for the PDF, sized to the block it sits in.
 *
 * The PDF print engine rasterises this, so the signature on the printed statement is the same
 * strokes the borrower drew, not a screenshot.
 */
export function signatureToSvgDocument(
  strokes: SignatureStrokes,
  width: number,
  height: number
): string {
  const path = strokesToSvgPath(strokes, width, height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ffffff"/><path d="${path}" fill="none" stroke="#0f172a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Parses stored JSON defensively: a corrupted row must render as "unsigned", never crash a receipt. */
export function parseStoredStrokes(stored: string | null | undefined): SignatureStrokes {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((stroke) => Array.isArray(stroke))
      .map((stroke: unknown[]) =>
        (stroke as unknown[])
          .filter(
            (point): point is { x: number; y: number } =>
              typeof point === 'object' &&
              point !== null &&
              Number.isFinite((point as { x: number }).x) &&
              Number.isFinite((point as { y: number }).y)
          )
          .map((point) => ({ x: point.x, y: point.y }))
      )
      .filter((stroke) => stroke.length > 0);
  } catch {
    return [];
  }
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function fixed(v: number): string {
  return (Math.round(v * 100) / 100).toFixed(2);
}
