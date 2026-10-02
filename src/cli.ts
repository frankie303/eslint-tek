import { Command } from 'commander';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { discoverFiles, getChangedFiles } from './discovery.ts';
import { createPool } from './pool.ts';
import { formatText, formatJson, formatErrors, formatSummary, plural } from './formatter.ts';
import type { RuleConfig } from './types.ts';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

/**
 * Parse argv and run the CLI, returning the exit code.
 * @param argv - Process arguments, excluding the node and script entries.
 * @returns Process exit code.
 */
export async function run(argv: string[]): Promise<number> {
  const program = new Command();
  let result: number | undefined;

  program
    .name('eslint-tek')
    .description('Run a single ESLint rule across your codebase. Fast.')
    .version(version)
    .argument('<rule>', "ESLint rule name: 'no-console' or 'plugin/rule'")
    .argument('[paths...]', 'Directories or files to lint', ['.'])
    .option('--fix', 'Apply autofixes for the target rule')
    .option(
      '--fix-type <types>',
      'Restrict fix types (comma-separated): problem, suggestion, layout',
      (value: string, previous: string[]) =>
        previous.concat(
          value
            .split(',')
            .map(s => s.trim())
            .filter(Boolean),
        ),
      [] as string[],
    )
    .option('--diff [base]', 'Only lint git-changed files vs base (default: HEAD)')
    .option('--workers <n>', 'Max worker thread count', String(Math.max(1, availableParallelism() >> 1)))
    .option('--format <fmt>', 'Output format: text, json', 'text')
    .option('--ext <extensions>', 'File extensions (comma-separated)', 'js,jsx,ts,tsx,mjs,mts,cjs,cts')
    .option('--config <path>', 'ESLint config file override')
    .option('--cache', 'Reuse ESLint cache for faster repeat runs')
    .option('--cache-location <path>', 'Cache file or directory (default: .eslintcache)')
    .option('--quiet', 'Only show errors, suppress warnings')
    .action(async (rule: string, paths: string[], opts) => {
      result = await execute(rule, paths, opts);
    });

  await program.parseAsync(['node', 'eslint-tek', ...argv]);

  return result ?? 0;
}

interface CliOptions {
  fix?: boolean;
  fixType?: string[];
  diff?: string | boolean;
  workers: string;
  format: string;
  ext: string;
  config?: string;
  cache?: boolean;
  cacheLocation?: string;
  quiet?: boolean;
}

/**
 * Write a line to stderr unless quiet.
 * @param quiet - When true, suppress output.
 * @param msg - Line to write.
 */
function log(quiet: boolean | undefined, msg: string) {
  if (!quiet) process.stderr.write(msg + '\n');
}

/**
 * Discover files, lint them, print output, and return an exit code.
 * @param rule - ESLint rule name to lint.
 * @param paths - Directories or files to lint.
 * @param opts - Parsed CLI options.
 * @returns Process exit code.
 */
async function execute(rule: string, paths: string[], opts: CliOptions): Promise<number> {
  const startTime = performance.now();
  const resolvedPaths = paths.map(p => resolve(p));
  const extensions = opts.ext.split(',').map(e => e.trim());
  const workerCount = parseInt(opts.workers, 10);

  let files: string[];

  if (opts.diff !== undefined) {
    const base = typeof opts.diff === 'string' ? opts.diff : 'HEAD';
    files = getChangedFiles(resolvedPaths, base, extensions);
  } else {
    files = await discoverFiles(resolvedPaths, extensions);
  }

  if (files.length === 0) {
    console.log('No files found.');
    return 0;
  }

  log(opts.quiet, `Scanning... ${plural(files.length, 'file')} found`);
  log(opts.quiet, `Linting with ${plural(workerCount, 'worker')}...`);

  const ruleConfig: RuleConfig = {
    rule,
    fix: opts.fix ?? false,
    fixTypes: opts.fixType ?? [],
    configPath: opts.config,
    cache: opts.cache ?? false,
    cacheLocation: opts.cacheLocation,
  };

  const pool = createPool(workerCount);

  let output;
  try {
    output = await pool.lint(files, ruleConfig);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  } finally {
    pool.terminate();
  }

  const { results, errors, warnings } = output;
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

  for (const warning of warnings) {
    log(opts.quiet, warning);
  }

  if (opts.format === 'json') {
    console.log(formatJson(results, errors));
  } else {
    const textOutput = formatText(results, opts.quiet);
    if (textOutput) {
      console.log(textOutput);
    }

    const errorOutput = formatErrors(errors);
    if (errorOutput) {
      console.error(errorOutput);
    }

    console.log(formatSummary(results, files.length, elapsed, workerCount, errors.length));
  }

  const hasErrors = results.some(r => r.messages.some(m => m.severity === 2));
  return hasErrors || errors.length > 0 ? 1 : 0;
}
