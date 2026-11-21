import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureHostCertificateBundle,
  hostCertificateBundle,
  trustSystemCertificates,
} from '../main/system-certificates.mjs';

const paths = [
  '/run/host/etc/ssl/certs/ca-certificates.crt',
  '/run/host/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
  '/run/host/etc/pki/tls/certs/ca-bundle.crt',
  '/run/host/etc/ssl/ca-bundle.pem',
  '/run/host/etc/ssl/cert.pem',
];

const certificate = `-----BEGIN CERTIFICATE-----
MIICbjCCAfOgAwIBAgIQYvYybOXE42hcG2LdnC6dlTAKBggqhkjOPQQDAzB4MQsw
CQYDVQQGEwJFUzERMA8GA1UECgwIRk5NVC1SQ00xDjAMBgNVBAsMBUNlcmVzMRgw
FgYDVQRhDA9WQVRFUy1RMjgyNjAwNEoxLDAqBgNVBAMMI0FDIFJBSVogRk5NVC1S
Q00gU0VSVklET1JFUyBTRUdVUk9TMB4XDTE4MTIyMDA5MzczM1oXDTQzMTIyMDA5
MzczM1oweDELMAkGA1UEBhMCRVMxETAPBgNVBAoMCEZOTVQtUkNNMQ4wDAYDVQQL
DAVDZXJlczEYMBYGA1UEYQwPVkFURVMtUTI4MjYwMDRKMSwwKgYDVQQDDCNBQyBS
QUlaIEZOTVQtUkNNIFNFUlZJRE9SRVMgU0VHVVJPUzB2MBAGByqGSM49AgEGBSuB
BAAiA2IABPa6V1PIyqvfNkpSIeSX0oNnnvBlUdBeh8dHsVnyV0ebAAKTRBdp20LH
sbI6GA60XYyzZl2hNPk2LEnb80b8s0RpRBNm/dfF/a82Tc4DTQdxz69qBdKiQ1oK
Um8BA06Oi6NCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYD
VR0OBBYEFAG5L++/EYZg8k/QQW6rcx/n0m5JMAoGCCqGSM49BAMDA2kAMGYCMQCu
SuMrQMN0EfKVrRYj3k4MGuZdpSRea0R7/DjiT8ucRRcRTBQnJlU5dUoDzBOQn5IC
MQD6SmxgiHPz7riYYqnOK8LZiqZwMR2vsJRM60/G49HzYqc8/5MuB1xJAWdpEgJy
v+c=
-----END CERTIFICATE-----
`;

test('host certificate discovery selects the first valid PEM bundle', () => {
  const reads = [];
  const selected = hostCertificateBundle((path) => {
    reads.push(path);
    if (path === paths[0]) throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
    if (path === paths[1])
      return '-----BEGIN CERTIFICATE-----\\nmalformed\\n-----END CERTIFICATE-----';
    if (path === paths[2]) return certificate;
    throw new Error('Should not read later paths');
  });
  assert.equal(selected, paths[2]);
  assert.deepEqual(reads, paths.slice(0, 3));
});

test('host certificate discovery returns undefined when no bundle is usable', () => {
  assert.equal(
    hostCertificateBundle(() => {
      throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
    }),
    undefined,
  );
  assert.equal(hostCertificateBundle(() => 'no PEM data'), undefined);
  assert.equal(
    hostCertificateBundle(() => '-----BEGIN CERTIFICATE-----\\ntruncated'),
    undefined,
  );
});

test('Flatpak host CA selection sets SSL_CERT_FILE without replacing an override', () => {
  const env = { FLATPAK_ID: 'io.n8n.Nod' };
  assert.equal(
    configureHostCertificateBundle(env, (path) => {
      if (path === paths[0]) return certificate;
      throw new Error('Unexpected path');
    }),
    paths[0],
  );
  assert.equal(env.SSL_CERT_FILE, paths[0]);

  const existing = { FLATPAK_ID: 'io.n8n.Nod', SSL_CERT_FILE: '/custom/ca.pem' };
  assert.equal(
    configureHostCertificateBundle(existing, () => assert.fail('Must preserve override')),
    undefined,
  );
  assert.equal(existing.SSL_CERT_FILE, '/custom/ca.pem');
});

test('host CA selection does not affect non-Flatpak installations', () => {
  const env = { FLATPAK_ID: 'another.app' };
  assert.equal(
    configureHostCertificateBundle(env, () => assert.fail('Must not inspect host')),
    undefined,
  );
  assert.equal(env.SSL_CERT_FILE, undefined);
});

test('trustSystemCertificates uses injected environment and file reader', () => {
  const originalSslCertFile = process.env.SSL_CERT_FILE;
  const env = { FLATPAK_ID: 'io.n8n.Nod' };
  const reads = [];
  const calls = [];
  const tls = {
    getCACertificates: (kind) => {
      calls.push(['get', kind]);
      return [];
    },
    setDefaultCACertificates: (certificates) => calls.push(['set', certificates]),
  };

  trustSystemCertificates(tls, env, (path) => {
    reads.push(path);
    if (path === paths[0]) return certificate;
    throw new Error('Unexpected path');
  });

  assert.equal(env.SSL_CERT_FILE, paths[0]);
  assert.deepEqual(reads, [paths[0]]);
  assert.deepEqual(
    calls.map(([action, value]) => [action, typeof value === 'string' ? value : null]),
    [
      ['get', 'system'],
      ['get', 'default'],
      ['set', null],
    ],
  );
  assert.ok(
    calls[2][1].some((pem) =>
      new X509Certificate(pem).subject.includes('CN=AC RAIZ FNMT-RCM SERVIDORES SEGUROS'),
    ),
  );
  assert.equal(process.env.SSL_CERT_FILE, originalSslCertFile);
});

test('host CA certificates are added even when Node cached its system store before setup', () => {
  const root = mkdtempSync(join(tmpdir(), 'nod-host-ca-'));
  try {
    const bundlePath = join(root, 'host-ca.pem');
    writeFileSync(bundlePath, certificate);
    const moduleUrl = new URL('../main/system-certificates.mjs', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { X509Certificate } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import * as tls from 'node:tls';
      import { trustSystemCertificates } from ${JSON.stringify(moduleUrl)};

      tls.getCACertificates('system');
      let configured;
      trustSystemCertificates({
        getCACertificates: tls.getCACertificates,
        setDefaultCACertificates: (certificates) => {
          configured = certificates;
        },
      }, process.env, readFileSync, [${JSON.stringify(bundlePath)}]);

      assert.ok(configured);
      assert.ok(configured.some((pem) =>
        new X509Certificate(pem).subject.includes('CN=AC RAIZ FNMT-RCM SERVIDORES SEGUROS')
      ));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        env: { ...process.env, FLATPAK_ID: 'io.n8n.Nod', SSL_CERT_FILE: '' },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
