import { stringify } from 'yaml';
import { FrameworkError } from '../errors.js';
import { writeAtomic } from '../io/files.js';
import { loadDocument, type CaseRegistry, type CaseT } from '../contracts/index.js';
import { computeContentHash, hasValidApproval, saveCase } from './lifecycle.js';

export function checkRegistry(reg: CaseRegistry, opts: { verifyHash: boolean } = { verifyHash: true }): void {
  const seen = new Set<string>();
  for (const [i, c] of reg.cases.entries()) {
    if (seen.has(c.case_id)) throw new FrameworkError('DUPLICATE_CASE_ID', `DUPLICATE_CASE_ID: ${c.case_id}`, `/cases/${i}/case_id`);
    seen.add(c.case_id);
    if (opts.verifyHash && c.content_hash !== computeContentHash(c)) {
      throw new FrameworkError('REVISION_STALE', `REVISION_STALE: ${c.case_id} content differs from content_hash; run "registry save"`, `/cases/${i}/content_hash`);
    }
    if (c.state === 'EXECUTABLE' && !hasValidApproval(c)) {
      throw new FrameworkError('APPROVAL_INVALID', `APPROVAL_INVALID: ${c.case_id} is EXECUTABLE without valid approval for its revision/content`, `/cases/${i}/approval`);
    }
  }
}

export function loadRegistry(path: string, opts: { verifyHash: boolean } = { verifyHash: true }): CaseRegistry {
  const reg = loadDocument('case_registry', path);
  checkRegistry(reg, opts);
  return reg;
}

export function writeRegistry(path: string, reg: CaseRegistry): void {
  writeAtomic(path, stringify(reg, { lineWidth: 0 }));
}

export function saveRegistryFile(path: string): { changed: string[] } {
  const reg = loadRegistry(path, { verifyHash: false });
  const changed: string[] = [];
  const cases = reg.cases.map((c) => {
    const n = saveCase(c);
    if (n !== c) changed.push(c.case_id);
    return n;
  });
  writeRegistry(path, { ...reg, cases });
  return { changed };
}

export function updateCase(path: string, caseId: string, fn: (c: CaseT) => CaseT): CaseT {
  const reg = loadRegistry(path);
  const idx = reg.cases.findIndex((c) => c.case_id === caseId);
  const cur = reg.cases[idx];
  if (!cur) throw new FrameworkError('USAGE_ERROR', `unknown case_id ${caseId}`);
  const next = fn(cur);
  reg.cases[idx] = next;
  writeRegistry(path, reg);
  return next;
}
