import type { OpenClawPluginDefinition } from "./types.js";

// This plugin intercepts "exec" and "write" to ask for user approval
export const confirmationHookPlugin: OpenClawPluginDefinition = {
  name: "confirmation-hook",
  version: "1.0.0",
  register(api) {
    api.on("before_tool_call", async (event, _ctx) => {
      const sensitiveTools = ["exec", "write_file", "delete_file", "append_to_file"];

      if (sensitiveTools.includes(event.toolName)) {
        // Here we would use the inbound confirmation flow
        // For demonstration, we block it directly if there's no pre-approval
        const message = `Confirmation required for tool "${event.toolName}". \n\nPlease respond with 'yes' to confirm or 'no' to deny.`;

        return {
          block: true,
          blockReason: message,
        };
      }

      return {};
    });
  },
};
