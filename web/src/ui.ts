/** 跨组件的画布操作与右键菜单状态 */

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; hint?: string }
  | { sep: true }
  | { title: string };

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  /** 替换菜单内容的自定义表单（例如编辑关系文字） */
  form?: React.ReactNode;
}

type Fn = () => void;
const menuListeners = new Set<Fn>();
const editListeners = new Set<(id: string) => void>();
let menu: MenuState | null = null;

export const ui = {
  /** 定位并选中节点（由画布注册） */
  focusNode: (_id: string) => {},
  /** 聚焦输入框（由输入框注册） */
  focusComposer: (_placeholder?: string) => {},

  /** 让 AI 处理某个节点：选中它并把光标放到输入框 */
  askAI(id: string, title: string) {
    ui.focusNode(id);
    ui.focusComposer(`想让 AI 怎么处理「${title}」？`);
  },

  requestEdit(id: string) {
    for (const fn of editListeners) fn(id);
  },
  onEditRequest(fn: (id: string) => void) {
    editListeners.add(fn);
    return () => {
      editListeners.delete(fn);
    };
  },

  openMenu(state: MenuState) {
    menu = state;
    for (const fn of menuListeners) fn();
  },
  closeMenu() {
    if (!menu) return;
    menu = null;
    for (const fn of menuListeners) fn();
  },
  subscribeMenu(fn: Fn) {
    menuListeners.add(fn);
    return () => {
      menuListeners.delete(fn);
    };
  },
  getMenu: () => menu,
};
