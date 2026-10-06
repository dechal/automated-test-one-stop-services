import type { EnvProfile } from '@hub/shared';

/**
 * Pure env-profile option helpers, split out of `EnvProfiles.tsx` so the run /
 * schedule forms and the EnvProfiles page share one source of truth and one
 * unit-testable surface.
 */

/** The synthetic option that means "run with the project's .env on disk". */
export const ENV_CURRENT = '__current__';

/**
 * Environment presets for the create/edit form's environment Select. Moved
 * VERBATIM from `EnvProfiles.tsx` — `custom` falls through to the gray badge
 * colour and must stay in the list.
 */
export const ENV_OPTIONS = [
  { value: 'dev', label: 'Dev' },
  { value: 'staging', label: 'Staging' },
  { value: 'prod', label: 'Prod' },
  { value: 'custom', label: 'Custom' },
];

/** Badge colour per environment. Moved VERBATIM from `EnvProfiles.tsx`. */
export function envColor(env: string): string {
  switch (env) {
    case 'dev':
      return 'blue';
    case 'staging':
      return 'yellow';
    case 'prod':
      return 'red';
    default:
      return 'gray';
  }
}

export interface EnvSelectOption {
  value: string;
  label: string;
}

/**
 * Build the env Select data: the `__current__` sentinel first (labelled by the
 * caller's i18n string), then one option per profile. Keeping the sentinel head
 * means a user who never set a profile sees exactly the Hub's old behaviour.
 */
export function buildEnvOptions(
  profiles: EnvProfile[] | undefined,
  currentLabel: string,
): EnvSelectOption[] {
  return [
    { value: ENV_CURRENT, label: currentLabel },
    ...(profiles ?? []).map((p) => ({ value: p.id, label: p.name })),
  ];
}

/**
 * Resolve the value the Select should pre-select: the default profile when it
 * still exists in the list, else the `__current__` sentinel.
 */
export function resolveDefaultEnv(
  defaultId: string | null | undefined,
  profiles: EnvProfile[] | undefined,
): string {
  if (defaultId && (profiles ?? []).some((p) => p.id === defaultId)) {
    return defaultId;
  }
  return ENV_CURRENT;
}
