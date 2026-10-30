import fs from 'node:fs';
import path from 'node:path';
import type { TestCaseSheet } from '@hub/shared';
import ExcelJS from 'exceljs';
import { RESULT_SUFFIX, readTestCaseGrid } from './testcases.js';

/**
 * The STANDARD test-case template — the single shape every per-module doc uses.
 *
 * Deliberately duplicated here rather than shelling out to the workspace's
 * Python generator: the Hub is workspace code and must not reference the AI
 * layer's scripts (steering `kiro-boundary` §1). Both copies describe the same
 * 18-column contract (brain LESS-014); change them together.
 */
export const TEST_CASE_HEADERS = [
  'Test Case ID',
  'Module',
  'Test Scenario',
  'Requirement Ref ID',
  'Test Type',
  'Pre-Condition',
  'Test Data Requirement',
  'Test Data Example',
  'Test Steps',
  'Expected Result',
  'Actual Result',
  'Severity',
  'Priority',
  'Status',
  'Remark',
  'Assign To',
  'Edited By',
  'Updated At',
] as const;

/** Per-column widths, in the same order as {@link TEST_CASE_HEADERS}. */
const COLUMN_WIDTHS = [14, 16, 40, 22, 9, 34, 44, 40, 56, 50, 12, 9, 9, 9, 28, 10, 10, 12];

const HEADER_FILL = 'FF2F5496';
const FONT = { name: 'Arial', size: 10 } as const;
const THIN_BORDER: ExcelJS.Borders = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
} as ExcelJS.Borders;

/** Style a workbook's header row + column widths the way the template does. */
function applyTemplateChrome(ws: ExcelJS.Worksheet): void {
  const header = ws.getRow(1);
  TEST_CASE_HEADERS.forEach((name, i) => {
    const cell = header.getCell(i + 1);
    cell.value = name;
    cell.font = { ...FONT, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
  });
  COLUMN_WIDTHS.forEach((width, i) => {
    ws.getColumn(i + 1).width = width;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, ws.rowCount), column: TEST_CASE_HEADERS.length },
  };
}

/** Absolute path of the doc a module owns, whether or not it exists yet. */
export function moduleDocPath(projectDir: string, moduleName: string): string {
  return path.join(projectDir, 'docs', moduleName, `${moduleName}_test-case.xlsx`);
}

/**
 * Scaffold an empty test-case doc for `moduleName` from the standard template.
 * Refuses when the module already has one — a second doc for the same module
 * would split the module's cases across two sources of truth.
 */
export async function createTestCaseDoc(
  projectDir: string,
  moduleName: string,
): Promise<{ path: string } | { error: 'DUPLICATE' }> {
  const target = moduleDocPath(projectDir, moduleName);
  if (fs.existsSync(target)) return { error: 'DUPLICATE' };
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Test Cases');
  applyTemplateChrome(ws);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await workbook.xlsx.writeFile(target);
  return { path: target };
}

/** `health_test-case.xlsx` → `health_test-case.result.xlsx` (sibling, git-ignored). */
export function resultPathFor(docPath: string): string {
  const dir = path.dirname(docPath);
  const base = path.basename(docPath, path.extname(docPath));
  return path.join(dir, `${base}${RESULT_SUFFIX}`);
}

/**
 * Write the doc's CURRENT state (source values plus everything the overlay
 * holds — Hub edits and synced run results) to a sibling `*.result.xlsx`, and
 * return its path.
 *
 * The source workbook is opened and re-saved under the new name, so all of its
 * formatting survives and the source file itself is never written to. Rows the
 * overlay added beyond the source's last row inherit that row's style, so an
 * exported result looks like the original rather than a bare grid. A CSV source
 * has no formatting to preserve, so it gets the standard template chrome.
 */
export async function writeResultXlsx(docPath: string): Promise<string | null> {
  const grid = await readTestCaseGrid(docPath);
  if (!grid) return null;
  const target = resultPathFor(docPath);
  const workbook = new ExcelJS.Workbook();
  const fromXlsx = docPath.toLowerCase().endsWith('.xlsx') && fs.existsSync(docPath);
  if (fromXlsx) await workbook.xlsx.readFile(docPath);

  for (const [idx, sheet] of grid.sheets.entries()) {
    const ws =
      workbook.getWorksheet(sheet.name) ??
      workbook.worksheets[idx] ??
      workbook.addWorksheet(sheet.name);
    fillSheet(ws, sheet);
    if (!fromXlsx) applyTemplateChrome(ws);
    else {
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(1, sheet.rows.length), column: sheet.rows[0]?.length ?? 1 },
      };
    }
  }

  await workbook.xlsx.writeFile(target);
  return target;
}

/** Overwrite a worksheet's cell values from the grid, keeping existing styling. */
function fillSheet(ws: ExcelJS.Worksheet, sheet: TestCaseSheet): void {
  const styleTemplateRow = ws.rowCount > 1 ? ws.getRow(ws.rowCount) : null;
  for (const [r, values] of sheet.rows.entries()) {
    const isNewRow = r + 1 > ws.rowCount;
    const row = ws.getRow(r + 1);
    for (const [c, value] of values.entries()) {
      const cell = row.getCell(c + 1);
      // A brand-new row starts unstyled; copy the last source row's look so the
      // export stays visually consistent with the rest of the sheet.
      if (isNewRow && styleTemplateRow) cell.style = { ...styleTemplateRow.getCell(c + 1).style };
      cell.value = value === '' ? null : value;
    }
    row.commit();
  }
}
