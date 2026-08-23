import { z } from 'zod'
import {
  InvalidTaskStateError,
  TaskAlreadyActiveError,
  TaskRuntimeError,
  UnknownApprovalRequestError,
  UnknownTaskError,
} from '@bee-agent/runtime'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

export interface ErrorEnvelope {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** Maps runtime and validation errors onto HTTP statuses and envelopes. */
export function errorToResponse(error: unknown): {
  status: number
  envelope: ErrorEnvelope
} {
  if (error instanceof UnknownTaskError) {
    return {
      status: 404,
      envelope: { code: 'task-not-found', message: error.message },
    }
  }
  if (error instanceof UnknownApprovalRequestError) {
    return {
      status: 404,
      envelope: { code: 'approval-not-found', message: error.message },
    }
  }
  if (error instanceof InvalidTaskStateError) {
    return {
      status: 409,
      envelope: {
        code: 'invalid-task-state',
        message: error.message,
        details: { taskId: error.taskId, state: error.state },
      },
    }
  }
  if (error instanceof TaskAlreadyActiveError) {
    return {
      status: 409,
      envelope: { code: 'task-already-active', message: error.message },
    }
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      envelope: {
        code: 'validation-failed',
        message: 'Request validation failed',
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
    }
  }
  if (error instanceof TaskRuntimeError) {
    return {
      status: 400,
      envelope: { code: 'task-runtime-error', message: error.message },
    }
  }
  return {
    status: 500,
    envelope: { code: 'internal-error', message: 'Internal server error' },
  }
}

export async function sendErrorResponse(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (reply.sent || reply.raw.headersSent) return
  const { status, envelope } = errorToResponse(error)
  if (status >= 500) {
    request.log.error(error as FastifyError, 'request failed')
  }
  await reply.code(status).send(envelope)
}
