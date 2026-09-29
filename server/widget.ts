// 组件节点（kind = "widget"）：md 字段存一份自包含的 HTML，前端放进沙箱 iframe 里运行。前后端共用

/** 代码指纹：前端上报运行结果时带上，服务端据此判断结果是不是针对当前这版代码 */
export function codeHash(code: string) {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 给模型看的写法约定（放在工具说明里） */
export const WIDGET_GUIDE = `代码是一份自包含的 HTML 片段（可含 <style>、<script>、<svg>、<canvas>），在白板节点内的沙箱 iframe 中运行：
- 完全离线：不能联网，不能引用任何外部脚本、样式、字体或图片（CDN 也不行），图表、图形请用原生 SVG / Canvas / JS 手写；图片只能用 data: URI。
- 宽度约 500px，自适应宽度；高度由内容决定（不要用 100vh / height:100%，给 SVG / Canvas 明确的高度）。
- 深色背景：页面背景透明，默认文字色 #e6e8eb；配色可用 #7aa2f7 #9ece6a #e0af68 #bb9af7 #7dcfff #f7768e #73daca #ff9e64，次要文字 #8b939e，线条 #3a414c。
- 只读白板数据：window.minder.onData(cb) 注册回调，拿到数据和数据变化时都会调用，参数 data = { self, nodes, edges }。
  self 是本节点 { id, title, summary, parentId }；nodes 是所有节点 [{ id, title, summary, md, parentId, kind }]（组件节点的 md 为空）；
  edges 是关系线 [{ source, target, dir, label, reverseLabel }]。辅助方法：minder.children(id)、minder.node(id)。
  需要展示白板内容（例如把子节点画成图表、时间线、关系图）时用它，数据变了要能重新渲染。
- 不能修改白板，不能弹窗（alert / confirm 无效），不能打开新页面或跳转。
- 运行报错会回传给你，请据此修正。`;
