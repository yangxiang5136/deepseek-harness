/**
 * Chat-session titles for the needs-you debts that name their originating
 * chat in `payload.session`. The source batches lookups through the
 * `taskflow.sessionTitles` Remote, caches each settled id for
 * {@link SESSION_TITLE_TTL_MS}, and settles every id of a failed batch as
 * unresolved, so a lookup failure changes display text and never rendering.
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { NeedsYouItem } from './fold.ts'

type SessionTitlesAnswer = Awaited<ReturnType<ClientRemote['taskflow']['sessionTitles']>>

/** Titles the host resolved, keyed by session id. */
export type SessionTitleMap = Extract<SessionTitlesAnswer, { ok: true }>['value']['titles']

/** Display title of one session as the host returns it. */
export type SessionTitle = SessionTitleMap[string]

/** How long a settled lookup, resolved or not, is reused before the next request. */
export const SESSION_TITLE_TTL_MS = 5 * 60 * 1000

/** Most ids per Remote request, matching the host's request cap. */
export const SESSION_TITLE_BATCH = 500

/** Settled lookups; an id absent from `titles` has not settled yet. */
export interface SessionTitlesState {
  /** Session id to its title, or null when no host source names it or the lookup failed. */
  readonly titles: ReadonlyMap<string, SessionTitle | null>
}

/** Observable title cache with batched, failure-tolerant lookups. */
export interface SessionTitlesSource extends HostObservable<SessionTitlesState> {
  /**
   * Request the ids that are neither in flight nor settled within the TTL.
   * @param ids - session ids of the debts on screen; duplicates are ignored.
   */
  ensure(ids: readonly string[]): void
  /** Drop every settled lookup and ignore answers to requests already in flight (reconnect). */
  reset(): void
}

/**
 * Create the session title source.
 * @param read - Remote adapter; rejects on a wire or host failure.
 * @param onError - reporter for a failed lookup (console in production).
 * @param clock - wall clock for TTL checks.
 * @returns The observable cache and its lookup trigger.
 */
export function createSessionTitles(
  read: (ids: string[]) => Promise<SessionTitleMap>,
  onError: (error: unknown) => void,
  clock: () => number = Date.now,
): SessionTitlesSource {
  let state: SessionTitlesState = { titles: new Map() }
  const settledAt = new Map<string, number>()
  const inFlight = new Set<string>()
  let generation = 0
  const listeners = new Set<() => void>()
  const publish = (titles: Map<string, SessionTitle | null>): void => {
    state = { titles }
    for (const notify of [...listeners]) notify()
  }
  const settle = (batch: readonly string[], answer: (id: string) => SessionTitle | null): void => {
    const titles = new Map(state.titles)
    const at = clock()
    for (const id of batch) {
      titles.set(id, answer(id))
      settledAt.set(id, at)
    }
    publish(titles)
  }
  const fresh = (id: string, now: number): boolean => {
    const at = settledAt.get(id)
    return at !== undefined && now - at < SESSION_TITLE_TTL_MS
  }
  const issue = (batch: string[]): void => {
    const issued = generation
    for (const id of batch) inFlight.add(id)
    void read(batch).then(
      (found) => {
        // Own entries only: an id such as `toString` must not read the prototype.
        const byId = new Map(Object.entries(found))
        if (issued === generation) settle(batch, id => byId.get(id) ?? null)
      },
      (error: unknown) => {
        if (issued !== generation) return
        onError(error)
        // Last good titles stay visible; never-resolved ids show the unresolved text.
        settle(batch, id => state.titles.get(id) ?? null)
      },
    ).finally(() => {
      if (issued === generation) for (const id of batch) inFlight.delete(id)
    })
  }
  return {
    getSnapshot: () => state,
    subscribe: (notify) => {
      listeners.add(notify)
      return () => { listeners.delete(notify) }
    },
    ensure: (ids) => {
      const now = clock()
      const due = [...new Set(ids)].filter(id => !inFlight.has(id) && !fresh(id, now))
      for (let start = 0; start < due.length; start += SESSION_TITLE_BATCH) {
        issue(due.slice(start, start + SESSION_TITLE_BATCH))
      }
    },
    reset: () => {
      generation += 1
      inFlight.clear()
      settledAt.clear()
      publish(new Map())
    },
  }
}

/**
 * The originating chat a debt names, if any.
 * @param debt - an open needs-you.
 * @returns The nonempty `payload.session` string, or null.
 */
export function debtSessionId(debt: NeedsYouItem): string | null {
  const session = debt.payload?.session
  return typeof session === 'string' && session.trim() !== '' ? session : null
}

/** One label-value fact row naming where a debt came from. */
export interface SessionDestination {
  /** 去处 when the title is known, 来源会话 otherwise. */
  label: '去处' | '来源会话'
  /** Tool and title, or a short id with the lookup status. */
  value: string
}

const TOOL_LABEL: Readonly<Record<SessionTitle['tool'], string>> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
}

/**
 * Describe a debt's originating chat from the cached lookups.
 * @param sessionId - the debt's `payload.session`.
 * @param state - the current title cache.
 * @returns The fact row: tool and title when resolved; otherwise the first
 *   eight id characters after any `local_` prefix, marked as still loading or
 *   as not found (no source names it, or the lookup failed).
 */
export function sessionDestination(sessionId: string, state: SessionTitlesState): SessionDestination {
  const lookup = state.titles.get(sessionId)
  if (lookup !== undefined && lookup !== null) {
    const archived = lookup.archived === true ? '（已归档）' : ''
    return { label: '去处', value: `${TOOL_LABEL[lookup.tool]} ·「${lookup.title}」${archived}` }
  }
  const short = sessionId.replace(/^local_/, '').slice(0, 8)
  return { label: '来源会话', value: `${short}（${lookup === undefined ? '正在查标题' : '标题查不到'}）` }
}
