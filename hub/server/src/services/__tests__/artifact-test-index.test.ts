import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactTestIndex } from '../run-compare.js';

/**
 * Write a Playwright `results.json` in the layout the reporter produces and
 * return the sibling report path callers pass around
 * (`<time>/html-results/index.html`).
 */
function writeReport(specs: unknown[], file = 'motorcycle/positive.spec.ts'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'artifact-idx-'));
  const htmlDir = path.join(root, 'html-results');
  mkdirSync(htmlDir, { recursive: true });
  writeFileSync(
    path.join(root, 'results.json'),
    JSON.stringify({ suites: [{ file, specs }] }),
    'utf8',
  );
  return path.join(htmlDir, 'index.html');
}

/** An attachment path as the reporter records it: pre-promotion, `.temp`, Windows. */
function tempAttachment(dir: string, fileName: string): { name: string; path: string } {
  return {
    name: 'trace',
    path: `C:\\out\\playwright\\web\\my-project\\.temp\\2026-08-04\\10-00-00\\evidences\\${dir}\\${fileName}`,
  };
}

const ARTIFACT_DIR = 'motorcycle-positive-Positi-7f22c-ยานยนต์-ชำระเงินจนจบขั้นตอน-e2e';

describe('artifactTestIndex', () => {
  it('maps the artifact directory to its spec title', () => {
    const reportPath = writeReport([
      {
        title: 'MOTOR_TYPE_1-C001: รถยนต์ ประกันชั้น 1 ชำระเงินจนจบขั้นตอน',
        ok: true,
        line: 103,
        tags: ['@e2e', '@critical'],
        tests: [{ results: [{ attachments: [tempAttachment(ARTIFACT_DIR, 'trace.zip')] }] }],
      },
    ]);

    const index = artifactTestIndex(reportPath);

    expect(index?.[ARTIFACT_DIR]).toEqual({
      title: 'MOTOR_TYPE_1-C001: รถยนต์ ประกันชั้น 1 ชำระเงินจนจบขั้นตอน',
      caseId: 'MOTOR_TYPE_1-C001',
      status: 'passed',
      tags: ['@e2e', '@critical'],
      file: 'motorcycle/positive.spec.ts',
      line: 103,
    });
  });

  it('joins on the directory basename, not the absolute path', () => {
    // The reporter records `.temp/...`; the Hub serves the promoted `error/...`.
    // Matching full paths would find nothing, which is the bug this pins.
    const reportPath = writeReport([
      {
        title: 'C002: something',
        ok: false,
        tests: [{ results: [{ attachments: [tempAttachment(ARTIFACT_DIR, 'video.webm')] }] }],
      },
    ]);

    const index = artifactTestIndex(reportPath);

    expect(Object.keys(index ?? {})).toEqual([ARTIFACT_DIR]);
    expect(index?.[ARTIFACT_DIR]?.status).toBe('failed');
  });

  it('prefers a case-id tag over the title prefix', () => {
    const reportPath = writeReport([
      {
        title: 'LEGACY-999: title prefix that is not the tag',
        ok: true,
        tags: ['@MOTOR_TYPE_1-C001'],
        tests: [{ results: [{ attachments: [tempAttachment('dir-a', 'trace.zip')] }] }],
      },
    ]);

    expect(artifactTestIndex(reportPath)?.['dir-a']?.caseId).toBe('MOTOR_TYPE_1-C001');
  });

  it('leaves caseId unset when neither a tag nor a title prefix carries one', () => {
    const reportPath = writeReport([
      {
        title: 'a lower-case sentence with no id',
        ok: true,
        tests: [{ results: [{ attachments: [tempAttachment('dir-b', 'trace.zip')] }] }],
      },
    ]);

    const info = artifactTestIndex(reportPath)?.['dir-b'];
    expect(info?.title).toBe('a lower-case sentence with no id');
    expect(info?.caseId).toBeUndefined();
  });

  it('keeps the first attempt when a retry reuses the same directory', () => {
    const reportPath = writeReport([
      {
        title: 'C003: retried',
        ok: false,
        tests: [
          {
            results: [
              { attachments: [tempAttachment('dir-c', 'trace.zip')] },
              { attachments: [tempAttachment('dir-c', 'video.webm')] },
            ],
          },
        ],
      },
    ]);

    expect(Object.keys(artifactTestIndex(reportPath) ?? {})).toEqual(['dir-c']);
  });

  it('returns null when the run has no results.json', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'artifact-idx-empty-'));
    mkdirSync(path.join(root, 'html-results'), { recursive: true });
    expect(artifactTestIndex(path.join(root, 'html-results', 'index.html'))).toBeNull();
  });

  it('skips specs that produced no attachments', () => {
    const reportPath = writeReport([{ title: 'C004: no artifacts', ok: true, tests: [{}] }]);
    expect(artifactTestIndex(reportPath)).toEqual({});
  });
});
