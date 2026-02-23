import type { DiscoveredServer } from "./scanner.js";
import { withClient, shouldSkipServer } from "./client.js";

export interface ToolInfo {
  server: string;
  project: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProxyCallResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  serverName: string;
  toolName: string;
  latencyMs: number;
}

/**
 * Format a tool's input schema into a readable parameter signature.
 */
function formatParams(schema: Record<string, unknown>): string {
  const props = schema.properties as Record<string, { type?: string }> | undefined;
  const required = (schema.required as string[]) || [];
  if (!props) return "()";

  const params = Object.entries(props).map(([name, def]) => {
    const type = def?.type || "any";
    const opt = required.includes(name) ? "" : "?";
    return `${name}${opt}: ${type}`;
  });

  return `(${params.join(", ")})`;
}

/**
 * Fetch full tool schemas from all (or filtered) servers.
 */
export async function fetchAllTools(
  servers: DiscoveredServer[],
  serverFilter?: string,
  projectFilter?: string
): Promise<{ tools: ToolInfo[]; errors: Array<{ server: string; project: string; error: string }> }> {
  let filtered = servers;
  if (serverFilter) {
    filtered = filtered.filter((s) => s.name === serverFilter);
  }
  if (projectFilter) {
    filtered = filtered.filter((s) =>
      s.project.toLowerCase().includes(projectFilter.toLowerCase())
    );
  }

  const allTools: ToolInfo[] = [];
  const errors: Array<{ server: string; project: string; error: string }> = [];

  for (const server of filtered) {
    const skipReason = shouldSkipServer(server);
    if (skipReason) continue;

    try {
      const tools = await withClient(server, async (client) => {
        const result = await client.listTools();
        return result.tools.map((t) => ({
          server: server.name,
          project: server.project,
          name: t.name,
          description: t.description || "",
          inputSchema: (t.inputSchema || {}) as Record<string, unknown>,
        }));
      });
      allTools.push(...tools);
    } catch (err) {
      errors.push({
        server: server.name,
        project: server.project,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tools: allTools, errors };
}

/**
 * Search for tools by keyword across servers.
 */
export async function searchTools(
  servers: DiscoveredServer[],
  query: string,
  serverFilter?: string,
  projectFilter?: string
): Promise<{ tools: ToolInfo[]; errors: Array<{ server: string; project: string; error: string }> }> {
  const { tools, errors } = await fetchAllTools(servers, serverFilter, projectFilter);
  const q = query.toLowerCase();

  const matched = tools.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q)
  );

  return { tools: matched, errors };
}

/**
 * Format tool list into readable output.
 */
export function formatToolList(
  tools: ToolInfo[],
  errors: Array<{ server: string; project: string; error: string }>
): string {
  if (tools.length === 0 && errors.length === 0) {
    return "No tools found.";
  }

  // Group by server
  const byServer = new Map<string, ToolInfo[]>();
  for (const t of tools) {
    const key = `${t.project}/${t.server}`;
    const group = byServer.get(key) || [];
    group.push(t);
    byServer.set(key, group);
  }

  let output = `Found ${tools.length} tools across ${byServer.size} servers:\n\n`;

  for (const [serverKey, serverTools] of byServer) {
    output += `${serverKey} (${serverTools.length} tools):\n`;
    for (const t of serverTools) {
      const params = formatParams(t.inputSchema);
      output += `  - ${t.name}${params}`;
      if (t.description) {
        const desc = t.description.length > 80
          ? t.description.substring(0, 77) + "..."
          : t.description;
        output += ` — ${desc}`;
      }
      output += "\n";
    }
    output += "\n";
  }

  if (errors.length > 0) {
    output += `Errors (${errors.length}):\n`;
    for (const e of errors) {
      output += `  ✗ ${e.project}/${e.server}: ${e.error}\n`;
    }
  }

  return output;
}

/**
 * Call a tool on a specific server. Validates the tool exists first.
 */
export async function callToolOnServer(
  server: DiscoveredServer,
  toolName: string,
  args: Record<string, unknown>
): Promise<ProxyCallResult> {
  const start = Date.now();

  return await withClient(server, async (client) => {
    // Validate tool exists
    const toolsResult = await client.listTools();
    const tool = toolsResult.tools.find((t) => t.name === toolName);
    if (!tool) {
      const available = toolsResult.tools.map((t) => t.name).join(", ");
      throw new Error(
        `Tool "${toolName}" not found on ${server.name}. Available: ${available}`
      );
    }

    // Call the tool
    const result = await client.callTool({ name: toolName, arguments: args });

    return {
      content: result.content as Array<{ type: string; [key: string]: unknown }>,
      isError: result.isError as boolean | undefined,
      serverName: server.name,
      toolName,
      latencyMs: Date.now() - start,
    };
  });
}
