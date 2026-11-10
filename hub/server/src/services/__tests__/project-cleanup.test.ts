import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cleanup-'));
const toolsDir = path.join(root, 'tools');
const outputsDir = path.join(root, 'outputs');
const store = new Map<string, unknown>();
const deletedSchedules: string[] = [];

const ROBOT = { tool: 'robot-framework', type: 'desktop', project: 'iia' };
const PYWIN = { tool: 'pywinauto', type: 'desktop', project: 'iia' };

vi.mock('../../config.js', () => ({ TOOLS_DIR: toolsDir, OUTPUTS_DIR: outputsDir }));
vi.mock('../manifest-registry.js', () => ({
  getToolManifest: async () => ({ projects: { root: 'projects', typeAxis: true } }),
}));
vi.mock('../persistence.js', () => ({
  loadJson: <T>(name: string, fallback: T): T =>
    structuredClone((store.get(name) as T | undefined) ?? fallback),
  saveJson: (name: string, value: unknown) => store.set(name, structuredClone(value)),
}));
vi.mock('../history-store.js', () => ({
  historyStore: {
    removeWhere: (match: (record: { request: typeof ROBOT }) => boolean) => {
      const all = store.get('history') as { request: typeof ROBOT }[];
      const kept = all.filter((record) => !match(record));
      store.set('history', kept);
      return all.length - kept.length;
    },
  },
}));
vi.mock('../runner.js', () => ({ runner: { forgetProject: vi.fn() } }));
vi.mock('../scheduler.js', () => ({
  scheduler: {
    getAll: () => [
      { id: 's-robot', config: ROBOT },
      { id: 's-pywin', config: PYWIN },
    ],
    delete: (id: string) => {
      deletedSchedules.push(id);
      return true;
    },
  },
}));

function makeProject(ref: typeof ROBOT): void {
  const dir = path.join(toolsDir, ref.tool, 'projects', ref.type, ref.project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), ref.tool);
  const out = path.join(outputsDir, ref.tool, ref.type, ref.project);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.html'), ref.tool);
}

describe('removeProjectCascade — same project name under two tools', () => {
  beforeEach(() => {
    fs.rmSync(toolsDir, { recursive: true, force: true });
    fs.rmSync(outputsDir, { recursive: true, force: true });
    store.clear();
    deletedSchedules.length = 0;
    makeProject(ROBOT);
    makeProject(PYWIN);
    store.set('history', [{ request: ROBOT }, { request: PYWIN }]);
    store.set('bookmarks.json', [{ config: ROBOT }, { config: PYWIN }]);
    store.set('env-profiles.json', [ROBOT, PYWIN]);
    store.set('webhooks.json', [
      { id: 'w-robot', scope: { tool: ROBOT.tool, project: 'iia' } },
      { id: 'w-pywin', scope: { tool: PYWIN.tool, project: 'iia' } },
      { id: 'w-any-tool', scope: { project: 'iia' } },
    ]);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('removes only the robot-framework project and keeps every pywinauto trace', async () => {
    const { removeProjectCascade } = await import('../project-cleanup.js');
    const result = await removeProjectCascade(ROBOT);

    expect(result.projectDirRemoved).toBe(true);
    expect(fs.existsSync(path.join(toolsDir, 'robot-framework/projects/desktop/iia'))).toBe(false);
    expect(fs.existsSync(path.join(toolsDir, 'pywinauto/projects/desktop/iia/README.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(outputsDir, 'pywinauto/desktop/iia/report.html'))).toBe(true);
    expect(result.historyRemoved).toBe(1);
    expect(store.get('history')).toEqual([{ request: PYWIN }]);
    expect(store.get('bookmarks.json')).toEqual([{ config: PYWIN }]);
    expect(store.get('env-profiles.json')).toEqual([PYWIN]);
    expect(deletedSchedules).toEqual(['s-robot']);
    expect((store.get('webhooks.json') as { id: string }[]).map((w) => w.id)).toEqual([
      'w-pywin',
      'w-any-tool',
    ]);
  });

  it('refuses to delete through a link that points into another tool', async () => {
    const robotDir = path.join(toolsDir, 'robot-framework/projects/desktop/iia');
    fs.rmSync(robotDir, { recursive: true, force: true });
    fs.symlinkSync(path.join(toolsDir, 'pywinauto/projects/desktop/iia'), robotDir, 'junction');

    const { removeProjectCascade } = await import('../project-cleanup.js');
    const result = await removeProjectCascade(ROBOT);

    expect(result.projectDirRemoved).toBe(false);
    expect(fs.existsSync(path.join(toolsDir, 'pywinauto/projects/desktop/iia/README.md'))).toBe(
      true,
    );
  });
});
