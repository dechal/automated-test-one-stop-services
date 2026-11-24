import { spawn } from 'node:child_process';
import type { AndroidEmulatorStatus, RunningEmulator, ToolRef } from '@hub/shared';
import { BASH_PATH, WORKSPACE_ROOT } from '../config.js';
import { runChild } from './exec.js';
import { getEnabledTools, type ToolManifest } from './manifest-registry.js';

const SERVICE_ID = 'android-emulator';
const STATUS_CACHE_TTL_MS = 3_000;
const SAFE_VALUE = /^[A-Za-z0-9._-]+$/;

let cache: { value: AndroidEmulatorStatus; at: number } | null = null;

async function ownerTools(): Promise<ToolManifest[]> {
  const tools = await getEnabledTools().catch((): readonly ToolManifest[] => []);
  return tools.filter((t) => t.localServices?.includes(SERVICE_ID) === true);
}

function taskLine(tool: ToolManifest, task: string, vars = ''): string {
  return `task --silent ${tool.runner.taskNamespace}:${task}${vars ? ` ${vars}` : ''}`;
}

async function runTask(tool: ToolManifest, task: string, vars = '') {
  return runChild(BASH_PATH, ['-lc', taskLine(tool, task, vars)], { cwd: WORKSPACE_ROOT });
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function invalidateEmulatorStatus(): void {
  cache = null;
}

export async function emulatorStatus(): Promise<AndroidEmulatorStatus> {
  if (cache && Date.now() - cache.at < STATUS_CACHE_TTL_MS) return cache.value;
  const owners = await ownerTools();
  const requiredBy: ToolRef[] = owners.map((t) => ({ toolId: t.id, toolTitle: t.title }));
  const owner = owners[0];
  if (!owner) {
    const value: AndroidEmulatorStatus = { requiredBy, avds: [], running: [] };
    cache = { value, at: Date.now() };
    return value;
  }
  const [list, status] = await Promise.all([
    runTask(owner, 'emulator-list'),
    runTask(owner, 'emulator-status'),
  ]);
  const running: RunningEmulator[] = lines(status.stdout).map((line) => {
    const [serial = '', avd = ''] = line.split('\t');
    return { serial, avd };
  });
  const value: AndroidEmulatorStatus = {
    requiredBy,
    avds: list.ok ? lines(list.stdout).filter((name) => SAFE_VALUE.test(name)) : [],
    running,
    ...(list.ok ? {} : { error: lines(list.output).pop() ?? 'emulator-list failed' }),
  };
  cache = { value, at: Date.now() };
  return value;
}

export async function startEmulator(avd: string): Promise<{ ok: boolean; message: string }> {
  const owner = (await ownerTools())[0];
  if (!owner) return { ok: false, message: 'No installed tool needs an Android emulator' };
  if (!SAFE_VALUE.test(avd)) return { ok: false, message: `Invalid AVD name: ${avd}` };
  const child = spawn(BASH_PATH, ['-lc', taskLine(owner, 'emulator-start', `AVD=${avd}`)], {
    cwd: WORKSPACE_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => console.warn('[android-emulator] start failed:', err.message));
  child.unref();
  invalidateEmulatorStatus();
  return { ok: true, message: `Starting ${avd}` };
}

export async function stopEmulators(serial?: string): Promise<{ ok: boolean; message: string }> {
  const owner = (await ownerTools())[0];
  if (!owner) return { ok: false, message: 'No installed tool needs an Android emulator' };
  if (serial && !SAFE_VALUE.test(serial))
    return { ok: false, message: `Invalid serial: ${serial}` };
  const result = await runTask(owner, 'emulator-stop', serial ? `SERIAL=${serial}` : '');
  invalidateEmulatorStatus();
  return { ok: result.ok, message: lines(result.output).pop() ?? '' };
}
