import { useEffect } from 'react';
import { usePixiBonesStore } from '@editor/store';
import { Editor } from '@editor/Editor';
import { WelcomePage } from '@editor/WelcomePage';

/**
 * 顶层路由：根据 store.currentProjectId 决定显示欢迎页或编辑器
 *   - null  → 欢迎页（新建/打开/最近）
 *   - 非 null → 编辑器（顶部 header + 画布 + 底部工具栏）
 *
 * 启动时如果 currentProjectId 为 null：
 *   - localStorage 有最近工程 → 自动打开最近第一个
 *   - 否则 → 自动开一个 "untitled" 默认工程（跳过欢迎页）
 */
export default function App() {
  const currentProjectId = usePixiBonesStore((s) => s.currentProjectId);

  useEffect(() => {
    if (currentProjectId) return;
    const s = usePixiBonesStore.getState();
    if (s.recentProjects.length > 0) {
      const last = s.recentProjects[0];
      s.openProject(last.id, last.name);
    } else {
      // 跳过欢迎页：直接进默认 untitled 工程
      s.openProject('untitled', 'untitled');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return currentProjectId ? <Editor /> : <WelcomePage />;
}
