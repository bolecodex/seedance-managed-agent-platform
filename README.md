# Visionary · 视觉创作工作台

一个无第三方运行依赖的前后端视觉创作工作台，以 Codex 会话为交互基准，底层调用 Seedance Managed Agent，支持多轮对话、计划模式、工具确认、持久目标、云端暂停、流式回复和断线续接。

## 启动

要求 **Node.js 22+**。前端和后端由同一个服务提供，无需分别安装依赖或启动两个进程。

```bash
# 首次使用且尚无 .env 时执行；不要覆盖已有密钥
cp .env.example .env
node server.js
```

打开 [http://localhost:3000](http://localhost:3000)。也可运行 `npm start` 或 `npm run dev`。修改 `.env` 后需要重启。

未配好 Agent 时，创作入口运行本机预置的**演示方案**，不调用模型、不生成真实图片或视频。界面始终显示演示标识；Key 已配置不代表权限已经验证。

## 会话、发送与恢复

每个工作区条目对应一条持久化的方舟 Session。首次发送创建 Session；后续消息继续写入同一会话。刷新浏览器不影响云端任务，侧栏会话列表通过 SSE 同步，切换会话时保留各自未发送草稿。

- Enter 发送，Shift+Enter 换行；运行中的补充消息可选择「排队发送」或「立即引导」。排队消息可以查看、移除，暂停期间会保留为待发送消息。
- 点击「暂停」或按 Esc，会向 Session 发送 `user.interrupt` 并等待云端确认空闲。继续时沿用原 Session、环境和历史内容。
- SSE 意外断开时先重新打开实时流，再分页补查 Session 历史并按事件 ID 去重。HTTP 发送结果不明确时不会自动重发；服务进程重启后会恢复原 Session 跟踪，不会创建新会话或重放已接收的消息。
- 会话支持重命名、置顶、归档、本机删除和复制。复制创建新的 Session，在原 Session 空闲时复制已有用户和 Agent 对话，不复制云端文件或工具权限确认。
- `/` 打开命令菜单；支持 `/goal`、`/plan`、`/agent`、`/pause`、`/resume`、`/fork`、`/rename`、`/pin`、`/archive`、`/clear`、`/new`。
- `/plan` 通过会话配置覆盖禁用服务端工具；`/agent` 通过方舟 Session upgrade 恢复原工具配置，始终使用同一 Session。切换在云端空闲时执行。
- 使用 `VISIONARY_DATA_DIR` 可将本机任务、Goal 和消息持久化目录放在指定路径。服务重启后会尝试自动恢复活动会话；发送结果不明确的消息需要先恢复查看，避免重复计费。

## 持久目标

在空白会话设置 Goal 会以同一个原子请求创建会话及目标。活跃目标可持续驱动会话，直到 Agent 明确返回 `<<GOAL_COMPLETE>>`、`<<GOAL_BLOCKED>>`、达到可选 Token 预算、被暂停或需要工具确认。预算在轮次结束时检查，当前轮次可能超过预算；未收到可核对的方舟累计用量时会暂停 Goal 并提示检查。可编辑、暂停、恢复、标记完成或移除目标。目标只对带有该目标 ID 的 Agent 回复更新状态，避免普通追问继承旧的完成标记。

演示模式不能执行持久目标，会提示需要连接已配置的 Managed Agent。目标本身和 Token 预算都会持久化；自动续跑采用服务端任务队列，并受模型与平台 Session 限制。这里的 Goal 对齐 Codex 的目标生命周期，不等于客户端提供操作系统沙箱或任意代码执行权限。

## 接入真实视觉 Agent

在 `.env` 配置 `ARK_API_KEY`，并选择一种方式：

- **复用已有 Agent**：填写 `ARK_AGENT_ID`，可选填写 `ARK_ENVIRONMENT_ID`。
- **自动创建**：填写 `ARK_AGENT_MODEL` 和 `ARK_IMAGE_MODEL`；如需视频工具，另填 `ARK_VIDEO_MODEL`。模型 ID 和开通权限以你的方舟控制台为准。

后端按[Seedance Managed Agents 官方文档](https://docs.volcengine.com/docs/ark/session-event-stream?lang=zh)使用 `Agents → Environments → Sessions`，建立 SSE 并等待 `: ready` 后发送消息，再持续消费 Agent、工具、用量和会话事件。断线时先重建实时流，再调用 Events API 分页补查。正常结束以 `session.status_idle.stop_reason.type=end_turn` 为准，随后查询 `Files API` 产物。**不是 `/chat/completions`，旧的 `ARK_MODEL` 不用于该流程。**

首次真实创作可能创建并缓存云端 Agent / Environment 到 `data/agent-resources.json`。默认 Environment 使用文档示例中的公共产物存储和 unrestricted 网络；仅适合非敏感演示。生产环境请使用自己的 TOS、受限网络、登录鉴权和访问控制。Demo 仅绑定本机，无多人隔离或磁盘加密。

真实创作会产生方舟计费；点击真实创作前请确认模型、项目权限及费用。不会自动重试生成请求；流中断、超时或服务重启时应先用任务中的 `sessionId` 到控制台核实原会话，避免重复计费。下载地址可能过期，长期保存请及时下载。

## 素材与人像边界

- 参考素材：支持 PDF、Word、TXT、Markdown、常用图片、视频和音频，单个最大 512 MB。本机保存到 `data/uploads/`；配置 Key 后上传 Files API（`purpose=agent`）。只有成功取得文件 ID 的参考素材能挂载到真实 Agent 会话。
- 工作台直接粘贴：点击「描述你的创意」输入框或卡片空白处，按 `⌘ V` / `Ctrl V` 粘贴剪贴板中的图片、视频或音频文件。支持多文件，自动上传到参考素材库，成功同步后自动引用；显示上传进度、失败重试与移除操作。上传未完成或存在失败素材时需先处理再开始创作。纯文字仍正常粘贴到输入框；复制的是网页链接时按文字处理，视频和音频需复制实际文件。
- 私域虚拟人像库：默认入口，支持本地图片、视频、音频，以及云端可访问的素材 URL。使用 `CreateAssetGroup(GroupType=AIGC) → CreateAsset → GetAsset`，不需要 H5 活体认证或公网回调地址。文档、剧本仍上传到「参考文档与素材」。
- 服务端配置 `ARK_ACCESS_KEY` / `ARK_SECRET_KEY` 和 `ARK_PROJECT_NAME=yingke`。选择已有 AIGC 素材组或新建角色素材组；后端校验素材组类型及项目一致性。可「同步云端素材」导入该组在控制台已有的资产，支持分页。
- 勾选虚拟素材使用权限，添加本地文件并上传：后端先保存文件，再通过 Files API 临时托管并取得签名下载地址，提交至 AIGC 素材组。无需将本机服务公开。也可展开 URL 表单直接提交素材链接。
- 刷新列表自动查询处理中资产。仅 `Active` 资产可以引用到创作；`Failed` 展示失败，未取得提交结果时标记「结果未确认」，不自动重复入库。普通本机暂存不等于云端入库。
- [虚拟人像指南](https://docs.volcengine.com/docs/82379/2333565?lang=zh)要求开通高级创作权益包并有可用容量，素材应符合虚拟人像规范。图片需小于 30 MB，宽高为 `(300, 6000)` px，宽高比为 `(0.4, 2.5)`；尺寸及内容审核以平台为准。视频、音频还需符合 Assets API 的格式和时长限制。
- 引用时由后端传递 `asset://AssetId` 及模态字段给 Agent 视频工具，提示词按「图片 1 / 视频 1 / 音频 1」指代素材。仅审核通过不代表已完成视频生成，生成结果以实际工具返回为准。
- 删除仅删除本机文件或记录，不删除远端 Files / Assets。`.env` 和 `data/` 已加入 `.gitignore`，切勿共享真实密钥。

### 可选的真人素材接口

以下兼容接口保留给明确提出真人素材入库的现有项目使用，不在当前虚拟素材工作台展示，也不是虚拟素材库的前置条件。

1. 配置 `ARK_ACCESS_KEY`、`ARK_SECRET_KEY`，以及所需的高级创作权益和 `yingke` 项目的 `ArkFullAccess` 权限。API Key **不能**替代 AK/SK。
2. 配置 `ARK_REAL_PERSON_CALLBACK_URL` 为你控制的**公网 HTTPS 回调页**，供 H5 完成后跳转。不要填写本机地址；可使用你已有的回调页面。Demo 不依赖页面传来的 `resultCode` 判成功，只以服务端查询为准。
3. 在页面创建认证链接，由肖像权本人打开并确认授权后完成活体认证。临时链接有效期 30 分钟，仅发给本人；Demo 不收集身份证或活体采集视频。
4. 点击「已完成 · 查询结果」：后端用 `GetVisualValidateResult` 取得组 ID，再用 `GetAssetGroup` 验证 `GroupType=LivenessFace` 和 `ProjectName=yingke`。
5. 上传同人图片或视频，勾选授权自动入库或逐份「提交入库」：后端先经 Files API 临时托管文件，服务端获取签发的短期下载 URL，再调用 `CreateAsset` 提交至真人素材组。真人文件不会因普通上传自动外发，也不会挂载原始文件给 Agent。
6. 自动查询 `GetAsset`，仅 `Active` 才可引用。引用时传递 `asset://` 可信 URI 给 Agent 的视频生成工具；工具是否支持该 URI、项目和模型权限，以实际生成结果为准，不能只凭审核通过宣称生成成功。

如本人已在方舟控制台完成认证，可以展开「已有本人认证的真人素材组」，输入现有 Group ID 并确认授权。后端以 AK/SK 调用 `GetAssetGroup`，只接受当前项目的 `LivenessFace` 组；导入既不创建虚拟组，也不能绕过真人认证。此路径无需配置新的 H5 回调地址或再次认证，但仍需要 AK/SK。

### 部署本人认证回调页

项目自带独立静态页 `public/portrait-callback/`，可先在 [本机预览](http://localhost:3000/portrait-callback/) 查看。将整个目录中的 `index.html`、`callback.css`、`callback.js` 一起部署到你控制的公网 HTTPS 站点，再把该页面的完整 HTTPS 地址填入 `ARK_REAL_PERSON_CALLBACK_URL` 并重启。本机预览地址不能用作手机上的公网回调。只需部署这三个文件，无需把本机 Demo、API、上传目录或 `.env` 公开到互联网。

回调页不请求任何接口，不保存 H5 认证凭证，不加载第三方资源；读取有限格式的 `resultCode` 后会移除地址栏中的全部 query 和 hash。它只提示检测结束、引导用户回电脑点击「已完成 · 查询结果」，不会凭浏览器参数宣称已认证或已入库。接收回调的 HTTPS 托管服务仍会先收到含参数的 URL，请关闭查询参数日志、站点分析及错误上报采集，并设置 `Referrer-Policy: no-referrer`、`Cache-Control: no-store`。页面已提供无 referrer 的 meta 和禁用网络连接的 CSP，正式认证仍以方舟服务端查询为准。

一组只对应一个真人，平台会与活体基准比对，多人脸素材不能入库。审核无时间 SLA。若提交响应丢失，状态为「结果未确认」，不会自动重试；先到控制台核实，避免重复资产。临时 Files 对象不会自动删除，防止在异步审核期间失效，请按你的留存策略在方舟控制台清理。认证凭证保存在权限为 600 的本机 `data/` 文件中，成功后移除临时凭证；请保护本机磁盘。

## 会话 API

| 接口 | 用途 |
| --- | --- |
| `POST /api/conversations` 或兼容的 `POST /api/creative` | 创建会话；支持 `prompt`、`requestId`、`mode`、`goal`、素材和创作参数 |
| `POST /api/tasks/:id/messages` | 向既有 Session 发送消息；支持 `delivery: "queue" / "steer"` 和每轮创作参数 |
| `POST /api/tasks/:id/pause`、`resume`、`recover` | 请求云端中断、继续或仅恢复原 Session 监听和历史 |
| `GET /api/tasks/:id/events` | 订阅本机会话状态 SSE |
| `POST /api/tasks/:id/goal` | 创建、编辑或操作持久目标；动作：`pause`、`resume`、`complete`、`clear` |
| `POST /api/tasks/:id/settings` | 设置后续消息使用的 `plan` / `agent` 模式 |
| `POST /api/tasks/:id/confirm` | 处理 Agent 请求的工具确认 |
| `POST /api/tasks/:id/metadata` | 更新会话标题、置顶和归档 |
| `POST /api/conversations/fork` | 空闲会话创建独立 Session 并复制对话历史 |
| `DELETE /api/tasks/:id` | 删除本机会话记录；不删除方舟 Session 或文件 |

## 本机 API


```bash
curl -X POST http://localhost:3000/api/creative \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"为香氛品牌创作秋季主视觉","options":{"aspectRatio":"1:1","style":"自然写实","optimize":true,"versions":false},"assetIds":[]}'
```

返回 `202 {"task": ...}`，不会等待生成完成；达到并发数后新任务保持 `queued`，获得执行名额后变为 `running`。通过 `GET /api/tasks/:id` 查询直到 `completed` 或 `failed`，`GET /api/tasks` 获取全部任务（含后台运行和排队记录）。

`POST /api/tasks/:id/refresh-outputs` 仅重新校验已结束会话并查询产物，不会再次提交生成；可用于文件注册延迟、临时下载链接过期或产物查询异常后恢复。没有产物的文本任务可以正常完成，Files 列表返回 `null` 时视为当前列表为空。

| 接口 | 用途 |
| --- | --- |
| `GET /api/config` | 脱敏配置状态，不返回密钥 |
| `GET /api/assets` | 素材列表与真人 / 虚拟资产审核状态 |
| `POST /api/uploads` | 原始文件 body；请求头 `X-File-Name`（URL 编码）、`X-Collection`（reference / virtual-avatar；兼容 private-person） |
| `POST /api/assets/:id/sync` | 重试同步已保存在本机的参考素材到方舟 Files API，不会重新上传到本机 |
| `GET /api/assets/:id/content` | 本机预览，支持 Range |
| `DELETE /api/assets/:id` | 删除本机素材 / 记录 |
| `GET /api/avatar-groups` | 查询当前项目 AIGC 素材组；可用 `nextToken` 翻页 |
| `POST /api/avatar-groups` | `{name}` 创建角色素材组；空对象创建 / 复用默认组 |
| `POST /api/avatar-assets` | `{name, assetUrl, assetType: "Image" / "Video" / "Audio", synthetic: true, groupId?}`，返回 202，查询素材列表跟踪异步状态 |
| `POST /api/avatar-assets/sync` | `{groupId, nextToken?}` 同步当前项目云端虚拟资产，返回下一页 token |
| `GET /api/portrait-verifications` | 当前项目真人认证记录，不返回原始 BytedToken |
| `POST /api/portrait-verifications` | `{name, consent: true}`，创建 H5 活体认证链接 |
| `POST /api/portrait-verifications/:id/refresh` | 服务端核验认证结果与真人素材组 |
| `POST /api/portrait-verifications/import` | `{groupId, consent: true}`，校验并复用当前项目已认证的真人组 |
| `POST /api/assets/:id/enroll` | 虚拟素材：`{synthetic: true, groupId?}`；兼容真人接口：`{verificationId, consent: true}`，返回 202 后查询素材列表 |

任务、素材和资源 ID 持久化在 `data/`。测试可用 `VISIONARY_ENV_FILE`、`VISIONARY_DATA_DIR`、`PORT` 指向隔离环境，避免使用真实凭据或影响已有数据。

## 测试

运行 `node --test tests/*.test.js`（或 `npm test`），覆盖并发队列、Seedance 多轮 Session、消息幂等、立即引导、云端暂停、重启与断线恢复、工具确认、计划模式切换、持久目标预算及会话管理。测试使用临时目录和本机模拟接口，不读取 `.env` 或调用真实模型。

浏览器回归测试使用 Playwright，可在已安装 Playwright / Chromium 的环境中运行 `npm run test:browser` 或 `node --test tests/*browser.mjs`。外部安装可通过 `VISIONARY_PLAYWRIGHT_PATH` 指定模块路径、`VISIONARY_CHROMIUM_PATH` 指定浏览器路径；可选 `VISIONARY_SCREENSHOT` 指定截图文件名前缀。覆盖 Enter/Shift+Enter、流式 Agent 回复、会话草稿、`/goal`、Esc 暂停、续跑、工具确认、会话管理及桌面/平板/移动布局。
