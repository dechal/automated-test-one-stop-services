import { parseTagQuery } from '@hub/shared';

export interface TagQueryGroups {
  include: string[][];
  exclude: string[];
}

const ROBOT_TOOL = 'robot-framework';
const LOOKAHEAD = /\((\?[=!])\.\*(?:\(\?:([^)]*)\)|([^)]+))\)/g;

function splitTags(part: string, separator: RegExp): string[] {
  return part
    .split(separator)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '' && tag !== '*');
}

export function describeTagQuery(tool: string, expr: string | undefined | null): TagQueryGroups {
  if (!expr) return { include: [], exclude: [] };
  if (tool === ROBOT_TOOL) {
    const [includePart = '', ...excludeParts] = expr.split('NOT');
    return {
      include: splitTags(includePart, /AND/).map((group) => splitTags(group, /OR/)),
      exclude: excludeParts.flatMap((part) => splitTags(part, /AND|OR/)),
    };
  }
  const include: string[][] = [];
  const exclude: string[] = [];
  for (const m of expr.matchAll(LOOKAHEAD)) {
    const tags = splitTags(m[2] ?? m[3] ?? '', /\|/);
    if (m[1] === '?!') exclude.push(...tags);
    else if (tags.length > 0) include.push(tags);
  }
  if (include.length === 0 && exclude.length === 0) {
    const flat = parseTagQuery(tool, expr);
    return { include: flat.include.map((tag) => [tag]), exclude: flat.exclude };
  }
  return { include, exclude };
}
