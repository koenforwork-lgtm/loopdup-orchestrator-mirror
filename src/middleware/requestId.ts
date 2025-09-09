import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";

export function requestId() {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as any).requestId = req.headers["x-request-id"] || randomUUID();
    next();
  };
}
