// scripts/install-core/index.ts
//
// Public entry point for the shared install pipeline. Both consumers depend on
// THIS module:
// - the headless CLI (`scripts/install-tool.ts`) imports it directly;
// - the Hub Post_Install_Hook reaches it by runtime dynamic import
// (`pathToFileURL` + `await import` through the tsx ESM loader registered in
// `hub/server/src/index.ts`) — the SAME mechanism the Hub already uses for
// `scripts/manifests` in `manifest-registry.ts`.
//
// Keeping every export funnelled through here means the Hub mirrors only this
// module's small public surface (as it already does for the manifest module),
// and the per-file paths stay private.

export { createDefaultEffects } from './effects.js';
export {
  buildDepsInstallInvocation,
  buildGitCloneInvocation,
  buildToolSetupInvocation,
  type ChildInvocation,
  type CloneInput,
  DEPS_INSTALL_TIMEOUT_MS,
  type DepsInvocation,
  GIT_CLONE_TIMEOUT_MS,
  type SpawnOptions,
  TOOL_SETUP_TIMEOUT_MS,
  type ToolPackageManager,
  type UnsafeInputKind,
  UnsafeInvocationInput,
} from './invocation.js';
export {
  type InstallEffects,
  type InstallRequest,
  type InstallResult,
  type InstallSource,
  type InstallStage,
  runInstallPipeline,
} from './pipeline.js';
export {
  isSafeGitRef,
  isSafeGitUrl,
  isSafeToolId,
  SAFE_GIT_REF,
  SAFE_GIT_URL,
  SAFE_ID,
} from './validation.js';
