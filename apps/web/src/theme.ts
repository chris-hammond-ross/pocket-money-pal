/**
 * The arcade theme shared by the kiosk, setup and the parent phone (specs 001 and 003):
 * a deep navy background with a soft glow, panel colours, a dim text colour, the four
 * stage colours and gold for points. Fredoka is the text font; Press Start 2P is only for
 * small labels, the app title, setup headings and countdown numbers.
 *
 * The same values are exposed three ways:
 * - `arcade` below, for code (inline styles, canvas-confetti colours);
 * - Mantine colours (`gold`, `bonus`, `due`, `overdue`, `late`, and `dark` as navy);
 * - CSS variables (`--pmp-bg`, `--pmp-gold`, `--pmp-font-pixel`, …) for CSS modules.
 */
import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';

export const arcade = {
  bg: '#0f1024',
  glow: '#2b2d6e',
  panel: '#1a1b3a',
  panel2: '#23244d',
  sheet: '#15163a',
  line: '#3a3c7a',
  track: '#2d2f66',
  text: '#eef0ff',
  dim: '#8f93c7',
  bonus: '#37e28c',
  due: '#ffc93c',
  overdue: '#ff8a3c',
  late: '#ff4d6d',
  lateDark: '#b3364f',
  gold: '#ffd43b',
  goldShadow: '#b8941f',
  bonusShadow: '#1f9e5f',
} as const;

export const FONT_TEXT = 'Fredoka, "Segoe UI", system-ui, sans-serif';
export const FONT_PIXEL = '"Press Start 2P", ui-monospace, monospace';

/** A ten-shade tuple with `base` at index 5 (the shade Mantine uses in dark mode). */
function shades(lighter: string[], base: string, darker: string[]): MantineColorsTuple {
  return [...lighter, base, ...darker] as unknown as MantineColorsTuple;
}

export const theme = createTheme({
  fontFamily: FONT_TEXT,
  fontFamilyMonospace: FONT_PIXEL,
  headings: { fontFamily: FONT_TEXT, fontWeight: '700' },
  primaryColor: 'gold',
  primaryShade: 5,
  autoContrast: true,
  defaultRadius: 'lg',
  white: arcade.text,
  black: arcade.bg,
  colors: {
    // Mantine's dark palette drives dark-mode surfaces and text: make it the arcade navy.
    dark: [
      arcade.text, // 0: text
      '#c5c8ef',
      arcade.dim, // 2: dimmed text
      '#5d619d',
      arcade.line, // 4: borders
      arcade.track,
      arcade.panel2, // 6: inputs, cards
      arcade.panel, // 7: body surfaces
      arcade.sheet,
      arcade.bg,
    ],
    gold: shades(['#fff9db', '#fff3bf', '#ffec99', '#ffe066', '#ffd84f'], arcade.gold, [
      '#fcc419',
      '#e0ab1a',
      arcade.goldShadow,
      '#8a6d12',
    ]),
    bonus: shades(['#e6fcf0', '#c3f7da', '#9af0c1', '#70e9a8', '#52e598'], arcade.bonus, [
      '#2cc97a',
      '#25b36b',
      arcade.bonusShadow,
      '#16784a',
    ]),
    due: shades(['#fff8e1', '#ffefb3', '#ffe585', '#ffda5c', '#ffd149'], arcade.due, [
      '#f0b62a',
      '#d9a020',
      '#b88619',
      '#8f6812',
    ]),
    overdue: shades(['#fff0e6', '#ffd9bf', '#ffc199', '#ffa973', '#ff9956'], arcade.overdue, [
      '#f07a2c',
      '#d96a22',
      '#b8591c',
      '#8f4515',
    ]),
    late: shades(['#ffe8ed', '#ffc2cd', '#ff9cae', '#ff768e', '#ff6380'], arcade.late, [
      '#f03e60',
      '#d93454',
      arcade.lateDark,
      '#8a2a3c',
    ]),
  },
  other: { arcade, fontPixel: FONT_PIXEL },
});

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    '--pmp-font-pixel': FONT_PIXEL,
    '--pmp-bg': arcade.bg,
    '--pmp-glow': arcade.glow,
    '--pmp-panel': arcade.panel,
    '--pmp-panel-2': arcade.panel2,
    '--pmp-sheet': arcade.sheet,
    '--pmp-line': arcade.line,
    '--pmp-track': arcade.track,
    '--pmp-text': arcade.text,
    '--pmp-dim': arcade.dim,
    '--pmp-bonus': arcade.bonus,
    '--pmp-due': arcade.due,
    '--pmp-overdue': arcade.overdue,
    '--pmp-late': arcade.late,
    '--pmp-late-dark': arcade.lateDark,
    '--pmp-gold': arcade.gold,
    '--pmp-gold-shadow': arcade.goldShadow,
    '--pmp-bonus-shadow': arcade.bonusShadow,
  },
  light: {},
  dark: {
    '--mantine-color-body': arcade.bg,
    '--mantine-color-text': arcade.text,
    '--mantine-color-dimmed': arcade.dim,
  },
});
