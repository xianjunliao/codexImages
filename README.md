# Codex Media 工作流

这个项目用于把 `life` 项目里的图片/视频生成任务转交给本机 Codex 执行。它不依赖 OpenAI API Key，而是通过本机已登录的 Codex 套餐运行 `codex exec`，生成图片帧并上传回 `life`。

## 当前能力

- 从 `life` 的 MySQL 队列读取媒体任务。
- 根据提示词生成单张图片或连续帧图片。
- 支持 `images`、`video`、`both` 三种模式。
- `video` / `both` 模式下，会先生成连续帧，再用 FFmpeg 合成短视频 `clip-0001.mp4`。
- 生成结果默认上传到 `life` 的 `/upload/to?themeName=CodexMedia`，返回可访问的下载地址。
- 支持 Windows 计划任务开机自启。

## 重要目录

| 路径 | 说明 | 是否提交 |
| --- | --- | --- |
| `scripts/` | worker、启动脚本、计划任务脚本 | 提交 |
| `life-integration/` | life 项目集成参考 | 提交 |
| `generated/` | Codex 生成的图片、视频、提示词和中间文件 | 不提交 |
| `logs/` | worker 日志 | 不提交 |
| `data/` | 本地数据 | 不提交 |
| `outputs/` | 旧版输出目录 | 不提交 |
| `tools/` | 本机工具，例如 FFmpeg | 不提交 |
| `.env` | 本地环境变量 | 不提交 |

`.gitignore` 已忽略 `generated/`、`logs/`、`data/`、`outputs/`、`tools/` 和 `.env`，避免把生成文件、日志、FFmpeg 压缩包等大文件提交到仓库。

## 本机依赖

### Node.js

需要 Node.js 18 或更高版本。

### Codex CLI

worker 会自动查找：

- 环境变量 `CODEX_COMMAND`
- `%NVM_SYMLINK%\codex.cmd`
- `E:\nvm4w\nodejs\codex.cmd`
- `C:\Program Files\nodejs\codex.cmd`
- `codex`

### FFmpeg

视频合成需要 FFmpeg。当前推荐安装到：

```text
e:\works\project\codexImages\tools\ffmpeg\bin\ffmpeg.exe
```

启动脚本会优先读取环境变量 `FFMPEG_COMMAND`，如果没有设置，会尝试使用：

```text
tools\ffmpeg\bin\ffmpeg.exe
```

验证命令：

```powershell
& "e:\works\project\codexImages\tools\ffmpeg\bin\ffmpeg.exe" -version
```

## 运行 worker

本地 life：

```powershell
$env:LIFE_BASE_URL="http://127.0.0.1:8080"
npm run worker
```

云端 life：

```powershell
$env:LIFE_BASE_URL="https://www.liaoxianjun.com"
$env:CODEX_MEDIA_PUBLIC_LIFE_BASE_URL="https://www.liaoxianjun.com"
$env:CODEX_MEDIA_UPLOAD_TO_LIFE="true"
npm run worker
```

只处理一次队列任务：

```powershell
npm run worker:once
```

## Windows 开机自启

安装计划任务：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-startup-task.ps1 -LifeBaseUrl https://www.liaoxianjun.com
```

卸载计划任务：

```powershell
npm run startup:uninstall
```

计划任务实际会运行：

```powershell
scripts\start-codex-media-worker.ps1
```

这个脚本会设置：

- `LIFE_BASE_URL`
- `CODEX_MEDIA_PUBLIC_LIFE_BASE_URL`
- `CODEX_MEDIA_OUTPUT_DIR`
- `CODEX_MEDIA_UPLOAD_TO_LIFE`
- `CODEX_COMMAND`
- `FFMPEG_COMMAND`

## 视频生成流程

Codex 本身在这里不是直接调用视频模型。当前视频能力是“连续帧 + FFmpeg 合成”：

1. `life` 创建 `codex_media_jobs` 任务。
2. 本机 worker 拉取 `pending` 任务并标记为 `running`。
3. worker 调用 `codex exec`，要求 Codex 生成有连续性的帧图，例如：
   - `frame-0001.png`
   - `frame-0002.png`
   - `frame-0003.png`
4. 如果任务模式是 `video` 或 `both`，worker 调用 FFmpeg 合成：
   - `clip-0001.mp4`
5. worker 上传结果到 `life`。
6. `life` AI 对话区和 `/lxj/pages/codex-media.html` 显示任务状态和结果。

目前视频时长会限制在 1 到 6 秒，避免连续帧数量过大导致任务失控。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LIFE_BASE_URL` | `http://127.0.0.1:8080` | life 服务地址 |
| `CODEX_MEDIA_PUBLIC_LIFE_BASE_URL` | 同 `LIFE_BASE_URL` | 返回给前端的公开 life 地址 |
| `CODEX_MEDIA_POLL_MS` | `10000` | worker 拉取任务间隔 |
| `CODEX_MEDIA_OUTPUT_DIR` | `generated/codex-media` | 本地生成输出目录 |
| `CODEX_MEDIA_UPLOAD_TO_LIFE` | `true` | 是否上传到 life |
| `CODEX_MEDIA_UPLOAD_THEME` | `CodexMedia` | 上传主题名 |
| `CODEX_COMMAND` | 自动查找 | Codex CLI 路径 |
| `FFMPEG_COMMAND` | 自动查找 | FFmpeg 路径 |
| `CODEX_MEDIA_CODEX_TIMEOUT_MS` | `1200000` | Codex 单任务超时时间 |
| `CODEX_MEDIA_FFMPEG_TIMEOUT_MS` | `300000` | FFmpeg 合成超时时间 |

## 任务提示词示例

```text
生成一个 3 秒视频，16:9。火山口夜景，最开始只有暗红色裂缝，随后岩浆快速喷涌而出，火光照亮黑色岩石，烟雾翻滚上升，镜头轻微后退，电影感，强烈明暗变化。
```

```text
生成图片和 2 秒视频，16:9。森林里的发光蘑菇从暗处逐渐亮起，萤火光点缓慢漂浮，镜头轻微横移，奇幻写实风格，保持同一场景连续变化。
```

## 和 life 的关系

`life` 部署在云端时，本机 worker 仍然可以对接，只要：

1. `LIFE_BASE_URL` 指向云端地址，例如 `https://www.liaoxianjun.com`。
2. 本机能访问云端接口。
3. 云端 `life` 已部署 `codex_media_jobs` 相关接口。
4. worker 上传文件到云端 `/upload/to` 成功。

这样云端发起任务，本机生成和上传，云端页面再展示结果。
