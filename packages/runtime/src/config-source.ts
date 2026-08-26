import { readFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import {
  verifyEffectiveStructure,
  type EffectiveStructure,
  type ReconcileResult,
} from '@bee-agent/kernel'
import type { StructureReconciler } from './structure-reconciler.ts'

export interface ConfigSource {
  readonly id: string
  load(): Promise<EffectiveStructure>
  subscribe?(onChange: () => void): () => void
}

export interface ConfigControllerSnapshot {
  readonly sourceId: string
  readonly running: boolean
  readonly refreshing: boolean
  readonly successfulRefreshes: number
  readonly lastStructureVersion: string | null
  readonly lastResult: ReconcileResult['kind'] | null
  readonly lastError: string | null
}

/** Watches a JSON-encoded EffectiveStructure; parsing also verifies its digest. */
export class FileEffectiveStructureSource implements ConfigSource {
  readonly id: string
  readonly path: string

  constructor(path: string) {
    this.path = resolve(path)
    this.id = `file:${this.path}`
  }

  async load(): Promise<EffectiveStructure> {
    return verifyEffectiveStructure(
      JSON.parse(await readFile(this.path, 'utf8')),
    )
  }

  subscribe(onChange: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    const watcher: FSWatcher = watch(this.path, () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(onChange, 50)
    })
    watcher.on('error', onChange)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      watcher.close()
    }
  }
}

/**
 * Serialized desired-state pump. Bursts are coalesced, candidate failures keep
 * the previous generation active, and later changes continue to be processed.
 */
export class StructureConfigController {
  readonly #source: ConfigSource
  readonly #reconciler: StructureReconciler
  #unsubscribe: (() => void) | undefined
  #tail: Promise<void> = Promise.resolve()
  #queued = false
  #running = false
  #refreshing = false
  #successfulRefreshes = 0
  #lastStructureVersion: string | null = null
  #lastResult: ReconcileResult['kind'] | null = null
  #lastError: string | null = null

  constructor(source: ConfigSource, reconciler: StructureReconciler) {
    this.#source = source
    this.#reconciler = reconciler
  }

  async start(): Promise<void> {
    if (this.#running) return
    this.#running = true
    this.#unsubscribe = this.#source.subscribe?.(() => this.requestRefresh())
    this.requestRefresh()
    await this.#tail
  }

  requestRefresh(): void {
    if (!this.#running) return
    this.#queued = true
    this.#tail = this.#tail.then(
      () => this.#drain(),
      () => this.#drain(),
    )
  }

  async #refresh(): Promise<ReconcileResult> {
    const structure = await this.#source.load()
    const result = await this.#reconciler.reconcile(structure)
    this.#successfulRefreshes += 1
    this.#lastStructureVersion = structure.digest
    this.#lastResult = result.kind
    this.#lastError = null
    return result
  }

  inspect(): ConfigControllerSnapshot {
    return {
      sourceId: this.#source.id,
      running: this.#running,
      refreshing: this.#refreshing,
      successfulRefreshes: this.#successfulRefreshes,
      lastStructureVersion: this.#lastStructureVersion,
      lastResult: this.#lastResult,
      lastError: this.#lastError,
    }
  }

  /** Wait until all refreshes queued at call time have settled. */
  settled(): Promise<void> {
    return this.#tail
  }

  async stop(): Promise<void> {
    this.#running = false
    this.#queued = false
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    await this.#tail
  }

  async #drain(): Promise<void> {
    if (this.#refreshing) return
    this.#refreshing = true
    try {
      while (this.#running && this.#queued) {
        this.#queued = false
        try {
          await this.#refresh()
        } catch (error) {
          this.#lastError =
            error instanceof Error ? error.message : String(error)
        }
      }
    } finally {
      this.#refreshing = false
    }
  }
}
