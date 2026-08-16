# @deepseek-ai/dsh-host-taskflow

[English](README.md) | 中文

TaskFlow 的宿主数据面：`taskflow` 命名空间的 Remote-only 服务，覆盖注意力账本 `~/my-memories/attention/events.jsonl`。`read` 一次性返回 JSONL 原文与读取元数据；解析与折算语义（规格 §6 v3.0）完全住在浏览器半（`@deepseek-ai/dsh-client-ui-taskflow`）——总线文件保持唯一真相，宿主永不缓存第二份。`seal` 变更（追加经人授权的 `done` 事件）在后续阶段落地。

## Model Experience

无。本服务不暴露工具、不贡献任何提示词内容，只应答浏览器的 Remote 调用。

## Known Limitations and Deferred Work

- **`read` 为整文件读取**——无增量 tail；按月轮转的账本体量下可接受，单月超限时再议。
- **`seal` 尚未实现**——收口勾（P2 S5）将在校验该任务存在未收口 `needs-you` 后追加 `done` 事件。
- **账本路径固定**为单 Mac 总线约定；多机布局是明确非目标（规格 §8）。
