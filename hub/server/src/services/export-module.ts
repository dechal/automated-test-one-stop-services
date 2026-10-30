import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LifecycleResult } from '@hub/shared';
import { WORKSPACE_ROOT } from '../config.js';

export interface ExportError {
  readonly code: string;
  readonly message: string;
}

export interface StandaloneExportResult {
  readonly tool: string;
  readonly type: string;
  readonly project: string;
  readonly targetDir: string;
  readonly mode: 'fresh' | 'migrate';
  readonly written: readonly string[];
  readonly installError?: ExportError;
}

export interface StandaloneExportOptions {
  readonly workspaceRoot: string;
  readonly tool: string;
  readonly type: string;
  readonly project: string;
  readonly targetDir: string;
  readonly onStage?: (stage: string) => void;
}

export interface BundleExportResult extends StandaloneExportResult {
  readonly kind: 'bundle';
  readonly platform: string;
  readonly runtimes: Readonly<Record<string, string>>;
  readonly entry: string | null;
  readonly sizeBytes: number;
  readonly envIncluded: boolean;
  readonly zipPath?: string;
  readonly zipError?: ExportError;
}

export interface BundleExportOptions {
  readonly workspaceRoot: string;
  readonly tool: string;
  readonly type: string;
  readonly project: string;
  readonly targetDir: string;
  readonly withEnv?: boolean;
  readonly zip?: boolean;
  readonly onStage?: (stage: string) => void;
}

export interface ExportModule {
  readonly BUNDLE_STAGES: readonly string[];
  isStandaloneSupported(tool: string): boolean;
  isBundleSupported(tool: string): boolean;
  isSafeIdent(value: string): boolean;
  exportProjectStandalone(
    opts: StandaloneExportOptions,
  ): Promise<ExportError | LifecycleResult<StandaloneExportResult>>;
  exportProjectBundle(
    opts: BundleExportOptions,
  ): Promise<ExportError | LifecycleResult<BundleExportResult>>;
}

let exportModule: Promise<ExportModule> | null = null;

export function getExportModule(): Promise<ExportModule> {
  if (exportModule) return exportModule;
  const moduleUrl = pathToFileURL(
    path.resolve(WORKSPACE_ROOT, 'scripts', 'export', 'index.ts'),
  ).href;
  exportModule = (import(moduleUrl) as Promise<ExportModule>).catch((err) => {
    exportModule = null;
    throw err;
  });
  return exportModule;
}
