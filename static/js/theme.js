// Colour themes. A theme only swaps the neutral tokens (ground, surface, text...) defined in
// static/css/themes.css; the per-anime --accent is never touched.
//
// The choice is a per-device preference, so it lives in localStorage. index.html has a tiny inline
// script that reads the same key before the page paints, so there is no flash of the wrong theme.

const STORE_KEY = 'anishelf.theme';

// `swatch` lists ground, surface, raised and text: just enough for a small preview in Settings.
export const THEMES = [
  { id: 'black', name: 'True black', text: 'The original: pure black, flat greys.', swatch: ['#000000', '#111111', '#2a2a2a', '#ffffff'] },
  { id: 'warm', name: 'Warm dark', text: 'Brown-black ground with warmer greys.', swatch: ['#0d0b09', '#171411', '#302b26', '#fbf7f1'] },
  { id: 'midnight', name: 'Midnight blue', text: 'Deep navy grounds, cool greys.', swatch: ['#070b14', '#0f1524', '#24304a', '#f3f6fc'] },
  { id: 'ink', name: 'Ink', text: 'Lighter, paper-like grey with high-contrast ink text.', swatch: ['#1c1b19', '#262521', '#3e3c36', '#f7f4ec'] },
  { id: 'sakura', name: 'Sakura night', text: 'Plum-tinted darks with soft pink-grey text.', swatch: ['#0f0a0e', '#1a1218', '#372a33', '#fbf2f6'] },
  { id: 'matcha', name: 'Matcha', text: 'Deep green-black grounds, warm cream text.', swatch: ['#080c09', '#111813', '#28352b', '#f5f1e4'] },
  { id: 'ocean', name: 'Ocean dusk', text: 'Teal-navy, like the sea after sunset.', swatch: ['#061012', '#0d1a1e', '#20373d', '#eef8f8'] },
  { id: 'lavender', name: 'Lavender', text: 'Violet-tinted greys.', swatch: ['#0c0a12', '#16131e', '#2f2a3d', '#f5f2fc'] },
  // The one light theme: its swatch text is dark, so Settings can show "Aa" in ink on paper.
  { id: 'paper', name: 'Paper', text: 'A light theme: off-white ground, white cards, near-black text.', swatch: ['#f3f1ec', '#ffffff', '#e3dfd7', '#17150f'] },
];

const VALID_IDS = THEMES.map((t) => t.id);

export function getTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORE_KEY);
  } catch {
    saved = null;
  }
  return VALID_IDS.includes(saved) ? saved : 'black';
}

/** Apply a theme now and remember it on this device. Unknown ids fall back to true black. */
export function setTheme(id) {
  const theme = VALID_IDS.includes(id) ? id : 'black';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORE_KEY, theme);
  } catch {
    /* storage unavailable: the theme still applies until the page reloads */
  }
  return theme;
}
