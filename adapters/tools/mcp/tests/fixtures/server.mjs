import readline from 'node:readline'

const input = readline.createInterface({ input: process.stdin })
let initialized = false
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    setTimeout(() => {
      initialized = true
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } })}\n`,
      )
    }, 20)
  }
  if (message.method === 'tools/call') {
    if (!initialized) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32_002, message: 'server not initialized' } })}\n`,
      )
      return
    }
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `hello ${message.params.arguments.name}` }] } })}\n`,
    )
  }
})

setInterval(() => {}, 1_000)
