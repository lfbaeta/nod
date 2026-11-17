---
title: App format reference
description: The supported Agent Plugins fields, Nod extension, and mandatory contract fixture.
sidebar:
  order: 5
---

Every shipped app must pass the Agent Plugins schemas and Nod's app profile.

## Standards used

| Standard                                                                       | Purpose                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [Agent Plugins 1.0.0](https://agent-plugins.org/specification)                 | Folder layout, manifest, MCP configuration, and client extensions |
| [Model Context Protocol](https://modelcontextprotocol.io/specification/latest) | Tool discovery, calls, responses, and OAuth setup                 |
| [Agent Skills](https://agentskills.io/specification)                           | Optional instructions and reference files                         |
| [Semantic Versioning](https://semver.org/)                                     | App definition versions                                           |

Nod adds display fields, private setup choices, required fixtures, and approval rules. A plugin for another client can use features outside this profile. Check this reference before copying a Codex or Claude plugin.

## Folder and package identity

Use `src/apps/<app-id>/plugin.json`. The folder and manifest `name` must match. Nod app IDs use two to 40 lowercase letters, digits, or single hyphens. Start with a letter and end with a letter or digit. Agent Plugins itself permits a broader name format.

Set `$schema` to `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`. Nod also requires a semantic `version` and a non-empty `description` of up to 1,000 characters.

Set `author.name` to the maintainer's public name or organization. Complete every generated placeholder before submission.

The standard root fields are `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, and `extensions`. Shipped app checks reject unknown root fields. Keep Nod data under `extensions.io.n8n.nod`.

The canonical schemas are bundled in `src/server/agent-plugins/`. The loader does not download schemas. Schema sources are the [manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json) and [MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json).

## Nod extension

| Field          | Requirement                                                          |
| -------------- | -------------------------------------------------------------------- |
| `displayName`  | Required display name, up to 80 characters                           |
| `icon`         | Optional path under `./io.n8n.nod/`; SVG, PNG, or WebP, up to 128 KB |
| `categories`   | Optional array of up to 10 category names                            |
| `prompts`      | Two to four concrete example requests                                |
| `requirements` | One to eight account, plan, scope, or version requirements           |
| `limitations`  | One to eight statements of unsupported or restricted behavior        |
| `connection`   | Required MCP connection definition                                   |

Unknown Nod extension fields fail validation. Other client extension namespaces keep their own meaning.

## Fixed MCP address

Select one named server from `mcp.json`:

```json
{
  "type": "mcp",
  "server": "my-app",
  "authentication": ["oauth2"],
  "scopes": ["read"]
}
```

The `scopes` field is optional. Fixed connections select one authentication method: `oauth2`, `bearer`, or `x-api-key`. Nod sends API keys in `X-API-Key`.

`mcp.json` must target the matching Agent Plugins schema version. It must contain exactly one server with `type: "streamable-http"`. Its address must be public HTTPS without credentials, a query, or a fragment. DNS and network checks also run when Nod connects.

Static headers, stdio servers, and legacy SSE servers are outside the current Nod app profile. A schema-valid Agent Plugin can still use features Nod does not support.

## Owner-supplied instance

Use this connection shape and omit `mcp.json`:

```json
{
  "type": "mcp",
  "endpoint": {
    "source": "owner",
    "path": "/mcp-server/http"
  },
  "authentication": ["oauth2", "bearer"]
}
```

The path contains slash-separated letters, digits, underscores, and hyphens. Nod appends it to the address the user enters. Fixed scopes are not supported for this setup.

Nod applies its address policy outside the manifest. Only n8n has the existing local-address exception and fixed localhost probe. Tokens go only to the saved address.

## Required contract fixture

Every folder includes `io.n8n.nod/contract.json`:

```json
{
  "source": "https://provider.example/docs/mcp",
  "tool": {
    "name": "find_records",
    "description": "Find records by a query.",
    "inputSchema": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"]
    },
    "annotations": { "readOnlyHint": true }
  },
  "input": { "query": "synthetic example" },
  "output": { "records": [{ "id": "synthetic-record" }] }
}
```

Use a documented read tool. `input` must match its schema. `output` must contain synthetic JSON data. Objects, arrays, strings, numbers, booleans, and null are supported. The read-only hint describes the fixture; it does not bypass Trust.

The fixture exercises Nod's MCP transport. It does not prove the external server still offers that tool. Provider acceptance remains a separate review requirement.

## Optional skills

Put each skill in `skills/<skill-name>/SKILL.md`, with Agent Skills frontmatter. Files must remain inside their skill directory after link resolution. The current loader supports Markdown guides and references. It does not install or execute skill scripts.

## Related resources

- [Build an app for Nod](/contribute/apps/)
- [Test the app](/contribute/apps/test/)
- [Agent Plugins specification](https://agent-plugins.org/specification)
