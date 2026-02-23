import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { HealthResult } from "./health.js";

const DATA_DIR = join(homedir(), ".mcp-doc");
const HISTORY_PATH = join(DATA_DIR, "history.json");
const MAX_ENTRIES = 500; // Keep history bounded

export interface ProxyCallRecord {
  server: string;
  project: string;
  tool: string;
  status: "ok" | "fail";
  latencyMs: number;
  error: string | null;
  calledAt: string;
}

interface HistoryFile {
  version: 1;
  checks: StoredCheck[];
  proxyCalls?: ProxyCallRecord[];
}

interface StoredCheck {
  server: string;
  project: string;
  status: string;
  latencyMs: number;
  toolCount: number;
  tools: string[];
  error: string | null;
  checkedAt: string;
}

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readHistory(): HistoryFile {
  try {
    if (!existsSync(HISTORY_PATH)) return { version: 1, checks: [], proxyCalls: [] };
    const raw = readFileSync(HISTORY_PATH, "utf-8");
    const data = JSON.parse(raw) as HistoryFile;
    if (data.version === 1 && Array.isArray(data.checks)) {
      if (!data.proxyCalls) data.proxyCalls = [];
      return data;
    }
    return { version: 1, checks: [], proxyCalls: [] };
  } catch {
    return { version: 1, checks: [], proxyCalls: [] };
  }
}

function writeHistory(data: HistoryFile): void {
  ensureDir();
  // Trim to max entries (keep most recent)
  if (data.checks.length > MAX_ENTRIES) {
    data.checks = data.checks.slice(-MAX_ENTRIES);
  }
  if (data.proxyCalls && data.proxyCalls.length > MAX_ENTRIES) {
    data.proxyCalls = data.proxyCalls.slice(-MAX_ENTRIES);
  }
  writeFileSync(HISTORY_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Save a single health check result.
 */
export function saveResult(result: HealthResult): void {
  const history = readHistory();
  history.checks.push({
    server: result.server,
    project: result.project,
    status: result.status,
    latencyMs: result.latencyMs,
    toolCount: result.toolCount,
    tools: result.tools,
    error: result.error,
    checkedAt: result.checkedAt,
  });
  writeHistory(history);
}

/**
 * Save multiple results.
 */
export function saveResults(results: HealthResult[]): void {
  const history = readHistory();
  for (const result of results) {
    history.checks.push({
      server: result.server,
      project: result.project,
      status: result.status,
      latencyMs: result.latencyMs,
      toolCount: result.toolCount,
      tools: result.tools,
      error: result.error,
      checkedAt: result.checkedAt,
    });
  }
  writeHistory(history);
}

export interface HistoryEntry {
  server: string;
  project: string;
  status: string;
  latencyMs: number;
  toolCount: number;
  error: string | null;
  checkedAt: string;
}

/**
 * Get health check history for a specific server.
 */
export function getServerHistory(serverName: string, limit = 20): HistoryEntry[] {
  const history = readHistory();
  return history.checks
    .filter((c) => c.server === serverName)
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
    .slice(0, limit)
    .map(({ tools, ...rest }) => rest);
}

/**
 * Get the most recent health check for each server.
 */
export function getLatestResults(): HistoryEntry[] {
  const history = readHistory();
  const latest = new Map<string, StoredCheck>();

  for (const check of history.checks) {
    const key = `${check.server}::${check.project}`;
    const existing = latest.get(key);
    if (!existing || check.checkedAt > existing.checkedAt) {
      latest.set(key, check);
    }
  }

  return Array.from(latest.values())
    .sort((a, b) => `${a.project}/${a.server}`.localeCompare(`${b.project}/${b.server}`))
    .map(({ tools, ...rest }) => rest);
}

/**
 * Get summary stats for a server.
 */
export function getServerStats(serverName: string): {
  totalChecks: number;
  okCount: number;
  failCount: number;
  uptimePercent: number;
  lastHealthy: string | null;
  lastFailed: string | null;
} {
  const history = readHistory();
  const checks = history.checks.filter((c) => c.server === serverName);

  const okCount = checks.filter((c) => c.status === "ok").length;
  const failCount = checks.filter((c) => c.status === "fail").length;
  const total = checks.length || 1;

  const sorted = [...checks].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  const lastHealthy = sorted.find((c) => c.status === "ok")?.checkedAt || null;
  const lastFailed = sorted.find((c) => c.status === "fail")?.checkedAt || null;

  return {
    totalChecks: checks.length,
    okCount,
    failCount,
    uptimePercent: Math.round((okCount / total) * 100),
    lastHealthy,
    lastFailed,
  };
}

/**
 * Save a proxy call record for audit logging.
 */
export function saveProxyCall(record: ProxyCallRecord): void {
  const history = readHistory();
  if (!history.proxyCalls) history.proxyCalls = [];
  history.proxyCalls.push(record);
  writeHistory(history);
}
