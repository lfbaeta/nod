---
title: Plan the app
description: Choose a supported connection method and define the app's scope before you build it.
sidebar:
  order: 3
---

Use the provider's supported remote MCP server when one exists.

## Check the connection method

| Provider interface                    | Current app format                              |
| ------------------------------------- | ----------------------------------------------- |
| Fixed public HTTPS MCP address        | Supported through `mcp.json`                    |
| Owner-supplied HTTPS instance address | Supported through the Nod setup extension       |
| Local n8n instance                    | Supported through n8n's existing address checks |
| REST, GraphQL, or SDK without MCP     | Supply an MCP server first                      |
| Local stdio server or MCPB package    | Requires additional runtime support             |

Other Agent Plugins clients can support more transports. Nod checks its narrower app profile before a contribution can ship.

## Define the scope

Write down the service, users, accounts, and operations the app supports. One folder describes one service. The first version uses one fixed server or one instance setup.

Choose the smallest useful OAuth scopes. Explain any write scope. Identify paid-plan requirements, administrator restrictions, and version requirements. Check whether a disconnected or revoked account can reconnect.

Check OAuth registration and consent with Nod itself. Another client's working configuration does not prove that Nod supports the same setup. Add runtime support and tests before advertising a method the app profile cannot express.

Use a separate account for each identity. Do not make the model select or handle credentials. Nod's private setup owns credential entry and storage.

## Check the server

Confirm the exact address from provider documentation. A website home page, legacy SSE endpoint, or API root is not necessarily an MCP endpoint.

Check the server's tool names and schemas. Select one read tool for the contract fixture. Include required inputs and a synthetic response. Do not copy an account's private records into the repository.

MCP tool descriptions and read-only hints do not grant permission. Nod keeps its normal Trust checks for every app call.

## Plan the public page

Choose two to four useful example requests. State account requirements and limits. Keep these examples within the access the server actually provides.

Do not describe event monitoring, email checks, or automatic work as supported unless the connection implements the required change signals.

## Related resources

- [Build an app for Nod](/contribute/apps/)
- [Build your first app](/contribute/apps/build/)
- [Approval requirements](/contribute/apps/approval/)
