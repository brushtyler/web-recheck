import { z } from 'zod';
import { SCHEMAS } from '../src/contracts/load.js';
import { writeAtomic } from '../src/io/files.js';

for (const [name, schema] of Object.entries(SCHEMAS)) {
  writeAtomic(`schemas/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' }), null, 2) + '\n');
}
