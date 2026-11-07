import { parseDocument } from 'yaml';
import { FrameworkError } from '../errors.js';

export const MAX_DOC_BYTES = 1024 * 1024;

/** YAML core schema only: no custom tags, no merge keys, bounded aliases, unique keys (SEC-4, A3). */
export function parseYamlSafe(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_DOC_BYTES) {
    throw new FrameworkError('UNSAFE_YAML', `document exceeds ${MAX_DOC_BYTES} bytes`);
  }
  const doc = parseDocument(text, { schema: 'core', merge: false, uniqueKeys: true, strict: true });
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length > 0) {
    throw new FrameworkError('UNSAFE_YAML', `unsafe or invalid YAML: ${problems.map((p) => p.message.split('\n')[0]).join('; ')}`);
  }
  return doc.toJS({ maxAliasCount: 50 });
}
