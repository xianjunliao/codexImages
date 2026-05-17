# Codex Media 工作流

这个项目用于把 `life` 项目里的图片/视频生成任务转交给本机 Codex 执行。它不依赖 OpenAI API Key 直接生成媒体，而是通过本机已登录的 Codex CLI 运行 `codex exec`，生成图片帧、合成视频，并把结果上传回 `life`。

## 当前能力

- 从 `life` 的媒体任务队列读取待处理任务。
- 根据提示词生成单张图片、连续帧图片，或由连续帧合成短视频。
- 支持 `images`、`video`、`both` 三种任务模式。
- `video` / `both` 模式会生成 `frame-0001.png` 这类有序帧，并用 FFmpeg 合成 `clip-0001.mp4`。
- 视频帧生成支持分段执行、进度回传、预计剩余时间、源帧率和输出帧率控制。
- 生成结果默认上传到 `life` 的 `/upload/to?themeName=CodexMedia`，并返回可访问地址。
- 支持删除已完成或失败任务：云端先标记 `delete_requested`，本机 worker 删除 `generated/codex-media/<requestId>` 后清理队列记录。
- 支持 Windows 计划任务开机自启。

## 重要目录

| 路径 | 说明 | 是否提交 |
| --- | --- | --- |
| `scripts/` | worker、启动脚本、计划任务脚本 | 提交 |
| `life-integration/` | `life` 项目集成参考 | 提交 |
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

视频合成需要 FFmpeg。推荐安装到：

```text
e:\works\project\codexImages\tools\ffmpeg\bin\ffmpeg.exe
```

启动脚本会优先读取环境变量 `FFMPEG_COMMAND`，没有设置时会尝试使用：

```text
tools\ffmpeg\bin\ffmpeg.exe
```

验证命令：

```powershell
& "e:\works\project\codexImages\tools\ffmpeg\bin\ffmpeg.exe" -version
```

## 环境变量

复制 `.env.example` 为 `.env` 后按需修改：

```dotenv
LIFE_BASE_URL=http://127.0.0.1:8080
CODEX_MEDIA_PUBLIC_LIFE_BASE_URL=http://127.0.0.1:8080
CODEX_MEDIA_ACCESS_KEY=life-your-access-key
CODEX_MEDIA_SESSION_TOKEN=
CODEX_MEDIA_WORKER_TOKEN=
CODEX_MEDIA_AUTH_RETRY_MS=30000
CODEX_MEDIA_UPLOAD_TO_LIFE=true
CODEX_MEDIA_VIDEO_SOURCE_FPS=24
CODEX_MEDIA_VIDEO_OUTPUT_FPS=24
CODEX_MEDIA_VIDEO_SEGMENT_FRAMES=12
CODEX_MEDIA_VIDEO_CONCURRENCY=1
CODEX_MEDIA_VIDEO_INTERPOLATE=true
```

常用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LIFE_BASE_URL` | `http://127.0.0.1:8080` | `life` 服务地址 |
| `CODEX_MEDIA_PUBLIC_LIFE_BASE_URL` | 同 `LIFE_BASE_URL` | 返回给前端的公开 `life` 地址 |
| `CODEX_MEDIA_ACCESS_KEY` | 空 | 站点访问密钥，worker 启动时会换取 session token |
| `CODEX_MEDIA_SESSION_TOKEN` | 空 | 已有的 `life_access_token` |
| `CODEX_MEDIA_WORKER_TOKEN` | 空 | 可选的专用 worker token |
| `CODEX_MEDIA_AUTH_RETRY_MS` | `30000` | worker 启动鉴权遇到网络/TLS 临时错误时的重试间隔 |
| `CODEX_MEDIA_POLL_MS` | `10000` | worker 拉取任务间隔 |
| `CODEX_MEDIA_DELETE_POLL_MS` | `5000` | 删除请求巡检间隔 |
| `CODEX_MEDIA_OUTPUT_DIR` | `generated/codex-media` | 本地生成输出目录 |
| `CODEX_MEDIA_UPLOAD_TO_LIFE` | `true` | 是否上传到 `life` |
| `CODEX_MEDIA_UPLOAD_THEME` | `CodexMedia` | 上传主题名 |
| `CODEX_COMMAND` | 自动查找 | Codex CLI 路径 |
| `FFMPEG_COMMAND` | 自动查找 | FFmpeg 路径 |
| `CODEX_MEDIA_CODEX_TIMEOUT_MS` | `1200000` | Codex 单任务超时时间 |
| `CODEX_MEDIA_FFMPEG_TIMEOUT_MS` | `300000` | FFmpeg 合成超时时间 |

