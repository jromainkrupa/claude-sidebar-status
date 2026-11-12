import { expect, test, type TestBody } from 'claude-code/testing'

import { endsOnQuestion } from './register'

type On = Parameters<TestBody>[1]

const SHELL = {
  id: 'b1',
  type: 'shell',
  status: 'running',
  description: 'Run the test suite',
}

const CRON = { id: 'c1', schedule: '27 16 12 11 *', recurring: false, prompt: 'check' }

const IDLE = { stop_hook_active: false, background_tasks: [], session_crons: [] }

// Stands for the app's session server: it holds the title the sidebar shows.
function sidebar(on: On, first: string) {
  const row = { title: first, renames: 0 }

  on('mcp.call', (_, e) => {
    if (e.tool === 'set_session_title') {
      row.title = String(e.args.title)
      row.renames += 1
    }

    return {
      value: {
        content: [{ type: 'text', text: JSON.stringify({ title: row.title }) }],
        isError: false,
      },
    }
  })

  return row
}

function settingsHooks(on: On) {
  on('classic.Stop', () => ({}))
  on('classic.StopFailure', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PostToolUse', () => ({}))
}

test('background work marks the title, and the mark goes when it ends', async ($, on) => {
  const row = sidebar(on, 'Fix the login page')

  settingsHooks(on)

  await $.classic.Stop({ ...IDLE, background_tasks: [SHELL] })
  expect(row.title).toBe('⏳ Fix the login page')

  // Nothing changed: no second rename.
  await $.classic.Stop({ ...IDLE, background_tasks: [SHELL] })
  expect(row.renames).toBe(1)

  // The shell is done, a wakeup is still booked.
  await $.classic.Stop({ ...IDLE, session_crons: [CRON] })
  expect(row.title).toBe('⏰ Fix the login page')

  await $.classic.Stop(IDLE)
  expect(row.title).toBe('Fix the login page')
  expect(row.renames).toBe(3)
})

test('a question dialog marks the title only while it is open', async ($, on) => {
  const row = sidebar(on, 'Deploy')
  let seen = ''

  settingsHooks(on)
  // The engine's part: the dialog is open while this hook runs.
  on('tool.call', () => {
    seen = row.title

    return { result: {} }
  })

  await $.classic.Stop({ ...IDLE, background_tasks: [SHELL] })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] })

  expect(seen).toBe('❓ Deploy')
  expect(row.title).toBe('⏳ Deploy')
})

test('a turn that ends on a question keeps the mark until the person writes', async ($, on) => {
  const row = sidebar(on, 'Deploy')

  settingsHooks(on)
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Done.', ask: 'Push it?' })
  await $.classic.Stop({ ...IDLE, background_tasks: [SHELL] })
  expect(row.title).toBe('❓ Deploy')

  // A background task wakes the session: the question still waits.
  await $.classic.UserPromptSubmit({ prompt: 'task done', source: 'system' })
  await $.classic.Stop(IDLE)
  expect(row.title).toBe('❓ Deploy')

  await $.classic.UserPromptSubmit({ prompt: 'yes', source: 'user' })
  expect(row.title).toBe('Deploy')

  // No end-of-turn tool: the last message says it.
  await $.classic.Stop({ ...IDLE, last_assistant_message: 'Which one do you want?' })
  expect(row.title).toBe('❓ Deploy')
})

test('a permission prompt marks the title until the tool runs', async ($, on) => {
  const row = sidebar(on, 'Deploy')

  settingsHooks(on)

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  expect(row.title).toBe('❓ Deploy')

  // Another tool ends first: the prompt is still open.
  await $.classic.PostToolUse({
    tool_name: 'Read',
    tool_input: {},
    tool_response: {},
    tool_use_id: 't1',
  })
  expect(row.title).toBe('❓ Deploy')

  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 't2',
  })
  expect(row.title).toBe('Deploy')
})

test('a failed turn marks the title until the person writes again', async ($, on) => {
  const row = sidebar(on, '⏳ Deploy')

  settingsHooks(on)

  await $.classic.StopFailure({ error: 'rate_limit' })
  expect(row.title).toBe('❌ Deploy')

  await $.classic.UserPromptSubmit({ prompt: 'continue', source: 'user' })
  expect(row.title).toBe('Deploy')
})

test('a refused or failed rename leaves the turn alone', async ($, on) => {
  on('mcp.call', (_, e) => {
    if (e.tool === 'set_session_title') throw new Error('no such server')

    return {
      value: { content: [{ type: 'text', text: '{"title":"Deploy"}' }], isError: false },
    }
  })
  on('classic.Stop', () => ({ additionalContext: ['kept'] }))

  const result = await $.classic.Stop({ ...IDLE, background_tasks: [SHELL] })

  expect(result.additionalContext).toEqual(['kept'])
})

test('a closing question is read through markdown and quotes', () => {
  expect(endsOnQuestion('Do you want **both?**')).toBe(true)
  expect(endsOnQuestion('Is it "done"?\n')).toBe(true)
  expect(endsOnQuestion('Done. See the file?name.')).toBe(false)
  expect(endsOnQuestion(undefined)).toBe(false)
})
