import type { OpenClawPluginApi, PluginCommandContext } from "../../src/plugins/types.js";
import { sendMessageTelegram } from "../../src/telegram/send.js";

// Store pending tool call resolutions
const pendingConfirmations = new Map<string, (approved: boolean) => void>();
let nextCallId = 1;

const plugin = {
  id: "confirmation-hook",
  name: "Sensitive Action Confirmation",
  description:
    "Intercepts and requires user confirmation for dangerous tools like exec or write_file.",
  version: "1.2.0",
  configSchema: {
    jsonSchema: {
      type: "object",
      properties: {
        sensitiveTools: {
          type: "array",
          items: {
            type: "string",
          },
          default: [
            "exec",
            "write_file",
            "delete_file",
            "append_to_file",
            "delete_files",
            "replace_file_content",
            "multi_replace_file_content",
          ],
        },
      },
      additionalProperties: false,
    },
  },
  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as { sensitiveTools?: string[] };
    const sensitiveTools = config?.sensitiveTools ?? [
      "exec",
      "write_file",
      "delete_file",
      "append_to_file",
      "delete_files",
      "replace_file_content",
      "multi_replace_file_content",
    ];

    // Command to approve a pending tool call
    api.registerCommand({
      name: "approve",
      description: "Approve a pending sensitive tool call. Usage: /approve [id]",
      acceptsArgs: true,
      handler: async (ctx: PluginCommandContext) => {
        const id = ctx.args?.trim();
        if (!id) return { text: "Please provide the confirmation ID. Usage: /approve [id]" };

        const resolver = pendingConfirmations.get(id);
        if (resolver) {
          resolver(true);
          pendingConfirmations.delete(id);
          return { text: `✅ Tool call **${id}** approved. Proceeding...` };
        }
        return { text: `❌ No pending confirmation found for ID: ${id}` };
      },
    });

    api.registerCommand({
      name: "deny",
      description: "Deny a pending sensitive tool call. Usage: /deny [id]",
      acceptsArgs: true,
      handler: async (ctx: PluginCommandContext) => {
        const id = ctx.args?.trim();
        if (!id) return { text: "Please provide the confirmation ID. Usage: /deny [id]" };

        const resolver = pendingConfirmations.get(id);
        if (resolver) {
          resolver(false);
          pendingConfirmations.delete(id);
          return { text: `🚫 Tool call **${id}** denied.` };
        }
        return { text: `❌ No pending confirmation found for ID: ${id}` };
      },
    });

    api.on("before_tool_call", async (event, ctx) => {
      if (sensitiveTools.includes(event.toolName)) {
        const callId = String(nextCallId++);

        api.logger.info(`Suspending sensitive tool call: ${event.toolName} (ID: ${callId})`);

        // Try to notify the user via Telegram if possible
        const sessionKey = ctx.sessionKey || "";
        const telegramMatch = sessionKey.match(/:telegram:[^:]+:direct:(-?\d+)/);

        if (telegramMatch) {
          const chatId = telegramMatch[1];
          try {
            await sendMessageTelegram(
              chatId,
              `⚠️ **Sensitive Action Detected**\n\nThe agent wants to use: \`${event.toolName}\`\nParameters: \`${JSON.stringify(event.params)}\`\n\nPlease confirm if you want to allow this action.`,
              {
                buttons: [
                  [
                    { text: "✅ Approve", callback_data: `/approve ${callId}` },
                    { text: "❌ Deny", callback_data: `/deny ${callId}` },
                  ],
                ],
              },
            );
          } catch (err) {
            api.logger.error(`Failed to send Telegram notification: ${err}`);
          }
        }

        const approval = new Promise<boolean>((resolve) => {
          pendingConfirmations.set(callId, resolve);

          // Set a timeout to avoid hanging forever (e.g. 10 minutes)
          setTimeout(() => {
            if (pendingConfirmations.has(callId)) {
              resolve(false);
              pendingConfirmations.delete(callId);
            }
          }, 600000);
        });

        const isApproved = await approval;

        if (!isApproved) {
          return {
            block: true,
            blockReason: `User denied or timed out confirmation for tool "${event.toolName}" (ID: ${callId}).`,
          };
        }

        // Approved! proceed with original params
        return { block: false };
      }
      return {};
    });
  },
};

export default plugin;
