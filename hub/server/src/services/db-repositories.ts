import type { DatabaseSync } from 'node:sqlite';
import type {
  Bookmark,
  DashboardLayout,
  DashboardWidget,
  DashboardWidgetId,
  EnvProfile,
  ReportAnnotation,
  RunRecord,
  RunRequest,
  RunStatus,
  WebhookConfig,
  WebhookEvent,
  WebhookPlatform,
} from '@hub/shared';
import { RUN_REQUEST_COLUMNS, readRunRequest, runRequestValues } from './db-run-request.js';
import {
  boolCol,
  numCol,
  type Row,
  readBool,
  readNum,
  readReqStr,
  readStr,
  type SqlValue,
  strCol,
} from './db-schema.js';

/**
 * Per-domain repositories: row <-> object mappers for the normalized schema.
 *
 * Collection repos expose `readAll` / `replaceAll`; document repos expose
 * `read` / `write`. Write methods do NOT open their own transaction — the
 * caller (`local-db.ts`) wraps them in `BEGIN IMMEDIATE … COMMIT` so a whole
 * collection swap is atomic.
 */

/**
 * Parse a JSON string[] column defensively. A single corrupt/legacy row must
 * not throw and fail the ENTIRE collection read (e.g. one bad webhook row
 * taking down the whole webhook list). Returns undefined on absent/invalid.
 */
function readStrArray(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed.filter((v) => typeof v === 'string') as string[])
      : undefined;
  } catch {
    return undefined;
  }
}

export interface CollectionRepo<T> {
  readAll(db: DatabaseSync): T[];
  /** Replace the whole collection (DELETE + INSERT). Caller wraps in a txn. */
  replaceAll(db: DatabaseSync, rows: readonly T[]): void;
}

export interface DocRepo<T> {
  read(db: DatabaseSync): T | undefined;
  /** Upsert the single document. Caller wraps in a txn. */
  write(db: DatabaseSync, value: T): void;
  /** Delete the single document (used to clear during migration). Caller wraps in a txn. */
  clear(db: DatabaseSync): void;
}

/** Persisted schedule shape (superset of `ScheduleEntry`, see scheduler.ts). */
export interface PersistedSchedule {
  id: string;
  name: string;
  cron: string;
  config: RunRequest;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: RunStatus | 'pending';
  lastRunId?: string;
  nextRunAt?: string;
  noOverlap?: boolean;
}

/** Persisted retention settings (see routes/system.ts). */
export interface RetentionDoc {
  retentionDays: number;
  autoCleanup: boolean;
}

const REQ_COLS = RUN_REQUEST_COLUMNS.join(', ');
const REQ_PLACEHOLDERS = RUN_REQUEST_COLUMNS.map(() => '?').join(', ');

// --- history ----------------------------------------------------------------

function rowToRunRecord(row: Row): RunRecord {
  // Reconstruct the summary only when at least one count was stored, so a run
  // with no parsed summary round-trips as `summary: undefined` (not zeros).
  const passed = readNum(row.summary_passed);
  const failed = readNum(row.summary_failed);
  const summary =
    passed !== undefined || failed !== undefined
      ? { passed: passed ?? 0, failed: failed ?? 0, skipped: readNum(row.summary_skipped) }
      : undefined;
  return {
    id: readReqStr(row.id),
    request: readRunRequest(row),
    command: readReqStr(row.command),
    status: readReqStr(row.status) as RunStatus,
    startedAt: readReqStr(row.started_at),
    endedAt: readStr(row.ended_at),
    exitCode: readNum(row.exit_code),
    reportPath: readStr(row.report_path),
    outputStamp: readStr(row.output_stamp),
    summary,
    triggeredBy: readStr(row.triggered_by) as RunRecord['triggeredBy'],
  };
}

const HISTORY_INSERT = `INSERT OR REPLACE INTO history
  (id, status, command, started_at, ended_at, exit_code, report_path, output_stamp, summary_passed, summary_failed, summary_skipped, triggered_by, ${REQ_COLS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${REQ_PLACEHOLDERS})`;

