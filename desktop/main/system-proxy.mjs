import { isIP } from 'node:net';

const LOCAL_NAME_SUFFIXES = [
  '.local',
  '.lan',
  '.home',
  '.corp',
  '.internal',
  '.home.arpa',
  '.localhost',
];

const PRIVATE_IPV4_RANGES = [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
].map(([address, bits]) => {
  const value = address.split('.').reduce((part, octet) => (part << 8) | Number(octet), 0);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return [value >>> 0, mask];
});

function ipv4ToInt(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function isPrivateAddress(address) {
  if (isIP(address) === 4)
    return PRIVATE_IPV4_RANGES.some(
      ([base, mask]) => (ipv4ToInt(address) & mask) === (base & mask),
    );
  const lowered = address.toLowerCase();
  if (lowered === '::' || lowered === '::1') return true;
  if (lowered.startsWith('::ffff:')) return isPrivateAddress(lowered.slice(7));
  const firstHextet = lowered.startsWith('::')
    ? 0
    : Number.parseInt(lowered.split(':')[0] || '0', 16);
  return (firstHextet & 0xffc0) === 0xfe80 || (firstHextet & 0xfe00) === 0xfc00;
}

export function localTrafficBypasses(hostname) {
  const name = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[(.+)\]$/, '$1');
  if (!name) return false;
  if (!name.includes('.')) return isIP(name) === 0 || isPrivateAddress(name);
  if (isIP(name)) return isPrivateAddress(name);
  return LOCAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function systemProxyEnvironment(resolved, noProxy = 'localhost,127.0.0.1,::1') {
  const results = Array.isArray(resolved) ? resolved : [resolved];
  for (const result of results)
    for (const entry of String(result ?? '').split(';')) {
      const match = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(entry.trim());
      if (match) {
        const proxy = `${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`;
        return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: noProxy };
      }
    }
  return {};
}

export function createSystemProxyDispatcher({ Agent, Dispatcher, EnvHttpProxyAgent }) {
  const direct = new Agent();
  const proxied = new EnvHttpProxyAgent();
  return new (class extends Dispatcher {
    dispatch(options, handler) {
      const hostname = new URL(options.origin).hostname;
      return (localTrafficBypasses(hostname) ? direct : proxied).dispatch(options, handler);
    }
    async close() {
      await Promise.all([direct.close(), proxied.close()]);
    }
    async destroy(error) {
      await Promise.all([direct.destroy(error), proxied.destroy(error)]);
    }
  })();
}

export async function useEnvironmentProxy(env = process.env, load = () => import('undici')) {
  if (!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) return;
  const undici = await load();
  undici.setGlobalDispatcher(createSystemProxyDispatcher(undici));
}
