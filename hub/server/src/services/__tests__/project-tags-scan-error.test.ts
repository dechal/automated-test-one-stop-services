import { describe, expect, it } from 'vitest';
import { summarizeScanFailure } from '../project-tags.js';

const PYTEST_PLUGIN_FAILURE = [
  'Error while loading plugin "automations.modules.base_fixture".',
  'automations\\modules\\base_fixture.py:5: in <module>',
  '    from automations.modules.base_page import BasePage',
  "E   ModuleNotFoundError: No module named 'projects'",
].join('\n');

describe('summarizeScanFailure', () => {
  it('keeps the error lines of a pytest collection failure', () => {
    expect(summarizeScanFailure(PYTEST_PLUGIN_FAILURE)).toBe(
      [
        'Error while loading plugin "automations.modules.base_fixture".',
        "ModuleNotFoundError: No module named 'projects'",
      ].join('\n'),
    );
  });

  it('falls back to the last line when no error line matches', () => {
    expect(summarizeScanFailure('starting\ncollected 0 items\n')).toBe('collected 0 items');
  });

  it('returns undefined for empty output', () => {
    expect(summarizeScanFailure('  \n')).toBeUndefined();
  });
});
