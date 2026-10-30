import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTargetPath, isSafeIdent, MAX_TARGET_PATH, SAFE_IDENT } from '../validate.js';

describe('isSafeIdent', () => {
  it.each(['a/../b', '..', '.', 'a//b', '/a', 'a/', '', 'a b', 'a;b', 'web/./x'])(
    'rejects %j',
    (value) => {
      expect(isSafeIdent(value)).toBe(false);
    },
  );

  it.each(['web/sub', 'IIA_v2', 'k6-performance-template-example', 'desktop', 'a.b'])(
    'accepts %j',
    (value) => {
      expect(isSafeIdent(value)).toBe(true);
    },
  );

  it('keeps the Hub SAFE_IDENT pattern verbatim', () => {
    expect(SAFE_IDENT.source).toBe('^[a-zA-Z0-9._/-]+$');
  });
});

describe('checkTargetPath', () => {
  it('rejects a relative path', () => {
    expect(checkTargetPath('bundles/out')).toBe('NOT_ABSOLUTE');
  });

  it('rejects a path longer than MAX_TARGET_PATH', () => {
    const long = path.resolve('/', 'x'.repeat(MAX_TARGET_PATH + 1));
    expect(checkTargetPath(long)).toBe('TOO_LONG');
  });

  it('accepts an absolute path with spaces', () => {
    expect(checkTargetPath(path.resolve('/', 'moved copy', 'k6'))).toBeNull();
  });
});
