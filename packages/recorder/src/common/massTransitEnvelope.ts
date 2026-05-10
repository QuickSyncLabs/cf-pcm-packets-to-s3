/** MassTransit JSON envelope: `message` holds contract payload. */
export function extractSessionIdFromMassTransitBody(raw: unknown): string | null {
  if (typeof raw === "string") {
    try {
      return extractSessionIdFromMassTransitBody(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.sessionId === "string" && o.sessionId.length > 0) {
    return o.sessionId;
  }
  const msg = o.message;
  if (msg && typeof msg === "object") {
    const sid = (msg as Record<string, unknown>).sessionId;
    if (typeof sid === "string" && sid.length > 0) {
      return sid;
    }
  }
  return null;
}
