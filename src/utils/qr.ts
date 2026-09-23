import qrcode from 'qrcode-generator';

/**
 * QR rendering for receipts (report §20.5).
 *
 * The receipt already carries a signed token (`TV1~…`). Putting that token in a square means a
 * treasurer can hand over a receipt that anyone can *scan* rather than retype — the difference
 * between verification that happens and verification that is skipped.
 *
 * The encoder is a pure-JS library (`qrcode-generator`), so this needs no camera module, no native
 * code and no rebuild of anything but the JS bundle. `toModuleMatrix` and `toSvgRects` are pure and
 * are covered by the verification harness; the React component and the PDF both consume them so the
 * printed square and the on-screen square can never encode different data.
 */

/**
 * Encodes `text` and returns the module matrix, dark = true.
 *
 * ECC level M (the ISO default for general use) tolerates ~15% damage, which is what a phone camera
 * needs when the receipt is a slightly crumpled printout or a photo someone re-shared.
 */
export function toModuleMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const matrix: boolean[][] = [];
  for (let row = 0; row < count; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < count; col += 1) {
      line.push(qr.isDark(row, col));
    }
    matrix.push(line);
  }
  return matrix;
}

/**
 * SVG `<rect>` list for embedding in the HTML that becomes the PDF.
 *
 * Browsers render this as sharply as a bitmap QR but at any zoom, so a printed statement stays
 * scannable instead of turning into grey mush at 300 dpi.
 */
export function toSvgRects(text: string, sizePx = 132, quietZone = 4): string {
  const matrix = toModuleMatrix(text);
  const count = matrix.length;
  const total = count + quietZone * 2;
  const scale = sizePx / total;

  const rects: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!matrix[row][col]) continue;
      const x = (col + quietZone) * scale;
      const y = (row + quietZone) * scale;
      rects.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${scale.toFixed(2)}" height="${scale.toFixed(2)}"/>`
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${sizePx} ${sizePx}" role="img" aria-label="Receipt verification code"><rect width="${sizePx}" height="${sizePx}" fill="#ffffff"/><g fill="#000000">${rects.join('')}</g></svg>`;
}

/** Locates the three finder patterns — the invariants a scanner depends on most. */
export function hasFinderPatterns(matrix: boolean[][]): boolean {
  const count = matrix.length;
  const isFinder = (top: number, left: number): boolean => {
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 7; col += 1) {
        const onOuterRing = row === 0 || row === 6 || col === 0 || col === 6;
        const onInnerBlock = row >= 2 && row <= 4 && col >= 2 && col <= 4;
        const expected = onOuterRing || onInnerBlock;
        if (matrix[top + row][left + col] !== expected) return false;
      }
    }
    return true;
  };

  return isFinder(0, 0) && isFinder(0, count - 7) && isFinder(count - 7, 0);
}