function historyValues(rec: RunRecord): SqlValue[] {
  return [
    strCol(rec.id),
    strCol(rec.status),
    strCol(rec.command),
    strCol(rec.startedAt),
    strCol(rec.endedAt),
    numCol(rec.exitCode),
    strCol(rec.reportPath),
    strCol(rec.outputStamp),
    numCol(rec.summary?.passed),
    numCol(rec.summary?.failed),
    numCol(rec.summary?.skipped),
    strCol(rec.triggeredBy),
    ...runRequestValues(rec.request),
  ];
}

export const historyRepo = {
  readAllOrdered(db: DatabaseSync): RunRecord[] {
    const rows = db.prepare('SELECT * FROM history ORDER BY started_at DESC').all() as Row[];
    return rows.map(rowToRunRecord);
  },
  replaceAll(db: DatabaseSync, rows: readonly RunRecord[]): void {
    db.exec('DELETE FROM history');
    const insert = db.prepare(HISTORY_INSERT);
    for (const rec of rows) insert.run(...historyValues(rec));
  },
  insert(db: DatabaseSync, rec: RunRecord): void {
    db.prepare(HISTORY_INSERT).run(...historyValues(rec));
  },
  trim(db: DatabaseSync, max: number): void {
    db.prepare(
      'DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY started_at DESC LIMIT ?)',
    ).run(max);
  },
};

// --- schedules --------------------------------------------------------------

export const schedulesRepo: CollectionRepo<PersistedSchedule> = {
  readAll(db) {
    const rows = db.prepare('SELECT * FROM schedules ORDER BY rowid').all() as Row[];
    return rows.map((row) => {
      const s: PersistedSchedule = {
        id: readReqStr(row.id),
        name: readReqStr(row.name),
        cron: readReqStr(row.cron),
        config: readRunRequest(row),
        enabled: readBool(row.enabled) ?? false,
        createdAt: readReqStr(row.created_at),
        lastRunAt: readStr(row.last_run_at),
        lastStatus: readStr(row.last_status) as RunStatus | 'pending' | undefined,
        lastRunId: readStr(row.last_run_id),
        nextRunAt: readStr(row.next_run_at),
        noOverlap: readBool(row.no_overlap),
      };
      return s;
    });
  },
  replaceAll(db, rows) {
    db.exec('DELETE FROM schedules');
    const insert = db.prepare(
      `INSERT INTO schedules
        (id, name, cron, enabled, created_at, last_run_at, last_status, last_run_id, next_run_at, no_overlap, ${REQ_COLS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${REQ_PLACEHOLDERS})`,
    );
    for (const s of rows) {
      insert.run(
        strCol(s.id),
        strCol(s.name),
        strCol(s.cron),
        boolCol(s.enabled),
        strCol(s.createdAt),
        strCol(s.lastRunAt),
        strCol(s.lastStatus),
        strCol(s.lastRunId),
        strCol(s.nextRunAt),
        boolCol(s.noOverlap),
        ...runRequestValues(s.config),
      );
    }
  },
};

// --- bookmarks --------------------------------------------------------------

export const bookmarksRepo: CollectionRepo<Bookmark> = {
  readAll(db) {
    const rows = db.prepare('SELECT * FROM bookmarks ORDER BY rowid').all() as Row[];
    return rows.map((row) => ({
      id: readReqStr(row.id),
      name: readReqStr(row.name),
      config: readRunRequest(row),
      createdAt: readReqStr(row.created_at),
    }));
  },
  replaceAll(db, rows) {
    db.exec('DELETE FROM bookmarks');
    const insert = db.prepare(
      `INSERT INTO bookmarks (id, name, created_at, ${REQ_COLS})
        VALUES (?, ?, ?, ${REQ_PLACEHOLDERS})`,
    );
    for (const b of rows) {
      insert.run(strCol(b.id), strCol(b.name), strCol(b.createdAt), ...runRequestValues(b.config));
    }
  },
};

// --- webhooks (+ webhook_events child) --------------------------------------

