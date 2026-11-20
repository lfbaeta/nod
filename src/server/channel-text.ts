import { loopbackHost } from '../shared/loopback.ts';
import { appPagePath, appPages, appPageUrl } from '../shared/app-links.ts';
import type { Nodes } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const markdown = unified().use(remarkParse).use(remarkGfm);
const urlEnd = /[)<>"'\]|`{}^*_~,.;:!?]/;

function localHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    loopbackHost(host) ||
    host === '0.0.0.0' ||
    host === '[::]' ||
    host.endsWith('.localhost') ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    /^\[::(?:ffff:)?(?:7f[0-9a-f]{2}:|127\.)/.test(host)
  );
}

function addresses(values: Array<[string, boolean]>, check: (candidate: string) => void) {
  let budget = 10_000;
  const token = /\S{0,2049}/y;
  const inspect = (value: string, from: number) => {
    token.lastIndex = from;
    const found = token.exec(value)![0];
    if (found.length > 2048) return false;
    const cuts = [found.length];
    for (let index = 1; index < found.length; index++)
      if (urlEnd.test(found[index])) cuts.push(index);
    if (cuts.length > 65 || (budget -= cuts.length) < 0) return false;
    for (const cut of cuts) check(found.slice(0, cut));
    return true;
  };
  for (const [value, paths] of values) {
    for (const match of value.matchAll(/:[/\\]{1,2}/g)) {
      const scheme = /https?$/i.exec(value.slice(Math.max(0, match.index - 5), match.index));
      if (scheme && !inspect(value, match.index - scheme[0].length)) return false;
    }
    if (paths)
      for (const match of value.matchAll(
        /(?<![\w.:/%@-])\/(?:api\/artifacts|vault|trust|browser|credentials|payments|approvals)/gi,
      ))
        if (!inspect(value, match.index)) return false;
  }
  return true;
}

export function channelText(text: string) {
  let secureAction = false;
  let artifact = false;
  const privateUrl = (value: string) => {
    let url: URL;
    try {
      url = new URL(value, 'https://nod.invalid');
    } catch {
      try {
        url = new URL(
          value.replace(/[\p{Terminal_Punctuation}\p{Pf}\p{Pe}'"\x60]+$/u, ''),
          'https://nod.invalid',
        );
      } catch {
        return false;
      }
    }
    const path = url.pathname.replace(/%([0-7][0-9a-f])/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    );
    if (path.startsWith('/api/artifacts/')) {
      artifact = true;
      return true;
    }
    if (localHost(url.hostname)) {
      secureAction = true;
      return true;
    }
    if (
      /^\/(?:vault|credentials|payments|approvals)\//.test(path) ||
      path === '/browser' ||
      (['/vault', '/trust'].includes(path) && url.searchParams.has('add'))
    ) {
      if (!/^https?:\/\//.test(value)) {
        secureAction = true;
        return true;
      }
    }
    return false;
  };
  const safe = text
    .replace(
      /\[((?:\\.|[^\]\\])*)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g,
      (match, label: string, url: string) => {
        const path = appPagePath(url);
        if (path) {
          const page = appPages[path as keyof typeof appPages];
          return `${page && label !== page ? `${label} (${page})` : label}: ${appPageUrl(path)}`;
        }
        return privateUrl(url) ? label : match;
      },
    )
    .replace(
      /https?:\/\/[^\s)]+|\/(?:api\/artifacts|vault|trust|browser|credentials|payments|approvals)[^\s)]*/g,
      (url) => (privateUrl(url) ? '' : url),
    )
    .trim();
  const values: Array<[string, boolean]> = [[safe, false]];
  const walk = (node: Nodes) => {
    if ('url' in node) {
      values.push([node.url, true]);
      privateUrl(node.url);
    }
    if (node.type === 'text') values.push([node.value, true]);
    if ('alt' in node && node.alt) values.push([node.alt, true]);
    if ('children' in node) for (const child of node.children) walk(child);
  };
  walk(markdown.parse(safe));
  if (!addresses(values, privateUrl)) secureAction = true;
  return { text: safe, secureAction, artifact };
}
