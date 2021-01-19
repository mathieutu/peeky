import { join, relative } from 'path'
import workerpool from '@akryum/workerpool'
import { ReactiveFileSystem } from '@peeky/reactive-fs'
import type { runTestFile as rawRunTestFile } from './run-test-file'
import consola from 'consola'
import chalk from 'chalk'
import { RunTestFileOptions, TestSuiteInfo, EventType } from './types'
import { Awaited } from './util'

export interface RunnerOptions {
  targetDirectory: string
  testFiles: ReactiveFileSystem
}

interface Context {
  options: RunnerOptions
}

type EventHandler = (eventType: string, payload: any) => unknown

export async function setupRunner (options: RunnerOptions) {
  const ctx: Context = {
    options,
  }

  const pool = workerpool.pool(join(__dirname, 'worker.js'))
  const { testFiles } = options

  const eventHandlers: EventHandler[] = []

  async function runTestFileWorker (options: RunTestFileOptions): ReturnType<typeof rawRunTestFile> {
    const suiteMap: { [id: string]: TestSuiteInfo } = {}
    return pool.exec('runTestFile', [options], {
      on: (eventType, payload) => {
        if (eventType === EventType.BUILD_FAILED) {
          const { error } = payload
          consola.error(`Test build failed: ${error.message}`)
        } else if (eventType === EventType.BUILD_COMPLETED) {
          const { testFilePath, duration } = payload
          consola.info(`Built ${relative(ctx.options.targetDirectory, testFilePath)} in ${duration}ms`)
        } else if (eventType === EventType.SUITE_START) {
          const suite: TestSuiteInfo = payload.suite
          consola.start(suite.title)
          suiteMap[suite.id] = suite
        } else if (eventType === EventType.SUITE_COMPLETED) {
          const { duration } = payload
          const suite = suiteMap[payload.suite.id]
          consola.log(chalk[payload.suite.errors ? 'red' : 'green'](`  ${suite.tests.length - payload.suite.errors} / ${suite.tests.length} tests passed: ${suite.title} ${chalk.grey(`(${duration}ms)`)}`))
        } else if (eventType === EventType.TEST_ERROR) {
          const { duration, error, stack } = payload
          const suite = suiteMap[payload.suite.id]
          const test = suite.tests.find(t => t.id === payload.test.id)
          consola.log(chalk.red(`  ❌️${test.title} ${chalk.grey(`(${duration}ms)`)}`))
          consola.error({ ...error, stack })
        } else if (eventType === EventType.TEST_SUCCESS) {
          const { duration } = payload
          const suite = suiteMap[payload.suite.id]
          const test = suite.tests.find(t => t.id === payload.test.id)
          consola.log(chalk.green(`  ✔️ ${test.title} ${chalk.grey(`(${duration}ms)`)}`))
        }

        for (const handler of eventHandlers) {
          handler(eventType, payload)
        }
      },
    })
  }

  function onEvent (handler: EventHandler) {
    eventHandlers.push(handler)
  }

  async function runTestFile (relativePath: string) {
    const file = testFiles.files[relativePath]
    if (file) {
      const result = await runTestFileWorker({
        entry: file.absolutePath,
      })

      // Patch filePath
      result.suites.forEach(s => {
        s.filePath = relative(ctx.options.targetDirectory, s.filePath)
      })

      return result
    }
  }

  async function close () {
    await testFiles.destroy()
    await pool.terminate()
    eventHandlers.length = 0
  }

  return {
    testFiles,
    runTestFile,
    close,
    onEvent,
    pool,
  }
}

export type RunTestFileResult = Awaited<ReturnType<Awaited<ReturnType<typeof setupRunner>>['runTestFile']>>