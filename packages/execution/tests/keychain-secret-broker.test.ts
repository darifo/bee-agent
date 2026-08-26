import { describe, expect, it } from 'vitest'
import type { ActionRequest } from '../src/execution-world.ts'
import {
  MacOSKeychainSecretBroker,
  parseKeychainSecretRef,
  type KeychainSecretRef,
} from '../src/keychain-secret-broker.ts'

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
      secretEnv: { API_KEY: 'keychain:bee/model' },
    },
    expectedEffects: [],
    verification: [],
    scope: { threadId: 'thread-1', turnId: 'turn-1' },
  }
}

describe('MacOSKeychainSecretBroker', () => {
  it('parses encoded service and account names', () => {
    expect(parseKeychainSecretRef('keychain:bee%2Fagent/model%40host')).toEqual(
      {
        service: 'bee/agent',
        account: 'model@host',
      },
    )
    expect(() => parseKeychainSecretRef('environment:API_KEY')).toThrow(
      'keychain:<service>/<account>',
    )
  })

  it('late-binds unique refs and redacts every materialized value', async () => {
    const resolved: KeychainSecretRef[] = []
    const broker = new MacOSKeychainSecretBroker({
      async resolve(ref) {
        resolved.push(ref)
        return 'super-secret-value'
      },
    })
    const request = action()
    const values = await broker.materialize(
      ['keychain:bee/model', 'keychain:bee/model'],
      request,
    )
    expect(resolved).toEqual([{ service: 'bee', account: 'model' }])
    expect(values.get('keychain:bee/model')).toBe('super-secret-value')
    expect(broker.redact('token=super-secret-value')).toBe('token=[REDACTED]')
    broker.release([], request)
    expect(broker.redact('token=super-secret-value')).toBe(
      'token=super-secret-value',
    )
  })
})
