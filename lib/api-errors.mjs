export class ApiError extends Error {
  constructor(code, message, subject) {
    super(message);
    this.code = code;
    this.subject = subject;
  }
}

export class BusError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isEnvelope(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function unwrapEnvelope(result) {
  if (!isEnvelope(result)) return result;
  if (Object.prototype.hasOwnProperty.call(result, "value")) return result.value;
  if (Object.prototype.hasOwnProperty.call(result, "data")) return result.data;
  return result;
}

export function okResponse(payload) {
  return { ok: true, ...payload };
}

export function errResponse(code, message, subject) {
  return { ok: false, error: { code, message, subject } };
}
