import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BUNDLE_STAGES, exportProjectBundle } from './bundle.js';
import { exportProjectStandalone, STANDALONE_STAGES } from './standalone.js';
import { checkTargetPath, isSafeIdent, MAX_TARGET_PATH } from './validate.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const USAGE =
  'usage: cli.ts <bundle|standalone> --tool <id> --type <type> --project <name> --out <abs dir> [--with-env] [--zip]';
const USAGE_CODES: ReadonlySet<string> = new Set([
  'INVALID_IDENT',
  'INVALID_TARGET',
  'TOOL_NOT_SUPPORTED',
  'SOURCE_MISSING',
  'PROJECT_NOT_FOUND',
]);
const IN_WORKSPACE_ALLOWED: readonly string[] = ['.cache', 'outputs'];
const BYTES_PER_MB = 1024 * 1024;

export type CliKind = 'bundle' | 'standalone';

export interface CliArgs {
  readonly kind: CliKind;
  readonly tool: string;
  readonly type: string;
  readonly project: string;
  readonly out: string;
  readonly withEnv: boolean;
  readonly zip: boolean;
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  readonly workspaceRoot: string;
  readonly io: CliIo;
  readonly exportBundle?: typeof exportProjectBundle;
  readonly exportStandalone?: typeof exportProjectStandalone;
}

export function parseCliArgs(argv: readonly string[]): CliArgs | { readonly error: string } {
  let parsed: ParsedCliOptions;
  try {
    parsed = parseCliOptions(argv);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const { values, positionals } = parsed;
  const kind = positionals[0];
  if (positionals.length !== 1 || (kind !== 'bundle' && kind !== 'standalone')) {
    return { error: 'first argument must be "bundle" or "standalone"' };
  }
  const tool = values.tool ?? '';
  const type = values.type ?? '';
  const project = values.project ?? '';
  const out = values.out ?? '';
  const missing = Object.entries({ tool, type, project, out })
    .filter(([, v]) => v.trim() === '')
    .map(([k]) => `--${k}`);
  if (missing.length > 0) return { error: `missing ${missing.join(', ')}` };
  for (const [label, value] of Object.entries({ tool, type, project })) {
    if (!isSafeIdent(value)) return { error: `--${label} '${value}' contains unsafe characters` };
  }
  const targetErr = checkTargetPath(out);
  if (targetErr === 'NOT_ABSOLUTE') return { error: '--out must be an absolute path' };
  if (targetErr === 'TOO_LONG') return { error: `--out must be at most ${MAX_TARGET_PATH} chars` };
  const withEnv = values['with-env'] === true;
  const zip = values.zip === true;
  if (kind === 'standalone' && (withEnv || zip)) {
    return { error: '--with-env and --zip apply to "bundle" only' };
  }
  return { kind, tool, type, project, out, withEnv, zip };
}

interface ParsedCliOptions {
  readonly values: {
    readonly tool?: string;
    readonly type?: string;
    readonly project?: string;
    readonly out?: string;
    readonly 'with-env'?: boolean;
    readonly zip?: boolean;
  };
  readonly positionals: readonly string[];
}

function parseCliOptions(argv: readonly string[]): ParsedCliOptions {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      tool: { type: 'string' },
      type: { type: 'string' },
      project: { type: 'string' },
      out: { type: 'string' },
      'with-env': { type: 'boolean' },
      zip: { type: 'boolean' },
    },
  });
}

export function isUnexpectedWorkspaceTarget(workspaceRoot: string, out: string): boolean {
  const rel = path.relative(path.resolve(workspaceRoot), path.resolve(out));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const first = rel.split(path.sep)[0] ?? '';
  return !IN_WORKSPACE_ALLOWED.includes(first);
}

export function exitCodeForError(code: string): number {
  return USAGE_CODES.has(code) ? EXIT_USAGE : EXIT_FAILED;
}

function stagePrinter(
  io: CliIo,
  kind: CliKind,
  stages: readonly string[],
): (stage: string) => void {
  return (stage) => io.out(`[${kind} ${stages.indexOf(stage) + 1}/${stages.length}] ${stage}`);
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { io, workspaceRoot } = deps;
  const args = parseCliArgs(argv);
  if ('error' in args) {
    io.err(`error: ${args.error}`);
    io.err(USAGE);
    return EXIT_USAGE;
  }
  if (isUnexpectedWorkspaceTarget(workspaceRoot, args.out)) {
    io.err(`warning: ${args.out} is inside the workspace and not under .cache/ or outputs/`);
  }
  const base = {
    workspaceRoot,
    tool: args.tool,
    type: args.type,
    project: args.project,
    targetDir: path.resolve(args.out),
  };
  if (args.kind === 'standalone') {
    const exportStandalone = deps.exportStandalone ?? exportProjectStandalone;
    const res = await exportStandalone({
      ...base,
      onStage: stagePrinter(io, 'standalone', STANDALONE_STAGES),
    });
    if ('code' in res) {
      io.err(`error ${res.code}: ${res.message}`);
      return exitCodeForError(res.code);
    }
    io.out(`standalone written to ${res.result.targetDir} (${res.result.mode})`);
    if (res.result.installError) {
      io.err(`warning ${res.result.installError.code}: ${res.result.installError.message}`);
    }
    return EXIT_OK;
  }
  const exportBundle = deps.exportBundle ?? exportProjectBundle;
  const res = await exportBundle({
    ...base,
    withEnv: args.withEnv,
    zip: args.zip,
    onStage: stagePrinter(io, 'bundle', BUNDLE_STAGES),
    log: (line) => io.out(`  ${line}`),
  });
  if ('code' in res) {
    io.err(`error ${res.code}: ${res.message}`);
    return exitCodeForError(res.code);
  }
  const r = res.result;
  const runtimes = Object.entries(r.runtimes)
    .map(([id, v]) => `${id} ${v}`)
    .join(', ');
  io.out(
    `bundle written to ${r.targetDir} (${r.mode}, ${(r.sizeBytes / BYTES_PER_MB).toFixed(1)} MB)`,
  );
  io.out(`runtimes: ${runtimes || 'none'}; .env included: ${r.envIncluded ? 'yes' : 'no'}`);
  if (r.zipPath) io.out(`zip: ${r.zipPath}`);
  if (r.zipError) io.err(`warning ${r.zipError.code}: ${r.zipError.message}`);
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspaceRoot = path.resolve(import.meta.dirname, '..', '..');
  const io: CliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  runCli(process.argv.slice(2), { workspaceRoot, io }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(EXIT_FAILED);
    },
  );
}
