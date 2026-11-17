---
name: create-nod-app
description: Create or update a Nod app folder, its required synthetic contract fixture, and its public docs listing. Use for community or partner app contributions in the Nod repository.
---

Build the app in the Nod repository. Read `AGENTS.md` and `docs/src/content/docs/contribute/apps/index.md` first. Read the format, testing, and approval pages before editing a connection.

Use official provider documentation for the MCP address, authentication, scopes, required plan, and read-tool contract. Do not guess a server address or claim an API is MCP. State any required MCP server work before proceeding with an unsupported service.

Use `pnpm create:app <app-id> --name <display-name> --url <public-mcp-url> --auth <oauth2|bearer|x-api-key>` for a fixed server. Select the authentication method from the provider documentation. Use n8n's existing app folder as the source example for owner-supplied instances. Keep the app ID stable when changing an existing app.

Complete all generated fields. Add concrete prompts, requirements, limits, maintainer details, and a synthetic read fixture. Use the documented tool name and input schema. Keep credentials and private content out of files and prompts.

Keep changes in the app folder unless the shared runtime needs a new supported behavior. Do not add a service-name branch to make a folder work. Do not weaken URL checks, Trust, credential removal, or account ownership checks.

Run `pnpm check:apps` and the relevant integration tests. Use only synthetic data and disposable database schemas. Report skipped checks. Never use a live model, saved account, or real recipient in automated tests.

The docs catalog and app page come from the manifest. Build the docs and inspect the app page and its `social.png` at desktop and mobile widths. Check the card text and image crop.

Provider acceptance is a separate maintainer step. Do not claim it passed from offline fixtures. Report the checks run, their results, supported scope, and the remaining provider acceptance work. AI output and passing tests do not grant approval. Do not push, publish, or post to social media without explicit authorization.