## 视频生成参数

视频模式不是直接调用视频模型，而是使用“连续帧 + FFmpeg 合成”的流程。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_MEDIA_VIDEO_SOURCE_FPS` | `24` | 每秒要求 Codex 生成多少张真实图片帧 |
| `CODEX_MEDIA_VIDEO_OUTPUT_FPS` | `24` | 输出 MP4 的帧率 |
| `CODEX_MEDIA_VIDEO_SEGMENT_FRAMES` | `12` | 每个 Codex 分段最多生成多少帧 |
| `CODEX_MEDIA_VIDEO_CONCURRENCY` | `1` | 视频连续性优先，目前固定按顺序生成 |
| `CODEX_MEDIA_VIDEO_INTERPOLATE` | `true` | 输出帧率高于源帧率时启用 FFmpeg 运动插帧 |

worker 也会识别提示词里的帧率或帧密度描述，例如 `24帧/秒`、`0.3秒8张图`。源帧请求会限制在每个任务最多 240 帧，避免本地生成任务失控。

## 运行 worker

本地 `life`：

```powershell
$env:LIFE_BASE_URL="http://127.0.0.1:8080"
npm run worker
```

云端 `life`：

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

## 常见问题

### 页面一直显示“等待本地 worker”

如果 `/lxj/pages/codex-media.html` 显示任务已创建，但长时间停在“等待本地 worker 生成”，通常说明云端队列已有任务，本机 worker 没有成功领取。优先检查：

1. 本机服务是否已启动：`npm run services` 或 `powershell -ExecutionPolicy Bypass -File scripts/start-local-services.ps1`。
2. ComfyUI 是否可访问：`http://127.0.0.1:8188`。
3. worker 日志：`logs/worker.err.log` 和 `logs/worker.out.log`。
4. `.env` 中的 `LIFE_BASE_URL` 是否指向正确环境，例如云端为 `https://www.liaoxianjun.com`。
5. `CODEX_MEDIA_ACCESS_KEY` 或 `CODEX_MEDIA_SESSION_TOKEN` 是否有效。

如果日志里出现 `fetch failed`、`ECONNRESET`、TLS 连接断开等临时网络错误，worker 会按 `CODEX_MEDIA_AUTH_RETRY_MS` 自动重试，不需要重新创建任务。若是 access key 错误、接口返回 401/403，则需要修正 `.env` 后重启 worker。

## life -> ComfyUI workflow parameters

When a `life` media job uses `mediaProvider: comfyui`, the worker keeps the
loaded ComfyUI workflow settings authoritative. Request metadata such as
`aspect`, `durationSeconds`, `fps`, `frames`, `steps`, `size`, and
`negativePrompt` may still appear in the `life` job details, but those values are
not used to overwrite ComfyUI graph parameters.

The worker only injects the runtime fields needed to execute the job: the
positive prompt, output filename prefix, and the uploaded input image for
image-to-video workflows. The final payload sent to ComfyUI is saved beside the
job output as `comfyui-prompt.json` for verification.

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

这个脚本会读取 `.env`，并会处理 UTF-8 BOM，避免带 BOM 的变量名导致环境变量无法生效。

## 视频生成流程

