// The raw request body is kept so webhook signatures can be verified against the exact bytes received.
declare global {
  namespace Express {
    interface Request { rawBody?: Buffer }
  }
}
export {};
