import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@nexus/core";

export class McpClientManager {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(serverCommand: string, serverArgs: string[]) {
    this.transport = new StdioClientTransport({
      command: serverCommand,
      args: serverArgs,
    });
    
    this.client = new Client({
      name: "nexus-mcp-client",
      version: "1.0.0",
    }, {
      capabilities: {}
    });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async getTools(): Promise<Tool[]> {
    const response = await this.client.listTools();
    
    return response.tools.map((mcpTool: any) => ({
      schema: {
        name: mcpTool.name,
        description: mcpTool.description || "MCP Extracted Tool",
        parameters: mcpTool.inputSchema as Record<string, any>,
      },
      execute: async (args: any) => {
        try {
          const result = await this.client.callTool({
            name: mcpTool.name,
            arguments: args
          }) as any;
          
          if (result.isError) {
            return JSON.stringify({ error: result.content.map((c: any) => c.type === 'text' ? c.text : '').join('\n') });
          }
          
          return JSON.stringify({ data: result.content.map((c: any) => c.type === 'text' ? c.text : '').join('\n') });
        } catch (err: any) {
          return JSON.stringify({ error: err.message });
        }
      }
    }));
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }
}
