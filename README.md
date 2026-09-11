# @cynosure-mcp/codex-terminal

MCP server for starting and controlling OpenAI Codex CLI coding sessions from another agent.

It exposes both documented Codex CLI workflows:

- Interactive terminal mode with `codex`, backed by a PTY so the agent can read output and send follow-up input.
- Non-interactive automation mode with `codex exec`, useful for one-shot coding tasks and summaries.

## Installation

```bash
npx @cynosure-mcp/codex-terminal
```

Or install globally:

```bash
npm install -g @cynosure-mcp/codex-terminal
codex-terminal
```

## Tools

| Tool | Description |
| ---- | ----------- |
| `check_codex_cli` | Check whether the Codex CLI is available and report its version |
| `codex_exec` | Run `codex exec` non-interactively and return stdout/stderr |
| `start_codex_job` | Start `codex exec --json` in the background and return a job ID |
| `resume_codex_job` | Resume a persisted Codex thread as another background job |
| `read_codex_job` | Poll a background job, optionally from a previous output offset |
| `stop_codex_job` | Gracefully stop a background job, escalating after five seconds |
| `list_codex_jobs` | List background jobs retained by this MCP process |
| `start_codex_session` | Start an interactive `codex` terminal session in a PTY |
| `read_codex_session` | Read buffered output from an interactive session |
| `send_codex_input` | Send text or control keys to an interactive session |
| `stop_codex_session` | Stop one interactive session |
| `list_codex_sessions` | List currently running interactive sessions |

## Recommended agent workflow

Use `start_codex_job` for coding tasks that may take more than a single MCP request timeout. It returns immediately with `jobId`, `running`, and `nextOffset`. Poll with `read_codex_job`, passing the last `nextOffset` as `since_offset` so only new JSONL events are returned. Continue until `running` is false, then inspect `exitCode` and the final events. Save the returned `threadId`; `resume_codex_job` can send follow-up work to that Codex thread, including after the MCP process restarts.

Jobs default to a two-hour hard timeout and may be configured up to 24 hours. On timeout or an explicit stop, the server sends SIGTERM and escalates to SIGKILL after five seconds. Finished jobs remain readable for 24 hours. In-memory job metadata and interactive PTYs end with the MCP server process; persisted Codex threads can still be continued afterward with `resume_codex_job` when the caller retained the `threadId`.

Use `codex_exec` only for short one-shot tasks where blocking the MCP call is acceptable. Use an interactive session when Codex needs follow-up prompts or TUI commands.

## Notes

The interactive session uses `--no-alt-screen` by default so terminal output is easier for MCP clients to capture. Use `send_codex_input` with `submit=true` to send a prompt to the Codex composer, or send control keys such as Ctrl+C. The default short delay between writing text and Enter avoids a Codex TUI paste/submit race.

Interactive reads return `output_mode: "clean"` by default. This strips ANSI/control sequences, collapses adjacent duplicate lines, and limits cleaned output by both `max_lines` and `max_chars` so calling LLMs get the readable tail of the session instead of raw terminal redraw noise. Pass `output_mode: "raw"` to `start_codex_session`, `read_codex_session`, or `send_codex_input` when you need exact PTY bytes for debugging.

Both session reads and sends return `nextOffset`. Pass it back as `since_offset` on the next call to avoid repeating previously observed output. If the bounded 250,000-character buffer rolled over before a read, `droppedChars` reports the amount no longer available.

Codex authentication is handled by your existing Codex CLI install. Run `codex login` outside this MCP if the CLI is not authenticated.

## MCP Config

```json
{
  "mcpServers": {
    "codex-terminal": {
      "command": "npx",
      "args": ["@cynosure-mcp/codex-terminal"]
    }
  }
}
```

## License

MIT
