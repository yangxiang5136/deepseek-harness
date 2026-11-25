# @deepseek-ai/dsh-host-taskflow

[English](README.md) | 中文

TaskFlow 的宿主数据面是 `taskflow` 命名空间的 Remote-only 服务，读取 `~/my-memories/attention/` 下的月度注意力账本。`read` 按文件名顺序拼接权限私密的普通 `events-YYYY-MM.jsonl` 文件，排除轮转用的 `events.jsonl` 软链接；损坏、权限过宽或非 ENOENT 的 I/O 失败会拒绝调用，让客户端保留最近一次成功折算。`seal` 只接受固定的 `dsh-ui:seal-click` 手势，可附一行收口留言（去首尾空白后不超过 280 字，写入收口记录的 `payload.note`），并持有共享 `.taskflow-ledger.lock` 的 owner 租约，完成读取、校验、月度轮转与追加。已有锁绝不自动破除；等待五秒后以 busy 失败，留给人工核验。writer 拒绝经软链接追加，以 canonical `event_id` 精确收口一条 `needs-you`（仅无 ID 的旧目标回退 `ts`），并追加自带 UUID 的 schema-v2 `done` resolver。追加内容会在释放锁前同步到磁盘，并把账本权限收紧到 `0600`，与 Python writer 对齐。总线文件仍是唯一事实源，宿主不留缓存。`todos` 原样读取 `~/my-memories/todo/projects/` 下的普通 `*.md` 文件（跳过软链接），供客户端的项目树使用。账本校验把 `park` 作为 `needs-you` 的第四种类型接受（支线停放位，协议 v2.1）。

## 本人阶段确认

`confirmPhase(request)` 接受一个精确待审身份，以及本机原始对话记录中一条真人消息的引用：绝对路径 `sourcePath`、该记录起始位置 `byteOffset`，以及不超过 280 字的单行原话 `quote`。`surface` 指明写下这份记录的 AI 工具并选择对应适配器；每个适配器把根目录固定在宿主用户主目录之下，Remote 调用方无法指定宿主读取的位置。所有适配器都拒绝：根目录、目录或文件为软链接，非普通文件，偏移不在行首，半行或超限记录（每条 1 MiB），JSON 或 UTF-8 损坏，读取期间被替换的文件，以及真人输入文本中不存在的引文。被拒绝的请求不写入任何内容。当前交互 AI 判断原话覆盖哪个精确待审项；此方法不对任意对话自动分类，也不按相似任务名扩展关闭范围。

| `surface` | 会话字段 | 接受的记录文件 | 真人消息 | `confirmation_ref` |
|---|---|---|---|---|
| `codex` 或省略 | `threadId` | 位于 `~/.codex/sessions/` 或 `archived_sessions/` 下，文件名以 `-<threadId>.jsonl` 结尾；首条记录是无父线程、非分叉的交互式 `vscode` 或 `cli` 会话 | 角色为 `user`、内容标记含 `user.text` 的 `response_item`，且开头不是自动化或注入上下文包装 | `codex-user:<threadId>#byte=<offset>` |
| `claude-code` | `sessionId` | `~/.claude/projects/<project-slug>/<sessionId>.jsonl`；子 agent 记录位于更深层目录，一律拒绝 | 该会话来自 `claude-desktop` 入口的 `user` 记录，`origin` 恰为 `{"kind":"human"}`，`turnOrigin: "human"`，`isSidechain: false`，且无 meta、压缩摘要或仅供记录显示的标记 | `claude-code-user:<sessionId>#byte=<offset>` |

Claude Code 的引文必须位于文本块中开头 `<system-reminder>` 元素之后的部分。去掉这些元素后仍以标记开头，或含注入包装（后续提醒、粘贴内容、shell 输入或输出、CI、任务、定时、旁支会话、跨会话或命令事件）的文本块不计入；图片和文档跳过，工具结果或未知类型的块使整条记录被拒绝。

点击确认和经过核验的自然语言确认共用账本锁及精确收口事务。自然确认把适配器给出的引用写为 `confirmation_ref`，`payload.note` 仅保存原话。收口时间表示确认时间，不推断现实事项实际完成日。重复请求不会追加第二条 resolver。原始聊天和待审来源保持原样。史官阶段复盘消费者可将任一审计收口作为复盘起点；本服务不代表史官已实际阅读或反思材料。

## 审阅计划

`reviewPlans()` 仅读取 `~/my-memories/attention/project-plans/` 顶层的 `*.json` 文件，宿主可通过绝对路径 `DSH_TASKFLOW_REVIEW_PLANS_DIR` 覆盖目录；Remote 调用不接受路径。文件按名称排序并保留 UTF-8 JSON 对象原文，审阅顺序的业务格式由客户端校验。目录缺失返回 `exists: false`；根目录或匹配文件为软链接、类型不符、JSON 损坏、文件读取期间变化及其他 I/O 失败都会拒绝整次读取。上限为 64 个文件、每文件 256 KiB、完整序列化快照 2 MiB，最后一项包含转义文本与元数据。读取计划不写账本事件，也不改变人工接受状态。

快照的 `observer` 只从 `~/my-memories/attention/review-watch-status.json`（可由 `DSH_TASKFLOW_REVIEW_WATCH_STATUS` 覆盖）返回 `lastScanAt`、`lastErrorCount`、`coverage` 和 `excluded`。状态文件缺失时返回 null；文件不安全、健康字段无效或超过 4 KiB 都会拒绝读取。私有来源游标与其他字段不会返回。客户端根据扫描时间判断监听是否停滞，与计划保存时间分别处理。

## 模型体验

无。本服务只应答浏览器对总线文件的 Remote 调用；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **`read` 为全历史读取**——无增量 tail 或月份游标；当前账本体量可接受，但每次轮询成本随保留历史总量增长。
- **账本路径固定**为单 Mac 总线约定；多机布局是明确非目标（规格 §8）。
- **Claude Code 确认只覆盖桌面应用中输入的记录。** 终端、IDE 与 SDK 入口在采集到其原生记录之前一律拒绝。回合运行期间输入的消息存为排队附件而非 `user` 记录，本人需在回合结束后再说一次确认。
- **恢复或分叉的 Claude Code 记录可能包含早先真人记录的副本**，副本带新会话 ID。这类副本能通过核验，因为文字确为本人所写，但引用指向副本，而非消息最初输入的会话。
- **记录核验信任本机账户。** 检查能拒绝错配、注入和挪动过的文本；能写入记录文件的进程仍可伪造记录。
