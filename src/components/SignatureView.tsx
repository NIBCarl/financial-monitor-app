import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Line } from 'react-native-svg';
import { parseStoredStrokes, strokesToSvgPath } from '../utils/signature';
import { formatDbDateTime } from '../utils/financial';

interface SignatureViewProps {
  /** Stored JSON strokes, straight from the database row. */
  strokes: string | null | undefined;
  signerName?: string | null;
  takenAt?: string | null;
  width?: number;
  height?: number;
  /** Shown instead of the box when nothing has been signed yet. */
  emptyLabel?: string;
}

/**
 * Renders a stored signature.
 *
 * Reads the same normalised strokes the capture pad wrote, so what the borrower drew is what gets
 * shown here, on the receipt and in the PDF — one representation, three surfaces.
 */
export const SignatureView: React.FC<SignatureViewProps> = ({
  strokes,
  signerName,
  takenAt,
  width = 260,
  height = 90,
  emptyLabel = 'Not signed',
}) => {
  const parsed = useMemo(() => parseStoredStrokes(strokes), [strokes]);
  const path = useMemo(() => strokesToSvgPath(parsed, width, height), [parsed, width, height]);

  if (parsed.length === 0) {
    return (
      <View style={[styles.empty, { width, height }]}>
        <Text style={styles.emptyText}>{emptyLabel}</Text>
      </View>
    );
  }

  return (
    <View>
      <View style={[styles.box, { width, height }]}>
        <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <Path
            d={path}
            fill="none"
            stroke="#0f172a"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Line
            x1={8}
            y1={height - 8}
            x2={width - 8}
            y2={height - 8}
            stroke="#cbd5e1"
            strokeWidth={1}
          />
        </Svg>
      </View>
      {(signerName || takenAt) && (
        <Text style={styles.caption}>
          {signerName ? `Signed by ${signerName}` : 'Signed'}
          {takenAt ? ` • ${formatDbDateTime(takenAt)}` : ''}
        </Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  box: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderStyle: 'dashed',
  },
  emptyText: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600',
  },
  caption: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 4,
  },
});

export default SignatureView;
