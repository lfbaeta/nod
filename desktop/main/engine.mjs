import { register } from 'tsx/esm/api';
import { trustSystemCertificates } from './system-certificates.mjs';
import { useEnvironmentProxy } from './system-proxy.mjs';

trustSystemCertificates();
await useEnvironmentProxy();
register();
await import('../../src/server/index.ts');
