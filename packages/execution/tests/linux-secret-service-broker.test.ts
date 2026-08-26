import { describe, expect, it } from 'vitest'
import type { ActionRequest } from '../src/execution-world.ts'
import {
  LinuxSecretServiceBroker,
  parseSecretServiceRef,
  type SecretServiceRef,
} from '../src/linux-secret-service-broker.ts'

function action(): ActionRequest {
  return {
    id: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    capability: 'tool:remote',
    subject: { type: 'agent', id: 'bee' },
    input: {},
    requirements: {
      readPaths: [],
      writePaths: [],
      networkTargets: [],
      commands: [],
      secretEnv: { API_KEY: 'secret-service:bee/model' },
    },
    expectedEffects: [],
    verification: [],
    scope: { threadId: 'thread', turnId: 'turn' },
  }
}

describe('LinuxSecretServiceBroker', () => {
  it('parses encoded Secret Service attributes', () => {
    expect(
      parseSecretServiceRef('secret-service:bee%2Fagent/model%40host'),
    ).toEqual({ service: 'bee/agent', account: 'model@host' })
    expect(() => parseSecretServiceRef('keychain:bee/model')).toThrow(
      'secret-service:<service>/<account>',
    )
  })

  it('late-binds unique refs and releases redaction state', async () => {
    const resolved: SecretServiceRef[] = []
    const broker = new LinuxSecretServiceBroker({
      async resolve(ref) {
        resolved.push(ref)
        return 'linux-secret-value'
      },
    })
    const request = action()
    const values = await broker.materialize(
      ['secret-service:bee/model', 'secret-service:bee/model'],
      request,
    )
    expect(resolved).toEqual([{ service: 'bee', account: 'model' }])
    expect(values.get('secret-service:bee/model')).toBe('linux-secret-value')
    expect(broker.redact('token=linux-secret-value')).toBe('token=[REDACTED]')
    broker.release([], request)
    expect(broker.redact('token=linux-secret-value')).toBe(
      'token=linux-secret-value',
    )
  })
})
