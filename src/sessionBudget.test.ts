import { describe, expect, it } from 'vitest'

import {
  budgetAfterArchive,
  budgetAfterShowMore,
  hasHiddenItems,
  itemBudget,
  projectItemPageSize,
  type ItemBudgets,
} from './sessionBudget'

const budgets = (entries: Record<string, number> = {}): ItemBudgets =>
  new Map(Object.entries(entries))

describe('itemBudget', () => {
  it('falls back to one page for a project the user never adjusted', () => {
    expect(itemBudget(budgets(), 'p1')).toBe(projectItemPageSize)
  })

  it('returns a stored budget', () => {
    expect(itemBudget(budgets({ p1: 12 }), 'p1')).toBe(12)
  })

  // The distinction that motivated the `?? ` rather than `||`: a user can
  // archive their way down to zero, and that is not "unset".
  it('treats a stored zero as a real budget, not a missing entry', () => {
    expect(itemBudget(budgets({ p1: 0 }), 'p1')).toBe(0)
  })

  it('keeps projects independent', () => {
    const map = budgets({ p1: 1 })
    expect(itemBudget(map, 'p2')).toBe(projectItemPageSize)
  })
})

describe('budgetAfterArchive', () => {
  it('narrows the list by one so archiving visibly removes a row', () => {
    expect(itemBudget(budgetAfterArchive(budgets({ p1: 5 }), 'p1'), 'p1')).toBe(4)
  })

  it('never goes negative', () => {
    expect(itemBudget(budgetAfterArchive(budgets({ p1: 0 }), 'p1'), 'p1')).toBe(0)
  })

  it('starts from the default page size for an unadjusted project', () => {
    expect(itemBudget(budgetAfterArchive(budgets(), 'p1'), 'p1')).toBe(projectItemPageSize - 1)
  })

  it('does not mutate the map it was given', () => {
    const original = budgets({ p1: 5 })
    budgetAfterArchive(original, 'p1')
    expect(original.get('p1')).toBe(5)
  })

  it('leaves other projects untouched', () => {
    const next = budgetAfterArchive(budgets({ p1: 5, p2: 9 }), 'p1')
    expect(next.get('p2')).toBe(9)
  })
})

describe('budgetAfterShowMore', () => {
  it('widens the list by one page', () => {
    expect(itemBudget(budgetAfterShowMore(budgets({ p1: 5 }), 'p1'), 'p1')).toBe(
      5 + projectItemPageSize,
    )
  })

  it('grows from the default for an unadjusted project', () => {
    expect(itemBudget(budgetAfterShowMore(budgets(), 'p1'), 'p1')).toBe(projectItemPageSize * 2)
  })

  it('does not mutate the map it was given', () => {
    const original = budgets({ p1: 5 })
    budgetAfterShowMore(original, 'p1')
    expect(original.get('p1')).toBe(5)
  })

  it('recovers a project archived down to zero', () => {
    const next = budgetAfterShowMore(budgets({ p1: 0 }), 'p1')
    expect(itemBudget(next, 'p1')).toBe(projectItemPageSize)
  })
})

describe('hasHiddenItems', () => {
  it('is true only when the total exceeds the budget', () => {
    expect(hasHiddenItems(6, 5)).toBe(true)
    expect(hasHiddenItems(5, 5)).toBe(false)
    expect(hasHiddenItems(4, 5)).toBe(false)
  })

  it('reports hidden items for a project archived down to zero', () => {
    expect(hasHiddenItems(1, 0)).toBe(true)
  })

  it('reports nothing hidden for an empty project', () => {
    expect(hasHiddenItems(0, 0)).toBe(false)
  })
})

describe('archive then show-more round trip', () => {
  it('returns to at least the original budget after one archive and one show-more', () => {
    let map = budgets()
    map = budgetAfterArchive(map, 'p1')
    map = budgetAfterShowMore(map, 'p1')
    expect(itemBudget(map, 'p1')).toBeGreaterThanOrEqual(projectItemPageSize)
  })

  it('shrinks monotonically across repeated archiving', () => {
    let map = budgets()
    const seen: number[] = []
    for (let i = 0; i < 8; i++) {
      map = budgetAfterArchive(map, 'p1')
      seen.push(itemBudget(map, 'p1'))
    }
    const expected = Array.from({ length: 8 }, (_, i) => Math.max(0, projectItemPageSize - 1 - i))
    expect(seen).toEqual(expected)
  })
})
