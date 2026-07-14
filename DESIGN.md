# Design

The visual system as it actually exists in `theme.css` + the tool CSS files. Written from the code, not aspiration. `theme.css` is the single source of truth; tool files scope everything under `.toolroot-<x>`.

## Register

Product. Design serves the task. The bar is earned familiarity: a player mid-craft should be able to read an answer off the page without studying the interface. Density is a virtue here, decoration is not.

## Color

Near-black charcoal at ~0 chroma, one warm gold accent, semantic green/red. All OKLCH.

| Role | Token | Value |
|---|---|---|
| Body bg | `--bg` | `oklch(15% 0.006 270)` |
| Recessed (inputs, wells) | `--bg-deep` | `oklch(12.5% 0.006 270)` |
| Surfaces | `--surface-1/2/3` | `18.5%` → `27%`, same hue |
| Borders | `--border`, `--border-strong` | white at 9% / 16% alpha (hairlines catch light) |
| Text | `--text`, `--text-muted`, `--text-faint` | `97%` / `74%` / `60%` |
| Accent | `--gold` | `oklch(82% 0.135 78)` (+ `-bright`, `-deep`, `-soft`, `-glow`) |
| Semantic | `--green`, `--red`, `--info`, `--violet` | success / danger / links / uniques |

Strategy is **Restrained**: gold is not decoration. It marks the primary action, the active nav item, cost totals, and the current selection. If gold appears on something that isn't one of those, remove it.

Contrast: every text style on every view clears WCAG AA (verified by a computed-style sweep at 1440 and 390). The muted-gray-on-dark drift is the failure mode to watch; if a new style is borderline, move it toward `--text`, not away.

## Type

One family. `Inter` for everything in the UI (`--font-display` is deliberately aliased to it: a display face was tried and retired). `JetBrains Mono` for **data only** — prices, weights, item text, regex, counts, tabular numbers. Body 13.5px/1.55.

Prose in mono is the recurring mistake here (the Gear Finder's entire helper copy was monospace until 2026-07-14). Mono is for things you compare in columns, not things you read in sentences.

## Layout

- `.shell` caps at 1280px; tool views left-align to its gutter (never centre a single view — switching to it visibly shifts the page).
- Hash-routed SPA. Each view is `<section class="view toolroot-<x>" data-view="<x>">`; CSS and JS are per-tool files, JS wrapped in `window.__viewInit["<view>"]`.
- Tables are the primary display form (the ledger). Sticky headers, tabular numerals, hover tint.
- Radii: `--r-sm:6 / --r:8 / --r-md:10 / --r-lg:14 / --r-pill`. Spacing: `--space-1..6` (prefer these over magic px in new CSS).

## Motion

`--t:160ms var(--ease)` for state transitions, `--ease: cubic-bezier(.2,.6,.2,1)`. Motion conveys state and nothing else: a price loading, a scan running, a refresh completing. No entrance choreography, no decorative animation. Every animation needs a `prefers-reduced-motion` alternative.

Long operations get honest indeterminate progress, not a static line: the Crafter's plan takes ~10s, so it sweeps a bar and says what it's doing.

## Rules learned the hard way

- **`[hidden]` must win.** `theme.css` sets `[hidden]{display:none !important}`. Any `.thing{display:flex}` out-specifies the UA rule, and elements the JS believes are hidden stay on screen — this shipped a "Best crafting route" button with no targets loaded and a scan button with no build.
- **The router focuses view headings** (`tabindex="-1"`) for screen readers. That focus must not paint a ring; `[tabindex="-1"]:focus` clears it.
- **No side-stripes.** No `border-left` accent bars on cards, rows, or callouts. Use a background tint.
- **Never colour a zero.** A `0%` outcome renders muted, never in the danger colour; red must always mean "this can happen to you".
- **Never print a price as `0.00`.** Sub-cent costs show `<0.01`. Free is the one thing no craft is.
- **The nav must survive 390px.** Below 900px it wraps to its own row and scrolls horizontally with an edge fade; it used to clip the last two tools off-screen entirely.

## Accessibility

Personal tool, but functional readability is non-negotiable (a tired player at 2am). AA contrast on body text, ≥24px hit targets, visible focus rings on keyboard nav, `prefers-reduced-motion` honored.
