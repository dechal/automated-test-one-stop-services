import type { DoctorCheck } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { groupByTool } from '../doctor-panel-helpers';

function check(name: string, toolId?: string, toolTitle?: string): DoctorCheck {
  return { name, ok: true, category: 'required-install', toolId, toolTitle };
}

describe('groupByTool', () => {
  it('puts general checks first, then one group per tool sorted by title', () => {
    const groups = groupByTool([
      check('node'),
      check('k6', 'k6', 'k6 (Performance)'),
      check('python', 'robot-framework', 'Robot Framework'),
      check('grafana', 'k6', 'k6 (Performance)'),
      check('git'),
    ]);
    expect(groups.map((g) => [g.toolId, g.checks.map((c) => c.name)])).toEqual([
      [undefined, ['node', 'git']],
      ['k6', ['k6', 'grafana']],
      ['robot-framework', ['python']],
    ]);
  });

  it('keeps an empty general group when every check belongs to a tool', () => {
    const groups = groupByTool([check('k6', 'k6', 'k6')]);
    expect(groups[0]?.checks).toEqual([]);
    expect(groups).toHaveLength(2);
  });
});