export const webhooksRepo: CollectionRepo<WebhookConfig> = {
  readAll(db) {
    const rows = db.prepare('SELECT * FROM webhooks ORDER BY rowid').all() as Row[];
    const eventStmt = db.prepare(
      'SELECT event FROM webhook_events WHERE webhook_id = ? ORDER BY seq',
    );
    return rows.map((row) => {
      const id = readReqStr(row.id);
      const events = (eventStmt.all(id) as Row[]).map((e) => readReqStr(e.event) as WebhookEvent);
      const scopeTool = readStr(row.scope_tool);
      const scopeType = readStr(row.scope_type);
      const scopeProject = readStr(row.scope_project);
      const hasScope =
        scopeTool !== undefined || scopeType !== undefined || scopeProject !== undefined;
      const projectFilterRaw = readStr(row.project_filter);
      const w: WebhookConfig = {
        id,
        name: readReqStr(row.name),
        platform: readReqStr(row.platform) as WebhookPlatform,
        url: readReqStr(row.url),
        token: readStr(row.token),
        recipientId: readStr(row.recipient_id),
        events,
        scope: hasScope
          ? {
              tool: scopeTool as NonNullable<WebhookConfig['scope']>['tool'],
              type: scopeType,
              project: scopeProject,
            }
          : undefined,
        projectFilter: readStrArray(projectFilterRaw),
        enabled: readBool(row.enabled) ?? false,
        createdAt: readReqStr(row.created_at),
        lastTriggeredAt: readStr(row.last_triggered_at),
        lastStatus: readStr(row.last_status) as WebhookConfig['lastStatus'],
      };
      return w;
    });
  },
  replaceAll(db, rows) {
    db.exec('DELETE FROM webhook_events');
    db.exec('DELETE FROM webhooks');
    const insert = db.prepare(
      `INSERT INTO webhooks
        (id, name, platform, url, token, recipient_id, enabled, created_at, last_triggered_at, last_status, scope_tool, scope_type, scope_project, project_filter)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = db.prepare(
      'INSERT INTO webhook_events (webhook_id, seq, event) VALUES (?, ?, ?)',
    );
    for (const w of rows) {
      insert.run(
        strCol(w.id),
        strCol(w.name),
        strCol(w.platform),
        strCol(w.url),
        strCol(w.token),
        strCol(w.recipientId),
        boolCol(w.enabled),
        strCol(w.createdAt),
        strCol(w.lastTriggeredAt),
        strCol(w.lastStatus),
        strCol(w.scope?.tool),
        strCol(w.scope?.type),
        strCol(w.scope?.project),
        w.projectFilter ? JSON.stringify(w.projectFilter) : null,
      );
      (w.events ?? []).forEach((event, seq) => {
        insertEvent.run(strCol(w.id), seq, strCol(event));
      });
    }
  },
};

// --- env profiles (+ env_profile_entries child) -----------------------------

export const envProfilesRepo: CollectionRepo<EnvProfile> = {
  readAll(db) {
    const rows = db.prepare('SELECT * FROM env_profiles ORDER BY rowid').all() as Row[];
    const entryStmt = db.prepare(
      'SELECT key, value FROM env_profile_entries WHERE profile_id = ? ORDER BY rowid',
    );
    return rows.map((row) => {
      const id = readReqStr(row.id);
      const entries: Record<string, string> = {};
      for (const e of entryStmt.all(id) as Row[]) entries[readReqStr(e.key)] = readReqStr(e.value);
      return {
        id,
        name: readReqStr(row.name),
        environment: readReqStr(row.environment),
        tool: readReqStr(row.tool) as EnvProfile['tool'],
        type: readReqStr(row.type),
        project: readReqStr(row.project),
        entries,
        createdAt: readReqStr(row.created_at),
        updatedAt: readReqStr(row.updated_at),
      };
    });
  },
  replaceAll(db, rows) {
    db.exec('DELETE FROM env_profile_entries');
    db.exec('DELETE FROM env_profiles');
    const insert = db.prepare(
      `INSERT INTO env_profiles (id, name, environment, tool, type, project, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEntry = db.prepare(
      'INSERT INTO env_profile_entries (profile_id, key, value) VALUES (?, ?, ?)',
    );
    for (const p of rows) {
      insert.run(
        strCol(p.id),
        strCol(p.name),
        strCol(p.environment),
        strCol(p.tool),
        strCol(p.type),
        strCol(p.project),
        strCol(p.createdAt),
        strCol(p.updatedAt),
      );
      for (const [key, value] of Object.entries(p.entries ?? {})) {
        insertEntry.run(strCol(p.id), strCol(key), strCol(value));
      }
    }
  },
};

// --- annotations ------------------------------------------------------------

export const annotationsRepo: CollectionRepo<ReportAnnotation> = {
  readAll(db) {
    const rows = db.prepare('SELECT * FROM annotations ORDER BY rowid').all() as Row[];
    return rows.map((row) => ({
      id: readReqStr(row.id),
      reportId: readReqStr(row.report_id),
      author: readReqStr(row.author),
      content: readReqStr(row.content),
      type: readReqStr(row.type) as ReportAnnotation['type'],
      createdAt: readReqStr(row.created_at),
      updatedAt: readStr(row.updated_at),
    }));
  },
  replaceAll(db, rows) {
    db.exec('DELETE FROM annotations');
    const insert = db.prepare(
      `INSERT INTO annotations (id, report_id, author, content, type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of rows) {
      insert.run(
        strCol(a.id),
        strCol(a.reportId),
        strCol(a.author),
        strCol(a.content),
        strCol(a.type),
        strCol(a.createdAt),
        strCol(a.updatedAt),
      );
    }
  },
};

// --- retention (single document) -------------------------------------------

export const retentionRepo: DocRepo<RetentionDoc> = {
  read(db) {
    const row = db.prepare('SELECT * FROM retention WHERE id = 1').get() as Row | undefined;
    if (!row) return undefined;
    return {
      retentionDays: readNum(row.retention_days) ?? 0,
      autoCleanup: readBool(row.auto_cleanup) ?? false,
    };
  },
  write(db, value) {
    db.prepare(
      `INSERT INTO retention (id, retention_days, auto_cleanup) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET retention_days = excluded.retention_days, auto_cleanup = excluded.auto_cleanup`,
    ).run(numCol(value.retentionDays), boolCol(value.autoCleanup));
  },
  clear(db) {
    db.exec('DELETE FROM retention');
  },
};

// --- dashboard layout (single document, widgets child) ----------------------

export const dashboardRepo: DocRepo<DashboardLayout> = {
  read(db) {
    const meta = db.prepare('SELECT updated_at FROM dashboard_meta WHERE id = 1').get() as
      | Row
      | undefined;
    if (!meta) return undefined;
    const rows = db.prepare('SELECT * FROM dashboard_widgets ORDER BY seq').all() as Row[];
    const widgets: DashboardWidget[] = rows.map((row) => ({
      id: readReqStr(row.widget_id) as DashboardWidgetId,
      label: readReqStr(row.label),
      visible: readBool(row.visible) ?? false,
      order: readNum(row.sort_order) ?? 0,
      span: (readNum(row.span) === 2 ? 2 : 1) as 1 | 2,
    }));
    return { widgets, updatedAt: readReqStr(meta.updated_at) };
  },
  write(db, value) {
    db.exec('DELETE FROM dashboard_widgets');
    db.prepare(
      `INSERT INTO dashboard_meta (id, updated_at) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(strCol(value.updatedAt));
    const insert = db.prepare(
      'INSERT INTO dashboard_widgets (seq, widget_id, label, visible, sort_order, span) VALUES (?, ?, ?, ?, ?, ?)',
    );
    value.widgets.forEach((w, seq) => {
      insert.run(
        seq,
        strCol(w.id),
        strCol(w.label),
        boolCol(w.visible),
        numCol(w.order),
        numCol(w.span),
      );
    });
  },
  clear(db) {
    db.exec('DELETE FROM dashboard_widgets');
    db.exec('DELETE FROM dashboard_meta');
  },
};
