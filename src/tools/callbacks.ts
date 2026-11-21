import type { ToolCallback, ToolDeps } from "./common.ts";
import { recordedTools } from "./register.ts";

export function collectToolCallbacks(deps: ToolDeps) {
  return new Map<string, ToolCallback>(
    recordedTools(deps).map(({ name, config, callback }) => {
      const schema = config.inputSchema;
      return [
        name,
        {
          schema,
          call: async (input, extra) => {
            const parsed = schema.safeParse(input);
            if (!parsed.success)
              return {
                content: [
                  {
                    type: "text",
                    text: `Invalid input for ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`,
                  },
                ],
                isError: true,
              };
            return callback(parsed.data, extra);
          },
        },
      ];
    }),
  );
}
