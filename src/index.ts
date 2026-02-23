#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { discoverServers, findDuplicates, type ServerConfig } from "./scanner.js";
import { checkAllServers, checkServer } from "./health.js";
import { saveResults, getServerHistory, getLatestResults, getServerStats, saveProxyCall } from "./history.js";
import { resolveServer } from "./client.js";
import { fetchAllTools, searchTools, formatToolList, callToolOnServer } from "./proxy.js";

/**
 * Redact passwords from connection-string URLs (e.g. postgres://user:pass@host).
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "****";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Redact sensitive values from args (tokens, keys, passwords, URLs).
 */
function redactArgs(args: string[]): string {
  const sensitivePatterns = /^(sntryu_|lsv2_|sk-|sk_|ghp_|ghu_|xox[bpas]-|key-|token-|Bearer\s)/i;
  const sensitiveFlags = ["--access-token", "--api-key", "--token", "--secret", "--password"];
  const urlWithAuthPattern = /^[a-z][a-z0-9+.-]*:\/\/[^/]*:[^/]*@/i;

  return args
    .map((arg, i) => {
      // Redact values that follow sensitive flags
      if (i > 0 && sensitiveFlags.includes(args[i - 1])) {
        return arg.substring(0, 6) + "…" + arg.substring(arg.length - 4);
      }
      // Redact values that look like tokens
      if (sensitivePatterns.test(arg)) {
        return arg.substring(0, 6) + "…" + arg.substring(arg.length - 4);
      }
      // Redact passwords in connection URLs
      if (urlWithAuthPattern.test(arg)) {
        return redactUrl(arg);
      }
      return arg;
    })
    .join(" ");
}

const server = new McpServer({
  name: "mcp-doc",
  version: "0.2.0",
});

// ─── Tool: list_servers ─────────────────────────────────────────────────────

