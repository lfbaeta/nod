import assert from 'node:assert/strict';
import { Compile } from 'typebox/compile';
import { bundledApps, type BundledApp } from '../src/server/app-catalog.ts';
import { createDiscoveredTransport } from '../src/providers/discovered/remote.ts';
import { createSkillLibrary } from '../src/providers/pi/skills.ts';
import { withoutSchemaPatterns } from '../src/shared/json-schema.ts';
import { coreSkills } from '../src/runtime/prompt.ts';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';

export async function checkAppContract(app: BundledApp) {
  const { contract } = app;
  const schema = withoutSchemaPatterns(contract.tool.inputSchema) as Record<string, unknown>;
  assert.equal(schema.type, 'object', `${app.slug}: the read tool needs an object input schema.`);
  assert(
    Compile(schema as Parameters<typeof Compile>[0]).Check(contract.input),
    `${app.slug}: the sample input does not match the tool schema.`,
  );
  const endpoint = app.endpoint ?? `https://instance.example.test${app.instancePath}`;
  const credential = 'synthetic-app-contract-token';
  const headers: Record<string, string> =
    app.auth === 'x-api-key'
      ? { 'X-API-Key': credential }
      : { Authorization: `Bearer ${credential}` };
  let failure: 'tool' | 'permission' | 'rate' | undefined;
  let calls = 0;
  const transport = createDiscoveredTransport(
    async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, endpoint, `${app.slug}: a request left the configured endpoint.`);
      assert.equal(
        request.headers.get(app.auth === 'x-api-key' ? 'x-api-key' : 'authorization'),
        app.auth === 'x-api-key' ? credential : `Bearer ${credential}`,
      );
      if (request.method === 'GET') return new Response(null, { status: 405 });
      if (request.method === 'DELETE') return new Response(null, { status: 200 });
      const message = JSON.parse(await request.text());
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === 'tools/call') {
        calls++;
        assert.equal(message.params.name, contract.tool.name);
        assert.deepEqual(message.params.arguments, contract.input);
        if (failure === 'permission' || failure === 'rate')
          return Response.json(
            {
              error:
                failure === 'permission' ? 'synthetic_permission_denied' : 'synthetic_rate_limit',
            },
            { status: failure === 'permission' ? 403 : 429 },
          );
      }
      let result;
      if (message.method === 'initialize')
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: `synthetic-${app.slug}`, version: '1.0.0' },
        };
      else if (message.method === 'tools/list') result = { tools: [contract.tool] };
      else {
        assert.equal(message.method, 'tools/call');
        result =
          failure === 'tool'
            ? { isError: true, content: [{ type: 'text', text: 'synthetic_record_unavailable' }] }
            : { content: [{ type: 'text', text: JSON.stringify(contract.output) }] };
      }
      return Response.json({ jsonrpc: '2.0', id: message.id, result });
    },
    async (value) => {
      assert.equal(value, endpoint);
      return value;
    },
  );
  const listed = await transport.listTools(endpoint, headers);
  assert(
    listed.tools.some((tool) => tool.name === contract.tool.name),
    `${app.slug}: the read tool was not discovered.`,
  );
  const result = (await transport.callTool(
    endpoint,
    headers,
    contract.tool.name,
    contract.input,
  )) as { content: Array<{ text: string }> };
  assert.deepEqual(JSON.parse(result.content[0].text), contract.output);
  for (const mode of ['tool', 'permission', 'rate'] as const) {
    failure = mode;
    const before = calls;
    await assert.rejects(
      transport.callTool(endpoint, headers, contract.tool.name, contract.input),
      mode === 'tool'
        ? /synthetic_record_unavailable/
        : mode === 'permission'
          ? /synthetic_permission_denied/
          : /synthetic_rate_limit/,
    );
    assert.equal(calls, before + 1, `${app.slug}: a failed call was sent more than once.`);
  }
  const stopped = new AbortController();
  stopped.abort(new Error('synthetic_stop'));
  const before = calls;
  await assert.rejects(
    transport.callTool(endpoint, headers, contract.tool.name, contract.input, stopped.signal),
    /synthetic_stop/,
  );
  assert.equal(calls, before, `${app.slug}: a stopped call reached the provider.`);
}

if (import.meta.main) {
  const selected = process.argv[2];
  const apps = selected ? [bundledApps.get(selected)] : [...bundledApps.values()];
  if (apps.some((app) => !app)) throw new Error(`App ${selected} was not found.`);
  const library = createSkillLibrary(
    [
      fileURLToPath(new URL('../src/runtime/skills/', import.meta.url)),
      ...[...bundledApps.values()].flatMap((app) => (app.skills ? [app.skills] : [])),
    ],
    coreSkills,
  );
  for (const skill of library.catalog) {
    const pending = ['SKILL.md'];
    const checked = new Set<string>();
    while (pending.length) {
      const path = pending.pop()!;
      if (checked.has(path)) continue;
      checked.add(path);
      const { content } = library.read(skill.name, path);
      for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+\.md(?:#[^)\s]*)?)\)/g)) {
        if (/^[a-z]+:|^\//i.test(match[1])) continue;
        pending.push(posix.join(posix.dirname(path), decodeURIComponent(match[1].split('#')[0])));
      }
    }
  }
  for (const app of apps as BundledApp[]) {
    await checkAppContract(app);
    console.log(`${app.slug}: format, discovery, read, errors, rate limit, and Stop passed.`);
  }
}
