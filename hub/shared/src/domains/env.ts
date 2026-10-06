import type { ToolId } from './tools.js';

// Env editor -----------------------------------------------------------------

export interface EnvFile {
  /** Path relative to workspace root. */
  path: string;
  exists: boolean;
  /** Whether a sibling `.env.template` exists. */
  hasTemplate: boolean;
  entries: EnvEntry[];
  /** Keys present in template but missing from .env. */
  missingKeys: string[];
}

export interface EnvEntry {
  key: string;
  value: string;
  /** True when the entry comes from the template (and has no override). */
  fromTemplate: boolean;
  comment?: string;
}

// Env profiles ---------------------------------------------------------------

export interface EnvProfile {
  id: string;
  name: string;
  /** e.g. 'dev', 'staging', 'prod' */
  environment: string;
  tool: ToolId;
  type: string;
  project: string;
  /** Key-value pairs for this profile */
  entries: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  /**
   * true: this profile is pre-selected in the run/schedule form for its
   * (tool,type,project). At most one default per (tool,type,project) — the
   * server enforces the invariant on write. Absent ⇒ not the default.
   */
  isDefault?: boolean;
  /**
   * true: allow keys that are not in this project's `.env.template`.
   * Absent/false ⇒ safe default: keys outside the template are a validation
   * error that blocks save/apply.
   */
  allowOutsideTemplate?: boolean;
}

/** Result of comparing a profile's entries against its `.env.template`. */
export interface EnvProfileValidation {
  /** Keys the template has but the profile is missing (non-blocking warning). */
  missingKeys: string[];
  /** Keys the profile has but the template does not (the gate when switch off). */
  extraKeys: string[];
  /** false ⇒ no/empty template, so key-sync is skipped entirely. */
  hasTemplate: boolean;
}
