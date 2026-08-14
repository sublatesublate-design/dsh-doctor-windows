import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  installedPackageVersion,
  probeNativePickerKoffi,
  renderDiagnosticReport,
  runWindowsDiagnostics,
} from '../src/diagnostics.ts'

const ctx = new Context()
const subprocessFiber = await ctx.plugin(LocalSubprocessRuntime)

try {
  const report = await runWindowsDiagnostics({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    env: process.env,
    workspace: process.cwd(),
    subprocess: ctx.subprocess,
    probeNativePicker: probeNativePickerKoffi,
    readPackageVersion: installedPackageVersion,
  }, {
    processTimeoutMs: 5_000,
    processGraceMs: 1_000,
    maxOutputBytes: 16_384,
    checkNativePicker: true,
  }, new AbortController().signal)
  process.stdout.write(`${renderDiagnosticReport(report)}\n`)
  if (report.checks.some(item => item.status === 'fail')) process.exitCode = 1
} finally {
  await subprocessFiber.dispose()
}
