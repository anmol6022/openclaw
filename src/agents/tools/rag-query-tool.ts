import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { getRagService } from "../../rag/rag-service.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

export type RagQueryToolOptions = {
  agentAccountId?: string;
  config?: OpenClawConfig;
};

/**
 * Tool for querying the processed knowledge base (RAG).
 * This allows the agent to explicitly search through documents previously indexed via /upload.
 */
export function createRagQueryTool(options?: RagQueryToolOptions): AnyAgentTool {
  return {
    label: "Query Knowledge Base",
    name: "query_knowledge_base",
    description:
      "Search the knowledge base for relevant information previously indexed from uploaded documents and files.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query to find relevant information." }),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of results to return (default: 3).",
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const query = readStringParam(args as Record<string, unknown>, "query", { required: true });
      const limit = (args.limit as number) ?? 3;

      const accountId = options?.agentAccountId;
      if (!accountId) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No account ID available for knowledge base query. Please ensure you are in a user context.",
            },
          ],
          details: { error: "no-account-id" },
        };
      }

      if (!options?.config) {
        return {
          content: [{ type: "text", text: "Error: Configuration is missing." }],
          details: { error: "no-config" },
        };
      }
      const ragService = getRagService(options.config);
      const result = await ragService.queryDocuments(accountId, query, limit);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
        details: { query, limit, accountId },
      };
    },
  };
}
