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
| `start_codex_session` | Start an interactive `codex` terminal session in a PTY |
| `read_codex_session` | Read buffered output from an interactive session |
| `send_codex_input` | Send text or control keys to an interactive session |
| `stop_codex_session` | Stop one interactive session |
| `list_codex_sessions` | List currently running interactive sessions |

## Notes

The interactive session uses `--no-alt-screen` by default so terminal output is easier for MCP clients to capture. Use `send_codex_input` with `submit=true` to send a prompt to the Codex composer, or send raw control characters for keys such as Ctrl+C.

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
