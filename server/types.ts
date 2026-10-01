// 前后端共享的数据结构

/** note：普通内容节点；task：后台任务产出的报告；widget：组件，md 里是在沙箱中运行的 HTML */
export type NodeKind = "note" | "task" | "widget";

/** 节点相对父节点的位置：左边 / 右边 / 下边；没设置时跟随父级的展开方向 */
export type NodeSide = "left" | "right" | "bottom";

export interface Activity {
  id: string;
  tool: string;
  label: string;
  status: "running" | "done" | "error";
  detail?: string;
  /** 该操作涉及的节点，点击可定位 */
  nodeId?: string;
  /** ask_user：向用户提的问题和用户的回答 */
  ask?: AskState;
}

export interface AskQuestion {
  question: string;
  /** 很短的标签 */
  header?: string;
  /** 候选项；没有时用户直接输入 */
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** 一个问题的回答：选中的候选项 + 自己输入的内容 */
export interface AskAnswer {
  selected: string[];
  text?: string;
}

export interface AskState {
  questions: AskQuestion[];
  /** undefined：还没回答；null：跳过 / 取消 */
  answers?: AskAnswer[] | null;
}

export type EditField = "md" | "summary";

export interface LastEdit {
  field: EditField;
  before: string;
  after: string;
  at: number;
  by: string;
}

export interface BoardNode {
  id: string;
  kind: NodeKind;
  title: string;
  /** 一两句话的要点摘要，折叠状态下展示 */
  summary: string;
  md: string;
  /** 思维树中的父节点；没有则为根（主题） */
  parentId: string | null;
  /** 手动拖动后固定位置，不参与自动排版 */
  pinned: boolean;
  x: number;
  y: number;
  /** 展开正文 */
  open: boolean;
  /** 折叠子树 */
  fold: boolean;
  /** 所在分组，只写在根节点（主题）上；子节点跟随所在主题 */
  groupId?: string;
  /** 子白板的入口卡片：点进去是一块独立的画布，里面的主题和分组的 scope 指向它 */
  subboard?: boolean;
  /** 主题所在的子白板（入口节点 id），只写在根节点上；没有则在主白板。在分组里时与分组的 scope 一致 */
  scope?: string;
  /** 模型仍在生成中的草稿节点 */
  draft?: boolean;
  /** 布局提示：放在父节点的哪一边（只对有父节点的节点有效） */
  side?: NodeSide;
  /** 自定义标签：可以标记为任何东西（状态、类型、用户的偏好……），用于筛选和定位 */
  tags?: string[];
  /** 顶层分列时在第几列（只对根节点有效）；AI 一轮结束时定下来，之后手动编辑不再重排 */
  col?: number;
  lastEdit?: LastEdit;
  createdAt: number;
  updatedAt: number;
}

/** 节点之间的关系线（树的父子关系不在这里） */
export interface BoardEdge {
  id: string;
  source: string;
  target: string;
  /** forward：source → target；both：双向；none：无箭头 */
  dir: "forward" | "both" | "none";
  /** source → target 方向的关系文字 */
  label?: string;
  /** target → source 方向的关系文字（仅双向时） */
  reverseLabel?: string;
}

export type EdgePatch = Partial<Pick<BoardEdge, "dir" | "label" | "reverseLabel">>;

/**
 * 分组：画布上的一块区域，装若干个完整的主题（不属于思维树）。
 * 组内卡片的 x/y 是相对分组原点的坐标，移动分组不需要改动里面的卡片。
 */
export interface BoardGroup {
  id: string;
  title: string;
  /** 分组原点（组内自动排版从这里开始）；pinned 时有效 */
  x: number;
  y: number;
  /** 拖动过就固定位置，否则和未分组的主题一起自动排列 */
  pinned: boolean;
  /** 折叠成一张小卡片 */
  fold: boolean;
  /** 自动排列时的顺序键（和主题的 createdAt 比较） */
  order: number;
  /** 顶层分列时在第几列，同 BoardNode.col */
  col?: number;
  /** 所在的子白板（入口节点 id）；没有则在主白板 */
  scope?: string;
  createdAt: number;
}

export type GroupPatch = Partial<Pick<BoardGroup, "title" | "x" | "y" | "pinned" | "fold" | "col">>;

export interface ChatEntry {
  id: string;
  role: "user" | "ai";
  text: string;
  /** 推理模型的思考过程 */
  thinking?: string;
  contextNodeIds?: string[];
  activity?: Activity[];
  streaming?: boolean;
  at: number;
}

export interface Board {
  nodes: BoardNode[];
  edges: BoardEdge[];
  groups: BoardGroup[];
  chat: ChatEntry[];
}

export interface Task {
  id: string;
  title: string;
  instructions: string;
  contextNodeIds: string[];
  status: "running" | "done" | "error" | "aborted";
  log: string;
  activity: Activity[];
  resultNodeId?: string;
  createdAt: number;
}

export interface QueueState {
  steering: string[];
  followUp: string[];
}

export interface BoardMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface ModelInfo {
  /** provider/id */
  key: string;
  provider: string;
  name: string;
  reasoning: boolean;
}

/** 参考资料：上传的文件，或本地目录（例如代码库） */
export interface Source {
  id: string;
  kind: "file" | "dir";
  name: string;
  /** 文件：存储路径；目录：绝对路径 */
  path: string;
  size: number;
  /** PDF 页数 / 目录文件数 */
  pages?: number;
  files?: number;
  status: "processing" | "ready" | "error";
  error?: string;
  /** 目录是上传的（存在白板目录里），而不是引用的本地目录 */
  uploaded?: boolean;
  /** 允许 AI 在这个目录里执行 shell 命令（查看用途） */
  allowBash?: boolean;
  addedAt: number;
}

/** 白板上的一个对话（可以新开对话、回到历史对话） */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 用户消息条数 */
  count: number;
}

