import path from 'node:path';
import { OUTPUTS_DIR, WORKSPACE_ROOT } from '../config.js';

/** True when `target` resolves under `root` (handles `..` traversal attempts). */
export function isUnder(root: string, target: string): boolean {
  const rootR = path.resolve(root);
  const targetR = path.resolve(target);
  if (targetR === rootR) return true;
  return targetR.startsWith(rootR + path.sep);
}

/** Convenience guard for the outputs/ tree (the most common security boundary). */
export function isUnderOutputs(target: string): boolean {
  return isUnder(OUTPUTS_DIR, target);
}

/** Convenience guard for anything inside the workspace root. */
export function isUnderWorkspace(target: string): boolean {
  return isUnder(WORKSPACE_ROOT, target);
}

export type StandaloneTargetRejection = 'NOT_ABSOLUTE' | 'INSIDE_WORKSPACE' | 'IS_WORKSPACE_ROOT';

export function rejectStandaloneTarget(target: string): StandaloneTargetRejection | null {
  if (!path.isAbsolute(target)) return 'NOT_ABSOLUTE';
  const resolved = path.resolve(target);
  if (resolved === path.resolve(WORKSPACE_ROOT)) return 'IS_WORKSPACE_ROOT';
  if (isUnderWorkspace(resolved)) return 'INSIDE_WORKSPACE';
  return null;
}
