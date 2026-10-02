import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { RuleConfig, LintResult, LintError, WorkerMessage } from './types.ts';

const thisFile = fileURLToPath(import.meta.url);
// worker beside this module, using the same extension (.ts or .js)
const WORKER_PATH = join(dirname(thisFile), `worker${extname(thisFile)}`);

interface PoolWorker {
  worker: Worker;
  ready: Promise<void>;
}

interface LintOutput {
  results: LintResult[];
  errors: LintError[];
  warnings: string[];
}

interface Pool {
  lint(files: string[], ruleConfig: RuleConfig): Promise<LintOutput>;
  terminate(): void;
}

// files a worker should handle before adding another
const FILES_PER_WORKER = 400;

/**
 * Pick a worker count scaled to the file count, capped by maxWorkers; startup
 * costs ~0.1s, so small runs finish sooner with fewer workers.
 * @param fileCount - Number of files to lint.
 * @param maxWorkers - Upper bound on worker count.
 * @returns Number of workers to spawn.
 */
export function chooseWorkerCount(fileCount: number, maxWorkers: number): number {
  if (fileCount <= 0 || maxWorkers <= 0) return 0;
  const adaptive = Math.ceil(fileCount / FILES_PER_WORKER);
  return Math.min(maxWorkers, fileCount, Math.max(1, adaptive));
}

/**
 * Resolve the base cache path; each worker derives its own file from it because
 * flat-cache is unsafe for concurrent writers.
 * @param location - Cache file or directory override.
 * @returns Absolute base cache path.
 */
function resolveCacheBase(location?: string): string {
  const raw = location ?? join(process.cwd(), '.eslintcache');
  return resolve(raw.endsWith('/') || raw.endsWith(sep) ? join(raw, '.eslintcache') : raw);
}

/**
 * Build a per-rule cache key, sanitizing the rule name for the filesystem.
 * @param base - Base cache path.
 * @param rule - ESLint rule name.
 * @returns Cache key for the rule.
 */
function cacheKeyForRule(base: string, rule: string): string {
  return `${base}.${rule.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/**
 * Create a pool that lints file batches across up to `size` workers.
 * @param size - Maximum number of workers.
 * @returns A pool with lint and terminate methods.
 */
export function createPool(size: number): Pool {
  const workers: PoolWorker[] = [];

  return {
    async lint(files, ruleConfig) {
      const actualSize = chooseWorkerCount(files.length, size);
      const cacheBase = ruleConfig.cache ? resolveCacheBase(ruleConfig.cacheLocation) : null;
      const cacheKey = cacheBase === null ? null : cacheKeyForRule(cacheBase, ruleConfig.rule);

      for (let i = 0; i < actualSize; i++) {
        const config = cacheKey === null ? ruleConfig : { ...ruleConfig, cacheLocation: `${cacheKey}.${i}` };
        workers.push(spawnWorker(config));
      }

      if (workers.length === 0) {
        return { results: [], errors: [], warnings: [] };
      }

      await Promise.all(workers.map(w => w.ready));

      const batches = splitIntoBatches(files, workers.length);
      const warnings: string[] = [];

      const promises = batches.map((batch, i) => lintBatch(workers[i].worker, batch, ruleConfig, i, warnings));

      const batchOutputs = await Promise.all(promises);

      const allResults: LintResult[] = [];
      const allErrors: LintError[] = [];
      for (const output of batchOutputs) {
        allResults.push(...output.results);
        allErrors.push(...output.errors);
      }

      return { results: allResults, errors: allErrors, warnings: [...new Set(warnings)] };
    },

    terminate() {
      for (const w of workers) {
        w.worker.terminate();
      }
    },
  };
}

/**
 * Start a worker and resolve once it reports ready.
 * @param ruleConfig - Rule and options the worker should lint with.
 * @returns The worker and a promise that settles when it is ready.
 */
function spawnWorker(ruleConfig: RuleConfig): PoolWorker {
  const worker = new Worker(WORKER_PATH);

  const ready = new Promise<void>((resolve, reject) => {
    const handler = (msg: WorkerMessage) => {
      if (msg.type === 'ready') {
        worker.off('message', handler);
        resolve();
      } else if (msg.type === 'error' && 'batchId' in msg && msg.batchId === -1) {
        worker.off('message', handler);
        reject(new Error(msg.error));
      }
    };
    worker.on('message', handler);
    worker.on('error', reject);
  });

  worker.postMessage({ type: 'init', ruleConfig } satisfies WorkerMessage);

  return { worker, ready };
}

/**
 * Send one batch to a worker and collect its results.
 * @param worker - Worker to send the batch to.
 * @param files - Files in the batch.
 * @param ruleConfig - Rule and options to lint with.
 * @param batchId - Identifier echoed back by the worker.
 * @param warnings - Shared list collecting rule warnings.
 * @returns The batch's results and errors.
 */
function lintBatch(
  worker: Worker,
  files: string[],
  ruleConfig: RuleConfig,
  batchId: number,
  warnings: string[],
): Promise<{ results: LintResult[]; errors: LintError[] }> {
  return new Promise((resolve, reject) => {
    const handler = (msg: WorkerMessage) => {
      if (msg.type === 'rule-warning') {
        warnings.push(msg.message);
        return;
      }

      if (!('batchId' in msg) || msg.batchId !== batchId) return;
      worker.off('message', handler);

      if (msg.type === 'results') {
        resolve({ results: msg.results, errors: msg.errors });
      } else if (msg.type === 'error') {
        reject(new Error(msg.error));
      }
    };

    worker.on('message', handler);
    worker.on('error', reject);
    worker.postMessage({ type: 'lint', files, ruleConfig, batchId } satisfies WorkerMessage);
  });
}

/**
 * Round-robin items into up to `count` non-empty batches.
 * @param items - Items to split.
 * @param count - Maximum number of batches.
 * @returns Non-empty batches.
 */
function splitIntoBatches<T>(items: T[], count: number): T[][] {
  const batches: T[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < items.length; i++) {
    batches[i % count].push(items[i]);
  }
  return batches.filter(b => b.length > 0);
}
