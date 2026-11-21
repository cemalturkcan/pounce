import { z } from "zod";

export const optionalString = z.string().optional().catch(undefined);
export const filledString = z.string().min(1).optional().catch(undefined);
export const optionalNumber = z.number().optional().catch(undefined);
export const textOrEmpty = z.string().catch("");
export const blockType = z.object({ type: z.string() });

export const apiErrorSchema = z.object({ type: optionalString, message: optionalString });
export type ApiError = z.infer<typeof apiErrorSchema>;
