/*
 * Pack-install smoke test: builds the tarball, installs it into a throwaway
 * project (with eslint as a peer), and runs the CLI. Guards against shipping a
 * package that cannot run (e.g. the node_modules TS-stripping restriction).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Optional arg selects the peer ESLint to install (default: current).
const eslintSpec = process.argv[2] ?? 'eslint@^10';
const cwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'tek-smoke-'));

try {
  console.log('smoke: packing (runs prepack build)...');
  execFileSync('npm', ['pack', '--pack-destination', dir], { cwd, stdio: 'inherit' });

  const tarball = readdirSync(dir).find(f => f.endsWith('.tgz'));
  if (!tarball) throw new Error('smoke: npm pack produced no tarball');

  const proj = join(dir, 'proj');
  mkdirSync(proj);
  writeFileSync(
    join(proj, 'package.json'),
    JSON.stringify({ name: 'tek-smoke', version: '1.0.0', private: true }, null, 2) + '\n',
  );
  writeFileSync(
    join(proj, 'eslint.config.mjs'),
    "export default [{ files: ['**/*.js'], rules: { 'no-console': 'error' } }];\n",
  );
  writeFileSync(join(proj, 'has-console.js'), 'console.log(1);\n');

  console.log(`smoke: installing tarball + ${eslintSpec}...`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', eslintSpec, join(dir, tarball)], {
    cwd: proj,
    stdio: 'inherit',
  });

  const bin = join(proj, 'node_modules', '.bin', 'eslint-tek');
  const version = execFileSync(bin, ['--version'], { cwd: proj, encoding: 'utf8' }).trim();
  console.log('smoke: installed version', version);

  // Exit code 1 = violations found, which is the expected outcome here.
  const res = spawnSync(bin, ['no-console', '.'], { cwd: proj, encoding: 'utf8' });
  if (res.status !== 1) {
    throw new Error(`smoke: expected exit 1, got ${res.status}\n${res.stderr}`);
  }
  if (!res.stdout.includes('has-console.js')) {
    throw new Error('smoke: expected has-console.js in output, got:\n' + res.stdout);
  }
  console.log('smoke: lint output ok');
  console.log('SMOKE PASS');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
