# mcp-doc

A meta MCP server that auto-discovers, health-checks, and proxies all your other MCP servers. Add it once — get a universal gateway to every tool across every project.

## What It Does

**mcp-doc** scans your machine for every MCP server configured across all your projects and IDEs. It can check if they're healthy, search across all their tools, and call any tool on any server from any project context.

### Tools

| Tool | Description |
|------|-------------|
| `list_servers` | Discover all MCP servers across all projects. Scans `~/.claude.json`, `.mcp.json`, Cursor, and VS Code configs. |
| `check_health` | Spawn each server, perform the MCP handshake, verify it responds. Saves results to history. |
| `server_history` | Show past health check results and uptime stats for a specific server. |
| `server_detail` | Deep inspection of a single server: config, live health check, full tool list, cross-project duplicates. |
| `list_all_tools` | Fetch the complete tool catalog from all servers — names, descriptions, and parameter schemas. |
| `search_tools` | Search for tools by keyword across all servers. Matches tool names and descriptions. |
| `call_tool` | Call any tool on any discovered server. Spawns the target, connects via MCP, invokes the tool, returns the result. |

### Examples

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

Ask Claude: *"Search my tools for anything related to issues"*

```
Found 14 tools matching "issue" across 2 servers:

totetaxi/sentry (7 tools):
  - list_issues(organization_slug: string, project_slug: string, ...) — List issues in a project
  - get_issue_details(issue_id: string) — Get details for a specific issue
  ...

store/sentry (7 tools):
  - list_issues(organization_slug: string, project_slug: string, ...) — List issues in a project
  ...
```

Ask Claude: *"Check my Google Analytics traffic"* (from any project)

```
[Proxied: matthew_raynor_website/google-analytics → run_report in 1.0s]

{ rows: [{ country: "United States", city: "New York", activeUsers: 6 }, ...] }
```

## Install

Add to your Claude Code config (`~/.claude.json` for global, or `.mcp.json` for per-project):

```json
{
  "mcpServers": {
    "doctor": {
      "command": "npx",
      "args": ["@mnraynor90/mcp-doc"]
    }
  }
}
```

Restart your IDE. That's it.

## How It Works

1. **Discovery** — Scans config files from Claude Code, Cursor, and VS Code to find all MCP servers across all your projects
2. **Health Check** — Spawns each server as a temporary child process, performs the MCP handshake, measures response time, then cleans up
3. **Tool Catalog** — Connects to servers to fetch full tool schemas with parameter types
4. **Proxy** — Spawns a target server on demand, validates the tool exists, calls it, and returns the result
5. **History** — Saves results to a local JSON file at `~/.mcp-doc/history.json`

### What It Scans

| Source | Path |
|--------|------|
| Claude Code (global) | `~/.claude.json` → `projects.*.mcpServers` |
| Claude Code (project) | `<project>/.mcp.json` |
| Cursor (global) | `~/.cursor/mcp.json` |
| VS Code (project) | `<project>/.vscode/mcp.json` |

### Design Decisions

- **Zero native dependencies.** Native Node.js addons (like `better-sqlite3`) crash IDE runtimes due to ABI mismatches. mcp-doc uses only pure JavaScript dependencies.
- **Stateless proxy.** Each `call_tool` invocation spawns a fresh server process — no persistent connections, no leaked state.
- **30-second timeout.** All operations are wrapped in `Promise.race()` to kill hung processes.
- **Credential redaction.** `list_servers` masks tokens, API keys, and URL passwords in output.
- **Audit logging.** Every proxied `call_tool` invocation is logged to the history file.
- **Self-check guard.** mcp-doc won't spawn itself, preventing infinite recursion.

## How It Compares

| | mcp-hub | MetaMCP | mcp-doc |
|---|---|---|---|
| Setup | Write a separate config | Create account + API key | Zero config — auto-discovers |
| Architecture | Proxy | Cloud proxy + GUI | Local scanner + proxy |
| Cross-project | No | Yes (workspaces) | Yes (auto-scan) |
| Tool discovery | No | Yes | Yes (search + catalog) |
| Health history | Current only | Current only | JSON history with uptime stats |
| Privacy | Local | Cloud | Local |

## Development

```bash
git clone https://github.com/mattyray/mcp-doc.git
cd mcp-doc
npm install
npm run build
```

## Tech Stack

- TypeScript + Node.js (ES2022, strict mode)
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — Official MCP SDK (Client + Server)

## License

MIT
