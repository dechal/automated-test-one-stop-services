import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedSelectionFromReport } from '../run-compare.js';

/**
 * Write a Playwright `results.json` in the layout the reporter produces and
 * return the sibling report path callers pass around
 * (`<time>/html-results/index.html`).
 */
function writeReport(specs: unknown[]): { reportPath: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'failed-sel-'));
  const htmlDir = path.join(root, 'html-results');
  mkdirSync(htmlDir, { recursive: true });
  writeFileSync(
    path.join(root, 'results.json'),
    JSON.stringify({ suites: [{ file: 'a.spec.ts', specs }] }),
    'utf8',
  );
  return { reportPath: path.join(htmlDir, 'index.html'), root };
}

describe('failedSelectionFromReport', () => {
  it('returns the case-id tags of failed tests only', () => {
    const { reportPath, root } = writeReport([
      { title: 'TC-LOGIN-001: ok', ok: true, tags: ['@TC-LOGIN-001', '@critical'] },
      { title: 'TC-LOGIN-002: bad', ok: false, tags: ['@TC-LOGIN-002', '@critical'] },
      { title: 'CART-C003: bad', ok: false, tags: ['@CART-C003', '@low'] },
    ]);
    try {
      const sel = failedSelectionFromReport(reportPath);
      // Facet tags (@critical, @low) are not selectors — only case ids are.
      expect(sel?.caseIds).toEqual(['@CART-C003', '@TC-LOGIN-002']);
      expect(sel?.failed).toBe(2);
      expect(sel?.total).toBe(3);
      expect(sel?.unidentified).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalises the BARE tags a real Playwright report contains to @-tags', () => {
    // Playwright's JSON reporter strips the leading `@`, so this — not the
    // @-prefixed fixture above — is the shape production actually sees. Returning
    // it verbatim selected nothing in the picker, whose vocabulary keeps the `@`.
    const { reportPath, root } = writeReport([
      {
        title: 'SEVEN_FLOOR_BUILDING-C001: ก่อสร้างไม่เกิน 7 ชั้น',
        ok: false,
        tags: ['building', 'positive', 'SEVEN_FLOOR_BUILDING-C001'],
      },
      { title: 'INTERIOR-C001: ตกแต่งภายใน', ok: false, tags: ['interior', 'INTERIOR-C001'] },
    ]);
    try {
      const sel = failedSelectionFromReport(reportPath);
      expect(sel?.caseIds).toEqual(['@INTERIOR-C001', '@SEVEN_FLOOR_BUILDING-C001']);
      expect(sel?.unidentified).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not double-prefix a tag that already carries @', () => {
    const { reportPath, root } = writeReport([
      { title: 'CART-C003: bad', ok: false, tags: ['@CART-C003'] },
    ]);
    try {
      expect(failedSelectionFromReport(reportPath)?.caseIds).toEqual(['@CART-C003']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a failed test with no case-id tag instead of dropping it', () => {
    const { reportPath, root } = writeReport([
      { title: 'untagged failure', ok: false, tags: ['@critical'] },
    ]);
    try {
      const sel = failedSelectionFromReport(reportPath);
      expect(sel?.caseIds).toEqual([]);
      expect(sel?.unidentified).toEqual(['untagged failure']);
      expect(sel?.failed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty selection for an all-green run, and null with no report', () => {
    const { reportPath, root } = writeReport([
      { title: 'TC-A-001: ok', ok: true, tags: ['@TC-A-001'] },
    ]);
    try {
      expect(failedSelectionFromReport(reportPath)).toEqual({
        caseIds: [],
        unidentified: [],
        total: 1,
        failed: 0,
      });
      expect(failedSelectionFromReport(undefined)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
