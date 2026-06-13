## MCP

Bark supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) using the modern Streamable HTTP transport semantics, allowing AI agents (like Claude Desktop, Cherry Studio or n8n) to send notifications directly through Bark. The Worker currently returns JSON responses only and does not expose a standalone SSE stream.

### Endpoints

| Endpoint           | Description                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `/mcp`             | Generic MCP endpoint. Requires `device_key` to be provided in the tool arguments.                             |
| `/mcp/:device_key` | Device-specific MCP endpoint. The `device_key` is fixed by the URL, and the AI agent doesn't need to know it. |

`GET` and `DELETE` on these endpoints return `405 Method Not Allowed`.

If `MCP_SESSION_SECRET` is configured, `initialize` returns `Mcp-Session-Id`, which clients may reuse on later requests. Existing clients may still skip `initialize` and call tools directly for backward compatibility, so the session secret is not an access-control boundary. Use Basic Auth to restrict MCP access.

The endpoint accepts one JSON-RPC message per POST. JSON-RPC batch arrays are rejected with `400`.

### Examples

Cherry Studio:   
```json
{
  "mcpServers": {
    "bark": {
      "type": "streamableHttp",
      "url": "https://api.day.app/mcp/{key}"
    }
  }
}
```

VS Code:  
```js
{
  "servers": {
    "bark": {
      "type": "http",
      "url": "https://api.day.app/mcp/{key}"
    }
  }
}
```

Claude Code:   
```sh
claude mcp add bark --transport http https://api.day.app/mcp/{key}
```  
or  
```js
{
  "mcpServers": {
    "bark": {
      "type": "http",
      "url": "https://api.day.app/mcp/{key}"
    }
  }
}
```  
> Note: Replace {key} in the URL with your own key.
