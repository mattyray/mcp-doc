import { spawn, ChildProcess } from "child_process";
import type { DiscoveredServer, ServerConfig } from "./scanner.js";

export interface HealthResult {
  server: string;
  project: string;
  status: "ok" | "fail" | "skip";
  latencyMs: number;
  toolCount: number;
  tools: string[];
  error: string | null;
  checkedAt: string;
}

const HEALTH_CHECK_TIMEOUT = 30_000; // 30 seconds max per server

/**
 * Send a JSON-RPC message over stdin to a child process.
 */
function sendJsonRpc(proc: ChildProcess, method: string, id: number, params?: Record<string, unknown>): void {
  const message = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: params || {},
  });
  proc.stdin?.write(message + "\n");
}

/**
 * Read JSON-RPC responses from stdout, looking for a specific id.
 */
function waitForResponse(proc: ChildProcess, expectedId: number, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for response (${timeoutMs}ms)`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      // Try to parse complete JSON objects from the buffer
      const lines = buffer.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (parsed.id === expectedId) {
            clearTimeout(timer);
            proc.stdout?.off("data", onData);
            if (parsed.error) {
              const err = parsed.error as Record<string, unknown>;
              reject(new Error((err.message as string) || "JSON-RPC error"));
            } else {
              resolve(parsed.result as Record<string, unknown>);
            }
            return;
          }
        } catch {
          // Not valid JSON yet, keep buffering
        }
      }
      // Keep the last incomplete line in the buffer
      buffer = lines[lines.length - 1] || "";
    };

    proc.stdout?.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited with code ${code}`));
    });
  });
}

/**
 * Check if a server config is a stdio server (has command) vs remote (has url).
 */
function isStdioServer(config: ServerConfig): boolean {
  return !!config.command;
}

/**
 * Health check a single stdio MCP server by spawning it and performing the handshake.
 */
async function checkStdioServer(server: DiscoveredServer): Promise<HealthResult> {
  const start = Date.now();
  const config = server.config;
  let proc: ChildProcess | null = null;

  try {
    // Resolve environment variables
    const env = { ...process.env, ...(config.env || {}) };

    proc = spawn(config.command!, config.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      timeout: HEALTH_CHECK_TIMEOUT,
    });

    // Step 1: Send initialize
    sendJsonRpc(proc, "initialize", 1, {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-doc", version: "0.1.0" },
    });

    await waitForResponse(proc, 1, HEALTH_CHECK_TIMEOUT);

    // Step 2: Send initialized notification (no response expected)
    const notif = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    proc.stdin?.write(notif + "\n");

    // Step 3: List tools
    sendJsonRpc(proc, "tools/list", 2);
    const toolsResult = await waitForResponse(proc, 2, HEALTH_CHECK_TIMEOUT);
    const tools = (toolsResult.tools as Array<{ name: string }>) || [];
    const toolNames = tools.map((t) => t.name);

    const latencyMs = Date.now() - start;

    return {
      server: server.name,
      project: server.project,
      status: "ok",
      latencyMs,
      toolCount: toolNames.length,
      tools: toolNames,
      error: null,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      server: server.name,
      project: server.project,
      status: "fail",
      latencyMs,
      toolCount: 0,
      tools: [],
      error: err instanceof Error ? err.message : String(err),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    if (proc) {
      proc.kill("SIGTERM");
      // Force kill after 2 seconds if still alive
      setTimeout(() => {
        try {
          proc?.kill("SIGKILL");
        } catch {
          // Already dead
        }
      }, 2000);
    }
  }
}

/**
 * Health check a single server. Skips remote/HTTP servers for now.
 */
export async function checkServer(server: DiscoveredServer): Promise<HealthResult> {
  if (!isStdioServer(server.config)) {
    return {
      server: server.name,
      project: server.project,
      status: "skip",
      latencyMs: 0,
      toolCount: 0,
      tools: [],
      error: "Remote/HTTP servers not yet supported for health checks",
      checkedAt: new Date().toISOString(),
    };
  }

  // Don't health-check ourselves (infinite recursion)
  const cmd = server.config.command || "";
  const args = (server.config.args || []).join(" ");
  if (cmd.includes("mcp-doc") || args.includes("mcp-doc")) {
    return {
      server: server.name,
      project: server.project,
      status: "skip",
      latencyMs: 0,
      toolCount: 0,
      tools: [],
      error: "Skipped self-check",
      checkedAt: new Date().toISOString(),
    };
  }

  return checkStdioServer(server);
}

/**
 * Health check all discovered servers. Runs sequentially to avoid resource contention.
 */
export async function checkAllServers(
  servers: DiscoveredServer[],
  projectFilter?: string
): Promise<HealthResult[]> {
  const filtered = projectFilter
    ? servers.filter((s) => s.project.toLowerCase().includes(projectFilter.toLowerCase()))
    : servers;

  const results: HealthResult[] = [];
  for (const server of filtered) {
    results.push(await checkServer(server));
  }
  return results;
}
