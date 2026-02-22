import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";
import type { HealthResult } from "./health.js";

const DB_DIR = join(homedir(), ".mcp-doc");
const DB_PATH = join(DB_DIR, "history.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server TEXT NOT NULL,
      project TEXT NOT NULL,
      status TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      tool_count INTEGER NOT NULL,
      tools TEXT,
      error TEXT,
      checked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_server_project
      ON health_checks (server, project);
    CREATE INDEX IF NOT EXISTS idx_checked_at
      ON health_checks (checked_at);
  `);

  return db;
}

/**
 * Save a health check result to the database.
 */
export function saveResult(result: HealthResult): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO health_checks (server, project, status, latency_ms, tool_count, tools, error, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    result.server,
    result.project,
    result.status,
    result.latencyMs,
    result.toolCount,
    JSON.stringify(result.tools),
    result.error,
    result.checkedAt
  );
}

/**
 * Save multiple results in a transaction.
 */
export function saveResults(results: HealthResult[]): void {
  const database = getDb();
  const saveMany = database.transaction((items: HealthResult[]) => {
    for (const result of items) {
      saveResult(result);
    }
  });
  saveMany(results);
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
  const database = getDb();
  const stmt = database.prepare(`
    SELECT server, project, status, latency_ms as latencyMs, tool_count as toolCount, error, checked_at as checkedAt
    FROM health_checks
    WHERE server = ?
    ORDER BY checked_at DESC
    LIMIT ?
  `);
  return stmt.all(serverName, limit) as HistoryEntry[];
}

/**
 * Get the most recent health check for each server.
 */
export function getLatestResults(): HistoryEntry[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT h.server, h.project, h.status, h.latency_ms as latencyMs, h.tool_count as toolCount, h.error, h.checked_at as checkedAt
    FROM health_checks h
    INNER JOIN (
      SELECT server, project, MAX(checked_at) as max_checked
      FROM health_checks
      GROUP BY server, project
    ) latest ON h.server = latest.server AND h.project = latest.project AND h.checked_at = latest.max_checked
    ORDER BY h.project, h.server
  `);
  return stmt.all() as HistoryEntry[];
}

/**
 * Get summary stats for a server: total checks, uptime percentage, last healthy date.
 */
export function getServerStats(serverName: string): {
  totalChecks: number;
  okCount: number;
  failCount: number;
  uptimePercent: number;
  lastHealthy: string | null;
  lastFailed: string | null;
} {
  const database = getDb();

  const counts = database.prepare(`
    SELECT
      COUNT(*) as totalChecks,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as okCount,
      SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as failCount
    FROM health_checks
    WHERE server = ?
  `).get(serverName) as { totalChecks: number; okCount: number; failCount: number };

  const lastHealthy = database.prepare(`
    SELECT checked_at FROM health_checks WHERE server = ? AND status = 'ok' ORDER BY checked_at DESC LIMIT 1
  `).get(serverName) as { checked_at: string } | undefined;

  const lastFailed = database.prepare(`
    SELECT checked_at FROM health_checks WHERE server = ? AND status = 'fail' ORDER BY checked_at DESC LIMIT 1
  `).get(serverName) as { checked_at: string } | undefined;

  const total = counts.totalChecks || 1; // Avoid division by zero
  return {
    totalChecks: counts.totalChecks,
    okCount: counts.okCount,
    failCount: counts.failCount,
    uptimePercent: Math.round((counts.okCount / total) * 100),
    lastHealthy: lastHealthy?.checked_at || null,
    lastFailed: lastFailed?.checked_at || null,
  };
}
