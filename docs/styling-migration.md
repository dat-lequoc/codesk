# Styling migration: Tailwind first, Radix after

The frontend is one 1732-line `src/App.tsx` (187 KB, 32 components) styled by one
hand-written `src/styles.css`. The stylesheet is 65 KB across 667 selectors, and
it has stopped being safe to edit:

| Symptom | Count |
| --- | --- |
| Selectors declared more than once | 117 (`.pinned-session strong` 6×, `.project-row` 5×) |
| `!important` declarations | 43 |
| Duplicate `@media(max-width:1250px)` blocks | 3 |
| Overlay widgets with `role="dialog"` / `aria-modal` / focus trap | 0 of 6 |

The duplicates are the real cost: rules are appended at the end of the file and
win by source order, so every edit has to reason about the whole cascade. The
missing dialog semantics are a separate, smaller defect that Tailwind does not
fix — Radix does.

Audit the first three numbers at any time:

```bash
python3 - <<'PY'
import re, collections
css = re.sub(r'/\*.*?\*/', '', open('src/styles.css').read(), flags=re.S)
sels = collections.Counter()
for rule in re.finditer(r'([^{}]+)\{[^{}]*\}', css):
    for sel in rule.group(1).split(','):
        sel = sel.strip()
        if sel and not sel.startswith(('@', '%')) and not sel[0].isdigit(): sels[sel] += 1
print('selectors', len(sels), '| duplicated', sum(1 for c in sels.values() if c > 1))
print('!important', css.count('!important'))
PY
```

## Ground rules

1. **Preflight stays off.** The stylesheet was written against browser defaults;
   Preflight's margin, border, heading and list resets would restyle every screen
   at once. `src/styles.css` imports `theme.css` and `utilities.css` only.
2. **Unlayered CSS outranks utilities.** Tailwind utilities live in the
   `utilities` cascade layer, and unlayered rules beat layered ones. So a
   utility silently loses to any existing rule for that element. Migrate by
   **deleting the rule**, never by stacking a utility on top of it.
3. **One element, one system.** Never put a hand-written class and utilities on
   the same element. Convert the whole element or leave it alone.
4. **`border` needs `border-solid`.** Without Preflight the default border style
   is `none`, so the width-only `border` utility renders nothing on its own.
5. **Every phase ends deployed.** `npm run desktop:redeploy`, then compare the
   sidebar against the previous launch screenshot. `main` stays shippable.

## Phase 0 — toolchain (done)

`tailwindcss` and `@tailwindcss/vite` pinned at 4.3.3, plugin registered in
`vite.config.ts`, theme and utilities imported without Preflight. Verified:
`npm run build` succeeds and the emitted CSS contains no Preflight markers.

## Phase 1 — theme tokens

Move the palette into an `@theme` block so utilities can name it instead of
repeating hex codes: the existing `--side/--main/--surface/--line/--muted/
--green/--orange`, plus the recurring greys (`#262827`, `#383a39`, `#2b4036`)
and the status colours (`#4dcf91`, `#ff3b30`, `#d4a15f`). Also define a text
scale that matches what the sidebar already uses (9 / 10 / 10.5 / 11 / 12 / 13.5
px) — Tailwind's default scale has none of these, and guessing here is what makes
migrated rows drift by a pixel. No markup changes in this phase.

## Phase 2 — pilot slice: sidebar leaf rows

Convert in this order, deleting each CSS rule as its markup converts:

1. `Spinner` / `.arc-spinner` — smallest possible proof, one element.
2. `.detached-row` / `.detached-main` / `.detached-add` — newest code, no
   duplicate-selector history to untangle.
3. `.project-running-count`.
4. `.project-session`, `.project-session-row`, `.session-pin`, `.session-archive`
   — the payoff: four of these are declared 4–5 times today.

Acceptance: sidebar renders identically, and `styles.css` shrinks by exactly the
deleted rules.

## Phase 3 — retire the override chains

Work down the duplicated-selector list from the audit. Each converted owner
removes a whole override chain, so the count is the progress metric. Target: zero
duplicated selectors and `!important` only where it fights a third-party style.

## Phase 4 — split `App.tsx`

Once styling travels with the markup, splitting is mechanical: one file per
screen and per widget under `src/components/`. Do this after Phase 2 so moved
components carry their utilities instead of leaving orphaned CSS behind.

## Phase 5 — Radix and shadcn for overlays

Only once utilities are the default for new code. Add `components.json` and the
`@/` path alias, then replace, in order of blast radius:

1. `Dialog` (3 call sites) and the 2 places that render `dialog-backdrop`
   directly — `@radix-ui/react-dialog`.
2. Project actions menu, workspace menu — `@radix-ui/react-dropdown-menu`.
3. Slash-command menu — keep the custom filtering, adopt Radix's roving focus.
4. `EnvironmentPopover` — `@radix-ui/react-popover`.

This is the phase that fixes the accessibility defects: focus trap, escape
handling, `aria-modal`, real `role="menu"` semantics and arrow-key navigation.
Radix needs no Tailwind, so if the migration stalls after Phase 2, this phase can
still be done against the existing CSS.

## Non-goals

- No big-bang rewrite, and no branch that parks unreleased UI work.
- No new colour or spacing decisions during migration; a converted row must look
  identical, so any redesign is a separate change.
- No component library beyond Radix primitives. shadcn output is copied into the
  repo and owned here.