1. `life` 创建 `codex_media_jobs` 任务。
2. 本机 worker 拉取 `pending` 任务，并把任务标记为 `running`。
3. worker 根据任务模式和提示词解析视频时长、源帧率、输出帧率和分段大小。
4. worker 调用 `codex exec` 生成连续帧。帧数较多时会拆成多个顺序分段，并要求每段继续上一段的画面状态。
5. worker 定期回传进度，包括已完成帧数、分段状态、百分比和预计剩余时间。
6. `video` / `both` 模式下，worker 调用 FFmpeg 合成 `clip-0001.mp4`。
7. worker 上传结果到 `life` 并标记任务完成。
8. `life` AI 对话区和 `/lxj/pages/codex-media.html` 显示任务状态和结果。

目前视频时长会限制在 1 到 6 秒，源帧总数最多 240 帧。

## 任务提示词示例

```text
生成一个 3 秒视频，16:9。火山口夜景，最开始只有暗红色裂缝，随后岩浆快速喷涌而出，火光照亮黑色岩石，烟雾翻滚上升，镜头轻微后退，电影感，强烈明暗变化。
```

```text
生成图片和 2 秒视频，16:9。森林里的发光蘑菇从暗处逐渐亮起，萤火光点缓慢漂浮，镜头轻微横移，奇幻写实风格，保持同一场景连续变化。
```

```text
生成 0.3 秒 8 张图并合成视频，输出 24帧/秒。玻璃杯落到木桌上，水珠飞溅，微距镜头，动作连续。
```

### 图生视频提示词建议

图生视频最容易在“转头、低头、抬眼、微笑、推近到面部特写”时出现脸部变形。想要明显变化时，优先把变化放在环境、风、衣物、道具和光线上，脸部保持稳定。

推荐结构：

```text
生成 4 秒视频，9:16，真实摄影风格。以上传图片作为第一帧，严格保持同一个人物、同一张脸、同一五官比例、同一发型、同一服装、同一道具和同一场景。

重要：人物脸部必须保持稳定，不改变长相，不改变表情，不转头，不低头，不抬眼，不张嘴，不微笑。脸部像照片一样保持清晰自然，只允许非常轻微的呼吸感。

明显变化集中在脸以外：一阵晚风吹过，发丝末端和衣角明显飘动；道具上方的热气或烟雾持续升起并扩散；远处灯光逐渐从暗到亮点亮；环境光从暖色慢慢过渡到更深的蓝紫色。镜头保持基本固定，只做非常轻微的稳定推进，不进入面部特写。

要求动作连续平滑，人物身份稳定，脸部不变形，眼睛不漂移，嘴巴不变形，手指不变形，道具不漂移，不新增人物，不切换场景，不改变服装颜色，不出现文字、水印、logo。

负面约束：face morphing, identity change, distorted face, warped eyes, changing mouth, extra teeth, bad anatomy, flicker, jitter, duplicate face, melted face, blurry face.
```

## 与 `life` 的关系

`life` 部署在云端时，本机 worker 仍然可以对接，只要：

1. `LIFE_BASE_URL` 指向云端地址，例如 `https://www.liaoxianjun.com`。
2. 本机能访问云端接口。
3. 云端 `life` 已部署 `codex_media_jobs` 相关接口。
4. worker 上传文件到云端 `/upload/to` 成功。

这样云端发起任务，本机生成和上传，云端页面再展示结果。

## 前端体验约定

- `life` 的 AI 对话区会优先识别图片/视频提示词，再识别定时任务，避免“第 1 秒 / 第 2 秒 / 下午”等视频描述被误判为定时任务。
- 明确的“生成图片/视频”请求会直接创建任务；长段视觉提示词会先询问确认。
- 对话区顶部只显示当前运行任务和下一个排队任务，任务完成后会把结果自动补进当前对话。
- `/lxj/pages/codex-media.html` 是任务队列页：
  - 移动端禁止横向滚动。
  - 仅运行中/排队中显示进度条，完成后隐藏进度条。
  - 结果文件默认只显示链接和大小，点击“预览”后才加载图片或视频。
  - 页面会复用 AI 对话页的背景图和玻璃透明度设置。
