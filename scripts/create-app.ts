import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isIP } from 'node:net';
import {
  appConnectionSchema,
  appSchemaId,
  appContractSchemaId,
  type AppDefinitionInput,
  type AppManifest,
  type AppMcpConfig,
  type AppContract,
} from '../src/shared/app-definitions.ts';

export async function createApp(
  slug: string,
  options: { url: string; name?: string; auth: string; directory?: string },
) {
  if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(slug) || /--/.test(slug))
    throw new Error(
      'Use two to 40 lowercase letters, digits, or single hyphens. Start with a letter and end with a letter or digit.',
    );
  const url = URL.parse(options.url);
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    /[?#]/.test(options.url) ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|example|example\.(?:com|org|net))$/.test(
      url.hostname.replace(/\.$/, ''),
    )
  )
    throw new Error(
      'Enter the public HTTPS MCP address without credentials, a query, or a fragment.',
    );
  const connection = appConnectionSchema.safeParse({
    type: 'mcp',
    server: slug,
    authentication: [options.auth],
  });
  if (!connection.success) throw new Error('Select oauth2, bearer, or x-api-key authentication.');
  const name = (options.name ?? slug).trim();
  if (!name || name.length > 80) throw new Error('Enter an app name with one to 80 characters.');
  const root = resolve(
    options.directory ?? fileURLToPath(new URL('../src/apps/', import.meta.url)),
  );
  const directory = join(root, slug);
  await mkdir(root, { recursive: true });
  await mkdir(directory);
  await mkdir(join(directory, 'io.n8n.nod'));
  const files = {
    'plugin.json': {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: slug,
      version: '0.1.0',
      description: `Connect ${name} to Nod.`,
      license: 'Apache-2.0',
      author: { name: 'Replace with the maintainer name' },
      extensions: {
        'io.n8n.nod': { app: './io.n8n.nod/app.json' },
      },
    } satisfies AppManifest,
    'mcp.json': {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { [slug]: { type: 'streamable-http', url: url.href } },
    } satisfies AppMcpConfig,
    'io.n8n.nod/app.json': {
      $schema: appSchemaId,
      displayName: name,
      prompts: [`Find a record in ${name}.`, `Summarize a record in ${name}.`],
      requirements: ['Replace with the required account plan and permissions.'],
      limitations: ['Replace with the limits of this connection.'],
      connection: connection.data,
    } satisfies AppDefinitionInput,
    'io.n8n.nod/contract.json': {
      $schema: appContractSchemaId,
      source: 'https://example.com/replace-with-provider-docs',
      tool: {
        name: 'replace_with_read_tool',
        description: 'Replace with the documented read tool.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        annotations: { readOnlyHint: true },
      },
      input: { query: 'synthetic example' },
      output: { records: [{ id: 'synthetic-record', title: 'Sample record' }] },
    } satisfies AppContract,
  };
  for (const [path, value] of Object.entries(files))
    await writeFile(join(directory, path), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  return directory;
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      name: { type: 'string' },
      auth: { type: 'string' },
      directory: { type: 'string' },
    },
  });
  if (positionals.length !== 1 || !values.url || !values.auth)
    throw new Error(
      'Use pnpm create:app <app-id> --url <public-mcp-url> --auth oauth2|bearer|x-api-key [--name <display-name>].',
    );
  const directory = await createApp(positionals[0], {
    ...values,
    url: values.url,
    auth: values.auth,
  });
  console.log(
    `Created ${directory}. Replace the maintainer, requirements, limits, provider documentation, and read tool fixture. Then run pnpm check:apps ${positionals[0]}.`,
  );
}
