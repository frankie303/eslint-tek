import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { run } from '../src/cli.ts';
import { discoverFiles, getChangedFiles } from '../src/discovery.ts';
import { formatText } from '../src/formatter.ts';
import { chooseWorkerCount } from '../src/pool.ts';

function captureConsole(fn: () => Promise<number>): Promise<{ output: string; error: string; exitCode: number }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origWrite = process.stderr.write;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errs.push(chunk.toString());
    return true;
  }) as unknown as typeof process.stderr.write;

  return fn()
    .then(exitCode => ({ output: logs.join('\n'), error: errs.join(''), exitCode }))
    .finally(() => {
      console.log = origLog;
      process.stderr.write = origWrite;
    });
}

describe('eslint-tek CLI', () => {
  it('finds no-debugger violations only in the right file', async () => {
    const { output, exitCode } = await captureConsole(() => run(['no-debugger', 'tests/fixtures', '--workers', '1']));

    assert.ok(output.includes('has-debugger.js'), 'should report has-debugger.js');
    assert.ok(!output.includes('has-console.js'), 'no-debugger should not flag console');
    assert.equal(exitCode, 1);
  });

  it('exits 0 when no violations found', async () => {
    const { exitCode } = await captureConsole(() => run(['no-debugger', 'tests/fixtures/clean.js', '--workers', '1']));

    assert.equal(exitCode, 0);
  });

  it('outputs valid JSON with --format json', async () => {
    const { output } = await captureConsole(() =>
      run(['no-console', 'tests/fixtures', '--workers', '1', '--format', 'json']),
    );

    const parsed = JSON.parse(output);
    assert.ok(parsed.results, 'should have results key');
    assert.ok(Array.isArray(parsed.results), 'results should be an array');
    assert.ok(parsed.results.length > 0, 'should have results');
    assert.ok(parsed.results[0].filePath, 'result should have filePath');
    assert.ok(parsed.results[0].messages.length > 0, 'result should have messages');
  });

  it('finds no-console violations across multiple workers', async () => {
    const { output, exitCode } = await captureConsole(() => run(['no-console', 'tests/fixtures', '--workers', '4']));

    assert.ok(output.includes('has-console.js'), 'should report has-console.js');
    assert.ok(!output.includes('clean.js'), 'should not report clean.js');
    assert.ok(!output.includes('has-debugger.js'), 'no-console should not flag debugger');
    assert.equal(exitCode, 1, 'should exit 1 when errors found');
  });

  it('does not let --fix-type swallow positional paths', async () => {
    const { output } = await captureConsole(() =>
      run(['no-console', '--fix-type', 'suggestion', 'tests/fixtures', '--workers', '1']),
    );

    assert.ok(output.includes('has-console.js'), 'should still lint the given path');
    assert.ok(output.includes('Scanned 3 files'), 'should only scan tests/fixtures');
  });

  it('warns when the requested rule is not enabled in the config', async () => {
    const { output, error, exitCode } = await captureConsole(() =>
      run([
        'no-console',
        'tests/plugin-rule',
        '--config',
        resolve('tests/plugin-rule/eslint.config.mjs'),
        '--workers',
        '1',
      ]),
    );

    assert.ok(error.includes('not enabled'), 'should hint that the rule is not in the config');
    assert.equal(exitCode, 0, 'nothing to report, so exit 0');
    assert.ok(!output.includes('object-spread.js'), 'should not report violations');
  });

  it('short-circuits on a systemic config error (bad rule name)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-systemic-'));
    const config = join(dir, 'eslint.config.mjs');

    try {
      // A config that references a rule which doesn't exist makes ESLint throw
      // "Key "rules": ... Could not find "..." in plugin "@"." for every file.
      await writeFile(config, "export default [{ files: ['**/*.js'], rules: { 'totally-bogus-rule': 'error' } }];\n");
      await writeFile(join(dir, 'a.js'), 'const a = 1;\n');

      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const { output, error, exitCode } = await captureConsole(() =>
          run(['totally-bogus-rule', '.', '--config', config, '--workers', '4', '--format', 'json']),
        );

        const parsed = JSON.parse(output) as { results: unknown[]; errors: unknown[] };
        assert.equal(parsed.results.length, 0, 'no results for a systemic failure');
        assert.ok(parsed.errors.length > 0, 'files are reported as failed');
        assert.ok(error.includes('could not be resolved'), 'emits a friendly warning once');
        assert.equal(exitCode, 1);
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hints when no ESLint config is found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-noconfig-'));
    try {
      await writeFile(join(dir, 'a.js'), 'const a = 1;\n');

      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const { error, exitCode } = await captureConsole(() => run(['no-console', '.', '--workers', '1']));
        assert.ok(error.includes('no ESLint config'), 'friendly no-config hint');
        assert.equal(exitCode, 1);
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('honours the severity configured by the user (warn stays warn)', async () => {
    const config = resolve('tests/severity/eslint.config.mjs');
    const { output, exitCode } = await captureConsole(() =>
      run(['no-console', 'tests/severity', '--config', config, '--workers', '1', '--format', 'json']),
    );

    const parsed = JSON.parse(output) as {
      results: Array<{ messages: Array<{ ruleId: string | null; severity: number }> }>;
    };
    const messages = parsed.results.flatMap(r => r.messages).filter(m => m.ruleId === 'no-console');

    assert.ok(messages.length > 0, 'should report the violation');
    assert.ok(
      messages.every(m => m.severity === 1),
      'warn severity should be preserved',
    );
    assert.equal(exitCode, 0, 'warnings-only run exits 0');
  });

  it('--diff: all paths, drops deletions, includes untracked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-diff-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');
      await mkdir(join(dir, 'a'), { recursive: true });
      await mkdir(join(dir, 'b'), { recursive: true });
      await mkdir(join(dir, 'c'), { recursive: true });
      await writeFile(join(dir, 'a', 'one.js'), 'const a = 1;\n');
      await writeFile(join(dir, 'b', 'two.js'), 'const b = 2;\n');
      git('add', '.');
      git('commit', '-qm', 'init');

      await writeFile(join(dir, 'b', 'two.js'), 'console.log(2);\n'); // modified
      await rm(join(dir, 'a', 'one.js')); // deleted
      await writeFile(join(dir, 'c', 'three.js'), 'console.log(3);\n'); // untracked

      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const base = process.cwd();
        const changed = getChangedFiles([resolve(base, 'a'), resolve(base, 'b'), resolve(base, 'c')], 'HEAD', ['js']);
        const names = changed.map(f => f.split('/').pop());

        assert.ok(names.includes('two.js'), 'changed file under the second path is included');
        assert.ok(names.includes('three.js'), 'untracked file is included');
        assert.ok(!names.includes('one.js'), 'deleted file is excluded');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('discovery respects .gitignore, keeps dotfiles, and de-duplicates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-ign-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
      await writeFile(join(dir, '.gitignore'), 'ignored.js\n');
      await writeFile(join(dir, 'ignored.js'), 'console.log(1);\n');
      await writeFile(join(dir, '.hidden.js'), 'console.log(1);\n');
      await writeFile(join(dir, 'kept.js'), 'console.log(1);\n');

      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const files = await discoverFiles(['.'], ['js']);
        const names = files.map(f => f.split('/').pop());

        assert.ok(names.includes('kept.js'), 'non-ignored file found');
        assert.ok(names.includes('.hidden.js'), 'dotfile found');
        assert.ok(!names.includes('ignored.js'), 'gitignored file excluded');

        const withExplicit = await discoverFiles([dir, join(dir, 'kept.js')], ['js']);
        assert.equal(withExplicit.length, new Set(withExplicit).size, 'no duplicates');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not print "undefined" for messages without a location', () => {
    const out = formatText([
      {
        filePath: join(process.cwd(), 'ignored.js'),
        messages: [{ ruleId: null, message: 'File ignored', severity: 1 as const }],
        fixableCount: 0,
      },
    ]);

    assert.ok(out.includes('File ignored'));
    assert.ok(!out.includes('undefined'));
  });

  it('reports only the target rule, ignoring unrelated diagnostics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-filter-'));
    const config = join(dir, 'eslint.config.mjs');

    try {
      await writeFile(config, "export default [{ rules: { 'no-console': 'error' } }];\n");
      // A disable comment for an undefined rule makes ESLint emit a
      // "Definition for rule ... was not found" error. With no console usage
      // in the file, running `no-console` must still be clean.
      await writeFile(join(dir, 'unknown-disable.js'), '/* eslint-disable not-a-real-rule */\nconst a = 1;\n');

      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const { output, exitCode } = await captureConsole(() =>
          run(['no-console', '.', '--config', config, '--workers', '1']),
        );

        assert.ok(!output.includes('Definition for rule'), 'unrelated diagnostics are dropped');
        assert.equal(exitCode, 0, 'clean run should exit 0');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still reports fatal parse errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-fatal-'));
    const config = join(dir, 'eslint.config.mjs');

    try {
      await writeFile(config, "export default [{ rules: { 'no-console': 'error' } }];\n");
      await writeFile(join(dir, 'broken.js'), 'function ( {\n');

      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const { output, exitCode } = await captureConsole(() =>
          run(['no-console', '.', '--config', config, '--workers', '1']),
        );

        assert.ok(output.includes('Parsing error'), 'parse errors still surface');
        assert.equal(exitCode, 1, 'fatal errors exit non-zero');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matches ESLint for a third-party plugin rule (eslint-plugin-reduce)', async () => {
    const dir = resolve('tests/plugin-rule');
    const config = join(dir, 'eslint.config.mjs');

    const { output } = await captureConsole(() =>
      run([
        'reduce/no-spread-in-reduce',
        'tests/plugin-rule',
        '--config',
        config,
        '--workers',
        '1',
        '--format',
        'json',
      ]),
    );

    const parsed = JSON.parse(output) as {
      results: Array<{
        filePath: string;
        messages: Array<{ ruleId: string | null; line?: number; column?: number }>;
      }>;
      errors: Array<{ filePath: string; error: string }>;
    };
    const tekResults = parsed.results;
    const tekSet = new Set(
      tekResults.flatMap(r => r.messages.map(m => `${r.filePath.split('/').pop()}:${m.line}:${m.column}`)),
    );

    const eslint = new ESLint({ overrideConfigFile: config });
    const raw = await eslint.lintFiles([dir]);
    const refSet = new Set(
      raw.flatMap(r =>
        r.messages
          .filter(m => m.ruleId === 'reduce/no-spread-in-reduce')
          .map(m => `${r.filePath.split('/').pop()}:${m.line}:${m.column}`),
      ),
    );

    assert.ok(refSet.size > 0, 'fixtures should produce at least one hit');
    assert.deepEqual([...tekSet].sort(), [...refSet].sort(), 'tek should match ESLint');
    assert.ok(!tekResults.some(r => r.filePath.endsWith('clean.js')), 'clean fixture not reported');
    assert.equal(parsed.errors.length, 0, "files outside the plugin's scope are skipped, not reported as errors");
  });

  it('skips files whose config never registers the rule plugin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-scope-'));
    const config = join(dir, 'eslint.config.mjs');

    try {
      // The plugin is registered only for covered.js, but the rule is enabled
      // for every file. Linting skipped.js throws `Could not find plugin "x" in
      // configuration`; tek must skip it rather than report it as an error.
      await writeFile(
        config,
        [
          'const x = {',
          '  rules: {',
          '    r: {',
          '      meta: { schema: [] },',
          '      create(context) {',
          '        return {',
          '          Identifier(node) {',
          "            if (node.name === 'boom') context.report({ node, message: 'boom' });",
          '          },',
          '        };',
          '      },',
          '    },',
          '  },',
          '};',
          'export default [',
          "  { files: ['covered.js'], plugins: { x } },",
          "  { files: ['**/*.js'], rules: { 'x/r': 'error' } },",
          '];',
          '',
        ].join('\n'),
      );
      await writeFile(join(dir, 'covered.js'), 'boom;\n');
      await writeFile(join(dir, 'skipped.js'), 'boom;\n');

      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const { output, error, exitCode } = await captureConsole(() =>
          run(['x/r', 'covered.js', 'skipped.js', '--config', config, '--workers', '1', '--format', 'json']),
        );

        const parsed = JSON.parse(output) as {
          results: Array<{ filePath: string; messages: Array<{ ruleId: string | null }> }>;
          errors: Array<{ filePath: string; error: string }>;
        };
        const names = parsed.results.map(r => r.filePath.split('/').pop());

        assert.deepEqual(names, ['covered.js'], 'only the file whose config registers the plugin is linted');
        assert.ok(
          parsed.results[0]!.messages.some(m => m.ruleId === 'x/r'),
          'the covered file still reports the rule',
        );
        assert.equal(parsed.errors.length, 0, 'the unscoped file is skipped, not reported as an error');
        assert.ok(error.includes('is not configured for 1 file(s)'), 'warns about the skipped file');
        assert.equal(exitCode, 1, 'the covered violation still fails the run');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('caches results across runs with --cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-cache-'));
    const config = join(dir, 'eslint.config.mjs');
    const cache = join(dir, '.eslintcache');

    try {
      await writeFile(config, "export default [{ files: ['**/*.js'], rules: { 'no-console': 'error' } }];\n");
      await writeFile(join(dir, 'has-console.js'), 'console.log(1);\n');
      await writeFile(join(dir, 'clean.js'), 'export const x = 1;\n');

      const args = [
        'no-console',
        '.',
        '--config',
        config,
        '--workers',
        '2',
        '--format',
        'json',
        '--cache',
        '--cache-location',
        cache,
      ];

      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const cold = await captureConsole(() => run(args));
        assert.ok(
          (await readdir(dir)).some(f => f.startsWith('.eslintcache')),
          'a cache file should be written',
        );

        const warm = await captureConsole(() => run(args));
        assert.equal(warm.exitCode, cold.exitCode, 'warm run should match cold');
        assert.deepEqual(
          JSON.parse(warm.output).results,
          JSON.parse(cold.output).results,
          'warm results should equal cold results',
        );
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps caches isolated per target rule', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-cache-rule-'));
    const config = join(dir, 'eslint.config.mjs');
    const cache = join(dir, '.eslintcache');

    try {
      await writeFile(
        config,
        "export default [{ files: ['**/*.js'], rules: { 'no-console': 'error', 'no-debugger': 'error' } }];\n",
      );
      await writeFile(join(dir, 'a.js'), 'console.log(1);\n');
      await writeFile(join(dir, 'b.js'), 'debugger;\n');

      const args = (rule: string) => [rule, '.', '--config', config, '--workers', '1', '--format', 'json'];
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        // Warm the cache with a different rule first.
        await captureConsole(() => run([...args('no-console'), '--cache', '--cache-location', cache]));

        const withCache = await captureConsole(() =>
          run([...args('no-debugger'), '--cache', '--cache-location', cache]),
        );
        const noCache = await captureConsole(() => run(args('no-debugger')));

        const cacheFiles = (await readdir(dir)).filter(f => f.startsWith('.eslintcache'));
        assert.ok(cacheFiles.length >= 2, 'each rule gets its own cache file');
        assert.deepEqual(
          JSON.parse(withCache.output).results,
          JSON.parse(noCache.output).results,
          'a previous rule must not poison this rule\u2019s cache',
        );
        assert.ok(withCache.output.includes('debugger'), 'still reports the violation');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-lints files whose contents change (cache invalidation)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-cache-inv-'));
    const config = join(dir, 'eslint.config.mjs');
    const cache = join(dir, '.eslintcache');
    const file = join(dir, 'x.js');

    try {
      await writeFile(config, "export default [{ files: ['**/*.js'], rules: { 'no-console': 'error' } }];\n");
      await writeFile(file, 'console.log(1);\n');

      const args = [
        'no-console',
        '.',
        '--config',
        config,
        '--workers',
        '1',
        '--format',
        'json',
        '--cache',
        '--cache-location',
        cache,
      ];
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const cold = await captureConsole(() => run(args));
        assert.equal(JSON.parse(cold.output).results.length, 1, 'flags the console call');

        await writeFile(file, 'export const y = 1;\n'); // different size => cache invalidated
        const clean = await captureConsole(() => run(args));
        assert.equal(clean.exitCode, 0);
        assert.equal(JSON.parse(clean.output).results.length, 0, 'no stale result after the edit');

        await writeFile(file, 'console.log(2);\n');
        const again = await captureConsole(() => run(args));
        assert.equal(again.exitCode, 1);
        assert.equal(JSON.parse(again.output).results.length, 1, 'picks the violation back up');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies fixes with a warm cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tek-cache-fix-'));
    const config = join(dir, 'eslint.config.mjs');
    const cache = join(dir, '.eslintcache');
    const file = join(dir, 'x.js');

    try {
      await writeFile(config, "export default [{ files: ['**/*.js'], rules: { 'prefer-const': 'error' } }];\n");
      await writeFile(file, 'let x = 1;\nexport { x };\n');

      const args = [
        'prefer-const',
        '.',
        '--config',
        config,
        '--workers',
        '1',
        '--fix',
        '--format',
        'json',
        '--cache',
        '--cache-location',
        cache,
      ];
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        await captureConsole(() => run(args));
        assert.ok((await readFile(file, 'utf8')).includes('const x'), 'fix applied with cache enabled');

        const warm = await captureConsole(() => run(args));
        assert.equal(warm.exitCode, 0);
        assert.equal(JSON.parse(warm.output).results.length, 0, 'clean on the warm run');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('produces byte-identical --fix output to ESLint', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'tek-fix-parity-')));
    const config = join(dir, 'eslint.config.mjs');
    const original = 'function f() {\n  let a = 1;\n  let b = 2;\n  return a + b;\n}\nexport { f };\n';

    try {
      // Only one fixable rule is enabled, so ESLint's fix *is* that rule's fix
      // and can be compared against tek's single-rule pass.
      await writeFile(config, "export default [{ files: ['**/*.js'], rules: { 'prefer-const': 'error' } }];\n");
      await writeFile(join(dir, 'tek.js'), original);
      await writeFile(join(dir, 'ref.js'), original);

      const cwd = process.cwd();
      process.chdir(dir);
      try {
        await captureConsole(() =>
          run(['prefer-const', 'tek.js', '--config', 'eslint.config.mjs', '--workers', '1', '--fix']),
        );

        const eslint = new ESLint({ fix: true, overrideConfigFile: config });
        await ESLint.outputFixes(await eslint.lintFiles(['ref.js']));

        const tekOut = await readFile(join(dir, 'tek.js'), 'utf8');
        const refOut = await readFile(join(dir, 'ref.js'), 'utf8');

        assert.ok(tekOut.includes('const a'), 'tek should have applied the fix');
        assert.equal(tekOut, refOut, 'tek --fix must match eslint --fix byte-for-byte');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scales the worker count within bounds', () => {
    assert.equal(chooseWorkerCount(0, 8), 0, 'no files, no workers');
    assert.equal(chooseWorkerCount(5, 0), 0, 'no workers when the max is zero');
    assert.equal(chooseWorkerCount(1, 8), 1, 'one file, one worker');

    for (const fileCount of [1, 2, 399, 400, 401, 1000, 5000]) {
      for (const maxWorkers of [1, 2, 8]) {
        const workers = chooseWorkerCount(fileCount, maxWorkers);
        assert.ok(workers >= 1, 'a non-empty run gets at least one worker');
        assert.ok(workers <= maxWorkers, 'never exceeds the requested max');
        assert.ok(workers <= fileCount, 'never more workers than files');
      }
    }
  });
});
