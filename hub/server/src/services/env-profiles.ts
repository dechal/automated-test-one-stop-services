import fs from 'node:fs';
import path from 'node:path';
import type { EnvProfile, EnvProfileValidation, ToolId } from '@hub/shared';
import { nanoid } from 'nanoid';
import { TOOLS_DIR } from '../config.js';
import { parseEnvToRecord } from './env-parser.js';
import { loadJson, saveJson } from './persistence.js';

const PROFILES_FILE = 'env-profiles.json';

/**
 * Discriminated outcome of {@link EnvProfileService.apply}. Callers branch on
 * `code` — the scheduler must NOT collapse this to `!success`, since
 * `OUTSIDE_TEMPLATE_KEYS` and `NOT_FOUND` need different fire-time handling.
 */
export type ApplyResult =
  | { success: true }
  | { success: false; code: 'NOT_FOUND' }
  | { success: false; code: 'OUTSIDE_TEMPLATE_KEYS'; extraKeys: string[] }
  | { success: false; code: 'APPLY_FAILED'; error: string };

function load(): EnvProfile[] {
  return loadJson<EnvProfile[]>(PROFILES_FILE, []);
}

function save(profiles: EnvProfile[]): void {
  saveJson(PROFILES_FILE, profiles);
}

function getProjectEnvPath(tool: ToolId, type: string, project: string): string {
  return path.join(TOOLS_DIR, tool, 'projects', type, project, '.env');
}

function readEnvAsRecord(envPath: string): Record<string, string> | null {
  if (!fs.existsSync(envPath)) return null;
  return parseEnvToRecord(fs.readFileSync(envPath, 'utf8'));
}

class EnvProfileService {
  getAll(): EnvProfile[] {
    return load();
  }

  getByProject(tool: ToolId, type: string, project: string): EnvProfile[] {
    return load().filter((p) => p.tool === tool && p.type === type && p.project === project);
  }

  getById(id: string): EnvProfile | undefined {
    return load().find((p) => p.id === id);
  }

