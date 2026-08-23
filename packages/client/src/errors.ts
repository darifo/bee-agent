/** Error raised for non-2xx responses carrying an error envelope. */
export class BeeAgentClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Readonly<Record<string, unknown>> | undefined,
  ) {
    super(message)
    this.name = 'BeeAgentClientError'
  }
}

/** Error raised when the response body is not valid JSON. */
export class BeeAgentProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BeeAgentProtocolError'
  }
}
