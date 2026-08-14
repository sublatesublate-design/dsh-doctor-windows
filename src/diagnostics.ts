import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import semver from 'semver'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Harness-supported Node.js release range. */
export const SUPPORTED_NODE_RANGE = '^22.19.0 || >=24.0.0'

/** Node.js releases that understand NODE_USE_ENV_PROXY. */
const ENV_PROXY_NODE_RANGE = '>=22.21.0 <23.0.0 || >=24.0.0'

/** Severity of one independent diagnostic result. */
export type DiagnosticStatus = 'pass' | 'warn' | 'fail' | 'info' | 'skip'

/** One named Windows environment diagnostic. */
export interface DiagnosticCheck {
  /** Stable machine-readable check id. */
  readonly id: string
  /** Short human-facing title. */
  readonly title: string
  /** Outcome severity. */
  readonly status: DiagnosticStatus
  /** Concise result and remediation when useful. */
  readonly summary: string
}

/** Complete report returned by the reusable diagnostic runner. */
export interface DiagnosticReport {
  /** Platform observed by the Harness host process. */
  readonly platform: NodeJS.Platform
  /** CPU architecture observed by the Harness host process. */
  readonly arch: string
  /** Node.js version without the leading v. */
  readonly nodeVersion: string
  /** Session workspace checked for path hazards. */
  readonly workspace: string
  /** Independent checks in display order. */
  readonly checks: readonly DiagnosticCheck[]
}

/** Tunable process budgets supplied by the plugin configuration. */
export interface DiagnosticOptions {
  /** Bound for each PowerShell probe. */
  readonly processTimeoutMs: number
  /** Additional wait after cancellation before reporting a wedged process. */
  readonly processGraceMs: number
  /** Per-stream diagnostic output cap. */
  readonly maxOutputBytes: number
  /** Whether to load the native Koffi dependency on Windows. */
  readonly checkNativePicker: boolean
}

/** Inputs injected by the plugin or tests. */
export interface DiagnosticEnvironment {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly nodeVersion: string
  readonly env: NodeJS.ProcessEnv
  readonly workspace: string
  readonly subprocess: SubprocessRuntime
  readonly probeNativePicker: () => Promise<string>
  readonly readPackageVersion: (packageName: string) => Promise<string | undefined>
}

interface ProcessProbeResult {
  readonly kind: 'settled' | 'deadline'
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly lossy: boolean
  readonly quiesced: boolean
}

interface KoffiModule {
  readonly default: {
    load(path: string): {
      func(convention: string, name: string, result: string, args: string[]): (...args: unknown[]) => unknown
    }
  }
}

function check(id: string, title: string, status: DiagnosticStatus, summary: string): DiagnosticCheck {
  return Object.freeze({ id, title, status, summary })
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return '<unrenderable error>'
  }
}

/**
 * Find UTF-16 code units whose low byte is zero, which older native picker
 * builds can mistake for the string terminator.
 * @param value - path or other UTF-16 JavaScript string.
 * @returns unique formatted code-unit labels in encounter order.
 */
export function riskyUtf16CodeUnits(value: string): readonly string[] {
  const found = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if ((codeUnit & 0xff) !== 0) continue
    const label = `U+${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`
    found.add(label)
  }
  return [...found]
}

/**
 * Read an installed package version without importing its runtime entry.
 * @param packageName - bare package name.
 * @returns version from package.json, or undefined when unavailable.
 */
export async function installedPackageVersion(packageName: string): Promise<string | undefined> {
  try {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve(`${packageName}/package.json`)
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) return undefined
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Load the Koffi copy owned by Harness's native picker and make one harmless
 * kernel32 call. This diagnoses the actual native dependency, not a second copy.
 * @returns a concise dependency and process-id description.
 */
export async function probeNativePickerKoffi(): Promise<string> {
  const require = createRequire(import.meta.url)
  const pickerEntry = require.resolve('@deepseek-ai/dsh-host-directory-picker-native')
  const pickerRequire = createRequire(pickerEntry)
  const koffiEntry = pickerRequire.resolve('koffi')
  const imported = await import(pathToFileURL(koffiEntry).href) as KoffiModule
  const kernel32 = imported.default.load('kernel32.dll')
  const getCurrentProcessId = kernel32.func('__stdcall', 'GetCurrentProcessId', 'uint32', [])
  const pid = getCurrentProcessId()
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`GetCurrentProcessId returned ${String(pid)}`)
  }
  return `${basename(koffiEntry)} loaded; native call returned pid ${pid}`
}

function collectedText(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): { text: string; lossy: boolean } {
  const reader = handle.collected[stream]
  if (reader === undefined) return { text: '', lossy: false }
  const result = reader.readFrom(0)
  return { text: result.text, lossy: result.lossy }
}

