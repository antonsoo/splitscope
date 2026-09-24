/** Thrown by the parser when an `.lss` file cannot be understood, with a message safe to show a user. */
export class LssParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LssParseError";
  }
}
