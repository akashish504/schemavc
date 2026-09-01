/** Typed service errors carried to the API layer as structured JSON. */

export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ServiceError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new ServiceError(409, code, message, details);
export const invalid = (code: string, message: string, details?: unknown) => new ServiceError(422, code, message, details);
