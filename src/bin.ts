#!/usr/bin/env node

import { run } from './cli.ts';

const exitCode = await run(process.argv.slice(2));
process.exit(exitCode);
