import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

export interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
}

export interface DiscoveredServer {
  name: string;
  project: string;
  projectPath: string;
  configFile: string;
  config: ServerConfig;
}

interface ClaudeJsonProject {
  mcpServers?: Record<string, ServerConfig>;
  [key: string]: unknown;
}

interface McpJsonFile {
  mcpServers?: Record<string, ServerConfig>;
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Scan ~/.claude.json for MCP servers configured under projects.
 */
function scanClaudeGlobal(): DiscoveredServer[] {
  const servers: DiscoveredServer[] = [];
  const claudeJsonPath = join(homedir(), ".claude.json");
  const data = readJsonSafe<{ projects?: Record<string, ClaudeJsonProject> }>(claudeJsonPath);
  if (!data?.projects) return servers;

  for (const [projectPath, projectConfig] of Object.entries(data.projects)) {
    const mcpServers = projectConfig.mcpServers;
    if (!mcpServers || Object.keys(mcpServers).length === 0) continue;

    for (const [name, config] of Object.entries(mcpServers)) {
      servers.push({
        name,
        project: basename(projectPath),
        projectPath,
        configFile: claudeJsonPath,
        config,
      });
    }
  }

  return servers;
}

/**
 * Scan .mcp.json files in project directories.
 * Looks in common dev directories and any projects found in ~/.claude.json.
 */
function scanMcpJsonFiles(projectDirs: string[]): DiscoveredServer[] {
  const servers: DiscoveredServer[] = [];
  const seen = new Set<string>();

  for (const dir of projectDirs) {
    const mcpJsonPath = join(dir, ".mcp.json");
    if (seen.has(mcpJsonPath)) continue;
    seen.add(mcpJsonPath);

    const data = readJsonSafe<McpJsonFile>(mcpJsonPath);
    if (!data?.mcpServers) continue;

    for (const [name, config] of Object.entries(data.mcpServers)) {
      servers.push({
        name,
        project: basename(dir),
        projectPath: dir,
        configFile: mcpJsonPath,
        config,
      });
    }
  }

  return servers;
}

/**
 * Scan Cursor global MCP config.
 */
function scanCursorGlobal(): DiscoveredServer[] {
  const servers: DiscoveredServer[] = [];
  const cursorConfigPath = join(homedir(), ".cursor", "mcp.json");
  const data = readJsonSafe<McpJsonFile>(cursorConfigPath);
  if (!data?.mcpServers) return servers;

  for (const [name, config] of Object.entries(data.mcpServers)) {
    servers.push({
      name,
      project: "(cursor-global)",
      projectPath: "",
      configFile: cursorConfigPath,
      config,
    });
  }

  return servers;
}

/**
 * Scan VS Code .vscode/mcp.json files in project directories.
 */
function scanVscodeMcpFiles(projectDirs: string[]): DiscoveredServer[] {
  const servers: DiscoveredServer[] = [];
  const seen = new Set<string>();

  for (const dir of projectDirs) {
    const vscodeMcpPath = join(dir, ".vscode", "mcp.json");
    if (seen.has(vscodeMcpPath)) continue;
    seen.add(vscodeMcpPath);

    const data = readJsonSafe<McpJsonFile>(vscodeMcpPath);
    if (!data?.mcpServers) continue;

    for (const [name, config] of Object.entries(data.mcpServers)) {
      servers.push({
        name,
        project: basename(dir),
        projectPath: dir,
        configFile: vscodeMcpPath,
        config,
      });
    }
  }

  return servers;
}

/**
 * Collect all known project directories from multiple sources.
 */
function collectProjectDirs(): string[] {
  const dirs = new Set<string>();

  // From ~/.claude.json projects
  const claudeJsonPath = join(homedir(), ".claude.json");
  const claudeData = readJsonSafe<{ projects?: Record<string, unknown> }>(claudeJsonPath);
  if (claudeData?.projects) {
    for (const projectPath of Object.keys(claudeData.projects)) {
      if (existsSync(projectPath)) {
        dirs.add(projectPath);
      }
    }
  }

  // Scan common dev directories for .mcp.json files
  const commonDevDirs = [
    join(homedir(), "Desktop"),
    join(homedir(), "Documents"),
    join(homedir(), "Projects"),
    join(homedir(), "projects"),
    join(homedir(), "dev"),
    join(homedir(), "src"),
    join(homedir(), "code"),
    join(homedir(), "workspace"),
  ];

  for (const devDir of commonDevDirs) {
    if (!existsSync(devDir)) continue;
    try {
      const entries = readdirSync(devDir);
      for (const entry of entries) {
        const fullPath = join(devDir, entry);
        try {
          if (statSync(fullPath).isDirectory()) {
            // Check one level deeper too (e.g., ~/Desktop/MattsPyProjects/totetaxi)
            if (existsSync(join(fullPath, ".mcp.json"))) {
              dirs.add(fullPath);
            }
            // Scan subdirectories
            const subEntries = readdirSync(fullPath);
            for (const subEntry of subEntries) {
              const subPath = join(fullPath, subEntry);
              try {
                if (statSync(subPath).isDirectory() && existsSync(join(subPath, ".mcp.json"))) {
                  dirs.add(subPath);
                }
              } catch {
                // Skip inaccessible dirs
              }
            }
          }
        } catch {
          // Skip inaccessible dirs
        }
      }
    } catch {
      // Skip inaccessible dirs
    }
  }

  return Array.from(dirs);
}

/**
 * Discover all MCP servers across all config sources.
 * Deduplicates servers that appear in multiple locations.
 */
export function discoverServers(): DiscoveredServer[] {
  const projectDirs = collectProjectDirs();
  const allServers: DiscoveredServer[] = [
    ...scanClaudeGlobal(),
    ...scanMcpJsonFiles(projectDirs),
    ...scanCursorGlobal(),
    ...scanVscodeMcpFiles(projectDirs),
  ];

  // Deduplicate: same server name + same project = keep the .mcp.json version (more specific)
  const seen = new Map<string, DiscoveredServer>();
  for (const server of allServers) {
    const key = `${server.project}::${server.name}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, server);
    } else if (server.configFile.endsWith(".mcp.json") && !existing.configFile.endsWith(".mcp.json")) {
      // .mcp.json takes priority over ~/.claude.json
      seen.set(key, server);
    }
  }

  return Array.from(seen.values());
}

/**
 * Find servers that share the same command/args across different projects.
 */
export function findDuplicates(servers: DiscoveredServer[]): Map<string, DiscoveredServer[]> {
  const groups = new Map<string, DiscoveredServer[]>();

  for (const server of servers) {
    // Create a fingerprint based on command + package name (strip versions and flags)
    const cmd = server.config.command || server.config.url || "unknown";
    const meaningfulArg = (server.config.args || []).find((a) => !a.startsWith("-")) || "";
    // Strip version suffixes: @sentry/mcp-server@0.29.0 → @sentry/mcp-server
    const packageName = meaningfulArg.replace(/@[\d.]+[-\w.]*$/, "").replace(/@latest$/, "");
    const fingerprint = `${cmd}::${packageName}`;

    const group = groups.get(fingerprint) || [];
    group.push(server);
    groups.set(fingerprint, group);
  }

  // Only return groups with duplicates
  const duplicates = new Map<string, DiscoveredServer[]>();
  for (const [key, group] of groups) {
    if (group.length > 1) {
      duplicates.set(key, group);
    }
  }

  return duplicates;
}
