# @deepseek-ai/dsh-client-ui-taskflow

[English](README.md) | 中文

TaskFlow 底部状态条，frame 级 `shell.overlay` 槽位的第一个正式住户：收起态 30px 迷你条，展开为规格 §6 v3.0 定义的注意力表面——统一实色低饱和的时间史条（系列打包、零碎块、原位 hover 上提）、一行呼吸点运行芯片、以及收纳待收口/无心跳/溢出的标题浮层。事实经 `taskflow` Remote 命名空间（`@deepseek-ai/dsh-host-taskflow`）来自总线账本，客户端每 10 秒由纯折算引擎（`src/client/fold.ts`，以真实账本 fixture 单测）重折算；本条只渲染账本，从不拥有数据。浮层的收口勾走审计级 `seal()` 门，钉死具体 needs-you 事件并以 `dsh-ui:seal-click` 为确认出处。

## Model Experience

无。纯人面表面；无工具、无提示词贡献。

## Known Limitations and Deferred Work

- **几何为启发式**——芯片溢出与 hover 宽度用 `estTextW` 字宽估算（尚无 DOM 测量）；S4 升级为真实测量。
- **内容避让需一行上游改动**——发布 `--dsh-shell-bottom-clearance` 须待 ui-layout 的 frame 消费它（P2 S4）；在此之前条浮于内容之上（S4 同时补挂避让）。
- **队列动作不在范围内**（规格 §6 v3.0 动作表）。
