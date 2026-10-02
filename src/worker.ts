import { parentPort } from 'node:worker_threads';
import { ESLint } from 'eslint';
import type { RuleConfig, WorkerMessage, LintResult, LintError } from './types.ts';

let eslintInstance: ESLint | null = null;
let ruleChecked = false;

/**
 * Detect failures that affect every file (bad rule name, broken config) rather
 * than one file.
 * @param message - ESLint error message.
 * @returns True when the error is systemic.
 */
function isSystemicError(message: string): boolean {
  return (
    // e.g. Key "rules": Key "bogus-rule": Could not find "bogus-rule" in plugin "@".
    /Could not find ".*" in plugin/i.test(message) ||
    /Definition for rule .* was not found/i.test(message) ||
    /couldn't find a configuration file/i.test(message) ||
    /No ESLint configuration/i.test(message)
  );
}

/**
 * Detect files whose config never wires up the rule's plugin, so they can be skipped.
 * @param message - ESLint error message.
 * @returns True when the rule is not applicable to the file.
 */
function isRuleNotApplicableError(message: string): boolean {
  return /Could not find plugin ".*" in configuration/i.test(message);
}

/**
 * Format a user-facing warning for an unresolvable rule.
 * @param rule - ESLint rule name.
 * @param message - Original error message.
 * @returns Warning text for the user.
 */
function ruleWarning(rule: string, message: string): string {
  if (/Key "rules"|Could not find .* in plugin|Definition for rule/i.test(message)) {
    return `Warning: rule '${rule}' could not be resolved. Check the spelling and that its plugin is installed.`;
  }
  return `Warning: ${message}`;
}

/**
 * Build an ESLint instance scoped to the target rule.
 * @param config - Rule and options to lint with.
 * @returns A configured ESLint instance.
 */
function createESLint(config: RuleConfig): ESLint {
  const opts: ESLint.Options = {
    // Run only the requested rule. We do NOT force-enable it or override its
    // severity: tek reports exactly what the user's config says. If the rule
    // isn't enabled, the worker warns (see ruleDisabledWarning) instead of
    // silently doing nothing.
    ruleFilter: ({ ruleId }) => ruleId === config.rule,
    fix: config.fix,
  };

  if (config.fixTypes.length > 0) {
    opts.fixTypes = config.fixTypes as ESLint.Options['fixTypes'];
  }

  if (config.configPath) {
    opts.overrideConfigFile = config.configPath;
  }

  if (config.cache) {
    opts.cache = true;
    if (config.cacheLocation) {
      opts.cacheLocation = config.cacheLocation;
    }
  }

  return new ESLint(opts);
}

/**
 * Read a rule entry's severity, or null when it is off or unset.
 * @param entry - Raw value from an ESLint config's rules map.
 * @returns 1 for warn, 2 for error, or null when off or unset.
 */
function severityOf(entry: unknown): number | null {
  if (entry == null) return null;
  const value = Array.isArray(entry) ? entry[0] : entry;
  if (value === 'off' || value === 0 || value === false) return null;
  if (value === 'warn' || value === 1) return 1;
  if (value === 'error' || value === 2) return 2;
  return null;
}

/**
 * Sample a spread of files rather than just the first, since config can vary per path.
 * @param files - Files to sample from.
 * @param max - Maximum number of files to return.
 * @returns A spread-out sample of files.
 */
function sampleFiles(files: string[], max: number): string[] {
  if (files.length <= max) return files;
  const step = Math.floor(files.length / max);
  const out: string[] = [];
  for (let i = 0; i < files.length && out.length < max; i += step) {
    out.push(files[i]);
  }
  return out;
}

/**
 * Warn when the rule is not enabled anywhere instead of reporting an empty result.
 * @param eslint - ESLint instance to query.
 * @param rule - ESLint rule name.
 * @param files - Files whose configs are sampled.
 * @returns Warning text, or null when the rule is enabled somewhere.
 */
async function ruleDisabledWarning(eslint: ESLint, rule: string, files: string[]): Promise<string | null> {
  for (const file of sampleFiles(files, 20)) {
    try {
      const config = await eslint.calculateConfigForFile(file);
      const entry = (config as { rules?: Record<string, unknown> }).rules?.[rule];
      if (severityOf(entry) !== null) return null;
    } catch {
      // Config couldn't be resolved here; let linting surface the real error.
      return null;
    }
  }

  return (
    `Warning: rule '${rule}' is not enabled in your ESLint config, so nothing was linted. ` +
    `tek runs rules at the severity you configure — enable it (e.g. rules: { '${rule}': 'warn' }) ` +
    `or check the rule name.`
  );
}

