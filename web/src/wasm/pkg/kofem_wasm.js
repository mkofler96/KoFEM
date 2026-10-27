// Adapter: wraps the Emscripten/Embind module (kofem_wasm_emcc.js) behind a
// single default `init()` export; solver.worker.ts calls methods on the
// returned module instance (see KofemModule in kofem_wasm.d.ts).
//
// kofem_wasm_emcc.js and kofem_wasm_emcc.wasm are build outputs written by
// scripts/build-wasm.sh — run that script (or scripts/docker-build-wasm.sh)
// before starting the dev server.

import _createModule from './kofem_wasm_emcc.js'

// Vite hashes the wasm via this static URL import. The filename matches the one
// the emcc loader self-references (new URL("kofem_wasm_emcc.wasm", ...)), so both
// references resolve to the same hashed asset at build time. We fetch and compile
// the module ourselves and hand it to emcc through `instantiateWasm`, so emcc
// never has to locate the file at runtime — and so each step reports progress
// and a failure names the step that failed.
import wasmUrl from './kofem_wasm_emcc.wasm?url'

/** A failure while loading the engine. `stage` names the step that failed. */
export class EngineLoadError extends Error {
    constructor(stage, message, options) {
        super(message, options)
        this.name = 'EngineLoadError'
        this.stage = stage
    }
}

// Uncompressed size, measured by Vite at build time (vite.config.ts). The wasm
// is served gzipped, so Content-Length (when sent at all) counts compressed
// bytes while the stream below sees decompressed ones.
const TOTAL = __KOFEM_ENGINE_BYTES__
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`

/**
 * Load and initialise the WASM module. Must be awaited before any other call.
 * `onProgress` receives {phase: 'downloading', loaded, total} while the binary
 * streams in, {phase: 'compiling'} once the last byte is in, {phase: 'starting'}
 * once compiled, and finally
 * {phase: 'ready', downloadMs, compileMs, instantiateMs, memoryBytes}.
 * A failure throws EngineLoadError.
 */
export default async function init(overrides = {}) {
    const { onProgress, ...moduleOverrides } = overrides
    const report = (progress) => onProgress?.(progress)
    const t0 = performance.now()
    report({ phase: 'downloading', loaded: 0, total: TOTAL })

    let res
    try {
        // Low priority: fetched at start-up, the engine must not hold up the
        // page's own requests (an example's .vtu).
        res = await fetch(wasmUrl, { priority: 'low' })
    } catch (err) {
        throw new EngineLoadError(
            'download',
            `The engine download (${wasmUrl}) failed: ${err.message}.`,
            { cause: err },
        )
    }
    if (!res.ok)
        throw new EngineLoadError(
            'download',
            `The server answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${wasmUrl}.`,
        )

    // Count the body on its way into the compiler: download and compile overlap
    // (compileStreaming), and progress needs no second copy of the binary.
    let loaded = 0
    let lastReport = 0
    let downloadMs = 0
    const counter = new TransformStream({
        transform(chunk, controller) {
            loaded += chunk.byteLength
            const now = performance.now()
            if (now - lastReport > 100) {
                lastReport = now
                report({ phase: 'downloading', loaded, total: TOTAL })
            }
            controller.enqueue(chunk)
        },
        flush() {
            downloadMs = performance.now() - t0
            report({ phase: 'compiling', loaded, total: TOTAL })
        },
    })

    let module
    try {
        module = await WebAssembly.compileStreaming(
            new Response(res.body.pipeThrough(counter), {
                headers: { 'Content-Type': 'application/wasm' },
            }),
        )
    } catch (err) {
        // A CompileError is bytes that are not this engine (an error page from a
        // proxy, a truncated file); anything else is the stream failing — the
        // connection dropped.
        if (err instanceof WebAssembly.CompileError)
            throw new EngineLoadError(
                'compile',
                `The downloaded engine (${wasmUrl}) is not valid WebAssembly: ${err.message}.`,
                { cause: err },
            )
        throw new EngineLoadError(
            'download',
            `The engine download broke off after ${mb(loaded)} of ${mb(TOTAL)}: ${err.message}.`,
            { cause: err },
        )
    }
    const compiledAt = performance.now()
    report({ phase: 'starting' })

    // emcc never settles its own promise when `instantiateWasm` fails, so that
    // failure is raced in from outside.
    let memory = null
    let failInstantiate
    const instantiateFailed = new Promise((_, reject) => {
        failInstantiate = reject
    })
    const created = _createModule({
        ...moduleOverrides,
        instantiateWasm(imports, receiveInstance) {
            WebAssembly.instantiate(module, imports)
                .then((instance) => {
                    memory = Object.values(instance.exports).find(
                        (value) => value instanceof WebAssembly.Memory,
                    )
                    receiveInstance(instance, module)
                })
                .catch(failInstantiate)
            return {}
        },
    })
    let instance
    try {
        instance = await Promise.race([created, instantiateFailed])
    } catch (err) {
        throw new EngineLoadError(
            'instantiate',
            `Starting the engine failed: ${err.message}.`,
            { cause: err },
        )
    }
    report({
        phase: 'ready',
        downloadMs,
        compileMs: compiledAt - t0 - downloadMs,
        instantiateMs: performance.now() - compiledAt,
        memoryBytes: memory.buffer.byteLength,
    })
    return instance
}
