# dsh-doctor-windows

Windows environment diagnostics for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The plugin adds a human-only `/doctor-windows` command, so it still works when the model provider is unavailable.

## Checks

- Harness, Node.js, platform, and architecture versions.
- Whether the current workspace is readable and writable.
- UTF-16 low-byte-zero characters that affected preview versions of the native folder picker can truncate.
- Proxy variables and Node's `NODE_USE_ENV_PROXY` startup setting. Node added built-in environment-proxy support in 22.21.0 and 24.0.0.
- Discovery and real non-interactive startup of PowerShell 7 (`pwsh`) and Windows PowerShell.
- The Koffi installation owned by Harness's native folder picker, including one harmless `GetCurrentProcessId` call.

The command does not print proxy URLs or credential values, change settings, open a folder dialog, or make network requests.

## Install from a checkout

Build and test the package:

```powershell
pnpm install
pnpm run check
```

Install the checkout into the Web profile:

```powershell
dsh plugin --profile web add C:\path\to\dsh-doctor-windows
dsh --profile web --dump-config
dsh web
```

Open a workspace and run:

```text
/doctor-windows
```

Remove it with:

```powershell
dsh plugin --profile web remove dsh-doctor-windows
```

## Install from GitHub

Git dependencies run the package's `prepare` script. With pnpm 10 or newer, allow the exact package key in the profile's `pnpm-workspace.yaml`, then install a pinned commit:

```powershell
dsh plugin --profile web add github:sublatesublate-design/dsh-doctor-windows#COMMIT_SHA
```

Only allow build scripts from source you trust.

## Configuration

Override the bundle row in the profile's `cordis.patch.yml`:

```yaml
- id: doctor-windows
  name: dsh-doctor-windows
  config:
    commandName: doctor-windows
    processTimeoutMs: 5000
    processGraceMs: 1000
    maxOutputBytes: 16384
    checkNativePicker: true
```

## Development

```powershell
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run smoke
pnpm pack --dry-run
```

## License

MIT
