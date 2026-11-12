import type { EngineInterface, Register } from 'claude-code'

// The desktop app's own MCP server: it reads and renames sessions.
const SERVER = 'ccd_session_mgmt'

// The session waits for the person: a question, a plan or a permission prompt.
const ASKING = '❓'
// The last turn stopped on an error (rate limit, API error, sign-in).
const FAILED = '❌'
// Background work runs now (a shell, a subagent, a monitor, a workflow).
const RUNNING = '⏳'
// Nothing runs now, but a scheduled wakeup will start a turn later.
const SCHEDULED = '⏰'

const MARKS = [ASKING, FAILED, RUNNING, SCHEDULED] as const

export type Mark = (typeof MARKS)[number]

// The app's end-of-turn tool: its `ask` is a question left for the person.
const WRAP_UP = 'mcp__ccd_turn__wrap_up'

export type Status = {
  /** Question or plan dialogs open now. */
  dialogs: number
  /** The tools with a permission prompt open now, by name. */
  prompts: string[]
  /** The last turn ended on a question for the person. */
  hasEndQuestion: boolean
  /** The last turn stopped on an error. */
  hasFailed: boolean
  /** What stays in flight between turns; `null` until a turn has ended. */
  background: Mark | undefined | null
}

type Pending = {
  background_tasks?: readonly unknown[]
  session_crons?: readonly unknown[]
}

export function backgroundMark(e: Pending): Mark | undefined {
  if ((e.background_tasks?.length ?? 0) > 0) return RUNNING
  if ((e.session_crons?.length ?? 0) > 0) return SCHEDULED

  return undefined
}

export function markOf(title: string): Mark | undefined {
  return MARKS.find(mark => title.startsWith(mark))
}

export function stripMark(title: string): string {
  const mark = markOf(title)

  return mark === undefined ? title : title.slice(mark.length).trimStart()
}

// One mark at a time, the most urgent first: the person's answer, a failure,
// then background work.
export function markFor(status: Status, title: string): Mark | undefined {
  if (status.dialogs > 0 || status.prompts.length > 0) return ASKING
  if (status.hasFailed) return FAILED
  if (status.hasEndQuestion) return ASKING
  if (status.background !== null) return status.background

  // After a reload nothing is known yet: a background mark already there stays.
  const current = markOf(title)

  return current === RUNNING || current === SCHEDULED ? current : undefined
}

export function titleFor(title: string, mark: Mark | undefined): string {
  const base = stripMark(title)

  return mark === undefined ? base : `${mark} ${base}`
}

export function endsOnQuestion(message: string | undefined): boolean {
  return message !== undefined && /\?[\s*_`)"'»]*$/.test(message)
}

function isMainThread(e: { agent_id?: string }): boolean {
  return e.agent_id === undefined
}

async function readTitle($: EngineInterface): Promise<string | undefined> {
  const got = await $.mcp.call(SERVER, 'get_session', { session_id: 'self' })
  const text = got.content.find(block => block.type === 'text')?.text

  if (got.isError || text === undefined) return undefined

  const title: unknown = (JSON.parse(text) as { title?: unknown }).title

  return typeof title === 'string' && title !== '' ? title : undefined
}

// What the mod knows of this session. It starts over each time the module loads.
const status: Status = {
  dialogs: 0,
  prompts: [],
  hasEndQuestion: false,
  hasFailed: false,
  background: null,
}

function reset(background: Status['background']): void {
  status.dialogs = 0
  status.prompts = []
  status.hasEndQuestion = false
  status.hasFailed = false
  status.background = background
}

// Reads the title the sidebar shows and renames the session only when the
// mark has to change. A failure never reaches the turn: it goes to the debug log.
async function apply($: EngineInterface): Promise<void> {
  try {
    const title = await readTitle($)

    if (title === undefined) return

    const wanted = titleFor(title, markFor(status, title))

    if (wanted === title) return

    const set = await $.mcp.call(SERVER, 'set_session_title', {
      session_id: 'self',
      title: wanted,
    })

    if (set.isError) {
      const why = set.content.find(block => block.type === 'text')?.text ?? ''

      $.ui.log(`rename refused: ${why.slice(0, 200)}`, { to: 'debug' })
    }
  } catch (error) {
    $.ui.log(`title not synced: ${String(error).slice(0, 200)}`, { to: 'debug' })
  }
}

// Renames run one after the other, so a later status never loses to an
// earlier one that was slower.
let queue: Promise<void> = Promise.resolve()

function sync($: EngineInterface): Promise<void> {
  queue = queue.then(() => apply($))

  return queue
}

// A question or a plan put to the person: the call stays open until they answer.
async function whileAsked<T>($: EngineInterface, call: () => Promise<T>): Promise<T> {
  status.dialogs += 1
  await sync($)

  try {
    return await call()
  } finally {
    status.dialogs -= 1
    await sync($)
  }
}

// The prompted tool ran, failed or was refused: the prompt is closed.
async function closePrompt($: EngineInterface, tool: string): Promise<void> {
  const at = status.prompts.indexOf(tool)

  if (at === -1) return

  status.prompts.splice(at, 1)
  await sync($)
}

export const register: Register = on => {
  reset(null)

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => whileAsked($, () => next(e)))
  on('tool.call', { tool: 'ExitPlanMode' }, ($, e, next) => whileAsked($, () => next(e)))

  // The app's end-of-turn tool says whether the turn leaves a question.
  on('tool.call', { tool: WRAP_UP }, ($, e, next) => {
    const ask: unknown = (e as { ask?: unknown }).ask

    status.hasEndQuestion = typeof ask === 'string' && ask.trim() !== ''

    return next(e)
  })

  // A permission prompt: when no settings hook decided, the person is asked.
  on('classic.PermissionRequest', async ($, e, next) => {
    const result = await next(e)

    if (result.decision === undefined) {
      status.prompts.push(e.tool_name)
      await sync($)
    }

    return result
  })

  on('classic.PostToolUse', async ($, e, next) => {
    await closePrompt($, e.tool_name)

    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    await closePrompt($, e.tool_name)

    return next(e)
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    await closePrompt($, e.tool_name)

    return next(e)
  })

  // The person wrote: their answer is given, and a failed turn starts again.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (isMainThread(e) && (e.source === undefined || e.source === 'user')) {
      status.prompts = []
      status.hasEndQuestion = false
      status.hasFailed = false
      await sync($)
    }

    return next(e)
  })

  // The end of each main-thread turn: the engine lists what is still in flight.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)

    if (isMainThread(e)) {
      status.prompts = []
      status.hasFailed = false
      status.hasEndQuestion ||= endsOnQuestion(e.last_assistant_message)
      status.background = backgroundMark(e)
      await sync($)
    }

    return result
  })

  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)

    if (isMainThread(e)) {
      status.prompts = []
      status.hasFailed = true
      await sync($)
    }

    return result
  })

  // A session that starts again or ends holds no question and no background work.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)

    if (isMainThread(e) && e.source !== 'compact') {
      reset(undefined)
      await sync($)
    }

    return result
  })

  on('classic.SessionEnd', async ($, e, next) => {
    const result = await next(e)

    reset(undefined)
    await sync($)

    return result
  })
}
