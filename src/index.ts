import { createServer, type Server } from 'node:http'
import { pathToFileURL } from 'node:url'

import { SERVER } from './common/constants/server.constants.js'
import type { AppConfig } from './common/types/config.js'
import { loadConfig } from './config/environment.js'
import { handleRoute } from './routes/index.js'

export { loadConfig }

export const createHttpServer = (config: AppConfig = loadConfig()): Server => {
    const server = createServer((request, response) => {
        void handleRoute(request, response, config)
    })

    server.headersTimeout = SERVER.HEADERS_TIMEOUT_MS
    server.requestTimeout = SERVER.REQUEST_TIMEOUT_MS
    server.keepAliveTimeout = SERVER.KEEP_ALIVE_TIMEOUT_MS
    server.maxHeadersCount = SERVER.MAX_HEADERS_COUNT

    server.on('clientError', (error, socket) => {
        if (socket.writable) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        }

        writeLog('warn', 'Malformed client request', { error: error.message })
    })

    return server
}

const writeLog = (level: 'info' | 'error' | 'warn', message: string, metadata: Record<string, unknown> = {}): void => {
    process.stdout.write(`${JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...metadata })}\n`)
}

const shutdown = (server: Server, signal: NodeJS.Signals): void => {
    writeLog('info', 'Shutdown signal received', { signal })

    const forceShutdownTimer = setTimeout(() => {
        server.closeAllConnections()
        writeLog('error', 'Forced shutdown after timeout')
        process.exitCode = 1
    }, SERVER.SHUTDOWN_TIMEOUT_MS)

    forceShutdownTimer.unref()
    server.close((error) => {
        clearTimeout(forceShutdownTimer)

        if (error !== undefined) {
            writeLog('error', 'Server shutdown failed', { error: error.message })
            process.exitCode = 1
            return
        }

        writeLog('info', 'Server shut down cleanly')
    })
    server.closeIdleConnections()
}

export const startServer = (config: AppConfig = loadConfig()): Server => {
    const server = createHttpServer(config)

    server.once('error', (error) => {
        writeLog('error', 'Server failed to start', { error: error.message })
        process.exitCode = 1
    })

    server.listen(config.port, config.host, () => {
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : config.port

        writeLog('info', 'Server started', {
            environment: config.environment,
            host: config.host,
            port
        })
    })

    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
    signals.forEach((signal) => {
        process.once(signal, () => shutdown(server, signal))
    })

    process.once('uncaughtException', (error) => {
        writeLog('error', 'Uncaught exception', { error: error.message, stack: error.stack })
        shutdown(server, 'SIGTERM')
    })

    process.once('unhandledRejection', (reason: unknown) => {
        writeLog('error', 'Unhandled promise rejection', { reason: String(reason) })
        shutdown(server, 'SIGTERM')
    })

    return server
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
    try {
        startServer()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeLog('error', 'Invalid server configuration', { error: message })
        process.exitCode = 1
    }
}
