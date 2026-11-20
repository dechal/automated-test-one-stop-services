import type { HeadlessMode, PerformanceType, RunMode, RunRequest, ToolId } from '@hub/shared';
import {
  boolCol,
  type Row,
  readBool,
  readReqStr,
  readStr,
  type SqlValue,
  strCol,
} from './db-schema.js';

/**
 * Maps the embedded `RunRequest` to/from the flattened `req_*` columns shared
 * by `history`, `schedules` and `bookmarks`. Optional fields round-trip as
 * `undefined` when their column is NULL; booleans preserve `false` (stored 0).
 */

/** Column names (in bind order) for the flattened `RunRequest`. */
export const RUN_REQUEST_COLUMNS = [
  'req_tool',
  'req_type',
  'req_project',
  'req_mode',
  'req_tag',
  'req_headless',
  'req_extra_args',
  'req_no_track',
  'req_silent',
  'req_discard_report',
  'req_clone_report_name',
  'req_section',
  'req_performance_type',
] as const;

/** Bind values for a `RunRequest`, in {@link RUN_REQUEST_COLUMNS} order. */
export function runRequestValues(r: RunRequest): SqlValue[] {
  return [
    strCol(r.tool),
    strCol(r.type),
    strCol(r.project),
    strCol(r.mode),
    strCol(r.tag),
    strCol(r.headless),
    strCol(r.extraArgs),
    boolCol(r.noTrack),
    boolCol(r.silent),
    boolCol(r.discardReport),
    strCol(r.cloneReportName),
    strCol(r.section),
    strCol(r.performanceType),
  ];
}

/** Reconstruct a `RunRequest` from a row's `req_*` columns. */
export function readRunRequest(row: Row): RunRequest {
  return {
    tool: readReqStr(row.req_tool) as ToolId,
    type: readReqStr(row.req_type),
    project: readReqStr(row.req_project),
    mode: readReqStr(row.req_mode) as RunMode,
    tag: readStr(row.req_tag),
    headless: readStr(row.req_headless) as HeadlessMode | undefined,
    extraArgs: readStr(row.req_extra_args),
    noTrack: readBool(row.req_no_track),
    silent: readBool(row.req_silent),
    discardReport: readBool(row.req_discard_report),
    cloneReportName: readStr(row.req_clone_report_name),
    section: readStr(row.req_section),
    performanceType: readStr(row.req_performance_type) as PerformanceType | undefined,
  };
}
