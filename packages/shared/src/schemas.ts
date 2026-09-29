import { z } from 'zod';

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. GBP');

export const familySettingsSchema = z.object({
  familyName: z.string().min(1).max(60),
  currency: currencySchema,
  centsPerPoint: z.number().int().min(0).max(10_000),
  timezone: z.string().min(1),
});
export type FamilySettings = z.infer<typeof familySettingsSchema>;

export const healthSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptimeSeconds: z.number(),
});
export type Health = z.infer<typeof healthSchema>;

export const pingRequestSchema = z.object({
  from: z.string().min(1).max(40),
});
export type PingRequest = z.infer<typeof pingRequestSchema>;
