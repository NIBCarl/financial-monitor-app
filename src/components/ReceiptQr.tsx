import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { toModuleMatrix } from '../utils/qr';

interface ReceiptQrProps {
  /** The signed receipt token (`TV1~…`) — exactly what the verify screen expects. */
  value: string;
  size?: number;
}

/**
 * The QR square that goes on a receipt.
 *
 * Rendered as SVG rects rather than an image so the receipt stays sharp at any print size, and so
 * the same module matrix that the PDF uses is drawn here.
 */
export const ReceiptQr: React.FC<ReceiptQrProps> = ({ value, size = 116 }) => {
  const rects = useMemo(() => {
    const matrix = toModuleMatrix(value);
    const count = matrix.length;
    const scale = size / count;
    const out: { key: string; x: number; y: number }[] = [];

    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (matrix[row][col]) out.push({ key: `${row}-${col}`, x: col * scale, y: row * scale });
      }
    }

    return { out, count, scale };
  }, [value, size]);

  return (
    <View
      style={{
        backgroundColor: '#ffffff',
        padding: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#e2e8f0',
      }}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${rects.count} ${rects.count}`}>
        <Rect x={0} y={0} width={rects.count} height={rects.count} fill="#ffffff" />
        {rects.out.map((r) => (
          <Rect key={r.key} x={r.x} y={r.y} width={rects.scale} height={rects.scale} fill="#000000" />
        ))}
      </Svg>
    </View>
  );
};

export default ReceiptQr;
