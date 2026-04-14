import { z } from "zod";

const MetadataSchema = z.record(z.string()).refine((val) => Object.keys(val).length <= 5, {
  message: "Metadata cannot exceed 5 keys",
}).optional();

export const AgentMessageSchema = z.discriminatedUnion("type", [
  // Offer / Counter / Accept (Structured Negotiation)
  z.object({
    version: z.literal("1.0"),
    type: z.enum(["offer", "counter", "accept"]),
    ticket_id: z.string().max(64).optional(),
    agent_id: z.string().max(64),
    timestamp: z.number().int().positive(),
    price: z.number().positive(),
    collateral_buyer: z.number().nonnegative(),
    collateral_seller: z.number().nonnegative(),
    asset_type: z.string().regex(/^[a-z0-9_]+$/).max(50),
    asset_description: z.string().max(512).optional(),
    signature: z.string().max(256).optional(), // Forward compatible for wallet signature tasks
    metadata: MetadataSchema,
  }).strict(),

  // Unstructured messages (reject, cancel, message, dispute, confirm_delivery, status, deposit_confirmed)
  z.object({
    version: z.literal("1.0"),
    type: z.enum(["reject", "cancel", "message", "dispute", "confirm_delivery", "status", "deposit_confirmed"]),
    ticket_id: z.string().max(64),
    agent_id: z.string().max(64),
    timestamp: z.number().int().positive(),
    content: z.string().max(1024).optional(),
    role: z.string().max(20).optional(),
    signature: z.string().max(256).optional(),
    metadata: MetadataSchema,
  }),
]);

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export function validateAgentMessage(input: unknown): AgentMessage {
  const result = AgentMessageSchema.safeParse(input);

  if (!result.success) {
    const errorMessages = result.error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(", ");
    throw new Error(`Invalid agent message: ${errorMessages}`);
  }

  return result.data;
}
