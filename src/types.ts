export interface RuleConfig {
  rule: string;
  fix: boolean;
  fixTypes: string[];
  configPath?: string;
  cache?: boolean;
  // Per-worker cache path (set by the pool); the base path lives in the CLI.
  cacheLocation?: string;
}

export interface LintMessage {
  ruleId: string | null;
  message: string;
  severity: 1 | 2;
  line?: number;
  column?: number;
  fatal?: boolean;
}

export interface LintResult {
  filePath: string;
  messages: LintMessage[];
  fixableCount: number;
}

export interface LintError {
  filePath: string;
  error: string;
}

export type WorkerMessage =
  | { type: 'init'; ruleConfig: RuleConfig }
  | { type: 'lint'; files: string[]; ruleConfig: RuleConfig; batchId: number }
  | { type: 'ready' }
  | { type: 'rule-warning'; message: string }
  | { type: 'results'; results: LintResult[]; errors: LintError[]; batchId: number }
  | { type: 'error'; error: string; batchId: number };
