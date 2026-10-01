# AI Minder

高频 AI 思考板：面向内容的思维导图画布（对话过程在侧栏） + 可排队/插话的对话 + 后台 agent 调度 + 版本分支树。AI 层基于 [pi](https://github.com/badlogic/pi-mono) SDK（`@earendil-works/pi-coding-agent`），模型沿用 `~/.pi/agent` 的配置。

```bash
npm install
npm run dev        # 开发：http://localhost:5173

npm run build      # 生产：构建前端
npm start          # 同一个端口提供页面和接口：http://localhost:5174
```

环境变量：`PORT`（默认 5174）、`HOST`（默认 127.0.0.1）、`AI_MINDER_DATA`（数据目录，默认 `<项目>/data`）。

## 操作

| 操作 | 方式 |
|---|---|
| 发送 / 排队 | `↵`（AI 工作时自动进入队列） |
| 插话 / 打断 | `⌘↵` / `Esc` |
| 关注节点 | 点选 / `⇧` 多选节点后再说话，新内容默认挂在它下面 |
| 展开正文 | 双击节点；顶栏可切换「摘要 / 全文」 |
| 更多操作 | 右键节点：让 AI 改、手动编辑、加子节点、删除…… |
| 加子节点 / 同级节点 | 选中节点后 `Tab` / `⇧Tab` |
| 调整层级 | 把节点拖到另一个节点上；拖到空白处则固定位置 |
| 关系线 | 从节点右侧圆点拖到另一个节点；右键改方向、双击改文字 |
| 搜索节点 | `⌘K` |
| 节点位置 | 右键节点 →「放在父节点的」左边 / 右边 / 下边 / 跟随父级；子树沿这个方向继续展开 |
| 节点标签 | 右键节点 →「标签…」；点卡片上或左上角的标签筛选，其余节点变淡；`⌘K` 里输入 `#标签` 搜索 |
| 技能 | 输入框键入 `/` 选择技能（`/skill:名字 要做的事`）；AI 也会在合适时自己读取。内置技能在 `server/skills/`，自定义的放 `<数据目录>/skills/<名字>/SKILL.md` |
| 导出 / 导入 | 顶栏「文件」：Markdown / JSON / PNG；也可把文件拖到画布 |
| 查看/撤销 AI 修改 | 节点上的「已改」 |
| 对话 / 调度板 / 版本树 | 右侧栏 |

## 结构

- `server/agents.ts` 主对话 agent 与调度板任务 agent（pi 会话、事件 → 白板）
- `server/tools.ts` 画布工具（查看/新建/局部修改/调整层级/关系/派发任务）
- `server/drafts.ts` 草稿节点：工具参数流式生成时就先上白板
- `server/skills.ts` 技能（Agent Skills 格式的 SKILL.md）加载与注入
- `server/web.ts` Exa 联网搜索与网页读取
- `server/versions.ts` 版本树（白板 + 对话上下文快照）
- `web/src/layout.ts` 思维导图自动布局（子树按轮廓贴紧、顶层多棵树自动分列、同列关系线的车道分配）；分列在 AI 每轮结束时定下来，手动编辑不会让树换列
- `web/src/io.ts` 导出导入格式转换
- `web/src/animator.ts` 修改动画：定位 → 标红待删 → 逐字删除 → 逐字写入 → 高亮渐隐
