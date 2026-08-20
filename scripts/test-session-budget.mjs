// Regression test for sidebar list behaviour when archiving.
//
// Reported bug: a project listing five conversations out of a larger set refilled
// the freed slot as soon as one was archived, so the list stayed at five no
// matter how many the user archived. Archiving must shrink the list; only "Show
// more" may grow it.
import assert from 'node:assert/strict'

import {
  budgetAfterArchive,
  budgetAfterShowMore,
  hasHiddenItems,
  itemBudget,
  projectItemPageSize,
} from '../src/sessionBudget.ts'

const key = 'host-1:project-1'

// An untouched project shows one page.
assert.equal(itemBudget(new Map(), key), projectItemPageSize)

// Eight conversations, five listed: archiving walks the list down to zero and
// never refills a freed slot.
let budgets = new Map()
let total = 8
const listed = []
for (let step = 0; step < projectItemPageSize; step += 1) {
  const budget = itemBudget(budgets, key)
  listed.push(Math.min(total, budget))
  budgets = budgetAfterArchive(budgets, key)
  total -= 1
}
assert.deepEqual(listed, [5, 4, 3, 2, 1], `list shrank as ${listed.join(' ')}`)
assert.equal(itemBudget(budgets, key), 0, 'budget reaches zero')
assert.equal(hasHiddenItems(total, itemBudget(budgets, key)), true, 'Show more stays available')

// Zero is a real budget, not a missing entry: "Show more" grows it by one page
// rather than resetting to two pages.
assert.equal(itemBudget(budgetAfterShowMore(budgets, key), key), projectItemPageSize)

// Archiving cannot drive the budget negative.
assert.equal(itemBudget(budgetAfterArchive(budgets, key), key), 0)

// A project with nothing hidden offers no "Show more" once one is archived.
let exact = new Map()
assert.equal(hasHiddenItems(5, itemBudget(exact, key)), false)
exact = budgetAfterArchive(exact, key)
assert.equal(itemBudget(exact, key), 4)
assert.equal(hasHiddenItems(4, itemBudget(exact, key)), false, 'nothing hidden, so no Show more')

console.log('ok - archiving shrinks a project list to zero and only Show more grows it back')
