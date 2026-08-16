# @deepseek-ai/dsh-client-ui-taskflow

[English](README.md) | 中文

TaskFlow 底部状态条，frame 级 `shell.overlay` 槽位的第一个正式住户：收起态 30px 迷你条，展开为规格 §6 v3.0 定义的注意力表面——统一实色低饱和的时间史条（系列打包、零碎块、原位 hover 上提）、一行呼吸点运行芯片、以及收纳待收口/无心跳/溢出的标题浮层。事实经 `taskflow` Remote 命名空间（`@deepseek-ai/dsh-host-taskflow`）来自总线账本，客户端每 10 秒由纯折算引擎（`src/client/fold.ts`，以真实账本 fixture 单测）重折算；本条只渲染账本，从不拥有数据。浮层的收口勾走审计级 `seal()` 门，钉死具体 needs-you 事件并以 `dsh-ui:seal-click` 为确认出处。本条以 ResizeObserver 观测当前挂载的条根，把实时高度以 `--dsh-shell-bottom-clearance` 发布到 shell frame 上，ui-layout 的 frame 按该变量收缩列内容——内容止于条上沿，而非被压在条下。

## Model Experience

无。纯人面表面；无工具、无提示词贡献。

## Known Limitations and Deferred Work

- **标签适配判定尺度混用**——文字宽度已是真实测量（canvas `measureText`，回退 `estTextW`），芯片行宽为实测；但时间史条的标签放不放得下仍对 900px 比例模型比较，非渲染像素。
- **队列动作不在范围内**（规格 §6 v3.0 动作表）。
