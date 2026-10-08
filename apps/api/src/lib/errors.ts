export class AppError extends Error {
  statusCode: number;
  details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, details);
export const unauthorized = (msg = "Authentication required") => new AppError(401, msg);
export const forbidden = (msg = "You do not have permission to perform this action") => new AppError(403, msg);
export const notFound = (msg = "Resource not found") => new AppError(404, msg);
export const conflict = (msg: string) => new AppError(409, msg);
export const unprocessable = (msg: string, details?: unknown) => new AppError(422, msg, details);
