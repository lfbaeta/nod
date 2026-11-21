import { readFileSync } from 'node:fs';
import { register } from 'tsx/esm/api';
import { trustSystemCertificates } from './system-certificates.mjs';

const [loading] = JSON.parse(
  readFileSync(new URL('../../src/shared/startup-steps.json', import.meta.url), 'utf8'),
);
process.parentPort?.postMessage({ type: 'nod-starting', step: loading });
trustSystemCertificates();
register();
await import('../../src/server/index.ts');
