import { stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { glob } from 'tinyglobby';

/**
 * List tracked and untracked files via git, respecting .gitignore; null when not
 * a git repo.
 * @param cwd - Directory to run git in.
 * @returns Relative file paths, or null when not a git repo.
 */
function getGitFiles(cwd: string): string[] | null {
  try {
    const output = execFileSync(
      'git',
      /*
       * --cached + --others + --exclude-standard lists tracked and untracked
       * files while respecting .gitignore, and works before the first commit
       * (unlike `ls-tree HEAD`). -z avoids git quoting paths that contain
       * special characters. Large repos easily exceed execFileSync's 1 MB
       * default, which throws ENOBUFS and silently drops files.
       */
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return output.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Check whether a file has one of the given extensions.
 */
function hasExtension(file: string, extensions: Set<string>): boolean {
  const ext = file.split('.').pop();
  return ext != null && extensions.has(ext);
}

/**
 * Keep files whose extension is in the set.
 */
function filterByExtensions(files: string[], extensions: Set<string>): string[] {
  return files.filter(f => hasExtension(f, extensions));
}

/**
 * Keep files under one of the given roots, or all files when a root is the cwd.
 */
function filterByRoots(files: string[], roots: string[], cwd: string): string[] {
  const relativizedRoots = roots.map(r => {
    const abs = isAbsolute(r) ? r : resolve(cwd, r);
    const rel = relative(cwd, abs);
    return rel === '' ? '' : rel + '/';
  });

  if (relativizedRoots.some(r => r === '' || r === '/')) {
    return files;
  }

  return files.filter(f => relativizedRoots.some(root => f.startsWith(root)));
}

/**
 * Drop duplicate paths.
 */
function dedupe(files: string[]): string[] {
  return [...new Set(files)];
}

/**
 * Discover lintable files under the given roots, using git when possible.
 * @param roots - Directories or files to search.
 * @param extensions - File extensions to keep, without dots.
 * @returns Absolute file paths.
 */
export async function discoverFiles(roots: string[], extensions: string[]): Promise<string[]> {
  const cwd = process.cwd();
  const extSet = new Set(extensions);

  const explicitFiles: string[] = [];
  const dirs: string[] = [];

  for (const root of roots) {
    const abs = isAbsolute(root) ? root : resolve(cwd, root);
    const s = await stat(abs).catch(() => null);
    if (!s) continue;
    if (s.isFile()) {
      if (hasExtension(abs, extSet)) explicitFiles.push(abs);
    } else if (s.isDirectory()) {
      dirs.push(root);
    }
  }

  if (dirs.length === 0) return dedupe(explicitFiles);

  const gitFiles = getGitFiles(cwd);

  if (gitFiles !== null) {
    const filtered = filterByRoots(gitFiles, dirs, cwd);
    const byExt = filterByExtensions(filtered, extSet);
    const absolute = byExt.map(f => resolve(cwd, f));
    return dedupe([...explicitFiles, ...absolute]);
  }

  // Fallback: not a git repo, use glob. dot:true keeps dot-directories in
  // step with the git path; .gitignore can't be honoured without git.
  const extPattern = extensions.length === 1 ? `**/*.${extensions[0]}` : `**/*.{${extensions.join(',')}}`;

  const patterns = dirs.map(dir => {
    const abs = isAbsolute(dir) ? dir : resolve(cwd, dir);
    return `${abs}/${extPattern}`;
  });

  const globbed = await glob(patterns, {
    ignore: ['**/node_modules/**'],
    dot: true,
    absolute: true,
  });

  return dedupe([...explicitFiles, ...globbed]);
}

/**
 * List changed and untracked files relative to a base ref.
 * @param roots - Roots to restrict results to.
 * @param baseRef - Git ref to diff against.
 * @param extensions - File extensions to keep, without dots.
 * @returns Absolute file paths.
 */
export function getChangedFiles(roots: string[], baseRef: string, extensions: string[]): string[] {
  const cwd = process.cwd();
  const opts = { cwd, encoding: 'utf-8' as const, maxBuffer: 64 * 1024 * 1024 };

  // Tracked changes vs the base ref; --diff-filter=ACMR excludes deletions so
  // we never hand ESLint a path that no longer exists.
  const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', baseRef, '--', '.'], opts)
    .split('\n')
    .filter(Boolean);

  // Untracked, non-ignored files count as changed too.
  const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', '.'], opts)
    .split('\0')
    .filter(Boolean);

  return filterByExtensions(
    filterByRoots([...new Set([...changed, ...untracked])], roots, cwd),
    new Set(extensions),
  ).map(f => resolve(cwd, f));
}
