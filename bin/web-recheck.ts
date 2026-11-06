#!/usr/bin/env -S npx tsx
import { main } from '../src/cli/main.js';

process.exitCode = await main(process.argv.slice(2));
