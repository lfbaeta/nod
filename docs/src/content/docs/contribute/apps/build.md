---
title: Build your first app
description: Scaffold a remote MCP app and complete the files needed for a contribution.
sidebar:
  order: 4
---

Create an app folder with the scaffold command, then replace its unfinished fields.

## Generate the files

Replace the example address with the provider's real public MCP address. Then run this command from the repository root:

```sh
pnpm create:app my-app --name "My App" --url https://mcp.example.com/mcp --auth oauth2
```

The command rejects private, local, and reserved example addresses. It writes files only. It does not contact the provider or create a connection.

Set `--auth` to the provider's documented method: `oauth2`, `bearer`, or `x-api-key`. The command requires this choice.

```text
src/apps/my-app/
  plugin.json
  mcp.json
  io.n8n.nod/
    app.json
    contract.json
```

The command refuses to replace an existing directory. The generated read-tool placeholder deliberately fails validation until you complete it.

## Complete the manifest

Set the maintainer, description, and version in `plugin.json`. Keep its Nod reference unchanged.

Edit `io.n8n.nod/app.json`:

1. Set the display name.
2. Add concrete example requests in `prompts`.
3. State account, plan, scope, and provider-version requirements.
4. State unsupported behavior in `limitations`.
5. Add OAuth scopes only when the provider requires them.

For an icon, add `io.n8n.nod/icon.svg` and set `icon` to `./io.n8n.nod/icon.svg`. PNG and WebP are also supported. Keep the image under 128 KB. Use letters, digits, underscores, or hyphens in asset names.

Keep the generated `$schema` values. Editors that support JSON Schema use them for field completion and error checks. CI uses the same definitions.

Do not put tokens, passwords, private server addresses, or customer data in these files.

## Complete the required fixture

Edit `io.n8n.nod/contract.json`. Set `source` to the provider documentation. Replace the read-tool name and input schema with the documented contract. Use invented IDs and content for `input` and `output`.

The fixture feeds a synthetic MCP server in the shared test framework. It does not connect to the real provider. See [Test the app](/contribute/apps/test/).

## Add a guide when needed

Use `skills/<app-id>/SKILL.md` for procedures the model cannot infer from the tool definitions. Keep required `name` and `description` frontmatter. Put detailed procedures in Markdown reference files.

App skills load with Nod's other guides. Skill names must be unique across the complete library. Credentials and permissions stay in the runtime.

## Check and preview

```sh
pnpm check:apps my-app
pnpm dev
```

Open **Apps** and find the new entry. Review setup without connecting a private account. Run the docs build and preview its catalog page:

Nod reads app definitions at startup. Restart the development server after changing an app folder.

```sh
pnpm --dir docs install --frozen-lockfile
pnpm --dir docs build
pnpm --dir docs preview
```

The page appears at `/docs/connect/community-apps/my-app/`. Its social image is `social.png` under that address.

## Use an instance address

Copy n8n's connection shape when users supply their own server address. Use an owner-supplied endpoint in the Nod extension and omit `mcp.json`. See [Format reference](/contribute/apps/format/).

Only n8n currently uses private or local instance addresses. A new app cannot enable private network access through its manifest.

## Related resources

- [Build an app for Nod](/contribute/apps/)
- [Format reference](/contribute/apps/format/)
- [Test the app](/contribute/apps/test/)
