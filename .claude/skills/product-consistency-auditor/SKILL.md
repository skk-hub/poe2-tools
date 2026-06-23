---
name: product-consistency-auditor
description: Audit a web app for UI, copy, design-system, and product-language consistency across pages and components — button/CTA wording, link & nav labels, error messages, forms, empty states, typography/spacing/component reuse, and design-system drift. Use when the user asks to audit consistency, check for inconsistent labels/wording/errors/empty states, find design-system drift or duplicated components, or normalize the product's language and UI. Triggers: "audit consistency", "consistency check", "are our buttons/labels/errors consistent", "find design drift", "normalize our copy/UI".
---

# Product Consistency Auditor

Audit one web app for consistency across four axes: **UI**, **copy**, **design system**, and **product language**. Output a grouped, severity-ranked report, propose normalization rules, then ask before fixing (unless told to fix directly).

## Scope first

Before auditing, establish the surface:

1. Find the front-end files — HTML, JSX/TSX/Vue/Svelte templates, CSS/SCSS, design-token files, component libraries. Use Glob/Grep, not guesses.
2. Identify the **design-system source of truth**: token files (`theme.css`, `tokens.*`, Tailwind config, CSS custom properties), shared component dirs, and any conventions doc (`CLAUDE.md`, `AGENTS.md`, `STYLEGUIDE.md`, storybook). The audit measures drift *against this*, so read it first. If none exists, infer the dominant pattern from frequency and say so.
3. If the user named a subset (e.g. "the homepage", "the auth flow"), audit only that surface but still compare it against the whole app's conventions.

Do not invent a "correct" standard from outside the codebase. The standard is whatever the app already does most consistently; deviations from *that* are the findings.

## What to check

### 1. Button / CTA labels
- Same action → same wording everywhere (one of "Save", not "Save"/"Update"/"Apply" for the same act).
- Primary CTA wording consistent across comparable screens.
- Destructive actions use one consistent verb. Flag random synonyms ("Remove" vs "Delete" vs "Erase") unless a documented rule distinguishes them (e.g. Remove = unlink, Delete = destroy).
- Casing/voice consistent (sentence case vs Title Case; imperative vs noun).

### 2. Links & navigation
- Same destination → same label (and same label → same destination).
- Link text is descriptive. Flag vague text: "click here", "this", "link", "more".
- No mixed casing for the same nav item across pages.

### 3. Errors
- Same error *type* uses the same structure (what happened + what to do).
- One tone throughout (no mix of terse, jokey, and formal-apologetic).
- Each message explains the cause *and* the user's next step.
- Consistent apology style — not "Oops!" in one place and "We sincerely apologize" in another.
- No divergent variants for the same validation issue (e.g. "Email is required" vs "Please enter your email" vs "Email can't be blank").

### 4. Forms
- Labels, placeholders, helper text, validation, disabled, loading, and success states follow one pattern across forms.
- Required fields marked consistently (asterisk, "(required)", or "(optional)" — pick the app's existing convention).
- The same field means the same label everywhere ("Email" vs "Email address" vs "E-mail").
- Placeholders aren't doing the label's job; helper text format is consistent.

### 5. Empty states
- Same structure everywhere: **title → explanation → action**.
- Not vague ("Nothing here"). Says what would populate it and why it's empty.
- The CTA matches the actual next action and reuses the canonical wording for that action (ties back to §1).

### 6. Visual consistency
- Typography scale consistent — flag one-off font sizes/weights outside the scale.
- Spacing uses existing tokens/utility classes, not magic numbers.
- Components reuse shared components instead of re-implementing one-offs.
- Cards, tables, buttons, modals, forms, badges follow the same variants.
- Color follows semantic meaning (success/danger/info/muted map to the right tokens; flag a raw hex where a token exists, or a danger color used decoratively).

### 7. Design-system drift
- Duplicated components (two modals, two button implementations, two card markups).
- One-off CSS/classes that should use an existing component or token.
- Inconsistent variants of one pattern (three badge styles, two table header treatments).
- Tokens redeclared or aliased per-page instead of inherited from the source of truth.

## Output format

Produce the report in this order:

1. **Audit** — grouped by the eight areas above, each finding tagged with severity:
   - **Critical** — breaks trust or function (destructive action mislabeled, contradictory error for the same case, a CTA that lies about what it does).
   - **High** — clearly inconsistent and user-visible (same action, different words across primary flows; duplicated component diverging).
   - **Medium** — noticeable drift (casing, spacing magic numbers, near-duplicate copy).
   - **Low** — polish (minor wording, ordering).

   Every finding includes: **`file_path:line`**, the **exact text/value found**, the **conflicting instances** it disagrees with (with their locations), and one line on the impact.

2. **Normalization rules** — for each cluster of findings, propose the single canonical form to standardize on, chosen from what the codebase already uses most. State the rule plainly (e.g. *"Destructive = 'Delete'; reserve 'Remove' for unlinking without data loss."*).

3. **Fix prompt** — ask whether to apply the fixes. **Skip this step and apply directly only if the user explicitly asked you to fix.**

Keep examples concrete and quoted. No vague "consider reviewing wording" — name the file, the string, and the winner.

## When fixing

- Prefer shared components over editing one-off markup; if a one-off should become shared, say so before doing it.
- Prefer existing design tokens over literal values.
- Do **not** invent new visual patterns unless the app genuinely lacks one and a finding requires it — and call it out when you do.
- Pull repeated text into constants/i18n where the codebase already has a place for it; don't introduce a constants layer the project doesn't use just for this.
- Keep the product's existing tone and voice — normalize *toward* what's already there, don't rewrite personality.
- Make the smallest diff that resolves each finding. Don't bundle unrelated refactors.

## Verify

If Chrome DevTools MCP or Playwright MCP is available, verify rendered results in the browser after fixing — confirm labels, states, and visual changes actually appear and nothing regressed. Run the project's existing checks (lint, smoke/visual tests) if present. If no browser tooling is available, say so and rely on static verification.