  create(data: Omit<EnvProfile, 'id' | 'createdAt' | 'updatedAt'>): EnvProfile {
    const profiles = load();
    const profile: EnvProfile = {
      ...data,
      id: nanoid(10),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    profiles.push(profile);
    save(profiles);
    return profile;
  }

  update(id: string, data: Partial<Omit<EnvProfile, 'id' | 'createdAt'>>): EnvProfile | null {
    const profiles = load();
    const idx = profiles.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const existing = profiles[idx] as EnvProfile;
    const updated = { ...existing, ...data, updatedAt: new Date().toISOString() };
    profiles[idx] = updated;
    save(profiles);
    return updated;
  }

  /**
   * Compare a FULL profile's entry keys against its `.env.template` keys.
   * `missingKeys` is a non-blocking warning; `extraKeys` is the gate the
   * caller enforces against `allowOutsideTemplate`. Pass a resolved profile —
   * on the update path, merge the patch over the stored record first, or
   * `getTemplate` resolves the wrong project and reports every key as extra.
   */
  validate(profile: EnvProfile): EnvProfileValidation {
    const template = this.getTemplate(profile.tool, profile.type, profile.project);
    const templateKeys = Object.keys(template);
    const hasTemplate = templateKeys.length > 0;
    if (!hasTemplate) return { missingKeys: [], extraKeys: [], hasTemplate: false };
    const profileKeys = new Set(Object.keys(profile.entries ?? {}));
    const templateKeySet = new Set(templateKeys);
    const missingKeys = templateKeys.filter((k) => !profileKeys.has(k));
    const extraKeys = [...profileKeys].filter((k) => !templateKeySet.has(k));
    return { missingKeys, extraKeys, hasTemplate: true };
  }

  /**
   * Mark one profile the default for its (tool,type,project), clearing the flag
   * on every sibling in a single `save` (one `writeCollection` transaction), so
   * the "at most one default per project" invariant holds even under racing
   * calls — each call rewrites the whole collection.
   */
  setDefault(id: string): EnvProfile | null {
    const profiles = load();
    const target = profiles.find((p) => p.id === id);
    if (!target) return null;
    const next = profiles.map((p) => {
      if (p.tool === target.tool && p.type === target.type && p.project === target.project) {
        return { ...p, isDefault: p.id === id };
      }
      return p;
    });
    save(next);
    return next.find((p) => p.id === id) ?? null;
  }

  /** Id of the default profile for a (tool,type,project), or null when none. */
  getDefault(tool: ToolId, type: string, project: string): string | null {
    const match = this.getByProject(tool, type, project).find((p) => p.isDefault === true);
    return match ? match.id : null;
  }

  delete(id: string): boolean {
    const profiles = load();
    const idx = profiles.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    profiles.splice(idx, 1);
    save(profiles);
    return true;
  }

  /**
   * Apply a profile to the project's .env on disk.
   * Preserves comments, blank lines, and unrelated keys; only substitutes the
   * keys defined in the profile (or appends them at the bottom).
   */
  apply(id: string): ApplyResult {
    const profile = this.getById(id);
    if (!profile) return { success: false, code: 'NOT_FOUND' };

    // Gate keys outside the template unless this profile opts in. Checked
    // before writing, so a rejected apply leaves `.env` untouched.
    if (profile.allowOutsideTemplate !== true) {
      const { extraKeys } = this.validate(profile);
      if (extraKeys.length > 0) {
        return { success: false, code: 'OUTSIDE_TEMPLATE_KEYS', extraKeys };
      }
    }

    const envPath = getProjectEnvPath(profile.tool, profile.type, profile.project);
    const dir = path.dirname(envPath);
    if (!fs.existsSync(dir)) {
      return { success: false, code: 'APPLY_FAILED', error: 'Project directory not found' };
    }

    let existingLines: string[] = [];
    if (fs.existsSync(envPath)) {
      existingLines = fs.readFileSync(envPath, 'utf8').split('\n');
    }

    const profileKeys = new Set(Object.keys(profile.entries));
    const writtenKeys = new Set<string>();
    const newLines: string[] = [];

    for (const line of existingLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        newLines.push(line);
        continue;
      }
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) {
        newLines.push(line);
        continue;
      }
      const key = line.slice(0, eqIdx).trim();
      if (profileKeys.has(key)) {
        newLines.push(`${key}=${profile.entries[key]}`);
        writtenKeys.add(key);
      } else {
        newLines.push(line);
      }
    }

    for (const [key, value] of Object.entries(profile.entries)) {
      if (!writtenKeys.has(key)) {
        newLines.push(`${key}=${value}`);
      }
    }

    try {
      fs.writeFileSync(envPath, newLines.join('\n'), 'utf8');
    } catch (err) {
      return { success: false, code: 'APPLY_FAILED', error: (err as Error).message };
    }
    return { success: true };
  }

  captureFromEnv(
    tool: ToolId,
    type: string,
    project: string,
    name: string,
    environment: string,
  ): EnvProfile | null {
    const entries = readEnvAsRecord(getProjectEnvPath(tool, type, project));
    if (!entries) return null;
    return this.create({ name, environment, tool, type, project, entries });
  }

  /** Compare current .env with profiles to find an exact match. */
  getActiveProfile(tool: ToolId, type: string, project: string): string | null {
    const profiles = this.getByProject(tool, type, project);
    if (profiles.length === 0) return null;

    const currentEntries = readEnvAsRecord(getProjectEnvPath(tool, type, project));
    if (!currentEntries) return null;

    for (const profile of profiles) {
      const profileKeys = Object.keys(profile.entries);
      if (profileKeys.length === 0) continue;
      const allMatch = profileKeys.every((key) => currentEntries[key] === profile.entries[key]);
      if (allMatch) return profile.id;
    }
    return null;
  }

  /** Get .env.template keys for a project. Empty record if no template. */
  getTemplate(tool: ToolId, type: string, project: string): Record<string, string> {
    const tplPath = path.join(TOOLS_DIR, tool, 'projects', type, project, '.env.template');
    if (!fs.existsSync(tplPath)) return {};
    return parseEnvToRecord(fs.readFileSync(tplPath, 'utf8'));
  }
}

export const envProfileService = new EnvProfileService();
