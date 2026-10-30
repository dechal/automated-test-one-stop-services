import path from 'node:path';

export const SAFE_IDENT = /^[a-zA-Z0-9._/-]+$/;

export const MAX_TARGET_PATH = 200;

export function isSafeIdent(value: string): boolean {
  if (!SAFE_IDENT.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export type TargetPathError = 'NOT_ABSOLUTE' | 'TOO_LONG';

export function checkTargetPath(targetDir: string): TargetPathError | null {
  if (!path.isAbsolute(targetDir)) return 'NOT_ABSOLUTE';
  if (path.resolve(targetDir).length > MAX_TARGET_PATH) return 'TOO_LONG';
  return null;
}
