# sidebar-status

A mod for Claude Code in the Claude desktop app. It puts an emoji before the title of a session. The sidebar then shows the state of each session.

You do not need to open a session to know if it waits for you.

## Marks

| Mark | State of the session |
| --- | --- |
| ❓ | The session waits for your answer. |
| ❌ | The last turn stopped on an error. |
| ⏳ | Background work runs. No action is necessary. |
| ⏰ | Nothing runs now. A scheduled wakeup starts a turn later. |
| No mark | The session is idle. |

A title shows one mark at a time. The order of priority is ❓, ❌, ⏳, ⏰.

### The ❓ mark

The session waits for your answer in these four cases:

- Claude shows a question dialog (`AskUserQuestion`).
- Claude shows a plan for your approval (`ExitPlanMode`).
- Claude shows a permission prompt for a tool.
- The turn ended on a question.

The mod removes the mark when you answer.

### The ❌ mark

A turn can stop on an error: a rate limit, an API error, or a sign-in problem. The mod removes the mark when you send the next message.

### The ⏳ and ⏰ marks

When a turn ends, Claude Code lists the work that continues: shells, subagents, monitors, and workflows. If the list is not empty, the title gets the ⏳ mark.

If only a scheduled wakeup stays (`/loop`, a cron task), the title gets the ⏰ mark.

## Install

In the desktop app:

1. Click **+** next to the prompt box.
2. Click **Plugins**.
3. Click **Add marketplace**, then enter `jromainkrupa/claude-sidebar-status`.
4. Click **Add plugin** for `sidebar-status`.

From a shell:

```bash
claude plugin install sidebar-status --marketplace jromainkrupa/claude-sidebar-status
```

At the prompt of a terminal session:

```
/plugin install sidebar-status --marketplace jromainkrupa/claude-sidebar-status
```

Answer `y` to add the marketplace, then select the user scope. The mod loads in each session that starts after the install.

## How it works

The mod is one hooks module: [`hooks/register.ts`](hooks/register.ts). It listens to these events:

| Event | What the mod does |
| --- | --- |
| `tool.call` for `AskUserQuestion` and `ExitPlanMode` | Shows ❓ while the dialog is open. |
| `classic.PermissionRequest` | Shows ❓ until the tool runs, fails, or is refused. |
| `tool.call` for `mcp__ccd_turn__wrap_up` | Records the question that the turn leaves for you. |
| `classic.Stop` | Reads the background work and the scheduled wakeups. |
| `classic.StopFailure` | Shows ❌. |
| `classic.UserPromptSubmit` | Removes ❓ and ❌ when you send a message. |
| `classic.SessionStart`, `classic.SessionEnd` | Removes all marks. |

The desktop app has an MCP server with the name `ccd_session_mgmt`. The mod calls two tools of this server: `get_session` reads the title, and `set_session_title` changes it.

The mod renames a session only when the mark changes.

## Limits

- The mod works only in the desktop app. A terminal session has no `ccd_session_mgmt` server, and the mod does nothing there.
- The ⏳ and ⏰ marks change only when a turn ends.
- A turn that runs gets no mark from this mod.
- If you typed the title yourself, the app can ask you to approve the rename.
- If a turn ends on a question in plain text, the mod finds it by the question mark at the end of the message.
- The mod API of Claude Code is in early access. A new release of Claude Code can break the mod.

Tested with Claude Code 2.1.321.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The tests are in [`hooks/register.test.ts`](hooks/register.test.ts). They use a fake session server, so they do not rename a real session.

## License

MIT. See [LICENSE](LICENSE).
