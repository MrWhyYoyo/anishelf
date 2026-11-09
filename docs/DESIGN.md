# AniShelf design direction (redesign, 2026-11-04)

Built with the **Taste Skill** (`design-taste-frontend`, app-screen rules in
`~/.claude/skills/design-taste-frontend/references/app-screens.md`) and checked against
**UI/UX Pro Max** (`~/.claude/skills/ui-ux-pro-max`, local style/UX database).

Style dealt: **True-black flat** (dark), seed 1347918246. Full sheet: `.taste-skill/app/direction.json`.
Reprint it with:
`node ~/.claude/skills/design-taste-frontend/scripts/draw.mjs --show` (from the project root, Node at `D:\NodeJS`).

## Why this style
AniShelf is used by one person in evening sessions, and it is a media product. Cover art is already
full of colour, so the chrome should go quiet and let the covers carry the screen. That is what
streaming apps do.

## The screen questions
- **Home:** "What do I watch next?" The biggest block is Continue watching: the next episode with a
  one-click "+1" and a "Watch on Crunchyroll" action.
- **Library:** "What's on my shelf, and where am I in each show?"
- **Anime detail:** "Where am I in this series, and what's next?"
- **Stats / Profile:** "How much have I watched, and what's my level?"
- **Mini games:** "Something to do between episodes."

## The face (what makes it AniShelf and not a kit)
1. **The one data hue comes from the anime itself.** On a detail page, `--accent` is the cover colour
   AniList gives (`meta.anilist.color`), adjusted to stay readable on black. Everywhere else the
   default is **torii vermilion `#ff5a36`**. That hue goes on data only: progress, watched episodes,
   the current season, chart bars. It never goes on buttons, tabs or nav.
2. **Signature element: the episode strip.** Each season is one horizontal strip of small cells, one
   per episode. Watched cells are filled in the data hue, the next episode is outlined, and unwatched
   cells are a tone step (#2a2a2a). It appears on the detail page (one strip per season in the
   Seasons block), as a thin strip on Continue watching cards, and grouped per series in the library.
   The cells are clickable on the detail page, and shift-click marks a range.
3. **Covers are the pictures.** Real cover art at real sizes, with square-ish corners (radius 6-8px)
   and no glow. The detail header uses the AniList banner as a flat, dimmed picture with a neutral
   scrim under the text, which is the one allowed scrim.

## Tokens (from the sheet, with our accent)
--ground #000, --surface #111, --raised #2a2a2a, --border #1a1a1a, --text #fff, --muted #b4b4b4,
--faint #949494, --accent #ff5a36 (per-anime override), --positive #c6f24e, --negative #e5484d,
--warning #e5a93b. Card radius 20px, control radius 999px (pill), control height 36px,
gap 14px, padding 22px. Inter 400/500/600; title 20, section 16, kpi 24, body 14, small 12;
tabular-nums on every number.

## House rules (removing the AI tells)
- No gradients, glows, glass/backdrop blur, coloured shadows, neon borders or emoji in the UI.
  Badges become small sentence-case text marks, not emoji.
- No icons in tinted circles or squares, no tiny uppercase letter-spaced labels, and no eyebrow
  labels above headings.
- The primary action is a white 36px pill with black text. Other buttons are text or outlined in #444.
- Nav: the active item is just white text (inactive #bbb). No coloured pill and no slide indicator.
- Shell: a 210-240px sidebar and a 64px top bar on the same black, split by 1px #1a1a1a rules. The
  top bar holds real things: global search, the back link with the object name, and the profile
  (avatar + level) at the right end behind a divider.
- Elevation is lightness only (#000, then #111, then #2a2a2a).
- Motion: short (150-250ms) opacity/transform only, with no bounces. Since 1.2.1 every click answers back
  (static/js/feel.js): a press dip, a soft ripple, a spinner while saving, a floating ✓ when saved, a
  2px loading line and a page slide-in. Settings > Feel > Calm and reduced-motion switch the movement off. The level-up celebration stays,
  because it is earned, but it's toned down.
- Honest data states: 0 shows as 0, missing shows as an em dash, and empty sections keep their frame.

## Mini games
- **Screen question:** "Something to do between episodes."
- **Styles** live in `static/css/games.css`.
- **Accent:** each themed game borrows the cover colour of the anime it's inspired by as `--accent`
  (the same rule as the detail page, set via `setAccent` from `meta.anilist.color`).
- **The accent still only marks data:** progress (the meters), hits, the rope, and safe tiles. It never
  goes on buttons or nav.
- **Primary action** is the white pill, like everywhere else.
