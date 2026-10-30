// scripts/install-core/validation.ts
//
// Canonical trust-boundary validators for the shared install pipeline
// . install-core owns ONE copy of
// `SAFE_ID` / `SAFE_GIT_URL` / `SAFE_GIT_REF`, and BOTH consumers of the
// pipeline use this copy:
// - the headless CLI (`scripts/install-tool.ts`) imports it directly;
// - the Hub does not import install-core; its Post_Install_Hook spawns the
// same `setup` task command (`runToolSetupTask` in
// `hub/server/src/services/tool-plugins.ts` mirrors `buildToolSetupInvocation`).
//
// Why the patterns are RE-STATED here rather than imported from
// `hub/server/src/lib/safe-id.ts`: Biome bans deep `../../*` imports, so `scripts/`
// cannot statically import a `hub/server/src` module, and the Hub server's only
// path alias into `scripts/` is `@manifests/*`, which does not cover install-core.
// There is no single physical file both *static* import graphs can
// share. install-core is therefore the single definition for the install
// pipeline; the patterns are byte-identical to the Hub guards they mirror:
// - SAFE_ID ← hub/server/src/lib/safe-id.ts (SAFE_ID)
// - SAFE_GIT_REF ← hub/server/src/lib/safe-id.ts (SAFE_GIT_REF)
// - SAFE_GIT_URL ← hub/server/src/services/tool-plugins.ts (SAFE_GIT_URL)
// Keep them in lock-step if either side ever changes (verified equal at authoring).

/**
 * Safe tool-id pattern: a lowercase letter, then lowercase letters, digits, or
 * hyphens — minimum two characters. Blocks path traversal and shell injection
 * at every filesystem / git / shell boundary. Identical to the Hub's `SAFE_ID`.
 */
export const SAFE_ID = /^[a-z][a-z0-9-]+$/;

/**
 * Safe git URL pattern. Accepts `https://`, `ssh://git@`, or `git@host:path`
 * forms; the charset excludes every shell metacharacter so a matching value
 * cannot break out of a command argument. Identical to the Hub's `SAFE_GIT_URL`.
 */
export const SAFE_GIT_URL = /^(?:https:\/\/|ssh:\/\/git@|git@)[A-Za-z0-9._:/~@?=+-]+(?:\.git)?$/;

/**
 * Safe git ref (branch / tag / SHA) pattern. Allows letters, digits, `.`, `_`,
 * `/`, `-`; forbids a leading hyphen (blocks `--upload-pack`-style option
 * injection) and any `..` sequence. Identical to the Hub's `SAFE_GIT_REF`.
 */
export const SAFE_GIT_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** Convenience predicate around {@link SAFE_ID}. */
export function isSafeToolId(value: string): boolean {
  return SAFE_ID.test(value);
}

/** Convenience predicate around {@link SAFE_GIT_URL}. */
export function isSafeGitUrl(value: string): boolean {
  return SAFE_GIT_URL.test(value);
}

/** Convenience predicate around {@link SAFE_GIT_REF}. */
export function isSafeGitRef(value: string): boolean {
  return SAFE_GIT_REF.test(value);
}
