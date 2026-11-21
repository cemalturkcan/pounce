import type { Page as PatchrightPage } from "patchright";
import type { Page } from "playwright-core";
import type { z } from "zod";
import type { Engine } from "../config/config.ts";

const ISOLATED_WORLD = "web-agent-isolated";

export async function evaluateMain<T>(
  engine: Engine,
  page: Page,
  expression: string,
  schema: z.ZodType<T>,
): Promise<T> {
  if (engine === "patchright") {
    // SAFETY: with the patchright engine every page comes from patchright's chromium, whose evaluate takes the extra isolatedContext argument.
    const patchrightPage = page as PatchrightPage;
    return schema.parse(
      await patchrightPage.evaluate<unknown>(expression, undefined, undefined, false),
    );
  }
  return schema.parse(await page.evaluate<unknown>(expression));
}

export async function evaluateIsolated<T>(
  engine: Engine,
  page: Page,
  expression: string,
  schema: z.ZodType<T>,
): Promise<T> {
  if (engine === "patchright") return schema.parse(await page.evaluate<unknown>(expression));
  const session = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: ISOLATED_WORLD,
    });
    const evaluated = await session.send("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails)
      throw new Error(
        evaluated.exceptionDetails.exception?.description ??
          evaluated.exceptionDetails.text ??
          "evaluation failed",
      );
    return schema.parse(evaluated.result.value);
  } finally {
    await session.detach().catch(() => undefined);
  }
}
