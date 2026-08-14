/**
 * DeepSeek Harness Windows diagnostics exposed as the human-only
 * `/doctor-windows` command.
 * @module dsh-doctor-windows
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  installedPackageVersion,
  probeNativePickerKoffi,
  renderDiagnosticReport,
  runWindowsDiagnostics,
  type DiagnosticOptions,
} from './diagnostics.ts'

export * from './diagnostics.ts'

export const name = 'doctor-windows'
export const inject = ['commands', 'subprocess']

/** Plugin configuration for diagnostic budgets and optional native loading. */
export interface Config {
  /** Slash command name without the leading slash. */
  commandName?: string
  /** Bound for each PowerShell probe. */
  processTimeoutMs?: number
  /** Additional termination/quiescence allowance after the probe deadline. */
  processGraceMs?: number
  /** Per-stream output retained by each process probe. */
  maxOutputBytes?: number
  /** Load Harness's Koffi dependency and call kernel32 on Windows. */
  checkNativePicker?: boolean
}

/** Runtime plugin configuration schema. */
export const Config: Schema<Config> = Schema.object({
  commandName: Schema.string().default('doctor-windows'),
  processTimeoutMs: Schema.number().default(5_000),
  processGraceMs: Schema.number().default(1_000),
  maxOutputBytes: Schema.number().default(16_384),
  checkNativePicker: Schema.boolean().default(true),
})

interface ResolvedConfig {
  readonly commandName: string
  readonly processTimeoutMs: number
  readonly processGraceMs: number
  readonly maxOutputBytes: number
  readonly checkNativePicker: boolean
}

function positiveInteger(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`doctor-windows: ${field} must be a positive safe integer`)
  }
}

/** Validate values that Schemastery's primitive schemas cannot constrain. */
function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    commandName: config.commandName ?? 'doctor-windows',
    processTimeoutMs: config.processTimeoutMs ?? 5_000,
    processGraceMs: config.processGraceMs ?? 1_000,
    maxOutputBytes: config.maxOutputBytes ?? 16_384,
    checkNativePicker: config.checkNativePicker ?? true,
  }
  if (!/^[a-z][a-z0-9_-]*$/u.test(resolved.commandName)) {
    throw new Error('doctor-windows: commandName must start with a lowercase letter and contain only lowercase letters, digits, hyphens, or underscores')
  }
  positiveInteger('processTimeoutMs', resolved.processTimeoutMs)
  positiveInteger('processGraceMs', resolved.processGraceMs)
  positiveInteger('maxOutputBytes', resolved.maxOutputBytes)
  return resolved
}

async function executeDoctor(
  ctx: Context,
  config: ResolvedConfig,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length !== 0) {
    return { kind: 'error', text: `Usage: /${config.commandName} (no arguments)` }
  }
  const workspace = invocation.agent.session.header.cwd ?? process.cwd()
  const options: DiagnosticOptions = {
    processTimeoutMs: config.processTimeoutMs,
    processGraceMs: config.processGraceMs,
    maxOutputBytes: config.maxOutputBytes,
    checkNativePicker: config.checkNativePicker,
  }
  const report = await runWindowsDiagnostics({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    env: process.env,
    workspace,
    subprocess: ctx.subprocess,
    probeNativePicker: probeNativePickerKoffi,
    readPackageVersion: installedPackageVersion,
  }, options, invocation.signal)
  return { kind: 'success', text: renderDiagnosticReport(report) }
}

/**
 * Register the Windows diagnostic slash command.
 * @param ctx - Harness context carrying command and subprocess services.
 * @param config - schema-resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.commands.register({
    name: resolved.commandName,
    description: 'Diagnose the Windows Harness runtime',
    recordInput: false,
    handler: invocation => executeDoctor(ctx, resolved, invocation),
  })
}
