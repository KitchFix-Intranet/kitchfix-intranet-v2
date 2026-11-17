// Port of v1's coerceActualCount. A malformed value is a 400 with the
// offending service, never a silent 0. Empty / null / undefined coerce
// to 0 (deliberate "cleared field" input).

export class ActualCountValidationError extends Error {
  readonly serviceId: string;
  constructor(message: string, serviceId: string) {
    super(message);
    this.name = "ActualCountValidationError";
    this.serviceId = serviceId;
  }
}

export function coerceActualCount(rawValue: unknown, serviceId: string): number {
  if (rawValue === null || rawValue === undefined || rawValue === "") return 0;
  const n = typeof rawValue === "number" ? rawValue : Number(rawValue);
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    throw new ActualCountValidationError(
      `Invalid value for service ${serviceId}: got ${JSON.stringify(rawValue)}, expected a non-negative integer`,
      serviceId,
    );
  }
  if (!Number.isInteger(n)) {
    throw new ActualCountValidationError(
      `Invalid value for service ${serviceId}: got ${JSON.stringify(rawValue)}, expected a non-negative integer`,
      serviceId,
    );
  }
  if (n < 0) {
    throw new ActualCountValidationError(
      `Invalid value for service ${serviceId}: got ${n}, must be non-negative`,
      serviceId,
    );
  }
  return n;
}
