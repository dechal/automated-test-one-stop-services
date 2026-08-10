import { createTheme, type MantineColorsTuple, rem } from '@mantine/core';

/**
 * Hub design tokens — the single source of truth for how the whole app looks.
 *
 * Why this file exists: the look used to come from a 5-line inline theme in
 * `main.tsx` (`primaryColor: 'blue'` + defaults), which is the stock Mantine
 * palette every template ships with. Centralising real tokens here — brand
 * accent, a softened dark palette, a typographic scale, and shared component
 * defaults — re-skins every page at once and gives one place to tune the brand.
 *
 * To rebrand: edit `brand` (accent) or `slate` (dark surfaces) below. Nothing
 * else in the app hardcodes these colours.
 */

// Accent — a modern indigo. Distinct from Mantine's default blue so the Hub
// reads as its own product, not a stock dashboard. 10 shades, light → dark.
// Chroma is deliberately lower than a stock indigo. A test runner is stared at
// for long stretches, and a highly saturated accent repeated across buttons,
// links, badges and charts is what makes a dense UI feel loud and tiring. Same
// hue family (trust/calm), less vibration — so the few places that DO need
// attention (a failure, a running state) can still out-shout it.
const brand: MantineColorsTuple = [
  '#eff1f8',
  '#dcdff0',
  '#b8bfdf',
  '#939ccd',
  '#7480bd',
  '#5f6cb2',
  '#5462ad',
  '#445198',
  '#3b4787',
  '#2f3b75',
];

// Dark surfaces — a neutral slate, softer than Mantine's default blue-black
// navy (the other big "generic Mantine" tell). Warmer greys read as premium
// and reduce eye strain during long test-watching sessions.
// Three shades carry the whole dark UI, and Mantine decides which:
//   dark[7] → `--mantine-color-body`, the page canvas
//   dark[6] → `--mantine-color-default`, inputs (and Paper/Card via index.css)
//   dark[4] → `--mantine-color-default-border`, EVERY outline in the app
// They used to sit within ~8% of each other, so a card was invisible against the
// page and only its 1px outline said "card" — which is what made the Hub read as
// a grid of boxes. The canvas is now clearly darker than the surface, so cards
// separate by FILL and the border is a refinement rather than the structure.
const slate: MantineColorsTuple = [
  '#c9cbcf',
  '#adb0b6',
  '#8b8f99',
  '#5d626c',
  '#34383f',
  '#22262c',
  '#191c22',
  '#0f1115',
  '#0b0d10',
  '#07080a',
];

const fontStack = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const theme = createTheme({
  primaryColor: 'brand',
  // Slightly lighter accent in dark mode keeps buttons legible on slate.
  primaryShade: { light: 6, dark: 5 },
  autoContrast: true,
  luminanceThreshold: 0.3,
  colors: { brand, dark: slate },

  fontFamily: fontStack,
  fontFamilyMonospace: 'JetBrains Mono, Fira Code, Consolas, monospace',
  defaultRadius: 'md',

  // Slightly rounder than Mantine defaults (sm 4→6, md 8→10). Soft corners read
  // as friendly/human; sharp right angles are part of the "formal/aggressive"
  // feel. Kept subtle so dense tables/inputs don't turn bubbly.
  radius: {
    xs: rem(4),
    sm: rem(6),
    md: rem(12),
    lg: rem(16),
    xl: rem(24),
  },

  // Interactive controls (Select, Checkbox, Radio…) show a pointer — a small
  // affordance that makes the UI feel responsive and clickable.
  cursorType: 'pointer',

  // A deliberate type scale: tighter line-heights + heavier weights on headings
  // create clear hierarchy so users' eyes land on titles first.
  headings: {
    fontFamily: fontStack,
    fontWeight: '650',
    sizes: {
      h1: { fontSize: rem(28), lineHeight: '1.3', fontWeight: '700' },
      h2: { fontSize: rem(23), lineHeight: '1.35' },
      h3: { fontSize: rem(19), lineHeight: '1.4' },
      h4: { fontSize: rem(16), lineHeight: '1.45' },
      h5: { fontSize: rem(14), lineHeight: '1.5' },
      h6: { fontSize: rem(12), lineHeight: '1.5' },
    },
  },

  // Shared component defaults — consistency without repeating props everywhere.
  components: {
    // Every tooltip gets an arrow so pointers to their target are unambiguous.
    Tooltip: { defaultProps: { withArrow: true } },
    // Modals centre by default (FormModal already did; now every modal matches).
    Modal: { defaultProps: { centered: true } },
    // Links underline only on hover — cleaner reading, clear affordance.
    Anchor: { defaultProps: { underline: 'hover' } },
    // Cards get a soft elevation so surfaces feel gently lifted rather than
    // boxed in by a hard 1px outline — the main "warmth" lever for content.
    Card: { defaultProps: { shadow: 'sm' } },
    // Badges default to the tinted variant. A row of solid pills competes for
    // attention and reads as decoration; `light` keeps the label readable while
    // leaving `filled` as an explicit choice for the one status that matters.
    Badge: { defaultProps: { variant: 'light' } },
    // One density rhythm for every table in the app, instead of each page
    // picking its own vertical spacing.
    Table: { defaultProps: { verticalSpacing: 6, horizontalSpacing: 'sm' } },
  },
});
