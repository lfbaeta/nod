import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Compile } from 'typebox/compile';
import { z } from 'zod';
import type { DiscoveredTool } from '../ports/discovered.ts';
import pluginSchema from './agent-plugins/plugin.schema.json' with { type: 'json' };
import mcpSchema from './agent-plugins/mcp.schema.json' with { type: 'json' };

const manifestCheck = Compile(pluginSchema as Parameters<typeof Compile>[0]);
const mcpCheck = Compile(mcpSchema as Parameters<typeof Compile>[0]);
const connectionSchema = z
  .object({
    type: z.literal('mcp'),
    server: z.string().min(1).max(80).optional(),
    endpoint: z
      .object({
        source: z.literal('owner'),
        path: z.string().regex(/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/),
      })
      .strict()
      .optional(),
    authentication: z
      .array(z.enum(['oauth2', 'bearer', 'x-api-key']))
      .min(1)
      .max(2),
    scopes: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  })
  .strict();
const appSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    icon: z.string().optional(),
    categories: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
    prompts: z.array(z.string().trim().min(1).max(240)).min(2).max(4),
    requirements: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
    limitations: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
    connection: connectionSchema,
  })
  .strict();

export interface BundledApp {
  slug: string;
  name: string;
  description: string;
  categories: string[];
  endpoint?: string;
  instancePath?: string;
  auth: 'oauth' | 'bearer' | 'x-api-key';
  scope?: string;
  icon?: { bytes: Uint8Array; mimeType: string };
  skills?: string;
  contract: {
    source: string;
    tool: DiscoveredTool;
    input: Record<string, unknown>;
    output: unknown;
  };
}

