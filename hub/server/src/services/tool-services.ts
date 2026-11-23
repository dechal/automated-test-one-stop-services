import path from 'node:path';
import type { ComposeServiceInfo, ToolLocalServiceId } from '@hub/shared';
import { TOOLS_DIR } from '../config.js';
import { runChild } from './exec.js';
import { getEnabledTools, type ToolManifest } from './manifest-registry.js';

const SERVICES_CACHE_TTL_MS = 60_000;

interface ComposeConfigJson {
  services?: Record<
    string,
    { image?: string; ports?: { published?: string | number; target?: number }[] }
  >;
}

interface ServiceEntry {
  info: ComposeServiceInfo;
  startCommand: string;
}

let cache: { entries: ServiceEntry[]; at: number; key: string } | null = null;

function startCommandFor(tool: ToolManifest, service: string): string {
  const startTask = tool.compose?.servicesStart;
  return startTask
    ? `task ${tool.runner.taskNamespace}:${startTask}`
    : `docker compose up -d ${service}`;
}

async function readToolServices(tool: ToolManifest): Promise<ServiceEntry[]> {
  const file = tool.compose?.services;
  if (!file) return [];
  const toolDir = path.join(TOOLS_DIR, tool.id);
  const result = await runChild(
    'docker',
    ['compose', '-f', path.join(toolDir, file), 'config', '--format', 'json'],
    { cwd: toolDir },
  );
  if (!result.ok) return [];
  let parsed: ComposeConfigJson;
  try {
    parsed = JSON.parse(result.stdout) as ComposeConfigJson;
  } catch {
    return [];
  }
  return Object.entries(parsed.services ?? {}).map(([name, svc]) => {
    const published = Number(svc.ports?.[0]?.published ?? svc.ports?.[0]?.target);
    return {
      info: {
        name,
        toolId: tool.id,
        toolTitle: tool.title,
        ...(svc.image ? { image: svc.image } : {}),
        ...(Number.isFinite(published) ? { port: published } : {}),
      },
      startCommand: startCommandFor(tool, name),
    };
  });
}

async function loadEntries(): Promise<ServiceEntry[]> {
  const tools = await getEnabledTools().catch((): readonly ToolManifest[] => []);
  const key = tools.map((t) => `${t.id}:${t.compose?.services ?? ''}`).join('|');
  if (cache && cache.key === key && Date.now() - cache.at < SERVICES_CACHE_TTL_MS) {
    return cache.entries;
  }
  const entries = (await Promise.all(tools.map(readToolServices))).flat();
  cache = { entries, at: Date.now(), key };
  return entries;
}

export async function listComposeServices(): Promise<ComposeServiceInfo[]> {
  return (await loadEntries()).map((e) => e.info);
}

export async function composeServiceStartCommand(service: string): Promise<string | undefined> {
  return (await loadEntries()).find((e) => e.info.name === service)?.startCommand;
}

export async function composeStartAllCommands(): Promise<string[]> {
  return [...new Set((await loadEntries()).map((e) => e.startCommand))];
}

export async function isLocalServiceRequired(id: ToolLocalServiceId): Promise<boolean> {
  const tools = await getEnabledTools().catch((): readonly ToolManifest[] => []);
  return tools.some((t) => t.localServices?.includes(id) === true);
}