/** 技能：一套固定的工作流程，用 /skill:name 指定或由 AI 通过 use_skill 读取 */
export interface SkillInfo {
  name: string;
  description: string;
}

export interface VersionMeta {
  id: string;
  parentId: string | null;
  label: string;
  at: number;
  nodeCount: number;
}

export type NodePatch = Partial<
  Pick<BoardNode, "title" | "summary" | "md" | "x" | "y" | "pinned" | "open" | "fold" | "parentId" | "tags" | "col">
> & {
  /** auto：清除设置，跟随父级 */
  side?: NodeSide | "auto";
};

// ---------- 服务端 → 客户端 ----------
export type ServerMsg =
  | { type: "snapshot"; board: Board; tasks: Task[]; queue: QueueState; busy: boolean }
  | { type: "board:replace"; board: Board }
  | { type: "versions"; versions: VersionMeta[]; head: string | null }
  | { type: "conversations"; conversations: ConversationMeta[]; current: string | null }
  | { type: "node:upsert"; node: BoardNode; animate?: "create" }
  | { type: "node:edit"; id: string; field: EditField; before: string; after: string; by: string }
  | { type: "node:delete"; id: string }
  | { type: "edge:add"; edge: BoardEdge }
  | { type: "edge:delete"; id: string }
  | { type: "group:upsert"; group: BoardGroup }
  | { type: "group:delete"; id: string }
  | { type: "chat:upsert"; entry: ChatEntry }
  | { type: "chat:delta"; id: string; delta: string; field?: "text" | "thinking" }
  /** 切换对话：整体替换对话记录 */
  | { type: "chat:replace"; chat: ChatEntry[] }
  | { type: "boards"; boards: BoardMeta[]; current: string }
  | { type: "sources"; sources: Source[] }
  | { type: "version:board"; id: string; board: Board }
  | { type: "recentDirs"; dirs: { path: string; name: string; lastUsed: number }[] }
  | { type: "skills"; skills: SkillInfo[] }
  | { type: "models"; models: ModelInfo[]; current: string | null; thinking: ThinkingLevel }
  | { type: "queue"; queue: QueueState }
  | { type: "busy"; busy: boolean }
  /** 可撤销 / 可重做的步数 */
  | { type: "history"; undo: number; redo: number }
  | { type: "task:upsert"; task: Task }
  | { type: "task:delta"; id: string; delta: string }
  | { type: "error"; message: string };