server.tool(
  "list_servers",
  "Discover all MCP servers configured across your projects and IDEs. Scans ~/.claude.json, .mcp.json files, Cursor config, and VS Code config. Returns a complete inventory with no side effects.",
  {},
  async () => {
    const servers = discoverServers();

    if (servers.length === 0) {
      return {
        content: [{ type: "text", text: "No MCP servers found on this machine." }],
      };
    }

    // Group by project
    const byProject = new Map<string, typeof servers>();
    for (const s of servers) {
      const group = byProject.get(s.project) || [];
      group.push(s);
      byProject.set(s.project, group);
    }

    let output = `Found ${servers.length} servers across ${byProject.size} projects:\n\n`;

    for (const [project, projectServers] of byProject) {
      output += `${project} (${projectServers.length} server${projectServers.length > 1 ? "s" : ""}):\n`;
      for (const s of projectServers) {
        const cmd = s.config.command || s.config.url || "unknown";
        const args = redactArgs(s.config.args || []);
        output += `  - ${s.name}: ${cmd} ${args}\n`;
        output += `    config: ${s.configFile}\n`;
      }
      output += "\n";
    }

    // Check for duplicates
    const duplicates = findDuplicates(servers);
    if (duplicates.size > 0) {
      output += "Duplicates detected (same server in multiple projects):\n";
      for (const [, group] of duplicates) {
        const names = group.map((s) => `${s.project}/${s.name}`).join(", ");
        output += `  - ${names}\n`;
      }
    }

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

// ─── Tool: check_health ─────────────────────────────────────────────────────

server.tool(
  "check_health",
  "Health-check all discovered MCP servers by spawning each one, performing the MCP handshake, and verifying it responds. Saves results to history. Optionally filter by project name.",
  {
    project: z.string().optional().describe("Filter to a specific project name (partial match)"),
  },
  async ({ project }) => {
    const servers = discoverServers();

    if (servers.length === 0) {
      return {
        content: [{ type: "text", text: "No MCP servers found to check." }],
      };
    }

    const startTime = Date.now();
    const results = await checkAllServers(servers, project);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    // Save to history
    saveResults(results);

    const ok = results.filter((r) => r.status === "ok").length;
    const fail = results.filter((r) => r.status === "fail").length;
    const skip = results.filter((r) => r.status === "skip").length;

    let output = `Health check complete (${results.length} servers, ${totalTime}s):\n\n`;

    for (const r of results) {
      const icon = r.status === "ok" ? "✓" : r.status === "fail" ? "✗" : "○";
      const status = r.status.toUpperCase().padEnd(4);
      const latency = r.status !== "skip" ? `${(r.latencyMs / 1000).toFixed(1)}s` : "  -";
      const tools = r.toolCount > 0 ? `${r.toolCount} tools` : "";
      const error = r.error && r.status === "fail" ? `  Error: ${r.error}` : "";

      output += `${icon} ${r.project}/${r.server}  ${status}  ${latency.padStart(6)}  ${tools}${error}\n`;
    }

    output += `\n${ok} healthy, ${fail} failing`;
    if (skip > 0) output += `, ${skip} skipped`;

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

// ─── Tool: server_history ───────────────────────────────────────────────────

server.tool(
  "server_history",
  "Show health check history for a specific MCP server. Displays past results and uptime stats from the local database.",
  {
    server: z.string().describe("Name of the MCP server (e.g., 'langsmith', 'sentry')"),
    limit: z.number().optional().default(10).describe("Number of history entries to show"),
  },
  async ({ server: serverName, limit }) => {
    const history = getServerHistory(serverName, limit);

    if (history.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No health check history for "${serverName}". Run check_health first.`,
        }],
      };
    }

    const stats = getServerStats(serverName);

    let output = `History for "${serverName}":\n\n`;

    for (const h of history) {
      const icon = h.status === "ok" ? "✓" : "✗";
      const date = new Date(h.checkedAt).toLocaleString();
      const latency = `${(h.latencyMs / 1000).toFixed(1)}s`;
      const error = h.error ? `  ${h.error}` : "";
      output += `${icon} ${date}  ${h.status.toUpperCase()}  ${latency}  ${h.toolCount} tools${error}\n`;
    }

    output += `\nStats: ${stats.totalChecks} checks, ${stats.uptimePercent}% uptime\n`;
    if (stats.lastHealthy) {
      output += `Last healthy: ${new Date(stats.lastHealthy).toLocaleString()}\n`;
    }
    if (stats.lastFailed) {
      output += `Last failed:  ${new Date(stats.lastFailed).toLocaleString()}\n`;
    }

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

// ─── Tool: server_detail ────────────────────────────────────────────────────

server.tool(
  "server_detail",
  "Show detailed information about a specific MCP server: config, last health check, full tool list, and whether it appears in multiple projects.",
  {
    server: z.string().describe("Name of the MCP server (e.g., 'langsmith', 'sentry')"),
    project: z.string().optional().describe("Project name to disambiguate if server exists in multiple projects"),
  },
  async ({ server: serverName, project }) => {
    const allServers = discoverServers();
    let matches = allServers.filter((s) => s.name === serverName);

    if (project) {
      matches = matches.filter((s) => s.project.toLowerCase().includes(project.toLowerCase()));
    }

    if (matches.length === 0) {
      return {
        content: [{
          type: "text",
          text: `Server "${serverName}" not found. Use list_servers to see all available servers.`,
        }],
      };
    }

    const target = matches[0];
    const config = target.config;

    let output = `${target.name} (${target.project})\n`;
    output += `${"─".repeat(40)}\n`;

    if (config.command) {
      output += `Command: ${config.command} ${redactArgs(config.args || [])}\n`;
    }
    if (config.url) {
      output += `URL: ${config.url}\n`;
    }
    output += `Config:  ${target.configFile}\n`;

    // Run a live health check
    output += `\nRunning health check...\n`;
    const result = await checkServer(target);
    saveResults([result]);

    const icon = result.status === "ok" ? "✓" : result.status === "fail" ? "✗" : "○";
    output += `Status:  ${icon} ${result.status.toUpperCase()} (${(result.latencyMs / 1000).toFixed(1)}s)\n`;

    if (result.error) {
      output += `Error:   ${result.error}\n`;
    }

    if (result.tools.length > 0) {
      output += `\nTools (${result.toolCount}):\n`;
      for (const tool of result.tools) {
        output += `  - ${tool}\n`;
      }
    }

    // Check if this server exists in other projects
    const otherInstances = allServers.filter(
      (s) => s.name === serverName && s.project !== target.project
    );
    if (otherInstances.length > 0) {
      output += `\nAlso configured in:\n`;
      for (const other of otherInstances) {
        output += `  - ${other.project} (${other.configFile})\n`;
      }
    }

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

// ─── Tool: list_all_tools ────────────────────────────────────────────────────

server.tool(
  "list_all_tools",
  "Fetch complete tool catalog from all discovered MCP servers. Connects to each server live and returns every tool's name, description, and parameters.",
  {
    server: z.string().optional().describe("Filter to a specific server name"),
    project: z.string().optional().describe("Filter to a specific project"),
  },
  async ({ server: serverFilter, project }) => {
    const servers = discoverServers();
    if (servers.length === 0) {
      return { content: [{ type: "text", text: "No MCP servers found." }] };
    }

    const { tools, errors } = await fetchAllTools(servers, serverFilter, project);
    const output = formatToolList(tools, errors);
    return { content: [{ type: "text", text: output }] };
  }
);

// ─── Tool: search_tools ─────────────────────────────────────────────────────

server.tool(
  "search_tools",
  "Search for tools by keyword across all discovered MCP servers. Matches against tool names and descriptions.",
  {
    query: z.string().describe("Search term to match against tool names and descriptions"),
    server: z.string().optional().describe("Limit search to a specific server"),
    project: z.string().optional().describe("Limit search to a specific project"),
  },
  async ({ query, server: serverFilter, project }) => {
    const servers = discoverServers();
    if (servers.length === 0) {
      return { content: [{ type: "text", text: "No MCP servers found." }] };
    }

    const { tools, errors } = await searchTools(servers, query, serverFilter, project);

    if (tools.length === 0) {
      let output = `No tools found matching "${query}".`;
      if (errors.length > 0) {
        output += `\n\nSome servers had errors:\n`;
        for (const e of errors) {
          output += `  ✗ ${e.project}/${e.server}: ${e.error}\n`;
        }
      }
      return { content: [{ type: "text", text: output }] };
    }

    const output = formatToolList(tools, errors);
    return { content: [{ type: "text", text: output.replace(/^Found \d+ tools/, `Found ${tools.length} tools matching "${query}"`) }] };
  }
);

// ─── Tool: call_tool ────────────────────────────────────────────────────────

server.tool(
  "call_tool",
  "Call any tool on any discovered MCP server. Spawns the target server, connects via MCP, invokes the tool, and returns the result. Use list_all_tools or search_tools to discover available tools first.",
  {
    server: z.string().describe("Name of the target MCP server (e.g., 'sentry', 'langsmith')"),
    tool: z.string().describe("Name of the tool to invoke on that server"),
    arguments: z.string().optional().default("{}").describe("Arguments as a JSON string (e.g. '{\"project_slug\": \"my-project\"}')"),
    project: z.string().optional().describe("Project name to disambiguate if server exists in multiple projects"),
  },
  async ({ server: serverName, tool: toolName, arguments: toolArgsJson, project }) => {
    const servers = discoverServers();

    let target;
    try {
      target = resolveServer(servers, serverName, project);
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      };
    }

    // Parse arguments JSON string
    let toolArgs: Record<string, unknown>;
    try {
      toolArgs = JSON.parse(toolArgsJson) as Record<string, unknown>;
    } catch {
      return {
        content: [{ type: "text" as const, text: `Invalid JSON in arguments: ${toolArgsJson}` }],
      };
    }

    try {
      const result = await callToolOnServer(target, toolName, toolArgs);

      // Log the proxy call
      saveProxyCall({
        server: result.serverName,
        project: target.project,
        tool: result.toolName,
        status: result.isError ? "fail" : "ok",
        latencyMs: result.latencyMs,
        error: null,
        calledAt: new Date().toISOString(),
      });

      // Serialize proxied result as text
      const header = `[Proxied: ${target.project}/${serverName} → ${toolName} in ${(result.latencyMs / 1000).toFixed(1)}s]`;
      const body = result.content
        .map((block) => {
          if (block.type === "text" && "text" in block) return block.text as string;
          return JSON.stringify(block, null, 2);
        })
        .join("\n");

      return {
        content: [{ type: "text" as const, text: `${header}\n\n${body}` }],
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      saveProxyCall({
        server: serverName,
        project: target.project,
        tool: toolName,
        status: "fail",
        latencyMs: 0,
        error: errorMsg,
        calledAt: new Date().toISOString(),
      });

      return {
        content: [{ type: "text" as const, text: `Failed to call ${serverName}/${toolName}: ${errorMsg}` }],
      };
    }
  }
);

// ─── Start server ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("mcp-doc failed to start:", err);
  process.exit(1);
});
