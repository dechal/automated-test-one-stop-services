import { useEffect, useRef, useState } from 'react';

export const SCOPE_ALL = 'all';
export const SCOPE_BY_TAG = 'tag';

interface TagScopeArgs {
  selectedTags: string[];
  excludedTags: string[];
  setSelectedTags: (tags: string[]) => void;
  setExcludedTags: (tags: string[]) => void;
}

export function useTagScope({
  selectedTags,
  excludedTags,
  setSelectedTags,
  setExcludedTags,
}: TagScopeArgs) {
  const hasSelection = selectedTags.length + excludedTags.length > 0;
  const [byTag, setByTag] = useState(hasSelection);
  const stash = useRef<{ include: string[]; exclude: string[] }>({ include: [], exclude: [] });

  useEffect(() => {
    if (hasSelection) setByTag(true);
  }, [hasSelection]);

  function setScope(value: string) {
    if (value === SCOPE_ALL) {
      stash.current = { include: selectedTags, exclude: excludedTags };
      setSelectedTags([]);
      setExcludedTags([]);
      setByTag(false);
      return;
    }
    setByTag(true);
    if (!hasSelection) {
      setSelectedTags(stash.current.include);
      setExcludedTags(stash.current.exclude);
    }
  }

  return { byTag, scope: byTag ? SCOPE_BY_TAG : SCOPE_ALL, setScope };
}
