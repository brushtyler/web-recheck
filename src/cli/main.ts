import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { FrameworkError, errMessage } from '../errors.js';
import { DOC_KINDS, RunResultsSchema, loadDocument, resolvePolicy, type DocKind } from '../contracts/index.js';
import { diffRuns } from '../compare/diff.js';
import { createGuardedClient } from '../security/http.js';
import { resolveSecret } from '../security/secrets.js';
import { redactor } from '../security/redactor.js';
import { Logger, stderrSink } from '../log/logger.js';
import { approve, markNeedsSpec, promote } from '../registry/lifecycle.js';
import { loadRegistry, saveRegistryFile, updateCase } from '../registry/registry.js';
import { ArtifactWriter } from '../io/artifact-writer.js';
import { readText } from '../io/files.js';
import { evaluateGate } from '../gate/evaluate.js';
import { renderHtml } from '../report/html.js';
import { renderJunit } from '../report/junit.js';
import { installSignalHandlers } from '../executor/abort.js';
import { runSuite } from '../executor/runner.js';
import { reap } from '../fixture/reaper.js';
import { Ledger } from '../fixture/ledger.js';
import { EXIT, exitFor } from './exit-codes.js';
import type { BrowserAdapter } from '../executor/adapter.js';

type Out = (s: string) => void;
const usage = `web-recheck <command>
  validate <file> --kind <site_profile|case_registry|run_manifest|run_results|gate_policy>
  registry approve|promote|needs-spec --registry F --case ID [--by NAME] | save --registry F | check --registry F
  run --profile F --registry F [--policy F] [--retries N] [--workers N] [--shard ID] [--out DIR] [--case ID]... [--adapter chromium|http-lite]
  gate --results F [--policy F]      report --results F --format json|junit|html --out DIR
  diff A.json B.json                 fixtures list|reap --profile F [--out DIR] [--dry-run]
exit codes: 0 PASS, 1 FAIL, 2 INCONCLUSIVE, 3 usage/config error`;

export interface MainDeps {
  out?: Out;
  err?: Out;
  adapter?: () => Promise<BrowserAdapter>;
}

