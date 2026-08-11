import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  favoriteReport,
  isFavorite,
  lockReport,
  unfavoriteReport,
  unlockReport,
} from '../reports.js';

/**
 * A favourite must never become deletable. These pin the invariant at the service
 * boundary, because the UI's disabled button is not the guard — the route is
 * reachable directly.
 */
const roots: string[] = [];

/** A report tree: `<time>/html-results/index.html`, markers live in `<time>/`. */
function makeReport(): { reportPath: string; timeDir: string } {
  const timeDir = mkdtempSync(path.join(tmpdir(), 'report-fav-'));
  roots.push(timeDir);
  const htmlDir = path.join(timeDir, 'html-results');
  mkdirSync(htmlDir, { recursive: true });
  const reportPath = path.join(htmlDir, 'index.html');
  writeFileSync(reportPath, '<html></html>', 'utf8');
  return { reportPath, timeDir };
}

const hasLock = (timeDir: string) => existsSync(path.join(timeDir, '.lock'));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('favorite implies lock', () => {
  it('favouriting writes both markers', () => {
    const { reportPath, timeDir } = makeReport();

    favoriteReport(reportPath);

    expect(isFavorite(reportPath)).toBe(true);
    expect(hasLock(timeDir)).toBe(true);
  });

  it('refuses to unlock a favourite and leaves the lock in place', () => {
    const { reportPath, timeDir } = makeReport();
    favoriteReport(reportPath);

    expect(unlockReport(reportPath)).toBe(false);
    expect(hasLock(timeDir)).toBe(true);
  });

  it('un-favouriting keeps the lock, so nothing becomes deletable implicitly', () => {
    const { reportPath, timeDir } = makeReport();
    favoriteReport(reportPath);

    unfavoriteReport(reportPath);

    expect(isFavorite(reportPath)).toBe(false);
    expect(hasLock(timeDir)).toBe(true);
    // ...and only NOW can it be unlocked.
    expect(unlockReport(reportPath)).toBe(true);
    expect(hasLock(timeDir)).toBe(false);
  });

  it('a plain lock is still freely unlockable', () => {
    const { reportPath, timeDir } = makeReport();
    lockReport(reportPath);

    expect(isFavorite(reportPath)).toBe(false);
    expect(unlockReport(reportPath)).toBe(true);
    expect(hasLock(timeDir)).toBe(false);
  });

  it('reports a non-favourite as such without any markers present', () => {
    const { reportPath } = makeReport();
    expect(isFavorite(reportPath)).toBe(false);
  });
});
