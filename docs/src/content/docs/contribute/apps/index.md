---
title: Build an app for Nod
description: Create, test, and submit an app connection for Nod.
sidebar:
  label: Overview
  order: 2
---

Add an app folder, run the required checks, and submit a pull request.

This guide is for community contributors and partners. An app is a service listed in **Apps**. A connection is one account or instance of that service. Nod stores account credentials separately from the app files.

App folders use [Agent Plugins 1.0.0](https://agent-plugins.org/specification). The `io.n8n.nod` extension supplies Nod's display and setup fields. The current format supports remote MCP servers and owner-supplied instance addresses. It does not execute package code or install dependencies.

## Before you start

- Set up a [source install](/get-started/install-from-source/).
- Learn the provider's MCP address, authentication methods, scopes, and limits.
- Find a documented read tool for the required synthetic fixture.
- Check the [app catalog](/connect/community-apps/) for an existing connection.

You do not need to write TypeScript for a supported MCP connection. A service without MCP needs an MCP server before it can use this format.

## Build and submit

| Step                                | Guide                                             |
| ----------------------------------- | ------------------------------------------------- |
| Choose the access method and scope  | [Plan the app](/contribute/apps/plan/)            |
| Generate and complete an app folder | [Build your first app](/contribute/apps/build/)   |
| Check every field                   | [Format reference](/contribute/apps/format/)      |
| Run the required offline checks     | [Test the app](/contribute/apps/test/)            |
| Meet the review requirements        | [Get an app approved](/contribute/apps/approval/) |
| Use an AI coding agent              | [Build with AI](/contribute/apps/build-with-ai/)  |

## What a contribution creates

The folder supplies the app card and connection setup. The same metadata supplies a public docs page and a social preview image. The docs build adds the app to the catalog automatically.

Nod's n8n, Linear, and Notion folders are working source examples. They use the same loader and checks as community contributions.

## Related resources

- [Contribute to Nod](/contribute/)
- [Browse custom apps](/connect/community-apps/)
- [MCP servers, APIs and CLIs](/connect/mcp-api-cli/)
