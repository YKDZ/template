export class PublicationFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PublicationFailure";
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new PublicationFailure(code, message);
}
