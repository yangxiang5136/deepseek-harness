# @deepseek-ai/dsh-client-ui-taskflow

[English](README.md) | 中文

TaskFlow 底部状态条是 frame 级 `shell.overlay` 槽位的第一个正式住户：收起态为 30px 迷你条，展开为规格 §6 v3.0 定义的注意力表面，包含低饱和时间史条、运行芯片行，以及收纳待收口、无心跳泳道和溢出项的标题浮层。事实经 `taskflow` Remote 命名空间（`@deepseek-ai/dsh-host-taskflow`）来自总线账本，每 10 秒重新折算。时间史、当前任务、后台任务与泳道仍按当天折算；`needs-you` 欠账按全账本折算，可跨日、跨月保留。v2 欠账只允许精确的 schema-v2 resolver 关闭：`dsh` 审计 `done` seal，或 note 以 `Superseded` 开头的 `drop` 撤回。旧 v1 欠账的 60 秒启发只读取旧 terminal 行，未来普通 v2 terminal 不能关闭它。收口勾在可用时发送目标 `event_id`，并以 `dsh-ui:seal-click` 记录确认出处。状态条把实时高度以 `--dsh-shell-bottom-clearance` 发布到 shell frame，使 ui-layout 内容止于条上沿。

## Model Experience

无。纯人面表面；无工具、无提示词贡献。

## Known Limitations and Deferred Work

- **标签适配判定尺度混用**——文字宽度已是真实测量（canvas `measureText`，回退 `estTextW`），芯片行宽为实测；但时间史条的标签放不放得下仍对 900px 比例模型比较，非渲染像素。
- **队列动作不在范围内**（规格 §6 v3.0 动作表）。
