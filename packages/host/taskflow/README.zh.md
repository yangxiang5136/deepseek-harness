# @deepseek-ai/dsh-host-taskflow

[English](README.md) | 中文

TaskFlow 的宿主数据面是 `taskflow` 命名空间的 Remote-only 服务，读取 `~/my-memories/attention/` 下的月度注意力账本。`read` 按文件名顺序拼接权限私密的普通 `events-YYYY-MM.jsonl` 文件，排除轮转用的 `events.jsonl` 软链接；损坏、权限过宽或非 ENOENT 的 I/O 失败会拒绝调用，让客户端保留最近一次成功折算。`seal` 只接受固定的 `dsh-ui:seal-click` 手势，并持有共享 `.taskflow-ledger.lock` 的 owner 租约，完成读取、校验、月度轮转与追加。已有锁绝不自动破除；等待五秒后以 busy 失败，留给人工核验。writer 拒绝经软链接追加，以 canonical `event_id` 精确收口一条 `needs-you`（仅无 ID 的旧目标回退 `ts`），并追加自带 UUID 的 schema-v2 `done` resolver。追加内容会在释放锁前同步到磁盘，并把账本权限收紧到 `0600`，与 Python writer 对齐。总线文件仍是唯一事实源，宿主不留缓存。

## Model Experience

无。本服务不暴露工具、不贡献任何提示词内容，只应答浏览器的 Remote 调用。

## Known Limitations and Deferred Work

- **`read` 为全历史读取**——无增量 tail 或月份游标；当前账本体量可接受，但每次轮询成本随保留历史总量增长。
- **账本路径固定**为单 Mac 总线约定；多机布局是明确非目标（规格 §8）。
