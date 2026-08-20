// How many conversations, runs, drafts, and observed sessions a project lists in
// the sidebar before it offers "Show more".
//
// The budget is per project and is only ever grown by "Show more". Archiving a
// listed conversation shrinks it, because holding it fixed would promote the next
// hidden conversation into the freed slot and the list would never appear to
// change. Projects the user has not adjusted are absent from the map and fall
// back to one page.
export const projectItemPageSize = 5

export type ItemBudgets = Map<string, number>

/// A project's current budget. Zero is a real value the user reaches by
/// archiving, so a missing entry must be distinguished from a stored zero.
export const itemBudget = (budgets: ItemBudgets, key: string): number =>
  budgets.get(key) ?? projectItemPageSize

/// Budget after archiving one listed item: one slot narrower, never negative.
export const budgetAfterArchive = (budgets: ItemBudgets, key: string): ItemBudgets =>
  new Map(budgets).set(key, Math.max(0, itemBudget(budgets, key) - 1))

/// Budget after "Show more": one page wider.
export const budgetAfterShowMore = (budgets: ItemBudgets, key: string): ItemBudgets =>
  new Map(budgets).set(key, itemBudget(budgets, key) + projectItemPageSize)

/// Whether a project has items the budget is currently hiding.
export const hasHiddenItems = (total: number, budget: number): boolean => total > budget
