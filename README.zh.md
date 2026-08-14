# dsh-doctor-windows

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 环境诊断插件。插件提供无需模型的 `/doctor-windows` 命令，因此模型提供方不可用时仍能运行。

## 诊断内容

- Harness、Node.js、操作系统和 CPU 架构版本。
- 当前工作区是否可读、可写。
- 可能被部分预览版原生目录选择器截断的 UTF-16 低字节为零字符。
- 代理环境变量与 Node 的 `NODE_USE_ENV_PROXY` 启动设置。Node 从 22.21.0 和 24.0.0 开始提供内置环境代理支持。
- 查找并实际以非交互方式启动 PowerShell 7（`pwsh`）和 Windows PowerShell。
- 加载 Harness 原生目录选择器实际使用的 Koffi，并执行一次无副作用的 `GetCurrentProcessId` 调用。

命令不会输出代理 URL 或凭据值，不会修改设置、打开目录选择器或发起网络请求。

## 从本地目录安装

先构建并验证：

```powershell
pnpm install
pnpm run check
```

安装到 Web profile：

```powershell
dsh plugin --profile web add C:\path\to\dsh-doctor-windows
dsh --profile web --dump-config
dsh web
```

打开工作区后执行：

```text
/doctor-windows
```

卸载：

```powershell
dsh plugin --profile web remove dsh-doctor-windows
```

## 从 GitHub 安装

Git 依赖会运行本包的 `prepare` 脚本。pnpm 10 及以上版本需要先在 profile 的 `pnpm-workspace.yaml` 中允许准确的包名，然后安装固定 commit：

```powershell
dsh plugin --profile web add github:sublatesublate-design/dsh-doctor-windows#COMMIT_SHA
```

只应允许运行来源可信的构建脚本。

## 配置

可以在 profile 的 `cordis.patch.yml` 中覆盖组合包配置：

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

## 开发验证

```powershell
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run smoke
pnpm pack --dry-run
```

## 许可证

MIT