/**
 * Keep the target rule plus fatal messages, dropping unrelated rule noise.
 * @param raw - Raw ESLint results.
 * @param rule - ESLint rule name to keep.
 * @returns Filtered lint results.
 */
function mapResults(raw: ESLint.LintResult[], rule: string): LintResult[] {
  return raw
    .map(r => ({
      filePath: r.filePath,
      // Keep the target rule plus genuine fatal errors (parse errors). Drop
      // everything else ESLint emits, e.g. "Definition for rule 'x' was not
      // found" from unrelated disable comments, which would otherwise be
      // reported (and fail the run) for a rule we never asked about.
      messages: r.messages
        .filter(m => m.ruleId === rule || m.fatal === true)
        .map(m => ({
          ruleId: m.ruleId,
          message: m.message,
          severity: m.severity as 1 | 2,
          line: m.line,
          column: m.column,
          fatal: m.fatal,
        })),
      fixableCount: r.fixableErrorCount + r.fixableWarningCount,
    }))
    .filter(r => r.messages.length > 0);
}

/**
 * Lint a batch, falling back to per-file retries to isolate broken files.
 * @param eslint - ESLint instance to lint with.
 * @param files - Files to lint.
 * @param fix - Whether to write autofixes.
 * @param rule - ESLint rule name to keep.
 * @returns Results, per-file errors, and an optional warning.
 */
async function lintBatchWithRetry(
  eslint: ESLint,
  files: string[],
  fix: boolean,
  rule: string,
): Promise<{ results: LintResult[]; errors: LintError[]; warning?: string }> {
  try {
    const raw = await eslint.lintFiles(files);
    if (fix) await ESLint.outputFixes(raw);
    return { results: mapResults(raw, rule), errors: [] };
  } catch (err) {
    const message = (err as Error).message;

    // Retrying a systemic failure file-by-file would hammer ESLint with N
    // invocations and emit N identical errors. Report once instead.
    if (isSystemicError(message)) {
      return {
        results: [],
        errors: files.map(file => ({ filePath: file, error: message })),
        warning: ruleWarning(rule, message),
      };
    }

    // Likely one bad file -- retry individually to isolate the broken file(s).
    const results: LintResult[] = [];
    const errors: LintError[] = [];
    let skipped = 0;

    for (const file of files) {
      try {
        const raw = await eslint.lintFiles([file]);
        if (fix) await ESLint.outputFixes(raw);
        results.push(...mapResults(raw, rule));
      } catch (e) {
        const fileMessage = (e as Error).message;
        if (isRuleNotApplicableError(fileMessage)) {
          skipped++;
          continue;
        }
        errors.push({ filePath: file, error: fileMessage });
      }
    }

    return {
      results,
      errors,
      ...(skipped > 0 ? { warning: `Warning: rule '${rule}' is not configured for ${skipped} file(s); skipped.` } : {}),
    };
  }
}

parentPort!.on('message', async (msg: WorkerMessage) => {
  if (msg.type === 'init') {
    try {
      eslintInstance = createESLint(msg.ruleConfig);
      parentPort!.postMessage({ type: 'ready' } satisfies WorkerMessage);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('Could not find config file') || message.includes('eslint.config')) {
        parentPort!.postMessage({
          type: 'error',
          error: 'No ESLint config found. Create eslint.config.mjs in your project root, or use --config.',
          batchId: -1,
        } satisfies WorkerMessage);
      } else {
        parentPort!.postMessage({
          type: 'error',
          error: message,
          batchId: -1,
        } satisfies WorkerMessage);
      }
    }
    return;
  }

  if (msg.type === 'lint') {
    try {
      if (!ruleChecked) {
        ruleChecked = true;
        const disabled = await ruleDisabledWarning(eslintInstance!, msg.ruleConfig.rule, msg.files);
        if (disabled) {
          parentPort!.postMessage({ type: 'rule-warning', message: disabled } satisfies WorkerMessage);
        }
      }

      const { results, errors, warning } = await lintBatchWithRetry(
        eslintInstance!,
        msg.files,
        msg.ruleConfig?.fix ?? false,
        msg.ruleConfig.rule,
      );

      if (warning) {
        parentPort!.postMessage({ type: 'rule-warning', message: warning } satisfies WorkerMessage);
      }

      parentPort!.postMessage({
        type: 'results',
        results,
        errors,
        batchId: msg.batchId,
      } satisfies WorkerMessage);
    } catch (err) {
      parentPort!.postMessage({
        type: 'error',
        error: (err as Error).message,
        batchId: msg.batchId,
      } satisfies WorkerMessage);
    }
  }
});
