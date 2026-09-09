import type { ToolId } from '@hub/shared';
import { useQuery } from '@tanstack/react-query';
import {
  qAllProjects,
  qProjectList,
  qProjectSections,
  qProjectTags,
  qProjectTypes,
} from '~/api/queries.js';

/**
 * Thin hook wrappers over the centralized query-options factory in
 * `~/api/queries`. Kept as named hooks so existing call-sites stay unchanged,
 * but the keys/fetchers now live in one place — shared with route loaders.
 */

/** All project names (across every tool/type). Used by webhook/flaky filters. */
export function useAllProjects() {
  return useQuery(qAllProjects());
}

export function useProjectTypes(tool: ToolId | undefined | '') {
  return useQuery(qProjectTypes(tool));
}

/** k6 forces type=performance — caller passes that effective type. */
export function useProjectList(tool: ToolId | undefined | '', type: string | undefined | '') {
  return useQuery(qProjectList(tool, type));
}

/** Used by k6 only — sections under `automations/specs/<section>/`. */
export function useProjectSections(
  project: string | undefined | '',
  enabled = true,
  tool?: string,
) {
  return useQuery(qProjectSections(project, enabled, tool));
}

export function useProjectTags(
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
) {
  return useQuery(qProjectTags(tool, type, project));
}