export function loadAppCatalog(directory = fileURLToPath(new URL('../apps/', import.meta.url))) {
  const root = realpathSync(directory);
  const result = new Map<string, BundledApp>();
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory())
      throw new Error(`App ${entry.name}: use one directory per app without symbolic links.`);
    const base = realpathSync(resolve(root, entry.name));
    if (!base.startsWith(root + sep))
      throw new Error(`App ${entry.name}: the directory leaves the app catalog.`);
    function file(path: string) {
      const target = realpathSync(resolve(base, path));
      if (!target.startsWith(base + sep))
        throw new Error(`App ${entry.name}: ${path} leaves the app directory.`);
      if (!statSync(target).isFile())
        throw new Error(`App ${entry.name}: ${path} must be a regular file.`);
      return target;
    }
    function json(path: string) {
      try {
        return JSON.parse(readFileSync(file(path), 'utf8'));
      } catch (cause) {
        const reason =
          cause instanceof SyntaxError
            ? `invalid JSON${/position \d+/.exec(cause.message)?.[0] ? ` at ${/position \d+/.exec(cause.message)![0]}` : ''}`
            : cause instanceof Error
              ? cause.message
              : 'unknown file error';
        throw new Error(`App ${entry.name}: could not read ${path}: ${reason}`);
      }
    }
    const rawManifest = json('plugin.json');
    if (!manifestCheck.Check(rawManifest))
      throw new Error(
        `App ${entry.name}: plugin.json does not match Agent Plugins 1.0.0: ${manifestCheck
          .Errors(rawManifest)
          .slice(0, 3)
          .map((error) => `${error.instancePath || '/'} ${error.message}`)
          .join('; ')}`,
      );
    const manifest = rawManifest as {
      name: string;
      version?: string;
      description?: string;
      extensions?: Record<string, unknown>;
      author?: { name?: string };
    };
    if (manifest.name !== entry.name || !/^[a-z][a-z0-9-]{1,39}$/.test(manifest.name))
      throw new Error(
        `App ${entry.name}: name must match its folder and use two to 40 lowercase letters, digits, or hyphens.`,
      );
    if (
      typeof manifest.version !== 'string' ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(
        manifest.version,
      )
    )
      throw new Error(`App ${entry.name}: set a semantic version in plugin.json.`);
    if (
      typeof manifest.description !== 'string' ||
      !manifest.description.trim() ||
      manifest.description.length > 1000
    )
      throw new Error(`App ${entry.name}: add a description of up to 1,000 characters.`);
    const parsed = appSchema.safeParse(manifest.extensions?.['io.n8n.nod']);
    if (!parsed.success)
      throw new Error(`App ${entry.name}: invalid io.n8n.nod settings: ${parsed.error.message}`);
    const app = parsed.data;
    const contract = z
      .object({
        source: z.url({ protocol: /^https$/ }),
        tool: z
          .object({
            name: z
              .string()
              .min(1)
              .max(100)
              .refine((name) => !name.startsWith('replace_')),
            description: z.string().min(1).max(2000),
            inputSchema: z.record(z.string(), z.unknown()),
            annotations: z.object({ readOnlyHint: z.literal(true) }).strict(),
          })
          .strict(),
        input: z.record(z.string(), z.unknown()),
        output: z.union([
          z.record(z.string(), z.unknown()),
          z.array(z.unknown()),
          z.string(),
          z.number(),
          z.boolean(),
          z.null(),
        ]),
      })
      .strict()
      .safeParse(json('io.n8n.nod/contract.json'));
    if (!contract.success)
      throw new Error(`App ${entry.name}: invalid contract.json: ${contract.error.message}`);
    if (
      !manifest.author?.name?.trim() ||
      JSON.stringify(manifest).includes('Replace with') ||
      contract.data.source.includes('replace-with-')
    )
      throw new Error(
        `App ${entry.name}: complete the maintainer, provider documentation, requirements, and limits.`,
      );
    const connection = app.connection;
    if (Boolean(connection.server) === Boolean(connection.endpoint))
      throw new Error(`App ${entry.name}: select one MCP server or one owner-supplied endpoint.`);
    const instance = Boolean(connection.endpoint);
    if (!instance && connection.authentication[0] !== 'oauth2' && connection.scopes?.length)
      throw new Error(`App ${entry.name}: OAuth scopes require OAuth authentication.`);
    if (
      new Set(connection.authentication).size !== connection.authentication.length ||
      (instance
        ? !connection.authentication.includes('oauth2') ||
          !connection.authentication.includes('bearer') ||
          Boolean(connection.scopes?.length)
        : connection.authentication.length !== 1)
    )
      throw new Error(
        `App ${entry.name}: fixed servers need one authentication method; instance setup needs OAuth and bearer authentication without fixed scopes.`,
      );
    let server: { url: string } | undefined;
    if (existsSync(resolve(base, 'mcp.json'))) {
      const rawMcp = json('mcp.json');
      if (!mcpCheck.Check(rawMcp))
        throw new Error(
          `App ${entry.name}: mcp.json does not match Agent Plugins 1.0.0: ${mcpCheck
            .Errors(rawMcp)
            .slice(0, 3)
            .map((error) => `${error.instancePath || '/'} ${error.message}`)
            .join('; ')}`,
        );
      const mcp = rawMcp as {
        mcpServers: Record<string, { type: string; url: string; headers?: Record<string, string> }>;
      };
      if (instance || Object.keys(mcp.mcpServers).length !== 1)
        throw new Error(
          `App ${entry.name}: fixed apps need one MCP server; owner-supplied endpoints must omit mcp.json.`,
        );
      const selected = mcp.mcpServers[connection.server!];
      if (!selected || selected.type !== 'streamable-http')
        throw new Error(`App ${entry.name}: the selected server must use streamable-http.`);
      const url = URL.parse(selected.url);
      if (
        !url ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
        /(?:^|\.)(?:localhost|local|internal|invalid|test|example|example\.(?:com|org|net))$/.test(
          url.hostname.replace(/\.$/, ''),
        )
      )
        throw new Error(
          `App ${entry.name}: use a fixed public HTTPS MCP address without credentials, a query, or a fragment.`,
        );
      if (Object.keys(selected.headers ?? {}).length)
        throw new Error(
          `App ${entry.name}: fixed MCP headers are not supported. Use private connection setup for credentials.`,
        );
      server = { url: url.href };
    } else if (!instance)
      throw new Error(`App ${entry.name}: add mcp.json for the selected server.`);
    let icon: BundledApp['icon'];
    if (app.icon) {
      if (!app.icon.startsWith('./io.n8n.nod/'))
        throw new Error(`App ${entry.name}: keep the icon in ./io.n8n.nod/.`);
      const mimeType = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }[
        extname(app.icon)
      ];
      const bytes = readFileSync(file(app.icon));
      if (!mimeType || bytes.length === 0 || bytes.length > 128 * 1024)
        throw new Error(`App ${entry.name}: use an SVG, PNG, or WebP icon of up to 128 KB.`);
      icon = { bytes, mimeType };
    }
    let skills: string | undefined;
    if (existsSync(resolve(base, 'skills'))) {
      skills = realpathSync(resolve(base, 'skills'));
      if (!skills.startsWith(base + sep) || !statSync(skills).isDirectory())
        throw new Error(`App ${entry.name}: skills must be a directory inside the app.`);
    }
    result.set(manifest.name, {
      slug: manifest.name,
      name: app.displayName,
      description: manifest.description.trim(),
      categories: app.categories,
      auth: connection.authentication[0] === 'oauth2' ? 'oauth' : connection.authentication[0],
      ...(server ? { endpoint: server.url } : {}),
      ...(connection.endpoint ? { instancePath: connection.endpoint.path } : {}),
      ...(connection.scopes?.length ? { scope: connection.scopes.join(' ') } : {}),
      ...(icon ? { icon } : {}),
      ...(skills ? { skills } : {}),
      contract: contract.data,
    });
  }
  return result;
}

export const bundledApps = loadAppCatalog();
