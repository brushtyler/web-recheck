import type { RunResults } from '../contracts/index.js';

const INVALID_XML = /[^\x09\x0A\x0D\x20-퟿-�]/g;
export const xmlEscape = (s: string): string =>
  s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function renderJunit(r: RunResults): string {
  const cases = r.results.map((c) => {
    const msg = xmlEscape(c.reason_code ?? c.verdict);
    const detail = xmlEscape(JSON.stringify(c.failed_assertions));
    let inner = '';
    if (c.verdict === 'FAIL') inner = `<failure message="${msg}">${detail}</failure>`;
    else if (c.verdict === 'SKIPPED') inner = `<skipped message="${msg}"/>`;
    else if (c.verdict !== 'PASS') inner = `<error message="${msg}">${detail}</error>`;
    else if (c.flaky) inner = `<error message="FLAKY_PASS_AFTER_RETRY"/>`;
    return `  <testcase classname="${xmlEscape(r.site_id)}" name="${xmlEscape(c.case_id)}" time="${(c.duration_ms / 1000).toFixed(3)}">${inner}</testcase>`;
  });
  const count = (f: (v: string) => boolean) => r.results.filter((c) => f(c.verdict)).length;
  const failures = count((v) => v === 'FAIL');
  const errors = count((v) => !['PASS', 'FAIL', 'SKIPPED'].includes(v));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xmlEscape(r.site_id)}" tests="${r.results.length}" failures="${failures}" errors="${errors}" skipped="${count((v) => v === 'SKIPPED')}">\n${cases.join('\n')}\n</testsuite>\n`;
}
