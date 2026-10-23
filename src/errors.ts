/** Error thrown for invalid keys, invalid values and type mismatches. */
export class ZulaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZulaError";
  }
}
