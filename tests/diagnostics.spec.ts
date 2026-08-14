import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  renderDiagnosticReport,
  riskyUtf16CodeUnits,
  runWindowsDiagnostics,
  type DiagnosticEnvironment,
  type DiagnosticOptions,
} from '../src/diagnostics.ts'

const OPTIONS: DiagnosticOptions = {
  processTimeoutMs: 100,
  processGraceMs: 50,
  maxOutputBytes: 4_096,
  checkNativePicker: true,
}

function reader(text: string) {
  return { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) }
}

function handle(stdout: string, exitCode = 0): SubprocessHandle {
  return {
    pid: 123,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader(stdout), stderr: reader('') },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  }
}

function runtime(): SubprocessRuntime {
  return {
    resolveExecutable: vi.fn(async command => `C:\\Program Files\\PowerShell\\${command}`),
    spawn: vi.fn(spec => handle(spec.argv[0]?.toLowerCase().includes('powershell.exe') === true
      ? 'DSH_DOCTOR_OK|5.1.22621.2506\r\n'
      : 'DSH_DOCTOR_OK|7.5.2\r\n')),
  } as unknown as SubprocessRuntime
}

function environment(overrides: Partial<DiagnosticEnvironment> = {}): DiagnosticEnvironment {
  return {
    platform: 'win32',
    arch: 'x64',
    nodeVersion: '24.5.0',
    env: {},
    workspace: process.cwd(),
    subprocess: runtime(),
    probeNativePicker: vi.fn(async () => 'koffi loaded'),
    readPackageVersion: vi.fn(async () => '0.1.0-rc.6'),
    ...overrides,
  }
}

describe('riskyUtf16CodeUnits', () => {
  it('finds low-byte-zero code units that truncate affected picker builds', () => {
    expect(riskyUtf16CodeUnits('C:\\安卓开发\\普通')).toEqual(['U+5F00'])
    expect(riskyUtf16CodeUnits('C:\\普通')).toEqual([])
  })
})

describe('runWindowsDiagnostics', () => {
  it('runs both PowerShell paths and the native picker probe', async () => {
    const env = environment()
    const report = await runWindowsDiagnostics(env, OPTIONS, new AbortController().signal)

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'node', status: 'pass' }),
      expect.objectContaining({ id: 'pwsh', status: 'pass', summary: expect.stringContaining('7.5.2') }),
      expect.objectContaining({ id: 'powershell.exe', status: 'pass', summary: expect.stringContaining('5.1') }),
      expect.objectContaining({ id: 'native-picker', status: 'pass' }),
    ]))
    expect(env.probeNativePicker).toHaveBeenCalledOnce()
  })

  it('reports a risky workspace and unavailable proxy support without leaking the URL', async () => {
    const env = environment({
      nodeVersion: '22.20.0',
      workspace: `${process.cwd()}\\安卓开发`,
      env: { HTTPS_PROXY: 'http://user:secret@example.invalid:8080' },
    })
    const report = await runWindowsDiagnostics(env, OPTIONS, new AbortController().signal)

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'node', status: 'pass' }),
      expect.objectContaining({ id: 'workspace-path', status: 'warn', summary: expect.not.stringContaining('secret') }),
      expect.objectContaining({ id: 'proxy', status: 'warn', summary: expect.not.stringContaining('secret') }),
    ]))
  })

  it('skips Windows-specific probes on other platforms', async () => {
    const env = environment({ platform: 'linux' })
    const report = await runWindowsDiagnostics(env, OPTIONS, new AbortController().signal)

    expect(report.checks.find(item => item.id === 'platform')?.status).toBe('skip')
    expect(report.checks.find(item => item.id === 'pwsh')?.status).toBe('skip')
    expect(env.probeNativePicker).not.toHaveBeenCalled()
    expect(env.subprocess.resolveExecutable).not.toHaveBeenCalled()
  })
})

describe('renderDiagnosticReport', () => {
  it('renders aggregate totals and stable check lines', () => {
    const text = renderDiagnosticReport({
      platform: 'win32', arch: 'x64', nodeVersion: '24.5.0', workspace: 'C:\\work',
      checks: [
        { id: 'a', title: 'Alpha', status: 'pass', summary: 'ready' },
        { id: 'b', title: 'Beta', status: 'warn', summary: 'review this' },
      ],
    })
    expect(text).toContain('1 pass, 1 warn')
    expect(text).toContain('[PASS] Alpha: ready')
    expect(text).toContain('[WARN] Beta: review this')
  })
})
