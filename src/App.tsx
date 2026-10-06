import { usePixiBonesStore } from '@editor/store';
import { Editor } from '@editor/Editor';
import { WelcomePage } from '@editor/WelcomePage';

/**
 * 顶层路由：根据 store.currentProjectId 决定显示欢迎页或编辑器
 *   - null  → 欢迎页（新建/打开/最近）
 *   - 非 null → 编辑器（顶部 header + 画布 + 底部工具栏）
 */
export default function App() {
  const currentProjectId = usePixiBonesStore((s) => s.currentProjectId);
  return currentProjectId ? <Editor /> : <WelcomePage />;
}
