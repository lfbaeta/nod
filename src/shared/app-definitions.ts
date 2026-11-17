import { z } from 'zod';

export const appSchemaId = 'https://nod.n8n.io/docs/schemas/apps/v1/app.schema.json';
export const appContractSchemaId = 'https://nod.n8n.io/docs/schemas/apps/v1/contract.schema.json';

export const appExtensionSchema = z.strictObject({ app: z.literal('./io.n8n.nod/app.json') });

const fixedServer = { type: z.literal('mcp'), server: z.string().trim().min(1).max(80) };

export const appConnectionSchema = z.union([
  z.strictObject({
    ...fixedServer,
    authentication: z.tuple([z.literal('oauth2')]),
    scopes: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  }),
  z.strictObject({
    ...fixedServer,
    authentication: z.tuple([z.enum(['bearer', 'x-api-key'])]),
  }),
  z.strictObject({
    type: z.literal('mcp'),
    endpoint: z.strictObject({
      source: z.literal('owner'),
      path: z.string().regex(/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/),
    }),
    authentication: z.tuple([z.literal('oauth2'), z.literal('bearer')]),
  }),
]);

export const appDefinitionSchema = z.strictObject({
  $schema: z.literal(appSchemaId),
  displayName: z.string().trim().min(1).max(80),
  icon: z
    .string()
    .regex(/^\.\/io\.n8n\.nod\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:svg|png|webp)$/)
    .optional(),
  categories: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
  prompts: z.array(z.string().trim().min(1).max(240)).min(2).max(4),
  requirements: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  limitations: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  connection: appConnectionSchema,
});

export const appContractSchema = z.strictObject({
  $schema: z.literal(appContractSchemaId),
  source: z.url().regex(/^[hH][tT][tT][pP][sS]:\/\//),
  tool: z.strictObject({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^(?!replace_)/),
    description: z.string().min(1).max(2000),
    inputSchema: z.object({ type: z.literal('object') }).catchall(z.json()),
    annotations: z.strictObject({ readOnlyHint: z.literal(true) }),
  }),
  input: z.record(z.string(), z.json()),
  output: z.json(),
});

export type AppDefinition = z.output<typeof appDefinitionSchema>;
export type AppDefinitionInput = z.input<typeof appDefinitionSchema>;
export type AppContract = z.output<typeof appContractSchema>;

export interface AppManifest {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
  name: string;
  version: string;
  description: string;
  author: { name: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions: { 'io.n8n.nod': z.output<typeof appExtensionSchema> } & Record<
    string,
    Record<string, unknown>
  >;
}

export interface AppMcpConfig {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
  mcpServers: Record<string, { type: 'streamable-http'; url: string }>;
}
