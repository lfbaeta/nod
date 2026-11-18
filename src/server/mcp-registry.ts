import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicAddress } from './app-catalog.ts';

const suggestionSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  endpoint: z.string(),
});

export type McpSuggestion = z.infer<typeof suggestionSchema>;

const entrySchema = z.object({
  attributes: z.object({
    slug: z.string().min(1).max(200),
    title: z.string().trim().min(2).max(80),
    tagline: z.string().nullish(),
    description: z.string().nullish(),
    authType: z.string(),
    isPublished: z.boolean().optional(),
    status: z.string().nullish(),
    requiredCapabilities: z.unknown().optional(),
    remotes: z.array(z.object({ type: z.string(), url: z.string() })).nullish(),
  }),
});

const pageSchema = z.object({
  data: z.array(z.unknown()),
  meta: z.object({ pagination: z.object({ pageCount: z.number() }) }).optional(),
});

const firstSyncWaitMs = 5000;

function publicEndpoint(value: string) {
  try {
    return publicAddress(value, 'catalog');
  } catch {
    return undefined;
  }
}

function displayName(title: string) {
  return title
    .replace(/[^A-Za-z0-9 .&'_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+/, '')
    .trim()
    .slice(0, 80);
}

function brief(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function endpointKey(value: string) {
  const url = URL.parse(value);
  return url ? `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}` : value;
}

function suggestionFrom(raw: unknown): McpSuggestion | undefined {
  const parsed = entrySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const entry = parsed.data.attributes;
  const capabilities = entry.requiredCapabilities;
  if (
    entry.authType !== 'oauth2' ||
    entry.isPublished !== true ||
    (entry.status ?? 'active') !== 'active' ||
    (Array.isArray(capabilities) ? capabilities.length > 0 : capabilities != null)
  )
    return undefined;
  const endpoint = entry.remotes
    ?.filter((remote) => remote.type === 'streamable-http')
    .map((remote) => publicEndpoint(remote.url))
    .find((url) => url !== undefined);
  const name = displayName(entry.title);
  if (!endpoint || name.length < 2) return undefined;
  return {
    slug: entry.slug,
    name,
    description: (entry.tagline || entry.description || '').trim().slice(0, 300),
    endpoint,
  };
}

export function createMcpRegistry(options: {
  file: string;
  url: string | undefined;
  served: () => Promise<(string | undefined)[]>;
  fetch?: typeof fetch;
  onError?: (error: Error) => void;
}) {
  const request = options.fetch ?? fetch;
  let suggestions: McpSuggestion[] = [];
  let loaded: Promise<void> | undefined;

  async function readCache() {
    try {
      suggestions = z
        .array(suggestionSchema)
        .parse(JSON.parse(await readFile(options.file, 'utf8')));
    } catch (cause) {
      if (Object(cause).code !== 'ENOENT')
        options.onError?.(
          new Error(
            `The saved MCP catalog could not be read (${Object(cause).code ?? 'invalid content'}).`,
          ),
        );
    }
  }

  async function fetchAll(base: string) {
    const entries: unknown[] = [];
    for (let page = 1; ; page++) {
      if (page > 20)
        throw new Error('The MCP catalog has more than 2,000 entries, so it was not saved.');
      const url = new URL('/api/mcp-servers', base);
      url.searchParams.set('version', '4');
      url.searchParams.set('pagination[page]', String(page));
      url.searchParams.set('pagination[pageSize]', '100');
      const response = await request(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(
          `The MCP catalog at ${url.origin} answered ${response.status}: ${brief(await response.text())}`,
        );
      const parsed = pageSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success)
        throw new Error(`The MCP catalog at ${url.origin} answered with an unexpected format.`);
      entries.push(...parsed.data.data);
      if (page >= (parsed.data.meta?.pagination.pageCount ?? 1)) return entries;
    }
  }

  async function refresh() {
    if (!options.url) return;
    const next = new Map<string, McpSuggestion>();
    for (const entry of await fetchAll(options.url)) {
      const suggestion = suggestionFrom(entry);
      if (suggestion && !next.has(suggestion.slug)) next.set(suggestion.slug, suggestion);
    }
    suggestions = [...next.values()].sort((a, b) => a.name.localeCompare(b.name));
    await mkdir(dirname(options.file), { recursive: true });
    const temporary = `${options.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(suggestions));
    await rename(temporary, options.file);
  }

  function start() {
    loaded ??= readCache().then(() =>
      refresh().catch((cause) => {
        options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
      }),
    );
    return loaded;
  }

  async function available() {
    const served = new Set(
      (await options.served()).flatMap((endpoint) => (endpoint ? [endpointKey(endpoint)] : [])),
    );
    return suggestions.filter((server) => !served.has(endpointKey(server.endpoint)));
  }

  return {
    start,
    available,
    registerRoutes(app: FastifyInstance) {
      app.get('/api/apps/mcp/registry', async () => {
        const stop = new AbortController();
        await Promise.race([
          loaded,
          delay(firstSyncWaitMs, undefined, { ref: false, signal: stop.signal }).catch(
            () => undefined,
          ),
        ]);
        stop.abort();
        return { servers: await available() };
      });
    },
  };
}
