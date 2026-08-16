# Agent Note: 基于总线账本的 TaskFlow 注意力条

Status: implemented

[English](2026-08-15-taskflow-attention-bar.md) | 中文

## Problem

用户的注意力账本（`~/my-memories/attention/events.jsonl`，各 AI 表面按 TaskFlow 协议追加的 append-only JSONL）此前没有控制台内的渲染：正在跑什么、今天的时间去了哪里、哪些委派产出还欠着人的收口，在 web 控制台里全不可见。十二轮迭代出的原型只以动态 Cordis 包（pkg-26）形态存在——其 `styles.insert` 字符串、`harness.handle` RPC、hash 类名 padding 注入与逐会话审批，均无法入树交付。

## Decision

以两个包移植原型。`@deepseek-ai/dsh-host-taskflow` 是薄文件面：`TypertRemoteService`（`taskflow`）的 `read()` 返回账本全文，`seal()` 追加一条带审计的 `done`——请求以 `ts` 钉死具体 `needs-you` 事件（`resolvesTs`）并写明人工确认出处（`confirmationRef`），门在调用时重读账本，别的表面刚收口过的债会被拒绝而非双重关闭。写入直接用 `node:fs`（session-persistence-jsonl 先例）；总线文件保持唯一事实源——无宿主缓存、事实不进 storage-domain。

`@deepseek-ai/dsh-client-ui-taskflow` 是 `shell.overlay` 的第一个正式住户：纯折算引擎（`fold.ts`——收口 ≥ 60 s、泳道归位、系列打包、零碎聚合、闲置暂停）对 10 秒轮询的账本 `HostObservable` 重折算；组件用 CSS Modules 走 `--dsw-*` 别名，低饱和项目调色板保留为数据字面量。文字宽度用 canvas `measureText`，以 `estTextW` 字宽启发为回退与纯折算默认；共享列上的一个 ResizeObserver 同时供给芯片拆分与时间史条的标签适配尺度。

内容避让是单属性契约：条把实时高度以 `--dsh-shell-bottom-clearance` 发布到 frame 元素（经 `[data-shell-overlay]` 的父元素定位），ui-layout 的 frame（`box-sizing: border-box`）按该变量为列内容加底部 padding——刻意独立成单一用途 commit，未来对上游 rebase 时只携带一个隔离 diff。

## Alternatives considered

- **宿主侧折算**——否：原型的折算语义是最费工夫的成果，服务端重推有静默漂移风险；且客户端反正要按时钟重折算（欠账时长无新事件也在走）。
- **原型的 hash 类名 padding 注入**（`.pI_x6G_frame`）——否：hash 类名随构建漂移；CSS 变量接缝跨构建存活，且把上游 diff 压到一条规则。
- **用 `ctx.fs` 写账本**——否：该服务是模型工具的策略围栏，拒绝工作区外写入；宿主业务包按既有持久化先例直接用 `node:fs`。
- **收口按任务名宽松匹配**——互审中否决：同名债绝不能误关，请求钉死事件时间戳并记录授权出处。
- **把避让变量发布到 `document.documentElement`**——否：自定义属性只向下继承，变量应设在恰好覆盖消费子树的元素上，并随条一起消失。

## Consequences

- 控制台获得"看得见/收得掉"闭环：今日时间史条、运行芯片、欠账浮层（其收口勾写入带审计的 `done`）——账本仍是总线文件，其他表面照常追加，协议零改动。
- 10 秒轮询是有意选择（尚无文件监听推送通道）；读取失败保留上一次折算并把错误显示在条上，而非静默冻结。
- 几何保留具名近似：芯片宽度公式镜像 CSS 常量（任务 150px 上限、来源标签 9px）而非测量已渲染节点；hover 宽度仍以 `cqw` 收敛。
- 真实组合验证（收起/展开避让几何、hover 零回流）留待活控制台验收；jsdom 覆盖接线与折算语义，fixture 用真实账本月文件。

## Deferred

- 按规格 §6 v3.0 的活控制台验收（P2 S6），含避让几何的 `apps/web` 场景。
- 会话软绑定：点击泳道跳转所属会话。
- 队列动作（按规格动作表不在范围内）。
