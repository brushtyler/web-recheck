# web-recheck

Declarative UI testing framework with a trustworthy release gate (PASS / FAIL / INCONCLUSIVE).

Quick start (no browser needed, uses the `http-lite` engine):

    npm ci --ignore-scripts
    npx tsx bin/web-recheck.ts validate examples/beta-portal/site-profile.yaml --kind site_profile
    npx tsx bin/web-recheck.ts registry check --registry examples/beta-portal/cases.yaml
    npm test

For Chromium: `npm run postinstall:browsers`. Exit codes: 0 PASS, 1 FAIL, 2 INCONCLUSIVE, 3 usage/config error.
Schemas live in `schemas/` (generated from zod: `npm run schemas`). Run `web-recheck` without arguments for the CLI reference.

Status: see the final notes of the implementation (docs/ still to be written; known failing e2e tests listed there).
