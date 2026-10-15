/** Read-only review planning metadata; ledger events own review outcomes. */
export interface ReviewPlanItem {
  id: string
  title: string
  ref: string
  threadId?: string
  /** Native chat title, preserved verbatim; never inferred from the step title. */
  chatTitle?: string
  order: number
  lane: 'main' | 'parallel' | 'conditional'
  reason: string
  after?: string[]
  debtEventIds: string[]
  condition?: string
}

/** A human-specified ordering override, with its source and reason. */
export interface ReviewPlanOverride {
  itemId: string
  order: number
  ref: string
  reason: string
}

/** Last observed and reconciled messages on one explicitly connected surface. */
export interface ReviewPlanSource {
  surface: string
  threadId: string
  latestMessageId: string
  observedAt: string
  reconciledMessageId?: string
  reconciledAt?: string
  pendingFromRef?: string
  pendingFromMessageId?: string
  reconciledRef?: string
  status: 'pending' | 'fresh' | 'unavailable'
  sourceRef: string
}

/** One versioned project review plan read from the attention bus. */
export interface ReviewPlan {
  schemaVersion: 1
  project: string
  revision: number
  updatedAt: string
  basisRef: string
  items: ReviewPlanItem[]
  overrides: ReviewPlanOverride[]
  sources: ReviewPlanSource[]
}

/** One displayed chat after combining its planned reading steps. */
export interface ReviewChat {
  key: string
  title: string
  threadId?: string
  lane: ReviewPlanItem['lane']
  order: number
  itemIds: string[]
  debtEventIds: string[]
}