async function pickAdapter(name: string): Promise<BrowserAdapter> {
  if (name === 'http-lite') return new (await import('../executor/http-lite/http-lite-adapter.js')).HttpLiteAdapter();
  return new (await import('../executor/playwright/playwright-adapter.js')).PlaywrightAdapter();
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.out ?? ((s) => void process.stdout.write(s + '\n'));
  const err = deps.err ?? ((s) => void process.stderr.write(s + '\n'));
  let started = false;
  try {
    const [cmd, sub] = argv;
    const { values, positionals } = parseArgs({
      args: argv.slice(1), allowPositionals: true, strict: true,
      options: {
        kind: { type: 'string' }, registry: { type: 'string' }, case: { type: 'string', multiple: true }, by: { type: 'string' }, profile: { type: 'string' },
        policy: { type: 'string' }, retries: { type: 'string' }, workers: { type: 'string' }, shard: { type: 'string' }, out: { type: 'string' },
        adapter: { type: 'string' }, results: { type: 'string' }, format: { type: 'string' }, 'dry-run': { type: 'boolean' },
      },
    });
    const need = (v: string | undefined, n: string): string => {
      if (!v) throw new FrameworkError('USAGE_ERROR', `missing --${n}`);
      return v;
    };
    const int = (v: string | undefined, n: string, max: number): number | undefined => {
      if (v === undefined) return undefined;
      const x = Number(v);
      if (!Number.isInteger(x) || x < 0 || x > max) throw new FrameworkError('USAGE_ERROR', `--${n} must be an integer 0..${max}`);
      return x;
    };
    const outDir = values.out ?? 'artifacts';
    switch (cmd) {
      case 'validate': {
        const kind = need(values.kind, 'kind') as DocKind;
        if (!DOC_KINDS.includes(kind)) throw new FrameworkError('USAGE_ERROR', `unknown --kind ${kind}`);
        loadDocument(kind, need(positionals[0], 'file'));
        out(`OK ${kind}`);
        return EXIT.PASS;
      }
      case 'registry': {
        const reg = need(values.registry, 'registry');
        if (sub === 'check') { loadRegistry(reg); out('OK registry'); return EXIT.PASS; }
        if (sub === 'save') { out(`saved; revised: ${saveRegistryFile(reg).changed.join(', ') || 'none'}`); return EXIT.PASS; }
        const id = need(values.case?.[0], 'case');
        if (sub === 'approve') updateCase(reg, id, (c) => approve(c, need(values.by, 'by')));
        else if (sub === 'promote') updateCase(reg, id, promote);
        else if (sub === 'needs-spec') updateCase(reg, id, markNeedsSpec);
        else throw new FrameworkError('USAGE_ERROR', 'unknown registry subcommand');
        out(`OK ${sub} ${id}`);
        return EXIT.PASS;
      }
      case 'run': {
        const profile = loadDocument('site_profile', need(values.profile, 'profile'));
        const registry = loadRegistry(need(values.registry, 'registry'));
        if (registry.site_id !== profile.site_id) throw new FrameworkError('USAGE_ERROR', 'registry site_id does not match profile');
        const policy = values.policy ? loadDocument('gate_policy', values.policy) : undefined;
        const retries = int(values.retries, 'retries', 5);
        const workers = int(values.workers, 'workers', 8);
        if (retries !== undefined && retries > profile.limits.max_retries) throw new FrameworkError('USAGE_ERROR', `--retries exceeds profile max_retries (${profile.limits.max_retries})`);
        const adapter = deps.adapter ? await deps.adapter() : await pickAdapter(values.adapter ?? profile.browser.engine);
        const ctrl = new AbortController();
        const dispose = installSignalHandlers(ctrl, new Logger('cli', [stderrSink]));
        started = true;
        try {
          const r = await runSuite({
            profile, registry, adapter, http: createGuardedClient(profile.allowed_origins), outRoot: outDir, signal: ctrl.signal, stderr: true,
            ...(policy ? { policy } : {}), ...(retries !== undefined ? { retries } : {}), ...(workers !== undefined ? { workers } : {}),
            ...(values.shard ? { shardId: values.shard } : {}), ...(values.case ? { caseIds: values.case } : {}),
          });
          out(`run ${r.results.run_id}: ${r.results.gate?.decision} (${r.runDir})`);
          return exitFor(r.results.gate?.decision ?? 'INCONCLUSIVE');
        } finally {
          dispose();
        }
      }
      case 'gate': {
        const res = loadDocument('run_results', need(values.results, 'results'));
        const g = evaluateGate({ plan: res.plan, plan_digest: res.plan_digest, results: res.results, faults: res.faults }, resolvePolicy(values.policy ? loadDocument('gate_policy', values.policy) : undefined));
        out(JSON.stringify(g, null, 2));
        return exitFor(g.decision);
      }
      case 'report': {
        const res = RunResultsSchema.parse(JSON.parse(readText(need(values.results, 'results'), 200 * 1024 * 1024)));
        const w = new ArtifactWriter(resolve(outDir), redactor);
        const f = need(values.format, 'format');
        if (f === 'json') w.writeNamed('results.json', JSON.stringify(res, null, 2));
        else if (f === 'junit') w.writeNamed('junit.xml', renderJunit(res));
        else if (f === 'html') w.writeNamed('report.html', renderHtml(res));
        else throw new FrameworkError('USAGE_ERROR', 'unknown --format');
        out(`OK report ${f}`);
        return EXIT.PASS;
      }
      case 'diff': {
        const [a, b] = positionals;
        const load = (p: string | undefined) => loadDocument('run_results', need(p, 'file'));
        out(JSON.stringify(diffRuns(load(a), load(b)), null, 2));
        return EXIT.PASS;
      }
      case 'fixtures': {
        const profile = loadDocument('site_profile', need(values.profile, 'profile'));
        const runsDir = join(outDir, 'runs');
        const logger = new Logger('reaper', [stderrSink]).child({ component: 'reaper' });
        if (sub === 'list') {
          const { listDirs } = await import('../io/files.js');
          for (const run of listDirs(runsDir)) for (const e of new Ledger(join(runsDir, run, 'ledger.jsonl')).open()) out(JSON.stringify({ run, status: e.status, kind: e.kind, name: e.name }));
          return EXIT.PASS;
        }
        if (sub !== 'reap') throw new FrameworkError('USAGE_ERROR', 'unknown fixtures subcommand');
        const rep = await reap({ runsDir, profile, http: createGuardedClient(profile.allowed_origins), resolveSecret, logger, dryRun: values['dry-run'] ?? false });
        out(JSON.stringify(rep));
        return rep.failed.length > 0 ? EXIT.INCONCLUSIVE : EXIT.PASS;
      }
      default:
        err(usage);
        return EXIT.USAGE;
    }
  } catch (e) {
    err(redactor.redact(errMessage(e)));
    // Fail closed: faults after the run started are INCONCLUSIVE, configuration faults are usage errors.
    return started ? EXIT.INCONCLUSIVE : EXIT.USAGE;
  }
}
