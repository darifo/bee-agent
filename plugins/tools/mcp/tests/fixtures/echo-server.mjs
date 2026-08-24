#!/usr/bin/env node
// Minimal MCP server on the stdio transport: newline-delimited JSON-RPC 2.0.
// Tools: echo (returns text), failing (isError), rich (multiple content).
import { createInterface } from 'node:readline/promises'

const PROTOCOL_VERSION = '2024-11-05'

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const tools = [
  {
    name: 'echo',
    description: 'Echoes the given text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'failing',
    description: 'Always fails with an isError result',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'rich',
    description: 'Returns multiple text content items',
    inputSchema: { type: 'object', properties: {} },
  },
]

const readline = createInterface({ input: process.stdin })
for await (const line of readline) {
  const trimmed = line.trim()
  if (trimmed.length === 0) continue
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    continue
  }
  if (message.id === undefined) continue // client notification
  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'echo-server', version: '0.1.0' },
        },
      })
      break
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools } })
      break
    case 'tools/call': {
      const name = message.params?.name
      const args = message.params?.arguments ?? {}
      if (name === 'echo') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }],
          },
        })
      } else if (name === 'failing') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: 'boom: not allowed' }],
            isError: true,
          },
        })
      } else if (name === 'rich') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' },
            ],
          },
        })
      } else {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: `unknown tool ${String(name)}` },
        })
      }
      break
    }
    default:
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `unknown method ${String(message.method)}`,
        },
      })
  }
}
