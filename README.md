# AI Minder

高频 AI 思考板：面向内容的思维导图画布（对话过程在侧栏） + 可排队/插话的对话 + 后台 agent 调度 + 版本分支树。AI 层基于 [pi](https://github.com/badlogic/pi-mono) SDK（`@earendil-works/pi-coding-agent`），模型沿用 `~/.pi/agent` 的配置。

```bash
npm install
npm run dev        # http://localhost:5173
```

## 操作

| 操作 | 方式 |
|---|---|
| 发送 / 排队 | `↵`（AI 工作时自动进入队列） |
| 插话 | `⌘↵`：在当前回答的工具调用间隙插入 |
| 打断 | `Esc` |
| 关注节点 | 点选 / `⇧` 多选节点后再说话，新内容默认挂在它下面 |
| 加子节点 / 同级节点 | 选中节点后 `Tab` / `⇧Tab` |
| 调整层级 | 把节点拖到另一个节点上 |
| 固定位置 | 拖到空白处即固定；点节点上的 ⌖ 恢复自动排版 |
| 折叠分支 | 节点右侧的圆形按钮 |
| 编辑 | 双击标题或正文，`⌘↵` / `Esc` 保存 |
| 摘要 / 全文 | 顶栏切换；单个节点用 ▾ 展开 |
| 查看/撤销 AI 修改 | 节点上的「已改」 |
| 对话 / 调度板 / 版本树 | 右侧栏 |

## 结构

- `server/agents.ts` 主对话 agent 与调度板任务 agent（pi 会话、事件 → 白板）
- `server/tools.ts` 画布工具（查看/新建/局部修改/连线/派发任务）
- `server/web.ts` Exa 联网搜索与网页读取
- `server/versions.ts` 版本树（白板 + 对话上下文快照）
- `web/src/layout.ts` 思维导图自动布局
- `web/src/animator.ts` 修改动画：定位 → 标红待删 → 逐字删除 → 逐字写入 → 高亮渐隐
