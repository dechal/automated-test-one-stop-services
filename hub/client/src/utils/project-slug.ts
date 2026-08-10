/**
 * Project names are folder names — they become `tools/<tool>/<type>/<name>` on
 * disk and are passed to shell recipes — so they are constrained to kebab-case
 * ASCII rather than validated after the fact. Sanitising as the user types means
 * the field can never hold a name the filesystem or the runner would reject, and
 * there is no error state to explain.
 */

/**
 * Coerce arbitrary input into kebab-case: lowercase ASCII letters, digits and
 * `-` only.
 *
 * Whitespace and `_` become the separator; anything else (symbols, accented or
 * non-Latin characters) is dropped. Runs of separators collapse, and a leading
 * separator is removed.
 *
 * A TRAILING `-` is deliberately kept: it is a legal intermediate state while
 * typing `my-project`, and stripping it live would fight the keystroke. Trim it
 * at submit time with {@link finalizeProjectSlug}.
 */
export function toProjectSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '');
}

/** The value actually submitted: a slug with no dangling separator. */
export function finalizeProjectSlug(input: string): string {
  return toProjectSlug(input).replace(/-+$/, '');
}
