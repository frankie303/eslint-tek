<p align="center">
  <img src="docs/assets/logo-light.png" alt="eslint-tek mascot — a cat with a magnifying glass reviewing a checklist" width="420">
</p>

# eslint-tek

[![CI](https://github.com/frankie303/eslint-tek/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/frankie303/eslint-tek/actions/workflows/ci.yml)

Run a single ESLint rule across your codebase — exactly as your config defines it. Fast.

_tek_ (Turkish) = single, one. That's the idea: one rule, full speed.

**tek's selling point is config fidelity.** A rule scoped to certain folders stays scoped,
`warn` stays `warn`, and your plugins, parser, and `eslint-disable` comments all apply —
tek just runs **only** that rule, in parallel.

Plain `eslint` can't do that: `--rule '<json>'` overrides _globally_ (it lints files your
config never enabled the rule for), and `--no-config-lookup` isolates one rule by throwing
your config away. `--concurrency` adds the speed but still runs every configured rule.

Prior art: eslint-focus and eslint-nibble tackled adjacent problems.

## Install

```bash
npm install -D eslint-tek
```

Requires ESLint 9 or 10, and Node.js >= 22.13.

## Usage

```bash
# Run a single rule on your codebase
npx eslint-tek no-console src/

# Plugin rules work too
npx eslint-tek react-hooks/exhaustive-deps src/

# Only lint files changed vs main branch
npx eslint-tek no-console src/ --diff main

# Autofix
npx eslint-tek no-console src/ --fix

# Autofix with type filter
npx eslint-tek no-console src/ --fix --fix-type suggestion

# JSON output for CI
npx eslint-tek no-console src/ --format json

# Suppress warnings
npx eslint-tek no-console src/ --quiet
```

## Output

Example:

```console
$ npx eslint-tek react-hooks/exhaustive-deps src/

src/hooks/useData.ts:34:8  React Hook useCallback has missing dependencies

  1 file | 1 issue | 1 fixable
  Scanned 412 files in 3.2s (4 workers)
```

## Options

| Flag                      | Description                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `--fix`                   | Apply autofixes for the target rule                                                  |
| `--fix-type <types>`      | Restrict fix types (comma-separated): `problem`, `suggestion`, `layout`              |
| `--diff [base]`           | Only lint git-changed files (default base: `HEAD`)                                   |
| `--workers <n>`           | Max worker thread count (default: half the CPU count). tek uses fewer for small runs |
| `--format <fmt>`          | Output format: `text` (default), `json`                                              |
| `--ext <exts>`            | File extensions, comma-separated (default: `js,jsx,ts,tsx,mjs,mts,cjs,cts`)          |
| `--config <path>`         | ESLint config file override                                                          |
| `--cache`                 | Reuse ESLint's cache for much faster repeat runs                                     |
| `--cache-location <path>` | Cache base path (default: `.eslintcache`). tek writes `<path>.<rule>.<worker>`       |
| `--quiet`                 | Only show errors, suppress warnings                                                  |

## How It Works

1. **File discovery** -- `git ls-files` finds tracked and untracked files (respecting `.gitignore`); `tinyglobby` is used outside git repos
2. **Worker pool** -- Files are split across Node.js worker threads
3. **Surgical ESLint** -- Each worker runs ESLint with `ruleFilter` to execute only the target rule
4. **Aggregate & print** -- Results from all workers are merged, then formatted

Your existing ESLint config, plugins, and parsers are fully respected. Custom rules work.

tek reports rules **exactly as your config defines them**, including severity
(`warn` stays `warn`, and warnings-only runs exit 0). The rule must be enabled
in your config for it to run; if it isn't, tek tells you and points at how to
enable it instead of reporting an empty result. This is the same contract as
running `eslint` itself.

## Why It's Fast

The speed comes from a few architectural decisions, not a custom lint engine:

- **Parallel**: N worker threads with independent ESLint instances (eslint-focus/nibble are single-threaded)
- **Surgical**: ESLint's `ruleFilter` callback skips all rules except the target (eslint-nibble runs every rule)
- **Reused instances**: One ESLint per worker, reused across files (eslint-focus creates one per file)
- **Single-pass fix**: `--fix` runs one lint pass (nibble's interactive autofix re-lints — 3 passes total)

## License

MIT
