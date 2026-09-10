import type { ToolId } from './tools.js';

/**
 * A test-case doc plus the tool/type/project axis it was found under, so the
 * "browse everything" view can group without a per-project request. `open`,
 * `download` and `preview` all take `path`, so the axis fields are additive.
 */
export interface TestCaseDocGrouped extends TestCaseDoc {
  tool: ToolId;
  type: string;
  project: string;
}

/** A test-case document discovered under a project (xlsx or csv). */
export interface TestCaseDoc {
  /** File basename, e.g. `ta_test-case.xlsx`. */
  name: string;
  /** Path relative to the project directory, for display / grouping. */
  relPath: string;
  /** Absolute path, passed back to the download / preview endpoints. */
  path: string;
  ext: 'xlsx' | 'csv';
  size: number;
  /**
   * True when a `.edited.json` overlay sits beside the doc — Hub edits and
   * synced run results live there, so this is what makes the `result` download
   * variant meaningful. The source doc itself is never modified.
   */
  edited: boolean;
}

/** Parsed contents of a CSV test-case document. */
export interface TestCaseCsv {
  headers: string[];
  rows: string[][];
  /** True when the file was truncated to the row cap. */
  truncated: boolean;
}

/** One worksheet of a parsed xlsx test-case document. */
export interface TestCaseSheet {
  name: string;
  rows: string[][];
}

/** Parsed contents of an xlsx test-case document (all worksheets). */
export interface TestCaseWorkbook {
  sheets: TestCaseSheet[];
  /** True when any worksheet was truncated to the row cap. */
  truncated: boolean;
}

/**
 * Result of syncing last-run status into a test-case doc's overlay. Rows are
 * matched by Test Case ID against the run's per-test ids (the `${caseId}: ...`
 * title prefix), so it only fills in where the doc id and the spec id agree.
 */
export interface TestCaseStatusSyncResult {
  grid: TestCaseGrid;
  /** Doc rows whose Test Case ID matched a run result and were updated. */
  matched: number;
  /** Total doc data rows considered. */
  total: number;
  /** ISO time of the run used, or null when no run was found. */
  runAt: string | null;
}

/** Editable grid for a test-case doc: one entry per sheet, rows[0] is the header row. */
export interface TestCaseGrid {
  sheets: TestCaseSheet[];
  /** True when served from a `.edited.json` overlay (local edits exist). */
  edited: boolean;
}

/** Payload to edit a single cell (rows[0] is the header, so `row` must be >= 1). */
export interface TestCaseEditRequest {
  path: string;
  sheet: number;
  row: number;
  col: number;
  value: string;
}

/** One test case's outcome from a run, as mapped onto a doc row. */
export interface TestCaseRunResult {
  status: 'passed' | 'failed';
  /** First line of the failure message — fills the row's "Actual Result". */
  error?: string;
}

/**
 * The `.edited.json` overlay that sits beside a source doc. Hub edits and synced
 * run results are written here; the source `.xlsx`/`.csv` is never modified.
 */
export interface TestCaseOverlay {
  /** Basename of the source doc this overlay belongs to. */
  source: string;
  savedAt: string;
  sheets: TestCaseSheet[];
  /**
   * Row → Hub user id, keyed `"<sheetIdx>:<rowIdx>"`. Records WHO edited a row
   * independently of the display name written into "Edited By", so renaming a
   * user can rewrite that column without name matching (two users may share a
   * display name). Absent for overlays written before user identity existed.
   */
  editors?: Record<string, string>;
  /** ISO time of the run whose results were last mapped into this overlay. */
  lastRunAt?: string;
}

/** A module of a project that can own a test-case doc. */
export interface TestCaseModule {
  /** Module folder name, e.g. `health` — also the doc's filename prefix. */
  name: string;
  /** Where the module was discovered: an automation spec folder, a docs folder, or both. */
  source: 'spec' | 'docs' | 'both';
  /** Relative path of the module's existing test-case doc, when it already has one. */
  docRelPath?: string;
}

/** Payload to scaffold a new per-module test-case doc from the standard template. */
export interface TestCaseCreateRequest {
  tool: string;
  type: string;
  project: string;
  /** Module the doc belongs to; must be one of the project's discovered modules. */
  module: string;
}

/** The Hub's single local user identity, used to auto-fill "Edited By". */
export interface HubUser {
  /**
   * Stable id, minted once. "Edited By" cells carry the display NAME, so the id
   * is what lets a rename find and rewrite the rows this user actually edited.
   */
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Result of renaming the Hub user: how many doc rows had "Edited By" rewritten. */
export interface HubUserSaveResult {
  user: HubUser;
  /** Doc rows whose "Edited By" was rewritten to the new name. */
  rowsRenamed: number;
  /** Overlay files touched by the rename. */
  docsTouched: number;
}
