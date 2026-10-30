import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baseImageFromDockerfile } from '../index.js';
import { DEFAULT_RUNNER_COMMAND_TEMPLATE, validateManifest } from '../validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATE_DIR = path.join(ROOT, 'tools', 'tool-template-example');
const STANDARD_TASKS = ['setup', 'check', 'run-local', 'run-docker'] as const;

function read(file: string): string {
  return fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');
}

function requiredFilesFromReadme(readme: string): string[] {
  return readme
    .split(/\r?\n/)
    .filter((line) => line.startsWith('| `') && /\|\s*\*\*Yes\*\*/.test(line))
    .map((line) => /^\| `([^`]+)`/.exec(line)?.[1] ?? '')
    .filter((file) => file !== '');
}

function existsInTemplate(pattern: string): boolean {
  if (!pattern.includes('<')) return fs.existsSync(path.join(TEMPLATE_DIR, pattern));
  const parts = pattern.replace(/\/$/, '').split('/');
  let dirs = [TEMPLATE_DIR];
  for (const part of parts) {
    const re = new RegExp(`^${part.replace(/[.]/g, '\\.').replace(/<[^>]+>/g, '[^/]+')}$`);
    dirs = dirs.flatMap((dir) =>
      fs.existsSync(dir)
        ? fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => re.test(e.name))
            .map((e) => path.join(dir, e.name))
        : [],
    );
  }
  return dirs.length > 0;
}

describe('tool-template-example keeps up with the real tools (guard G-09)', () => {
  const raw: unknown = JSON.parse(read('tool.manifest.json'));

  it('its manifest validates and points at the workspace schema', () => {
    const result = validateManifest(raw);
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect((raw as { $schema?: string }).$schema).toBe(
      '../../scripts/manifests/schemas/tool.manifest.schema.json',
    );
  });

  it('carries no field that only repeats its default', () => {
    const manifest = raw as {
      alias: string;
      runner: { taskNamespace?: string; commandTemplate?: string };
    };
    expect(manifest.runner.commandTemplate).not.toBe(DEFAULT_RUNNER_COMMAND_TEMPLATE);
    expect(manifest.runner.taskNamespace).not.toBe(manifest.alias);
  });

  it('ships every file its README marks as required', () => {
    const required = requiredFilesFromReadme(read('README.md'));
    expect(required).toContain('tool.manifest.json');
    expect(required.filter((file) => !existsInTemplate(file))).toEqual([]);
  });

  it('its Taskfile has the standard tasks the root calls', () => {
    const taskfile = read('Taskfile.yml');
    const missing = STANDARD_TASKS.filter(
      (t) => !new RegExp(`^ {2}${t}:\\s*$`, 'm').test(taskfile),
    );
    expect(missing).toEqual([]);
  });

  it('its Dockerfile uses the Node major the workspace pins and a pinned pnpm', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      volta?: { node?: string };
    };
    const nodeMajor = pkg.volta?.node?.split('.')[0];
    const dockerfile = read('Dockerfile');
    expect(baseImageFromDockerfile(dockerfile)).toMatch(new RegExp(`^node:${nodeMajor}(-|$)`));
    expect(dockerfile).not.toMatch(/pnpm@latest/);
    expect(read('docker-compose.template.yml')).toMatch(/^\s+context: \.\s*$/m);
  });
});
