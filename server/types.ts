// 前后端共享的数据结构

/** note：普通内容节点；task：后台任务产出的报告 */
export type NodeKind = "note" | "task";

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

export interface ChatEntry {
  id: string;
  role: "user" | "ai";
  text: string;
  contextNodeIds?: string[];
  activity?: Activity[];
  streaming?: boolean;
  at: number;
}

export interface Board {
  nodes: BoardNode[];
  edges: BoardEdge[];
  chat: ChatEntry[];
}

export type TaskKind = "research" | "organize";

export interface Task {
  id: string;
  kind: TaskKind;
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
  | { type: "node:upsert"; node: BoardNode; animate?: "create" }
  | { type: "node:edit"; id: string; field: EditField; before: string; after: string; by: string }
  | { type: "node:delete"; id: string }
  | { type: "edge:add"; edge: BoardEdge }
  | { type: "edge:delete"; id: string }
  | { type: "chat:upsert"; entry: ChatEntry }
  | { type: "chat:delta"; id: string; delta: string }
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
  | { type: "node:update"; id: string; patch: NodePatch }
  | { type: "node:create"; id: string; parentId: string | null; x?: number; y?: number }
  | { type: "node:delete"; id: string }
  | { type: "node:revert"; id: string }
  | { type: "edge:add"; source: string; target: string }
  | { type: "edge:update"; id: string; patch: EdgePatch }
  | { type: "edge:reverse"; id: string }
  | { type: "edge:delete"; id: string }
  | { type: "task:create"; kind: TaskKind; instructions: string; contextNodeIds: string[] }
  | { type: "task:steer"; id: string; text: string }
  | { type: "task:abort"; id: string }
  | { type: "version:checkout"; id: string }
  | { type: "version:save"; label?: string };
