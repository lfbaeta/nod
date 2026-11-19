export function systemProxyEnvironment(resolved, noProxy = 'localhost,127.0.0.1,::1') {
  const entry = String(resolved ?? '')
    .split(';')[0]
    .trim();
  const match = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(entry);
  if (!match) return {};
  const proxy = `${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`;
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: noProxy };
}

export async function useEnvironmentProxy(env = process.env, load = () => import('undici')) {
  if (!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) return;
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await load();
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