// ---------- 客户端 → 服务端 ----------
export type ClientMsg =
  /** view：用户当前所在的子白板（null 为主白板） */
  | { type: "chat"; text: string; mode: "queue" | "steer"; contextNodeIds: string[]; view?: string | null }
  | { type: "abort" }
  | { type: "queue:clear" }
  /** 回答 ask_user 的提问（id 是工具调用 id）；answers 为 null 表示跳过 */
  | { type: "ask:answer"; id: string; answers: AskAnswer[] | null }
  /** 新开一个对话（白板内容不变，AI 从空上下文开始） */
  | { type: "chat:new" }
  | { type: "chat:open"; id: string }
  | { type: "chat:delete"; id: string }
  | { type: "node:update"; id: string; patch: NodePatch }
  /** scope：新主题所在的子白板（有 groupId 时跟随分组） */
  | { type: "node:create"; id: string; parentId: string | null; x?: number; y?: number; groupId?: string; scope?: string | null }
  | { type: "node:delete"; id: string }
  | { type: "node:revert"; id: string }
  | { type: "edge:add"; source: string; target: string }
  | { type: "edge:update"; id: string; patch: EdgePatch }
  | { type: "edge:reverse"; id: string }
  | { type: "edge:delete"; id: string }
  /** 把节点打包成新分组；x/y 给出时分组固定在那里 */
  | { type: "group:create"; id: string; title: string; nodeIds: string[]; x?: number; y?: number; scope?: string | null }
  | { type: "group:update"; id: string; patch: GroupPatch }
  /** withContent：连里面的卡片一起删除；否则解散（卡片变成未分组的主题） */
  | { type: "group:delete"; id: string; withContent: boolean }
  /** 把节点（连同子树）移到某个分组（null 为不分组）；非主题会从原树上断开 */
  | { type: "node:toGroup"; id: string; groupId: string | null; x?: number; y?: number }
  /** 新建子白板：入口卡片放在这些节点原来的位置，节点（连同子树）成为里面的主题 */
  | { type: "subboard:create"; id: string; title: string; nodeIds: string[] }
  /** 把节点转为子白板：它的子节点成为里面的主题 */
  | { type: "subboard:convert"; id: string }
  /** 解散子白板：里面未分组的主题挂回入口卡片下，分组移到上一层 */
  | { type: "subboard:dissolve"; id: string }
  /** 把节点（连同子树）作为主题移到某个子白板（null 为主白板）；非主题会从原树上断开 */
  | { type: "node:toScope"; id: string; scope: string | null }
  | { type: "task:create"; instructions: string; contextNodeIds: string[] }
  | { type: "task:steer"; id: string; text: string }
  | { type: "task:abort"; id: string }
  | {
      type: "board:import";
      /** replace：替换整个白板；merge：合并进来（挂到 parentId 下或作为新主题） */
      mode: "replace" | "merge";
      name: string;
      parentId?: string | null;
      nodes: (Pick<BoardNode, "id" | "title" | "summary" | "md" | "parentId" | "kind" | "tags" | "side"> &
        Partial<Pick<BoardNode, "subboard" | "scope">>)[];
      edges: Pick<BoardEdge, "source" | "target" | "dir" | "label" | "reverseLabel">[];
    }
  | { type: "version:checkout"; id: string }
  | { type: "version:save"; label?: string }
  /** 取某个版本的白板快照（用于对比），只回给请求方 */
  | { type: "version:get"; id: string }
  /** 把对比中发现被删除的节点恢复回来 */
  | { type: "node:restore"; node: BoardNode }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "boards:switch"; id: string }
  | { type: "boards:create"; name: string }
  | { type: "boards:rename"; id: string; name: string }
  | { type: "boards:delete"; id: string }
  | { type: "sources:addDir"; path: string }
  | { type: "sources:remove"; id: string }
  | { type: "sources:bash"; id: string; allow: boolean }
  | { type: "recentDirs:forget"; path: string }
  /** 组件节点在前端运行后的结果（hash 对应运行的那版代码） */
  | { type: "widget:status"; id: string; hash: string; error: string | null }
  | { type: "model:set"; key: string }
  | { type: "thinking:set"; level: ThinkingLevel };
