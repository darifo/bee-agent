export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number | undefined,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ModelProviderError'
  }
}

/** Thrown when a provider response cannot be shaped into the contract. */
export class ModelProtocolError extends ModelProviderError {
  constructor(
    message: string,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'ModelProtocolError'
  }
}
