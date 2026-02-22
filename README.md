# mcp-doc

An MCP server that auto-discovers and health-checks all your other MCP servers. Add it once, ask your AI tool "what's broken?", done.

## What It Does

**mcp-doc** is a diagnostic tool, not a proxy. It scans your machine for every MCP server configured across all your projects and IDEs, checks if they're healthy, and tracks history over time. Your existing MCP connections stay exactly as they are.

### Tools

| Tool | Description |
|------|-------------|
| `list_servers` | Discover all MCP servers across all projects. Scans `~/.claude.json`, `.mcp.json`, Cursor, and VS Code configs. |
| `check_health` | Spawn each server, perform the MCP handshake, verify it responds. Saves results to history. |
| `server_history` | Show past health check results and uptime stats for a specific server. |
| `server_detail` | Deep inspection of a single server: config, live health check, full tool list, cross-project duplicates. |

### Example

Ask Claude: *"Are all my MCP servers healthy?"*

```
Health check complete (9 servers, 9.7s):

✓ totetaxi/langsmith              OK   1.2s  16 tools
✓ totetaxi/sentry                 OK   1.4s  22 tools
✓ store/sentry                    OK   1.2s  22 tools
✓ store/postgres-local            OK   0.9s   1 tools
✓ store/postgres-prod             OK   0.9s   1 tools
✓ store/redis                     OK   0.9s  45 tools
✓ store/netlify                   OK   1.3s   9 tools
✓ store/railway                   OK   1.1s  14 tools
✓ matt-website/google-analytics   OK   0.7s   6 tools

9 healthy, 0 failing
```

## Install

Add to your Claude Code config (`~/.claude.json` for global, or `.mcp.json` for per-project):

```json
{
  "mcpServers": {
    "doctor": {
      "command": "npx",
      "args": ["mcp-doc"]
    }
  }
}
```

Restart your IDE. That's it.

## How It Works

1. **Discovery** — Scans config files from Claude Code, Cursor, and VS Code to find all MCP servers across all your projects
2. **Health Check** — Spawns each server as a temporary child process, sends `initialize` + `tools/list` via JSON-RPC, measures response time, then kills the process
3. **History** — Saves results to a local SQLite database at `~/.mcp-doc/history.db`
4. **Reporting** — Returns formatted results through MCP tools that your AI assistant can read and interpret

### What It Scans

| Source | Path |
|--------|------|
| Claude Code (global) | `~/.claude.json` → `projects.*.mcpServers` |
| Claude Code (project) | `<project>/.mcp.json` |
| Cursor (global) | `~/.cursor/mcp.json` |
| VS Code (project) | `<project>/.vscode/mcp.json` |

### What It Does NOT Do

- Does not proxy traffic — your servers connect directly to your IDE
- Does not modify any config files
- Does not run servers persistently — spawns briefly for health checks only
- Does not require an account, API key, or cloud service
- Does not add latency to your normal MCP usage

## How It Compares

| | mcp-hub | MetaMCP | mcp-doc |
|---|---|---|---|
| Setup | Write a separate config | Create account + API key | Zero config — auto-discovers |
| Architecture | Proxy | Cloud proxy + GUI | Read-only scanner |
| Cross-project | No | Yes (workspaces) | Yes (auto-scan) |
| Health history | Current only | Current only | SQLite history |
| Privacy | Local | Cloud | Local |

## Development

```bash
git clone https://github.com/mattyray/mcp-doc.git
cd mcp-doc
npm install
npm run build
```

## Tech Stack

- TypeScript + Node.js
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — Official MCP SDK
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — Local history database

## License

MIT
