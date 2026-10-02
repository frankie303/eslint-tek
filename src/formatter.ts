import { relative } from 'node:path';
import type { LintResult, LintError } from './types.ts';

/**
 * Render a count with a singular or plural word.
 * @param n - Count.
 * @param word - Singular noun.
 * @returns The count followed by the correctly pluralized word.
 */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Render results as one "file:line:column  message" line each, dropping warnings
 * when quiet.
 * @param results - Lint results to format.
 * @param quiet - When true, suppress warnings.
 * @returns Newline-joined output.
 */
export function formatText(results: LintResult[], quiet = false): string {
  const lines: string[] = [];
  const cwd = process.cwd();

  for (const result of results) {
    for (const msg of result.messages) {
      if (quiet && msg.severity !== 2) continue;
      const rel = relative(cwd, result.filePath);
      const location = msg.line == null ? rel : `${rel}:${msg.line}:${msg.column}`;
      lines.push(`${location}  ${msg.message}`);
    }
  }

  return lines.join('\n');
}

/**
 * Serialize results and errors as pretty-printed JSON.
 * @param results - Lint results to include.
 * @param errors - Per-file lint errors to include.
 * @returns Pretty-printed JSON.
 */
export function formatJson(results: LintResult[], errors: LintError[] = []): string {
  return JSON.stringify({ results, errors }, null, 2);
}

/**
 * Render lint failures, capped at max with an overflow note.
 * @param errors - Per-file lint errors.
 * @param max - Maximum errors to show before summarizing the rest.
 * @returns Newline-joined output, or an empty string when there are no errors.
 */
export function formatErrors(errors: LintError[], max = 10): string {
  if (errors.length === 0) return '';

  const cwd = process.cwd();
  const lines = [`${plural(errors.length, 'file')} failed to lint:`];

  for (const err of errors.slice(0, max)) {
    const rel = relative(cwd, err.filePath);
    lines.push(`  ${rel}: ${err.error}`);
  }

  if (errors.length > max) {
    lines.push(`  ... and ${errors.length - max} more`);
  }

  return lines.join('\n');
}

/**
 * Render the closing summary with issue, file, and timing counts.
 * @param results - Lint results to summarize.
 * @param totalFiles - Total number of files scanned.
 * @param elapsedSec - Elapsed time in seconds.
 * @param workerCount - Number of workers used.
 * @param failedCount - Number of files that failed to lint.
 * @returns Summary text.
 */
export function formatSummary(
  results: LintResult[],
  totalFiles: number,
  elapsedSec: string,
  workerCount: number,
  failedCount = 0,
): string {
  const filesWithIssues = results.length;
  const totalIssues = results.reduce((sum, r) => sum + r.messages.length, 0);
  const fixable = results.reduce((sum, r) => sum + r.fixableCount, 0);
  const scanned = `Scanned ${plural(totalFiles, 'file')} in ${elapsedSec}s (${plural(workerCount, 'worker')})`;

  if (totalIssues === 0) {
    return failedCount > 0
      ? `\n  ${plural(failedCount, 'file')} failed to lint\n  ${scanned}`
      : `\n  No issues found. ${scanned}`;
  }

  const failed = failedCount > 0 ? `\n  ${plural(failedCount, 'file')} failed to lint` : '';
  return `\n  ${plural(filesWithIssues, 'file')} | ${plural(totalIssues, 'issue')} | ${fixable} fixable${failed}\n  ${scanned}`;
}
