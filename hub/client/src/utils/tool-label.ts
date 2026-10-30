import type { ToolView } from '@hub/shared';

/**
 * Return a short display label for a tool id.
 * Prefers `manifest.alias` for known tools or `manifest.title` for a human-readable
 * name. Falls back to the raw id when the tool is not in the installed list.
 *
 * Replaces the ad-hoc `tool === 'robot-framework' ? 'robot' : tool` pattern
 * scattered across banners, history, and queue components.
 */
export function toolLabel(id: string, tools: readonly ToolView[]): string {
  const found = tools.find((t) => t.id === id);
  if (found) return found.alias || found.title;
  // Legacy / unknown: keep the id but shorten the known noisy one defensively
  if (id === 'robot-framework') return 'robot';
  return id;
}

/** Enabled tools only (status === 'enabled'). */
export function enabledTools(tools: readonly ToolView[]): ToolView[] {
  return tools.filter((t) => t.status === 'enabled');
}

export function firstEnabledTool(
  tools: readonly Pick<ToolView, 'id' | 'status'>[],
  preferred: string,
): string {
  const enabled = tools.filter((t) => t.status === 'enabled');
  if (enabled.length === 0 || enabled.some((t) => t.id === preferred)) return preferred;
  return enabled[0]?.id ?? preferred;
}

/**
 * Mantine `Select`/`data` options (`{ value: id, label: title }`) for the
 * enabled tools. Replaces the `tools.filter(enabled).map(...)` array that the
 * Run form, Clone/Create modals, and the schedule form each rebuilt inline.
 */
export function toolSelectData(tools: readonly ToolView[]): { value: string; label: string }[] {
  return enabledTools(tools).map((t) => ({ value: t.id, label: t.title }));
}
