import { useCallback, useState } from 'react';

export interface UseCollapsedGroupsOptions {
  searching: boolean;
  initial?: Iterable<string>;
}

export interface CollapsedGroups {
  isCollapsed: (key: string) => boolean;
  isMarked: (key: string) => boolean;
  toggle: (key: string) => void;
  setAll: (keys: Iterable<string>) => void;
}

export function useCollapsedGroups({
  searching,
  initial,
}: UseCollapsedGroupsOptions): CollapsedGroups {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(initial));

  const isCollapsed = useCallback(
    (key: string): boolean => !searching && collapsed.has(key),
    [searching, collapsed],
  );

  const isMarked = useCallback((key: string): boolean => collapsed.has(key), [collapsed]);

  const toggle = useCallback((key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setAll = useCallback((keys: Iterable<string>): void => {
    setCollapsed(new Set(keys));
  }, []);

  return { isCollapsed, isMarked, toggle, setAll };
}
