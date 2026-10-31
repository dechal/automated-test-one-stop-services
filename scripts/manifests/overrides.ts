// scripts/manifests/overrides.ts
//
// Local override resolution (no-commit disable). Reads the gitignored
// `scripts/manifests/data/.tool-overrides.json` and produces an enabled-resolver that the
// manifest registry plugs into its resolution seam.
//
// Resolution order (highest precedence first):
//   1. local override        — `scripts/manifests/data/.tool-overrides.json` entry for the tool
//   2. manifest.enabled       — the committed value in `tool.manifest.json`
//   3. implicit `true`        — when neither source defines a value
//
// The override file lets a developer disable a tool on their machine without
// committing a change that would affect teammates.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolManifest } from './types.js';

/** Path of the local overrides file, relative to the workspace root. */
export const TOOL_OVERRIDES_PATH = path.join(
  'scripts',
  'manifests',
  'data',
  '.tool-overrides.json',
);

/** Per-tool override entry. Only `enabled` is honoured today. */
export interface ToolOverrideEntry {
  readonly enabled?: boolean;
}

/** Shape of `scripts/manifests/data/.tool-overrides.json`: `{ "<toolId>": { "enabled": bool } }`. */
export type ToolOverrides = Readonly<Record<string, ToolOverrideEntry>>;

/**
 * Read + parse `scripts/manifests/data/.tool-overrides.json`. Never throws: an absent,
 * unreadable, or malformed file resolves to "no overrides" (`{}`) so a stray
 * local file can never break discovery for the whole workspace.
 */
export function readOverrides(workspaceRoot: string): ToolOverrides {
  const overridesPath = path.join(workspaceRoot, TOOL_OVERRIDES_PATH);

  let raw: string;
  try {
    raw = fs.readFileSync(overridesPath, 'utf8');
  } catch {
    return {}; // absent or unreadable → no overrides
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // malformed JSON → ignore, never throw
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as ToolOverrides;
}

/**
 * Build an enabled-resolver bound to the overrides on disk at call time.
 *
 * The overrides file is read once here so a single `refresh()` resolves every
 * manifest against a consistent snapshot. Reconstruct the resolver (i.e. call
 * this again) to pick up edits to the override file — the registry does this on
 * each `refresh()`.
 */
export function createEnabledResolver(workspaceRoot: string): (manifest: ToolManifest) => boolean {
  const overrides = readOverrides(workspaceRoot);

  return (manifest) => {
    const override = overrides[manifest.id];
    if (override !== undefined && typeof override.enabled === 'boolean') {
      return override.enabled; // tier 1: local override wins
    }
    // tier 2: committed manifest value. The schema makes `enabled` required, so
    // tier 3 (implicit `true`) only applies to manifests that bypassed schema
    // validation — resolution always runs on validated manifests here.
    return manifest.enabled;
  };
}
