import type { RunRecord, WebhookConfig, WebhookEvent, WebhookScope } from '@hub/shared';
import { nanoid } from 'nanoid';
import { getEnabledToolIds, getEnabledTools } from './manifest-registry.js';
import { loadJson, saveJson } from './persistence.js';

const WEBHOOKS_FILE = 'webhooks.json';
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

// ---------------------------------------------------------------------------
// Persistence + legacy migration
// ---------------------------------------------------------------------------

function isScopeEmpty(scope: WebhookScope | undefined): boolean {
  return !scope || (!scope.tool && !scope.type && !scope.project);
}

function load(): WebhookConfig[] {
  return loadJson<WebhookConfig[]>(WEBHOOKS_FILE, []);
}

function save(webhooks: WebhookConfig[]): void {
  saveJson(WEBHOOKS_FILE, webhooks);
}

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

/** True when the webhook's scope (if any) matches the run. */
function scopeMatches(scope: WebhookScope | undefined, run: RunRecord): boolean {
  if (isScopeEmpty(scope)) return true;
  if (scope?.tool && scope.tool !== run.request.tool) return false;
  if (scope?.type && scope.type !== run.request.type) return false;
  if (scope?.project && scope.project !== run.request.project) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function durationSec(run: RunRecord): string {
  if (!run.endedAt || !run.startedAt) return '?';
  return String(
    Math.round((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000),
  );
}

function buildSlackPayload(run: RunRecord, event: WebhookEvent): object {
  const emoji =
    event === 'run-passed' ? ':white_check_mark:' : event === 'run-failed' ? ':x:' : ':warning:';
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *Test Run ${event.replace('run-', '').toUpperCase()}*\n*Project:* ${run.request.project}\n*Tool:* ${run.request.tool}\n*Type:* ${run.request.type}\n*Duration:* ${durationSec(run)}s`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Command: \`${run.command}\`` }],
      },
    ],
  };
}

function buildDiscordPayload(run: RunRecord, event: WebhookEvent): object {
  const color = event === 'run-passed' ? 0x2ecc71 : event === 'run-failed' ? 0xe74c3c : 0xf39c12;
  return {
    embeds: [
      {
        title: `Test Run ${event.replace('run-', '').toUpperCase()}`,
        color,
        fields: [
          { name: 'Project', value: run.request.project, inline: true },
          { name: 'Tool', value: run.request.tool, inline: true },
          { name: 'Type', value: run.request.type, inline: true },
          { name: 'Command', value: `\`${run.command}\`` },
        ],
        timestamp: run.endedAt ?? run.startedAt,
      },
    ],
  };
}

function buildTeamsPayload(run: RunRecord, event: WebhookEvent): object {
  const color = event === 'run-passed' ? '2ecc71' : event === 'run-failed' ? 'e74c3c' : 'f39c12';
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: color,
    summary: `Test Run ${event.replace('run-', '')}`,
    sections: [
      {
        activityTitle: `Test Run ${event.replace('run-', '').toUpperCase()}`,
        facts: [
          { name: 'Project', value: run.request.project },
          { name: 'Tool', value: run.request.tool },
          { name: 'Type', value: run.request.type },
          { name: 'Status', value: run.status },
        ],
      },
    ],
  };
}

function buildLinePayload(run: RunRecord, event: WebhookEvent, recipientId: string): object {
  const emoji = event === 'run-passed' ? '✅' : event === 'run-failed' ? '❌' : '⚠️';
  return {
    to: recipientId,
    messages: [
      {
        type: 'text',
        text: `${emoji} Test Run ${event.replace('run-', '').toUpperCase()}\n\nProject: ${run.request.project}\nTool: ${run.request.tool}\nType: ${run.request.type}\nDuration: ${durationSec(run)}s\nCommand: ${run.command}`,
      },
    ],
  };
}

function buildGenericPayload(run: RunRecord, event: WebhookEvent): object {
  return {
    event,
    run: {
      id: run.id,
      project: run.request.project,
      tool: run.request.tool,
      type: run.request.type,
      status: run.status,
      command: run.command,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
    },
    timestamp: new Date().toISOString(),
  };
}

function buildPayload(webhook: WebhookConfig, run: RunRecord, event: WebhookEvent): object {
  switch (webhook.platform) {
    case 'slack':
      return buildSlackPayload(run, event);
    case 'discord':
      return buildDiscordPayload(run, event);
    case 'teams':
      return buildTeamsPayload(run, event);
    case 'line':
      return buildLinePayload(run, event, webhook.recipientId ?? '');
    case 'generic':
      return buildGenericPayload(run, event);
  }
}

/** Resolve transport URL + headers for a webhook (handles LINE special-case). */
function resolveTransport(
  webhook: WebhookConfig,
): { url: string; headers: Record<string, string> } | { error: string } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (webhook.platform === 'line') {
    if (!webhook.token || !webhook.recipientId) {
      return { error: 'LINE requires token and recipientId' };
    }
    headers.Authorization = `Bearer ${webhook.token}`;
    return { url: LINE_PUSH_URL, headers };
  }
  return { url: webhook.url, headers };
}

