import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DiscoveredServer } from "./scanner.js";

export const CLIENT_TIMEOUT = 30_000;

/**
 * Returns a reason to skip this server, or null if it should be checked.
 */
export function shouldSkipServer(server: DiscoveredServer): string | null {
  // Skip remote/HTTP servers
  if (!server.config.command) {
    return "Remote/HTTP servers not yet supported";
  }

  // Skip self-references to avoid infinite recursion
  const cmd = server.config.command || "";
  const args = (server.config.args || []).join(" ");
  const fullCommand = `${cmd} ${args}`.toLowerCase();
  if (
    fullCommand.includes("mcp-doc") ||
    fullCommand.includes("@mnraynor90/mcp-doc") ||
    server.name === "mcp-doc"
  ) {
    return "Skipped self-check";
  }

  return null;
}

/**
 * Find a server by name, optionally filtering by project.
 * Throws descriptive errors if not found or ambiguous.
 */
export function resolveServer(
  servers: DiscoveredServer[],
  serverName: string,
  project?: string
): DiscoveredServer {
  let matches = servers.filter((s) => s.name === serverName);

  if (project) {
    matches = matches.filter((s) =>
      s.project.toLowerCase().includes(project.toLowerCase())
    );
  }

  if (matches.length === 0) {
    const available = [...new Set(servers.map((s) => s.name))].join(", ");
    throw new Error(
      `Server "${serverName}" not found. Available: ${available}`
    );
  }

  if (matches.length > 1 && !project) {
    const projects = matches.map((s) => `${s.project}/${s.name}`).join(", ");
    throw new Error(
      `Multiple servers named "${serverName}" found: ${projects}. Specify a project to disambiguate.`
    );
  }

  return matches[0];
}

/**
 * Race a promise against a timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out (${ms}ms)`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Spawn an MCP server, connect via SDK Client, run a callback, and always clean up.
 */
export async function withClient<T>(
  server: DiscoveredServer,
  fn: (client: Client) => Promise<T>,
  timeoutMs = CLIENT_TIMEOUT
): Promise<T> {
  const transport = new StdioClientTransport({
    command: server.config.command!,
    args: server.config.args || [],
    env: { ...process.env, ...(server.config.env || {}) } as Record<string, string>,
    stderr: "pipe",
  });

  const client = new Client(
    { name: "mcp-doc", version: "0.2.0" },
    { capabilities: {} }
  );

  try {
    await withTimeout(client.connect(transport), timeoutMs, "Connection");
    return await withTimeout(fn(client), timeoutMs, "Operation");
  } finally {
    try {
      await client.close();
    } catch {
      // Already dead — force kill via transport
      try {
        await transport.close();
      } catch {
        // Best effort
      }
    }
  }
}
