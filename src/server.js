import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchDocuments } from "./search.js";

const server = new McpServer({
  name: "codex-memory",
  version: "1.0.0",
});

server.tool(
  "search_documents",
  "Searches local documents using semantic similarity",
  {
    query: z.string().min(1),
    topK: z.number().int().min(1).max(10).default(5),
  },
  async ({ query, topK }) => {
    const results = await searchDocuments(query, topK);

    const text = results
      .map((result, index) => {
        return [
          `--- Result ${index + 1} ---`,
          `Text: ${result.text}`,
          `Source: ${result.sourceFile}`,
          `Distance: ${result._distance}`,
        ].join("\n");
      })
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: text || "No matching documents found.",
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();

await server.connect(transport);