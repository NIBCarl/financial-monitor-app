/**
 * Theme and Design System based on HCI & Mobile Touch Guidelines
 * - Main: Sky Blue (#0ea5e9 / #0284c7)
 * - Deep: Deep Blue (#0c4a6e / #075985 / #1e3a8a)
 * - Supporting: White (#ffffff) and Black / Dark Slate (#0f172a / #000000)
 * - Minimum Touch Target: 48x48dp (Fitts' Law)
 */

export const AppColors = {
  // Main Sky Blue Palette
  sky: {
    50: '#f0f9ff',
    100: '#e0f2fe',
    200: '#bae6fd',
    300: '#7dd3fc',
    400: '#38bdf8',
    500: '#0ea5e9', // Primary Main Brand
    600: '#0284c7', // Primary High Contrast
    700: '#0369a1',
  },

  // Deep Blue Palette
  deepBlue: {
    800: '#075985',
    900: '#0c4a6e', // Primary Deep Navy
    950: '#082f49', // Deepest Slate Blue
    navy: '#0a192f',
  },

  // Monochrome
  white: '#ffffff',
  black: '#000000',

  // Slate Neutral Grayscale
  slate: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
  },

  // Semantic Alerts
  danger: {
    light: '#fef2f2',
    border: '#fecaca',
    main: '#dc2626',
    dark: '#991b1b',
  },
  warning: {
    light: '#fffbeb',
    border: '#fde68a',
    main: '#d97706',
    dark: '#92400e',
  },
  success: {
    light: '#f0fdf4',
    border: '#bbf7d0',
    main: '#16a34a',
    dark: '#166534',
  },
} as const;

export const AppHCI = {
  // Fitts' Law touch target standards
  minTouchTarget: 48,
  minIconTarget: 44,

  // Visual Comfort & Hierarchy
  radius: {
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    full: 9999,
  },

  // Spacing
  spacing: {
    xs: 4,
    sm: 8,
    md: 14,
    lg: 20,
    xl: 28,
  },
} as const;
