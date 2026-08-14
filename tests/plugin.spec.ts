import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { apply } from '../src/index.ts'

describe('plugin registration', () => {
  it('registers the human-only diagnostic command', () => {
    let definition: CommandDefinition | undefined
    const ctx = {
      commands: {
        register: vi.fn((value: CommandDefinition) => {
          definition = value
          return vi.fn()
        }),
      },
    } as unknown as Context

    apply(ctx, {})

    expect(definition).toMatchObject({
      name: 'doctor-windows',
      description: 'Diagnose the Windows Harness runtime',
      recordInput: false,
    })
    expect(definition?.handler).toBeTypeOf('function')
  })

  it('rejects unsafe names and unusable process budgets at load', () => {
    const ctx = { commands: { register: vi.fn() } } as unknown as Context
    expect(() => apply(ctx, { commandName: 'Doctor Windows' })).toThrow('commandName')
    expect(() => apply(ctx, { processTimeoutMs: 0 })).toThrow('processTimeoutMs')
    expect(ctx.commands.register).not.toHaveBeenCalled()
  })
})
