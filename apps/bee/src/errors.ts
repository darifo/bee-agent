import { z } from 'zod'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import {
  KanbanInvalidTransitionError,
  KanbanLeaseLostError,
  KanbanTaskNotFoundError,
  KanbanVersionConflictError,
} from '@bee-agent/kanban'

export interface ErrorEnvelope {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** Maps request validation and runtime failures onto HTTP statuses. */
export function errorToResponse(error: unknown): {
  status: number
  envelope: ErrorEnvelope
} {
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
  if (error instanceof KanbanTaskNotFoundError) {
    return {
      status: 404,
      envelope: { code: 'not-found', message: error.message },
    }
  }
  if (
    error instanceof KanbanVersionConflictError ||
    error instanceof KanbanInvalidTransitionError ||
    error instanceof KanbanLeaseLostError
  ) {
    return {
      status: 409,
      envelope: { code: 'conflict', message: error.message },
    }
  }
  if (
    error instanceof Error &&
    /not recoverable|not resumable/.test(error.message)
  ) {
    return {
      status: 409,
      envelope: { code: 'invalid-turn-state', message: error.message },
    }
  }
  if (
    error instanceof Error &&
    /not found|no pending approval|does not match/.test(error.message)
  ) {
    return {
      status: 404,
      envelope: { code: 'not-found', message: error.message },
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
