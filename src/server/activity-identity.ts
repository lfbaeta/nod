import { createHash } from 'node:crypto';
import { z } from 'zod';

export const activityIdentitySchema = z
  .object({
    objective: z.string().trim().min(1).max(500),
    sourceIds: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    connectionIds: z.array(z.uuid()).max(10).default([]),
  })
  .strict();

export type ActivityIdentity = z.infer<typeof activityIdentitySchema>;

export function canonicalActivityIdentity(input: ActivityIdentity) {
  return {
    objective: input.objective.replace(/\s+/g, ' ').trim().toLowerCase(),
    sourceIds: [...new Set(input.sourceIds.map((value) => value.trim()))].sort(),
    connectionIds: [...new Set(input.connectionIds.map((value) => value.toLowerCase()))].sort(),
  } satisfies ActivityIdentity;
}

export function activityIdentityKey(input: ActivityIdentity) {
  return `activity:${createHash('sha256')
    .update(JSON.stringify(canonicalActivityIdentity(input)))
    .digest('hex')}`;
}
