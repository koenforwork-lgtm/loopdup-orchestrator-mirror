export function logInfo(msg: string, obj: Record<string, any> = {}) {
  console.log(JSON.stringify({ level: "info", msg, ...obj }));
}
export function logWarn(msg: string, obj: Record<string, any> = {}) {
  console.warn(JSON.stringify({ level: "warn", msg, ...obj }));
}
export function logError(msg: string, obj: Record<string, any> = {}) {
  console.error(JSON.stringify({ level: "error", msg, ...obj }));
}
