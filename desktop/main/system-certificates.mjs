import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

const certificatePaths = [
  '/run/host/etc/ssl/certs/ca-certificates.crt',
  '/run/host/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
  '/run/host/etc/pki/tls/certs/ca-bundle.crt',
  '/run/host/etc/ssl/ca-bundle.pem',
  '/run/host/etc/ssl/cert.pem',
];

function parseCertificateBundle(contents) {
  const value = String(contents);
  const blocks = [
    ...value.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g),
  ];
  const starts = value.match(/-----BEGIN CERTIFICATE-----/g) || [];
  const ends = value.match(/-----END CERTIFICATE-----/g) || [];
  if (!blocks.length || blocks.length !== starts.length || blocks.length !== ends.length) return [];
  return blocks.map(([pem]) => new X509Certificate(pem).toString());
}

function readCertificateBundle(path, read) {
  const certificates = parseCertificateBundle(read(path, 'utf8'));
  return certificates.length ? { path, certificates } : undefined;
}

function findHostCertificateBundle(read, paths) {
  for (const path of paths) {
    try {
      const bundle = readCertificateBundle(path, read);
      if (bundle) return bundle;
    } catch {
      continue;
    }
  }
}

function configureHostCertificateBundleDetails(env, read, paths) {
  if (env.FLATPAK_ID !== 'io.n8n.Nod') return;

  if (env.SSL_CERT_FILE) {
    if (!paths.includes(env.SSL_CERT_FILE)) return;
    try {
      return readCertificateBundle(env.SSL_CERT_FILE, read);
    } catch {
      return;
    }
  }

  const bundle = findHostCertificateBundle(read, paths);
  if (bundle) env.SSL_CERT_FILE = bundle.path;
  return bundle;
}

export function hostCertificateBundle(read = readFileSync, paths = certificatePaths) {
  return findHostCertificateBundle(read, paths)?.path;
}

export function configureHostCertificateBundle(
  env = process.env,
  read = readFileSync,
  paths = certificatePaths,
) {
  return configureHostCertificateBundleDetails(env, read, paths)?.path;
}

export function trustSystemCertificates(
  tls = { getCACertificates, setDefaultCACertificates },
  env = process.env,
  read = readFileSync,
  paths = certificatePaths,
) {
  const bundle = configureHostCertificateBundleDetails(env, read, paths);
  const now = Date.now();
  const system = tls.getCACertificates('system').filter((cert) => {
    try {
      return new X509Certificate(cert).validToDate.getTime() > now;
    } catch {
      return true;
    }
  });
  const host = (bundle?.certificates || []).filter(
    (cert) => new X509Certificate(cert).validToDate.getTime() > now,
  );
  const certificates = [...system, ...host];
  if (!certificates.length) return;
  tls.setDefaultCACertificates([
    ...new Set([...tls.getCACertificates('default'), ...certificates]),
  ]);
}
