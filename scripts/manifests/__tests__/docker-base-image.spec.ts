import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseImageFromCompose, baseImageFromDockerfile, createManifestRegistry } from '../index.js';
import { baseManifest, makeTmpDir } from './_helpers.js';

describe('docker base image is read from the files that build the image', () => {
  it('takes the last FROM that is not an earlier stage', () => {
    const text = [
      'ARG V=1',
      'FROM --platform=linux/amd64 node:26-slim AS build',
      'RUN echo',
      'FROM build AS test',
      'FROM mcr.microsoft.com/playwright:v1-noble',
      'COPY --from=build /a /a',
    ].join('\n');
    expect(baseImageFromDockerfile(text)).toBe('mcr.microsoft.com/playwright:v1-noble');
    expect(baseImageFromDockerfile('FROM base AS a\nFROM a')).toBe('base');
    expect(baseImageFromDockerfile('# no image here')).toBe('');
  });

  it('falls back to the first compose image', () => {
    expect(baseImageFromCompose('x: &t\n  image: "grafana/k6:1.0" # pin\n')).toBe('grafana/k6:1.0');
    expect(baseImageFromCompose('x:\n  build: .\n')).toBe('');
  });

  it('the registry shows the derived image instead of the hand-typed one', async () => {
    const root = makeTmpDir('docker-base-');
    const json = baseManifest();
    const id = String(json.id);
    const toolDir = path.join(root, 'tools', id);
    fs.mkdirSync(toolDir, { recursive: true });
    fs.writeFileSync(path.join(toolDir, 'tool.manifest.json'), JSON.stringify(json));
    fs.writeFileSync(path.join(toolDir, 'Dockerfile'), 'FROM real/image:2\n');
    const registry = createManifestRegistry(root);
    await registry.refresh();
    expect(registry.byId(id)?.docker.baseImage).toBe('real/image:2');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
