# mcp-doc

Meta MCP server that discovers, health-checks, and proxies all your other MCP servers.

## Quick Reference

- **Build:** `npm run build` (TypeScript → dist/)
- **Dev:** `npm run dev` (watch mode)
- **Start:** `npm start` or `node dist/index.js`
- **Publish:** `npm publish --access public` (requires npm 2FA)
- **Package:** `@mnraynor90/mcp-doc` on npm, currently v0.2.0

## Architecture

```
src/
  index.ts      → MCP server entry point, registers all 7 tools
  scanner.ts    → Discovers MCP servers from config files across the machine
  health.ts     → Health-checks servers (spawn → MCP handshake → listTools)
  history.ts    → JSON file storage at ~/.mcp-doc/history.json (500 entry cap)
  client.ts     → Shared MCP client lifecycle (withClient, shouldSkipServer, resolveServer)
  proxy.ts      → Tool catalog fetching, search, and proxied tool calls
```

### Data Flow

Scanner discovers configs → Client spawns servers temporarily → Health/Proxy operations run → History persists results

### Key Patterns

- **No native dependencies.** better-sqlite3 was removed because native addons crash IDE runtimes (ABI mismatch). JSON file storage only.
- **`withClient(server, fn, timeout)`** is the core pattern: spawn → connect → run callback → always clean up (finally block kills child process).
- **30-second timeout** on all client operations via `Promise.race()`.
- **Self-check guard** in `shouldSkipServer()` prevents infinite recursion (checks command, package name, and server.name).
- **Sequential health checks** to avoid spawning too many processes at once.
- **Credential redaction** in `redactArgs()` — catches tokens (sk-, ghp_, etc.) and URL passwords via the URL constructor.

## MCP Tools (7 total)

| Tool | Purpose |
|------|---------|
| `list_servers` | Discover all configured MCP servers across projects/IDEs |
| `check_health` | Spawn and verify each server responds to MCP handshake |
| `server_history` | Show past health check results and uptime stats |
| `server_detail` | Deep inspection: config, live check, tool list, duplicates |
| `list_all_tools` | Fetch full tool catalog with parameter schemas from all servers |
| `search_tools` | Search tools by keyword across all servers |
| `call_tool` | Proxy: call any tool on any server from any project context |

## Config Sources Scanned

- `~/.claude.json` → global Claude Code projects
- `<project>/.mcp.json` → per-project Claude Code
- `~/.cursor/mcp.json` → Cursor global
- `<project>/.vscode/mcp.json` → VS Code per-project
- Scans ~/Desktop, ~/Documents, ~/Projects, ~/dev, ~/src, ~/code, ~/workspace (2 levels deep)

## Important Constraints

- MCP servers run as child processes in IDE runtimes — never use native Node.js addons.
- `call_tool` accepts arguments as a JSON string (`z.string()`), not a typed object. This is because tool schemas are dynamic/unknown at registration time.
- The proxy bypasses the host's per-tool permission model — the host only approves "call_tool", not the underlying operation.
- History is stored at `~/.mcp-doc/history.json`, not in the project directory.
- `scanner.ts` uses synchronous fs reads — fine for config files, don't extend this pattern to large files.

## TypeScript Config

- Target: ES2022, Module: Node16 (ESM with `"type": "module"` in package.json)
- Strict mode enabled
- All imports use `.js` extensions (required for Node16 module resolution)
