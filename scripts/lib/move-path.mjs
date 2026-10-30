#!/usr/bin/env node
// scripts/lib/move-path.mjs
//
// Resilient, cross-platform move for a single file OR directory. Node-core-only
// replacement for `mv` in the k6 / robot-framework result pipelines — `node` is
// a Core tool always on PATH, so this runs identically from cmd, PowerShell, and
// Git Bash.
//
// Why not plain `mv`: on Windows a rename of a JUST-written file (e.g. k6's
// summary.html/json, a fresh report.pdf) intermittently fails with
// EPERM/EACCES/EBUSY because Defender / the Search indexer briefly holds a
// handle on the new file. A bare `mv` turns that transient lock into a hard
// task failure. Here we:
//   1) retry rename() with short backoff (clears the transient scanner lock), then
//   2) fall back to copy + delete (copy needs only shared-read, which usually
//      succeeds even while a scanner holds the source; a failed delete is
//      non-fatal — stale sources get swept by the pre-run cleanup).
// Also handles EXDEV (cross-device) by going straight to the copy fallback.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** @param {number} ms */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Move `src` (file or directory) to `dest`, creating the destination's parent.
 * @param {string} src source path
 * @param {string} dest destination path
 */
export async function movePath(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`source not found: ${src}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const isDir = fs.statSync(src).isDirectory();

  // 1) Fast path: rename is atomic on the same volume. Retry transient Windows
  //    locks with linear backoff (200/400/600/800ms) before falling back.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? '';
      if (code === 'EXDEV') break; // cross-device — rename can't work
      if (!TRANSIENT.has(code)) throw err; // a real error — surface it
      if (attempt === 5) break; // retries exhausted — try copy fallback
      await delay(attempt * 200);
    }
  }

  // 2) Fallback: copy then remove. Destination lands even if the source can't
  //    be unlinked (that stale source is cleaned before the next run).
  if (isDir) {
    fs.cpSync(src, dest, { recursive: true });
    try {
      fs.rmSync(src, { recursive: true, force: true });
    } catch {
      /* non-fatal: destination already exists */
    }
  } else {
    fs.copyFileSync(src, dest);
    try {
      fs.unlinkSync(src);
    } catch {
      /* non-fatal: destination already exists */
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) {
    console.error('usage: move-path.mjs <src> <dest>');
    process.exit(2);
  }
  try {
    await movePath(src, dest);
    console.info(`[move-path] moved -> ${dest}`);
  } catch (err) {
    console.error(
      `[move-path] failed to move ${src} -> ${dest}: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}
