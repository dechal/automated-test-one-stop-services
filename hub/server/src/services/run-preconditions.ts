import path from 'node:path';
import { missingChecksForTool, type RunRequest } from '@hub/shared';
import { TOOLS_DIR } from '../config.js';
import { cachedDoctorReport, runDoctor } from './doctor.js';
import { getToolManifest } from './manifest-registry.js';
import { readMissingEnvKeys } from './scanner.js';

export type RunBlockerCode =
  | 'TOOL_NOT_AVAILABLE'
  | 'REQUIREMENTS_UNVERIFIED'
  | 'MISSING_REQUIREMENT';

export interface RunBlocker {
  readonly code: RunBlockerCode;
  readonly message: string;
  readonly check?: string;
}

export interface RunPreconditions {
  readonly blockers: readonly RunBlocker[];
  readonly warnings: readonly string[];
}

function projectDirFor(tool: string, root: string, effectiveType: string, project: string): string {
  return path.join(TOOLS_DIR, tool, root, effectiveType, project);
}

export interface RunPreconditionOptions {
  readonly allowDoctorSweep?: boolean;
}

export async function checkRunPreconditions(
  req: RunRequest,
  options: RunPreconditionOptions = {},
): Promise<RunPreconditions> {
  const manifest = await getToolManifest(req.tool);
  if (!manifest) {
    return {
      blockers: [
        {
          code: 'TOOL_NOT_AVAILABLE',
          message: `Tool "${req.tool}" is not installed or is disabled.`,
        },
      ],
      warnings: [],
    };
  }

  const blockers: RunBlocker[] = [];
  const allowSweep = options.allowDoctorSweep !== false;

  if (allowSweep) {
    try {
      const report = await runDoctor();
      for (const check of missingChecksForTool(manifest, report.checks)) {
        blockers.push({
          code: 'MISSING_REQUIREMENT',
          check,
          message: `"${check}" is missing or failing — install it from the Doctor page before running ${req.tool}.`,
        });
      }
    } catch (err) {
      blockers.push({
        code: 'REQUIREMENTS_UNVERIFIED',
        message: `Environment checks could not be run, so ${req.tool}'s requirements are unverified: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  } else {
    const report = cachedDoctorReport();
    for (const check of report ? missingChecksForTool(manifest, report.checks) : []) {
      blockers.push({
        code: 'MISSING_REQUIREMENT',
        check,
        message: `"${check}" is missing or failing — install it from the Doctor page before running ${req.tool}.`,
      });
    }
  }

  const { typeAxis, fixedType, root } = manifest.projects;
  const effectiveType = typeAxis ? req.type : (fixedType ?? '');
  const { hasTemplate, missing } = readMissingEnvKeys(
    projectDirFor(req.tool, root, effectiveType, req.project),
  );
  const warnings =
    hasTemplate && missing.length > 0
      ? [`${missing.length} key(s) in .env.template are unset in .env: ${missing.join(', ')}`]
      : [];

  return { blockers, warnings };
}
