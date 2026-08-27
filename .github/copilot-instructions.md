# CodeGraph MCP server

Use the TypeScript MCP SDK documentation at https://modelcontextprotocol.io/llms-full.txt for server and tool patterns.

The graph database is Kuzu. Use the `kuzu` package at the locked version in `package.json`. Preserve the MCP server's read-only tool boundary: do not expose arbitrary Cypher supplied by an MCP client.
