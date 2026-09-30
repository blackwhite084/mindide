// 前后端共享的数据结构

/** note：普通内容节点；task：后台任务产出的报告；widget：组件，md 里是在沙箱中运行的 HTML */
export type NodeKind = "note" | "task" | "widget";

export interface Activity {
  id: string;
  tool: string;
  label: string;
  status: "running" | "done" | "error";
  detail?: string;
  /** 该操作涉及的节点，点击可定位 */
  nodeId?: string;
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
  /** 模型仍在生成中的草稿节点 */
  draft?: boolean;
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
  createdAt: number;
}

export type GroupPatch = Partial<Pick<BoardGroup, "title" | "x" | "y" | "pinned" | "fold">>;

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

export interface VersionMeta {
  id: string;
  parentId: string | null;
  label: string;
  at: number;
  nodeCount: number;
}

export type NodePatch = Partial<
  Pick<BoardNode, "title" | "summary" | "md" | "x" | "y" | "pinned" | "open" | "fold" | "parentId">
>;

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
  | { type: "models"; models: ModelInfo[]; current: string | null; thinking: ThinkingLevel }
  | { type: "queue"; queue: QueueState }
  | { type: "busy"; busy: boolean }
  | { type: "task:upsert"; task: Task }
  | { type: "task:delta"; id: string; delta: string }
  | { type: "error"; message: string };

// ---------- 客户端 → 服务端 ----------
export type ClientMsg =
  | { type: "chat"; text: string; mode: "queue" | "steer"; contextNodeIds: string[] }
  | { type: "abort" }
  | { type: "queue:clear" }
  /** 新开一个对话（白板内容不变，AI 从空上下文开始） */
  | { type: "chat:new" }
  | { type: "chat:open"; id: string }
  | { type: "chat:delete"; id: string }
  | { type: "node:update"; id: string; patch: NodePatch }
  | { type: "node:create"; id: string; parentId: string | null; x?: number; y?: number; groupId?: string }
  | { type: "node:delete"; id: string }
  | { type: "node:revert"; id: string }
  | { type: "edge:add"; source: string; target: string }
  | { type: "edge:update"; id: string; patch: EdgePatch }
  | { type: "edge:reverse"; id: string }
  | { type: "edge:delete"; id: string }
  /** 把节点打包成新分组；x/y 给出时分组固定在那里 */
  | { type: "group:create"; id: string; title: string; nodeIds: string[]; x?: number; y?: number }
  | { type: "group:update"; id: string; patch: GroupPatch }
  /** withContent：连里面的卡片一起删除；否则解散（卡片变成未分组的主题） */
  | { type: "group:delete"; id: string; withContent: boolean }
  /** 把节点（连同子树）移到某个分组（null 为不分组）；非主题会从原树上断开 */
  | { type: "node:toGroup"; id: string; groupId: string | null; x?: number; y?: number }
  | { type: "task:create"; instructions: string; contextNodeIds: string[] }
  | { type: "task:steer"; id: string; text: string }
  | { type: "task:abort"; id: string }
  | {
      type: "board:import";
      /** replace：替换整个白板；merge：合并进来（挂到 parentId 下或作为新主题） */
      mode: "replace" | "merge";
      name: string;
      parentId?: string | null;
      nodes: Pick<BoardNode, "id" | "title" | "summary" | "md" | "parentId" | "kind">[];
      edges: Pick<BoardEdge, "source" | "target" | "dir" | "label" | "reverseLabel">[];
    }
  | { type: "version:checkout"; id: string }
  | { type: "version:save"; label?: string }
  /** 取某个版本的白板快照（用于对比），只回给请求方 */
  | { type: "version:get"; id: string }
  /** 把对比中发现被删除的节点恢复回来 */
  | { type: "node:restore"; node: BoardNode }
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
