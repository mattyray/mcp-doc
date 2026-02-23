# Build Log: mcp-doc — From Crash to Meta MCP Server

*A chronicle of building an MCP server that monitors, discovers, and proxies all your other MCP servers.*

---

## Phase 1: The Crash

**Problem:** Installing mcp-doc as an MCP server crashed both VS Code and Claude Code immediately on startup.

**Root cause:** The `better-sqlite3` dependency is a native C++ addon compiled against a specific Node.js ABI version. When VS Code or Claude Code spawns an MCP server, they use their own Node.js/Electron runtime — which has a different ABI than the system Node.js that compiled the native module. This causes a segfault that kills the entire host process. Not an error. Not an exception. A hard crash.

**Decision:** Replace `better-sqlite3` with a plain JSON file for history storage. SQLite was overkill for what's essentially a simple append log of health check results. The JSON approach:
- Zero native dependencies (no ABI issues, ever)
- Works in any Node.js runtime
- History capped at 500 entries to keep the file small
- Dropped 36 packages from the dependency tree

**Lesson learned:** Native Node.js addons are a ticking time bomb in MCP servers. MCP servers run as child processes inside IDE runtimes you don't control. Pure JavaScript dependencies only.

## Phase 2: Bug Fixes

### Self-Check Infinite Recursion Guard

The health checker spawns each discovered MCP server to test it. But what if it discovers *itself*? It would spawn itself, which would discover itself, which would spawn itself...

The original guard only checked if the command string contained "mcp-doc". But if someone configured it as `npx @mnraynor90/mcp-doc`, the package name check could miss. Fixed by also checking:
- The npm scoped package name (`@mnraynor90/mcp-doc`)
- The server name field (`server.name === "mcp-doc"`)

### Credential Leaking in Output

Running `list_servers` revealed that database connection strings were shown in full, including passwords:

```
postgres://postgres:****@yamanote.proxy.rlwy.net:10478/railway
```

The existing `redactArgs()` function only caught token-style prefixes (`sk-`, `ghp_`, etc.). Added URL password detection using the `URL` constructor — any `scheme://user:password@host` pattern now gets the password replaced with `****`.

## Phase 3: Designing the Meta MCP Server

### The Idea

mcp-doc started as a health checker — "are my servers up?" But the real question users have is: "what can all my servers *do*?"

With 9 MCP servers across 3 projects exposing 136 tools, it's genuinely hard to remember which server has which tool. The idea: turn mcp-doc into a **meta MCP server** — a gateway that can discover, inspect, and invoke tools on any MCP server configured on your machine.

### Risk Analysis

Before building, we identified key risks:

1. **Permission bypass**: MCP hosts (VS Code, Claude Code) normally gate each tool call individually. A proxy that calls any tool through a single `call_tool` gateway bypasses that per-tool approval. The user only approves "mcp-doc: call_tool" — not the underlying operation.

2. **Process spawning overhead**: Every proxied call spawns a new server process, does a full MCP handshake, calls one tool, and tears down. That's 1-2 seconds of overhead for something the host could do directly.

3. **Orphaned processes**: If mcp-doc crashes mid-proxy-call, child processes could be left running.

### Mitigations

- **Tool validation**: `call_tool` verifies the target tool exists (calls `listTools()` first) before invoking it
- **Transparency header**: Every proxied response includes which server/tool was called and how long it took
- **Audit logging**: All `call_tool` invocations are logged to the history file
- **Forced cleanup**: `withClient()` always kills child processes in a `finally` block
- **30-second timeout**: Operations that hang get killed via `Promise.race()`

### Decision: Build It Anyway

The cross-project use case is real: you're working in Project A but need data from a server only configured in Project B. And the discovery tools (`list_all_tools`, `search_tools`) are useful regardless — they turn mcp-doc into living documentation for your entire MCP ecosystem.

## Phase 4: Architecture Refactor

### Replacing Raw JSON-RPC with the SDK Client

The original health checker used hand-rolled JSON-RPC over raw `child_process.spawn()` — about 80 lines of custom protocol code. The `@modelcontextprotocol/sdk` already provides a `Client` class with `StdioClientTransport` that handles all of this correctly.

**Created `src/client.ts`** — a shared module with:
- `withClient(server, fn, timeout)`: Spawn → connect → run callback → always clean up
- `shouldSkipServer(server)`: Centralized self-check and remote server guards
- `resolveServer(servers, name, project?)`: Find a server by name with disambiguation

This let us rewrite `health.ts` from ~160 lines to ~80 lines while adding better timeout handling and process cleanup.

### New Module: `src/proxy.ts`

The proxy operations module provides:
- `fetchAllTools()`: Connect to servers, return full tool schemas with parameter signatures
- `searchTools()`: Fetch all tools, then filter by keyword match on name/description
- `callToolOnServer()`: Connect, validate tool exists, call it, return result
- `formatToolList()`: Pretty-print tool catalogs with parameter signatures

## Phase 5: The New Tools

### `list_all_tools`
Connects to every discovered server and fetches complete tool schemas. Shows each tool's name, parameters (with types and required/optional), and description. Result: a full catalog of 136 tools across 9 servers.

### `search_tools`
"Which of my 136 tools can handle issues?" — searches tool names and descriptions across all servers. Found 14 tools matching "issue" across both Sentry instances.

### `call_tool`
The proxy itself. Takes a server name, tool name, and arguments. Spawns the target server, connects via MCP, calls the tool, returns the result. First successful test: proxied `railway/list-projects` and got back real project data in 1.2 seconds.

## Phase 6: Results

### Before (v0.1.0)
- 4 tools: list_servers, check_health, server_history, server_detail
- Crashed VS Code and Claude Code on startup
- Leaked database passwords in output
- Raw JSON-RPC protocol handling

### After (v0.2.0)
- 7 tools: + list_all_tools, search_tools, call_tool
- Zero native dependencies (no more crashes)
- Credential redaction for URLs
- SDK-based client with proper cleanup
- Audit logging for proxied calls
- Full meta MCP gateway capability

### What This Means

You can now ask Claude: "What tools do I have across all my projects?" and get a real answer. You can search for capabilities by keyword. And you can invoke any tool on any server from any project — turning a health checker into a universal MCP gateway.

---

*Built with Claude Code. Every decision, every bug, every fix — documented as it happened.*
