/**
 * Single source of truth for the safe identifier pattern used to validate
 * tool ids (and similar kebab-case names) before any filesystem / git / shell
 * work. Starts with a lowercase letter, then lowercase letters, digits, or
 * hyphens — minimum two characters. Blocks path traversal and injection.
 *
 * Imported by routes (`tools.ts`), services (`tool-plugins.ts`, `credentials.ts`),
 * and tests so the rule never drifts between copies.
 */
export const SAFE_ID = /^[a-z][a-z0-9-]+$/;

/**
 * Safe git ref (branch / tag / SHA) pattern for values that reach a `git`
 * shell command. Allows letters, digits, `.`, `_`, `/`, `-`. Forbids a leading
 * hyphen (blocks `--upload-pack`-style option injection) and any `..` sequence
 * (git refname rule + path-traversal safety). Because the charset excludes every
 * shell metacharacter (space, `;`, `|`, `&`, `$`, backtick, quotes, `<`, `>`,
 * `(`, `)`, `*`, `?`, `~`, newline), a matching value cannot break out of a
 * double-quoted shell argument.
 *
 * Deliberately stricter than the full `git check-ref-format` spec (which permits
 * a few more bytes). If a legitimate ref is ever rejected, move the `git` calls
 * in `tool-plugins.ts` to argv-form `runChild` (no shell) and drop this guard.
 */
export const SAFE_GIT_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/**
 * Validator for a git URL. Accepts:
 *   - https://host/path[.git]
 *   - git@host:path[.git]
 *   - ssh://git@host[:port]/path[.git]
 * Rejects anything containing whitespace, shell metacharacters, or NUL.
 */
export const SAFE_GIT_URL = /^(?:https:\/\/|ssh:\/\/git@|git@)[A-Za-z0-9._:/~@?=+-]+(?:\.git)?$/;