async function runProcessProbe(
  runtime: SubprocessRuntime,
  argv: readonly string[],
  cwd: string,
  options: DiagnosticOptions,
  outerSignal: AbortSignal,
): Promise<ProcessProbeResult> {
  const timeout = new AbortController()
  const signal = AbortSignal.any([outerSignal, timeout.signal])
  const timer = setTimeout(
    () => timeout.abort(new Error(`probe exceeded ${options.processTimeoutMs} ms`)),
    options.processTimeoutMs,
  )
  const handle = runtime.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: options.maxOutputBytes },
      stderr: { maxBytes: options.maxOutputBytes },
    },
    graceMs: options.processGraceMs,
    signal,
  })

  let hardDeadlineTimer: NodeJS.Timeout | undefined
  const hardDeadline = new Promise<{ readonly kind: 'deadline' }>((resolve) => {
    hardDeadlineTimer = setTimeout(
      () => resolve({ kind: 'deadline' }),
      options.processTimeoutMs + options.processGraceMs,
    )
  })
  const settlement = handle.done.then(
    outcome => ({ kind: 'settled' as const, outcome }),
    error => ({ kind: 'rejected' as const, error }),
  )

  try {
    const result = await Promise.race([settlement, hardDeadline])
    if (result.kind === 'rejected') throw result.error
    if (result.kind === 'deadline') {
      handle.terminate()
      const quiesced = await handle.waitForExit(AbortSignal.timeout(options.processGraceMs))
      const stdout = collectedText(handle, 'stdout')
      const stderr = collectedText(handle, 'stderr')
      return {
        kind: 'deadline', exitCode: null, signal: null,
        stdout: stdout.text, stderr: stderr.text,
        lossy: stdout.lossy || stderr.lossy, quiesced,
      }
    }
    const stdout = collectedText(handle, 'stdout')
    const stderr = collectedText(handle, 'stderr')
    return {
      kind: 'settled', ...result.outcome,
      stdout: stdout.text, stderr: stderr.text,
      lossy: stdout.lossy || stderr.lossy, quiesced: true,
    }
  } finally {
    clearTimeout(timer)
    if (hardDeadlineTimer !== undefined) clearTimeout(hardDeadlineTimer)
  }
}

