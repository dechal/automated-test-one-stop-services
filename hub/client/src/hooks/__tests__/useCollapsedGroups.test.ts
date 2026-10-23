import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCollapsedGroups } from '~/hooks/useCollapsedGroups.js';

describe('useCollapsedGroups', () => {
  it('toggles a key collapsed then expanded', () => {
    const { result } = renderHook(() => useCollapsedGroups({ searching: false }));
    expect(result.current.isCollapsed('a')).toBe(false);
    act(() => result.current.toggle('a'));
    expect(result.current.isCollapsed('a')).toBe(true);
    act(() => result.current.toggle('a'));
    expect(result.current.isCollapsed('a')).toBe(false);
  });

  it('forces every group expanded while searching', () => {
    const { result, rerender } = renderHook(
      ({ searching }: { searching: boolean }) => useCollapsedGroups({ searching }),
      { initialProps: { searching: false } },
    );
    act(() => result.current.toggle('a'));
    expect(result.current.isCollapsed('a')).toBe(true);
    rerender({ searching: true });
    expect(result.current.isCollapsed('a')).toBe(false);
    rerender({ searching: false });
    expect(result.current.isCollapsed('a')).toBe(true);
  });

  it('starts with the initial keys collapsed', () => {
    const { result } = renderHook(() =>
      useCollapsedGroups({ searching: false, initial: ['x', 'y'] }),
    );
    expect(result.current.isCollapsed('x')).toBe(true);
    expect(result.current.isCollapsed('y')).toBe(true);
    expect(result.current.isCollapsed('z')).toBe(false);
  });

  it('replaces the whole set with setAll', () => {
    const { result } = renderHook(() => useCollapsedGroups({ searching: false }));
    act(() => result.current.setAll(['a', 'b', 'c']));
    expect(result.current.isCollapsed('a')).toBe(true);
    expect(result.current.isCollapsed('b')).toBe(true);
    act(() => result.current.setAll([]));
    expect(result.current.isCollapsed('a')).toBe(false);
    expect(result.current.isCollapsed('b')).toBe(false);
  });

  it('isMarked reports raw membership regardless of searching', () => {
    const { result, rerender } = renderHook(
      ({ searching }: { searching: boolean }) => useCollapsedGroups({ searching }),
      { initialProps: { searching: false } },
    );
    act(() => result.current.toggle('a'));
    expect(result.current.isMarked('a')).toBe(true);
    expect(result.current.isCollapsed('a')).toBe(true);
    rerender({ searching: true });
    expect(result.current.isMarked('a')).toBe(true);
    expect(result.current.isCollapsed('a')).toBe(false);
  });
});
