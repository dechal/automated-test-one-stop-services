import type { ToolView } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { firstEnabledTool } from '~/utils/tool-label.js';

type ToolRef = Pick<ToolView, 'id' | 'status'>;

const tool = (id: string, status: ToolView['status'] = 'enabled'): ToolRef => ({ id, status });

describe('firstEnabledTool', () => {
  it('keeps the preferred tool while it is enabled', () => {
    expect(firstEnabledTool([tool('k6'), tool('playwright')], 'playwright')).toBe('playwright');
  });

  it('falls back to the first enabled tool when the preferred one is missing', () => {
    expect(firstEnabledTool([tool('k6'), tool('robot-framework')], 'playwright')).toBe('k6');
  });

  it('skips a disabled preferred tool', () => {
    const tools = [tool('playwright', 'disabled'), tool('robot-framework')];
    expect(firstEnabledTool(tools, 'playwright')).toBe('robot-framework');
  });

  it('returns the preferred tool while the list is still empty', () => {
    expect(firstEnabledTool([], 'playwright')).toBe('playwright');
  });
});
