export type HandlerResult = {
  handled: boolean;
  reply?: string;
  escalate?: boolean;
  reason?: string;
  meta?: Record<string, any>;
};

