import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Compile } from 'typebox/compile';
import {
  appDefinitionSchema,
  appContractSchema,
  appExtensionSchema,
  type AppContract,
} from '../shared/app-definitions.ts';
import pluginSchema from './agent-plugins/plugin.schema.json' with { type: 'json' };
import mcpSchema from './agent-plugins/mcp.schema.json' with { type: 'json' };

const manifestCheck = Compile(pluginSchema as Parameters<typeof Compile>[0]);
const mcpCheck = Compile(mcpSchema as Parameters<typeof Compile>[0]);
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
  contract: AppContract;
}

export function loadAppCatalog(directory = fileURLToPath(new URL('../apps/', import.meta.url))) {
  const root = realpathSync(directory);
  const result = new Map<string, BundledApp>();
  for (const entry of readdirSync(root, { withFileTypes: true })
    .filter((item) => !item.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))) {
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
    if (
      manifest.name !== entry.name ||
      !/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(manifest.name) ||
      /--/.test(manifest.name)
    )
      throw new Error(
        `App ${entry.name}: name must match its folder and use two to 40 lowercase letters, digits, or single hyphens. Start with a letter and end with a letter or digit.`,
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
    const extension = appExtensionSchema.safeParse(manifest.extensions?.['io.n8n.nod']);
    if (!extension.success)
      throw new Error(
        `App ${entry.name}: invalid io.n8n.nod reference: ${extension.error.message}`,
      );
    const parsed = appDefinitionSchema.safeParse(json('io.n8n.nod/app.json'));
    if (!parsed.success)
      throw new Error(`App ${entry.name}: invalid app.json: ${parsed.error.message}`);
    const app = parsed.data;
    const contract = appContractSchema.safeParse(json('io.n8n.nod/contract.json'));
    if (!contract.success)
      throw new Error(`App ${entry.name}: invalid contract.json: ${contract.error.message}`);
    if (
      !manifest.author?.name?.trim() ||
      JSON.stringify({ manifest, app }).includes('Replace with') ||
      contract.data.source.includes('replace-with-')
    )
      throw new Error(
        `App ${entry.name}: complete the maintainer, provider documentation, requirements, and limits.`,
      );
    const connection = app.connection;
    const instance = 'endpoint' in connection;
    const scopes = 'scopes' in connection ? connection.scopes : undefined;
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
      const selected = mcp.mcpServers[!instance ? connection.server : ''];
      if (!selected || selected.type !== 'streamable-http')
        throw new Error(`App ${entry.name}: the selected server must use streamable-http.`);
      const url = URL.parse(selected.url);
      if (
        !url ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        /[?#]/.test(selected.url) ||
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
      ...(instance ? { instancePath: connection.endpoint.path } : {}),
      ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
      ...(icon ? { icon } : {}),
      ...(skills ? { skills } : {}),
      contract: contract.data,
    });
  }
  return result;
}

export const bundledApps = loadAppCatalog();
