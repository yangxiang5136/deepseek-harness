# Agent Note: 基于总线账本的 TaskFlow 注意力条

Status: implemented

[English](2026-08-15-taskflow-attention-bar.md) | 中文

## Problem

用户的注意力账本（`~/my-memories/attention/events.jsonl`，各 AI 表面按 TaskFlow 协议追加的 append-only JSONL）此前没有控制台内的渲染：正在跑什么、今天的时间去了哪里、哪些委派产出还欠着人的收口，在 web 控制台里全不可见。十二轮迭代出的原型只以动态 Cordis 包（pkg-26）形态存在——其 `styles.insert` 字符串、`harness.handle` RPC、hash 类名 padding 注入与逐会话审批，均无法入树交付。

## Decision

以两个包移植原型。`@deepseek-ai/dsh-host-taskflow` 是薄文件面：`TypertRemoteService`（`taskflow`）的 `read()` 拼接全部权限私密的普通月度账本，但不重复读取轮转软链接；损坏、权限过宽或非 ENOENT 的读取失败会拒绝调用，而非伪装为空账本。`seal()` 只接受固定 UI 手势，在注意力根目录的跨语言 `.taskflow-ledger.lock` 内完成读取、校验、月份轮转与追加，以 canonical `event_id` 钉死目标（仅目标无 ID 时回退 `ts`），并同步追加自带 UUID 的 schema-v2 `done` resolver。锁绝不自动破除，追加路径绝不跟随软链接，文件会收紧到 `0600`。写入直接用 `node:fs`；总线仍是唯一事实源——无宿主缓存、事实不进 storage-domain。

`@deepseek-ai/dsh-client-ui-taskflow` 是 `shell.overlay` 的第一个正式住户：纯折算引擎（`fold.ts`）让时间史、当前任务、后台任务和泳道按当天显示，同时按 append 顺序从全账本折算注意力欠账。v2 欠账只允许精确的 schema-v2 resolver 关闭：`dsh` 审计 `done` seal，或 note 以 `Superseded` 开头的 `drop` 撤回。旧 v1 欠账的 60 秒启发只读取旧 terminal 行；未来普通 v2 terminal 不能关闭它。所有任务身份比较统一使用 project+task，并以 append ordinal 区分完全相同的 legacy UI 行。组件使用 CSS Modules 与现有 `--dsw-*` 别名，低饱和项目调色板保留为数据字面量。

内容避让是单属性契约：条把实时高度以 `--dsh-shell-bottom-clearance` 发布到 frame 元素（经 `[data-shell-overlay]` 的父元素定位），ui-layout 的 frame（`box-sizing: border-box`）按该变量为列内容加底部 padding——刻意独立成单一用途 commit，未来对上游 rebase 时只携带一个隔离 diff。

## Alternatives considered

- **宿主侧折算**——否：原型的折算语义是最费工夫的成果，服务端重推有静默漂移风险；且客户端反正要按时钟重折算（欠账时长无新事件也在走）。
- **原型的 hash 类名 padding 注入**（`.pI_x6G_frame`）——否：hash 类名随构建漂移；CSS 变量接缝跨构建存活，且把上游 diff 压到一条规则。
- **用 `ctx.fs` 写账本**——否：该服务是模型工具的策略围栏，拒绝工作区外写入；宿主业务包按既有持久化先例直接用 `node:fs`。
- **新欠账按任务名或耗时关闭**——否：schema-v2 欠账必须由精确 resolver 关闭，旧耗时规则只用于读取 legacy v1 记录。
- **进程内收口队列**——否：两个宿主可并发运行，所有 runtime 都以共享原子目录锁作为串行点。
- **把避让变量发布到 `document.documentElement`**——否：自定义属性只向下继承，变量应设在恰好覆盖消费子树的元素上，并随条一起消失。

## Consequences

- 控制台获得“看得见/收得掉”闭环：今日时间史条与运行芯片，加上可跨日保留的 schema-v2 欠账；收口勾只写一条精确审计 resolver。
- 跨月收口不会再通过过期的 `events.jsonl` 链接写回旧月：seal 在共享锁内以同一个时钟选择月份，创建月文件、原子替换软链接，再追加事件。
- 10 秒轮询是有意选择（尚无文件监听推送通道）；读取失败保留上一次折算并把错误显示在条上，而非静默冻结。
- 几何保留具名近似：芯片宽度公式镜像 CSS 常量（任务 150px 上限、来源标签 9px）而非测量已渲染节点；hover 宽度仍以 `cqw` 收敛。
- 避让发布器为 effect 驱动而非 ref 驱动：活体验收发现平台运行时在换根时先挂新根的 ref、后调旧根的 null——ref 持有的 observer 会被前任的清理误断；effect 的 cleanup→setup 顺序则两种情况下都有保证。jsdom 的运行时调用序相反，测不出此坑。
- 活体验收已通过（收起/展开双向避让几何、hover 零回流三态、浮层开着过 10 秒刷新、对真实账本的审计收口往返）；标题浮层向上展开——原型的向下锚点在底部停靠条上会裁出视口。

## Deferred

- 在真实组合里钉住避让几何的 `apps/web` 场景（活体验收已人工覆盖）。
- 会话软绑定：点击泳道跳转所属会话。
- 队列动作（按规格动作表不在范围内）。