async function powerShellCheck(
  runtime: SubprocessRuntime,
  command: 'pwsh' | 'powershell.exe',
  missingStatus: 'warn' | 'info',
  cwd: string,
  options: DiagnosticOptions,
  signal: AbortSignal,
): Promise<DiagnosticCheck> {
  const title = command === 'pwsh' ? 'PowerShell 7 (pwsh)' : 'Windows PowerShell'
  let executable: string
  try {
    executable = await runtime.resolveExecutable(command, undefined, signal)
  } catch (error: unknown) {
    return check(
      command,
      title,
      missingStatus,
      command === 'pwsh'
        ? `pwsh was not found on PATH; Harness may still find a well-known PowerShell installation: ${errorText(error)}`
        : `powershell.exe was not found on PATH: ${errorText(error)}`,
    )
  }

  const script = "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Write-Output ('DSH_DOCTOR_OK|' + $PSVersionTable.PSVersion.ToString())"
  try {
    const result = await runProcessProbe(
      runtime,
      [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      cwd,
      options,
      signal,
    )
    if (result.kind === 'deadline') {
      return check(
        command,
        title,
        'fail',
        `process exceeded ${options.processTimeoutMs} ms and ${result.quiesced ? 'was terminated' : 'did not quiesce after termination'}`,
      )
    }
    const marker = /DSH_DOCTOR_OK\|([^\r\n]+)/u.exec(result.stdout)
    if (result.exitCode !== 0 || marker === null) {
      const tail = (result.stderr || result.stdout).trim().slice(-500)
      return check(
        command,
        title,
        'fail',
        `probe exited with code ${String(result.exitCode)}${result.signal === null ? '' : ` (${result.signal})`}${tail.length === 0 ? '' : `: ${tail}`}`,
      )
    }
    return check(
      command,
      title,
      'pass',
      `${executable} started successfully; version ${marker[1]}${result.lossy ? ' (output was truncated)' : ''}`,
    )
  } catch (error: unknown) {
    if (signal.aborted) throw error
    return check(command, title, 'fail', `could not run ${executable}: ${errorText(error)}`)
  }
}

function proxyCheck(env: NodeJS.ProcessEnv, nodeVersion: string): DiagnosticCheck {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
    .filter(name => typeof env[name] === 'string' && env[name]?.trim().length !== 0)
  if (names.length === 0) {
    return check('proxy', 'Node proxy environment', 'info', 'no HTTP proxy environment variables are set')
  }
  if (!semver.satisfies(nodeVersion, ENV_PROXY_NODE_RANGE, { includePrerelease: true })) {
    return check(
      'proxy',
      'Node proxy environment',
      'warn',
      `${names.join(', ')} are set, but Node ${nodeVersion} predates built-in environment-proxy support; use Node 22.21+ or 24+`,
    )
  }
  if (env.NODE_USE_ENV_PROXY !== '1' && !process.execArgv.includes('--use-env-proxy')) {
    return check(
      'proxy',
      'Node proxy environment',
      'warn',
      `${names.join(', ')} are set, but proxy handling is not enabled; start DSH with NODE_USE_ENV_PROXY=1 if provider requests require the proxy`,
    )
  }
  return check('proxy', 'Node proxy environment', 'pass', `${names.join(', ')} are set and Node environment-proxy handling is enabled`)
}

/**
 * Run the Windows diagnostic suite without mutating the machine.
 * @param environment - observed host facts and injected service operations.
 * @param options - validated process and native-probe settings.
 * @param signal - command cancellation signal.
 * @returns ordered diagnostic report.
 */
export async function runWindowsDiagnostics(
  environment: DiagnosticEnvironment,
  options: DiagnosticOptions,
  signal: AbortSignal,
): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = []
  const dshVersion = await environment.readPackageVersion('@deepseek-ai/dsh')
    ?? await environment.readPackageVersion('@deepseek-ai/dsh-commands')
  checks.push(check(
    'runtime',
    'Harness runtime',
    'info',
    `DSH ${dshVersion ?? 'version unavailable'}; Node ${environment.nodeVersion}; ${environment.platform} ${environment.arch}`,
  ))

  checks.push(semver.satisfies(environment.nodeVersion, SUPPORTED_NODE_RANGE, { includePrerelease: true })
    ? check('node', 'Node.js version', 'pass', `Node ${environment.nodeVersion} satisfies ${SUPPORTED_NODE_RANGE}`)
    : check('node', 'Node.js version', 'fail', `Node ${environment.nodeVersion} is unsupported; install ${SUPPORTED_NODE_RANGE}`))

  if (environment.platform !== 'win32') {
    checks.push(check('platform', 'Host platform', 'skip', `Windows-only checks skipped on ${environment.platform}`))
  } else {
    checks.push(check('platform', 'Host platform', 'pass', `Windows ${environment.arch}`))
  }

  const riskyUnits = riskyUtf16CodeUnits(environment.workspace)
  checks.push(riskyUnits.length === 0
    ? check('workspace-path', 'Workspace path', 'pass', 'no UTF-16 low-byte-zero code units detected')
    : check(
        'workspace-path',
        'Workspace path',
        'warn',
        `${JSON.stringify(environment.workspace)} contains ${riskyUnits.join(', ')}; affected preview builds may truncate this path in the native folder picker`,
      ))

  try {
    await access(environment.workspace, constants.R_OK | constants.W_OK)
    checks.push(check('workspace-access', 'Workspace access', 'pass', 'workspace is readable and writable by the Harness host'))
  } catch (error: unknown) {
    checks.push(check('workspace-access', 'Workspace access', 'fail', `workspace access failed: ${errorText(error)}`))
  }

  checks.push(proxyCheck(environment.env, environment.nodeVersion))

  if (environment.platform === 'win32') {
    checks.push(await powerShellCheck(
      environment.subprocess, 'pwsh', 'warn', environment.workspace, options, signal,
    ))
    checks.push(await powerShellCheck(
      environment.subprocess, 'powershell.exe', 'info', environment.workspace, options, signal,
    ))
    if (options.checkNativePicker) {
      try {
        const detail = await environment.probeNativePicker()
        checks.push(check('native-picker', 'Native folder picker dependency', 'pass', detail))
      } catch (error: unknown) {
        checks.push(check('native-picker', 'Native folder picker dependency', 'fail', errorText(error)))
      }
    } else {
      checks.push(check('native-picker', 'Native folder picker dependency', 'skip', 'disabled by plugin configuration'))
    }
  } else {
    checks.push(check('pwsh', 'PowerShell 7 (pwsh)', 'skip', 'Windows-only process probe'))
    checks.push(check('powershell.exe', 'Windows PowerShell', 'skip', 'Windows-only process probe'))
    checks.push(check('native-picker', 'Native folder picker dependency', 'skip', 'Windows-only native probe'))
  }

  return Object.freeze({
    platform: environment.platform,
    arch: environment.arch,
    nodeVersion: environment.nodeVersion,
    workspace: environment.workspace,
    checks: Object.freeze(checks),
  })
}

const STATUS_LABEL: Readonly<Record<DiagnosticStatus, string>> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  info: 'INFO',
  skip: 'SKIP',
}

/**
 * Render a report for the human-only slash-command result.
 * @param report - diagnostic report.
 * @returns stable multiline plain text.
 */
export function renderDiagnosticReport(report: DiagnosticReport): string {
  const totals = new Map<DiagnosticStatus, number>()
  for (const item of report.checks) totals.set(item.status, (totals.get(item.status) ?? 0) + 1)
  const summary = (['pass', 'warn', 'fail', 'info', 'skip'] as const)
    .filter(status => (totals.get(status) ?? 0) > 0)
    .map(status => `${totals.get(status)} ${status}`)
    .join(', ')
  const lines = report.checks.map(item => `[${STATUS_LABEL[item.status]}] ${item.title}: ${item.summary}`)
  return [`DeepSeek Harness Windows Doctor — ${summary}`, '', ...lines].join('\n')
}
