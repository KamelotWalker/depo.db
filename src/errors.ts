/** Error thrown for invalid keys, invalid values and type mismatches. */
export class DepoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DepoError";
  }
}
