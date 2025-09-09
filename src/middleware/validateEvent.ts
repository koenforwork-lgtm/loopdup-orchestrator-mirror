import type { Request, Response, NextFunction } from "express";
import { z } from "zod";

const EventSchema = z.object({
  propertyId: z.string().min(1),
  channel: z.string().min(1),
  conversationId: z.string().min(1),
  guestId: z.string().optional(),
  messageId: z.string().optional(),
  direction: z.string().optional(),
  type: z.string().default("text"),
  text: z.string().default(""),
  lang: z.string().default("en"),
  ts: z.string().optional()
});

export type InboundEvent = z.infer<typeof EventSchema>;

export function validateEvent() {
  return (req: Request, res: Response, next: NextFunction) => {
    const parse = EventSchema.safeParse(req.body || {});
    if (!parse.success) {
      return res.status(400).json({ error: "invalid_event", issues: parse.error.issues });
    }
    (req as any).event = parse.data;
    next();
  };
}
