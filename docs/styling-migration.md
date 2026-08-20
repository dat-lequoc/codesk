# Styling migration: Tailwind and Radix

**Status: done.** This records what was changed and why, so the constraints are
not rediscovered. For how to write frontend code today, see the Styling section
of [.kiro/steering/workflow.md](../.kiro/steering/workflow.md).

## Why

The frontend was one 1732-line `src/App.tsx` styled by one hand-written
`src/styles.css` — 65 KB, 667 selectors — that had stopped being safe to edit:

| Symptom | Count |
| --- | --- |
| Selectors declared more than once | 117 (`.pinned-session strong` 6×, `.project-row` 5×) |
| `!important` declarations | 43 |
| Duplicate `@media(max-width:1250px)` blocks | 3 |
| Overlay widgets with `role="dialog"` / focus trap | 0 of 6 |

The duplicates were the real cost: rules were appended at the end of the file
and won by source order, so every edit had to reason about the whole cascade.
The missing dialog semantics were a separate defect that Tailwind does not fix —
Radix does.

## What happened

A phased migration was planned and then abandoned in favour of a single
rewrite, because the transitional rules it depended on — Preflight off, and
utilities losing to unlayered CSS — made every half-migrated element a trap.
Instead:

- `src/styles.css` is deleted. `src/index.css` holds an `@theme` block of 56
  tokens, base resets, and the few component classes utilities cannot express.
- Preflight is **on**. `border` needs no `border-solid`, and the universal
  border reset is part of the base layer.
- `App.tsx` is split across `src/features/`, `src/components/`, `src/hooks/`
  and `src/lib/`.
- Radix backs every overlay. `AppDialog` in `src/components/ui/` supplies the
  portal, focus trap, Escape and backdrop dismissal that the hand-rolled
  overlays never had.

## Constraints that still hold

- Density is load-bearing. The original values were recovered by reading
  computed styles from the running app, not from the stylesheet, because the
  cascade made the source unreliable. Change a size deliberately or not at all.
- `body` keeps `min-width: 980px`. The shell is a fixed 344px rail plus a
  reading column; below that the starter cards and composer clip.
- No component library beyond Radix primitives. shadcn-style output is copied
  into the repo and owned here.
