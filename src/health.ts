import type { DiscoveredServer } from "./scanner.js";
import { withClient, shouldSkipServer } from "./client.js";

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

/**
 * Health check a single server.
 */
export async function checkServer(server: DiscoveredServer): Promise<HealthResult> {
  const skipReason = shouldSkipServer(server);
  if (skipReason) {
    return {
      server: server.name,
      project: server.project,
      status: "skip",
      latencyMs: 0,
      toolCount: 0,
      tools: [],
      error: skipReason,
      checkedAt: new Date().toISOString(),
    };
  }

  const start = Date.now();

  try {
    return await withClient(server, async (client) => {
      const toolsResult = await client.listTools();
      const toolNames = toolsResult.tools.map((t) => t.name);

      return {
        server: server.name,
        project: server.project,
        status: "ok" as const,
        latencyMs: Date.now() - start,
        toolCount: toolNames.length,
        tools: toolNames,
        error: null,
        checkedAt: new Date().toISOString(),
      };
    });
  } catch (err) {
    return {
      server: server.name,
      project: server.project,
      status: "fail",
      latencyMs: Date.now() - start,
      toolCount: 0,
      tools: [],
      error: err instanceof Error ? err.message : String(err),
      checkedAt: new Date().toISOString(),
    };
  }
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