async function sendWebhook(
  webhook: WebhookConfig,
  run: RunRecord,
  event: WebhookEvent,
): Promise<boolean> {
  const transport = resolveTransport(webhook);
  if ('error' in transport) return false;

  try {
    const resp = await fetch(transport.url, {
      method: 'POST',
      headers: transport.headers,
      body: JSON.stringify(buildPayload(webhook, run, event)),
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class WebhookService {
  getAll(): WebhookConfig[] {
    return load();
  }

  getById(id: string): WebhookConfig | undefined {
    return load().find((w) => w.id === id);
  }

  create(
    data: Omit<WebhookConfig, 'id' | 'createdAt' | 'lastTriggeredAt' | 'lastStatus'>,
  ): WebhookConfig {
    const webhooks = load();
    const webhook: WebhookConfig = {
      ...data,
      id: nanoid(10),
      createdAt: new Date().toISOString(),
    };
    webhooks.push(webhook);
    save(webhooks);
    return webhook;
  }

  update(id: string, data: Partial<Omit<WebhookConfig, 'id' | 'createdAt'>>): WebhookConfig | null {
    const webhooks = load();
    const idx = webhooks.findIndex((w) => w.id === id);
    if (idx === -1) return null;
    const existing = webhooks[idx] as WebhookConfig;
    const merged: WebhookConfig = { ...existing, ...data };
    // When client sends a fresh `scope`, drop legacy `projectFilter` to avoid stale matches.
    if (Object.hasOwn(data, 'scope')) {
      delete merged.projectFilter;
    }
    webhooks[idx] = merged;
    save(webhooks);
    return merged;
  }

  delete(id: string): boolean {
    const webhooks = load();
    const idx = webhooks.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    webhooks.splice(idx, 1);
    save(webhooks);
    return true;
  }

  toggle(id: string): WebhookConfig | null {
    const webhooks = load();
    const idx = webhooks.findIndex((w) => w.id === id);
    if (idx === -1) return null;
    const existing = webhooks[idx] as WebhookConfig;
    existing.enabled = !existing.enabled;
    webhooks[idx] = existing;
    save(webhooks);
    return existing;
  }

  /**
   * Send a test notification.
   * Scope priority for the sample run shown in the message:
   *   1. caller-provided `overrides` (e.g. test-from-UI passes scope explicitly)
   *   2. webhook's own scope (configured filter)
   *   3. fallback placeholder (only when webhook is unscoped)
   * IMPORTANT: we never fall back to the user's most-recent run anymore — that
   * was the source of the "wrong project name" bug.
   */
  async test(
    id: string,
    overrides?: { tool?: string; type?: string; project?: string },
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const webhook = this.getById(id);
    if (!webhook) return { success: false, error: 'Webhook not found' };

    const scope = webhook.scope ?? {};
    const project = overrides?.project || scope.project || '(webhook test)';
    // Placeholder tool for the sample notification: prefer the webhook's own
    // scope, else the first installed tool (manifest-driven, so the test never
    // shows a tool the user doesn't have). The literal is an unreachable guard
    // for the degenerate "no tools installed" case.
    const enabledTools = await getEnabledTools();
    const tool = (overrides?.tool ||
      scope.tool ||
      enabledTools[0]?.id ||
      'playwright') as RunRecord['request']['tool'];
    const type = overrides?.type || scope.type || 'web';

    const sampleRun: RunRecord = {
      id: 'test-run-001',
      request: { tool, type, project, mode: 'local' },
      command: `[test notification from ${webhook.name}]`,
      status: 'passed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0,
    };

    const transport = resolveTransport(webhook);
    if ('error' in transport) return { success: false, error: transport.error };

    try {
      const resp = await fetch(transport.url, {
        method: 'POST',
        headers: transport.headers,
        body: JSON.stringify(buildPayload(webhook, sampleRun, 'run-passed')),
        signal: AbortSignal.timeout(10_000),
      });
      return { success: resp.ok, statusCode: resp.status };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async fireForRun(run: RunRecord): Promise<void> {
    const event: WebhookEvent | null =
      run.status === 'passed'
        ? 'run-passed'
        : run.status === 'failed'
          ? 'run-failed'
          : run.status === 'error'
            ? 'run-error'
            : run.status === 'cancelled'
              ? 'run-cancelled'
              : null;

    if (!event) return;

    // Skip notifications for runs of a disabled/uninstalled tool — disabling a
    // tool silences its webhooks without deleting the webhook config.
    const enabledIds = await getEnabledToolIds();
    if (!enabledIds.has(run.request.tool)) return;

    const matched = load().filter(
      (w) => w.enabled && w.events.includes(event) && scopeMatches(w.scope, run),
    );
    if (matched.length === 0) return;

    // Fire in parallel — each request still has its own 10s timeout, so a
    // slow webhook won't hold up the others. Then write the resulting
    // statuses in a single pass to avoid N load+save cycles.
    const results = await Promise.all(
      matched.map((webhook) =>
        sendWebhook(webhook, run, event).then((success) => ({ webhook, success })),
      ),
    );

    const triggeredAt = new Date().toISOString();
    const all = load();
    let changed = false;
    for (const { webhook, success } of results) {
      const idx = all.findIndex((w) => w.id === webhook.id);
      if (idx === -1) continue;
      const existing = all[idx] as WebhookConfig;
      all[idx] = {
        ...existing,
        lastTriggeredAt: triggeredAt,
        lastStatus: success ? 'success' : 'error',
      };
      changed = true;
    }
    if (changed) save(all);
  }
}

export const webhookService = new WebhookService();
