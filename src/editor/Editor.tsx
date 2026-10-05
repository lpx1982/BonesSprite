import { usePixiBonesStore } from './store';
import { PsdPanel } from './PsdPanel';
import { PropertyPanel } from './PropertyPanel';
import { BoneEditor } from './BoneEditor';
import { BottomToolbar } from './BottomToolbar';
import { TopMenu } from './TopMenu';

/**
 * Day 3.5 · Spine 风格主编辑器
 *   - 顶部 header：logo + 快捷按钮 + 项目名 + 面板 toggle / view mode
 *   - 主体：左侧可选 PsdPanel（toggle） + 画布（永远在中间，full width） + 右侧可选 PropertyPanel
 *   - 底部：工具栏
 *   - 导入 PSD 走画布拖拽 / 顶部菜单（不再在 header 放按钮）
 */
export function Editor() {
  const viewMode = usePixiBonesStore((s) => s.viewMode);
  const setViewMode = usePixiBonesStore((s) => s.setViewMode);
  const showLeftPanel = usePixiBonesStore((s) => s.showLeftPanel);
  const showRightPanel = usePixiBonesStore((s) => s.showRightPanel);
  const toggleLeftPanel = usePixiBonesStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = usePixiBonesStore((s) => s.toggleRightPanel);
  const psd = usePixiBonesStore((s) => s.psd);
  const bones = usePixiBonesStore((s) => s.bones);

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--spine-bg-base)' }}>
      <header
        className="flex items-center gap-2 px-3 h-9 shrink-0 border-b"
        style={{ background: 'var(--spine-bg-toolbar)', borderColor: 'var(--spine-border)' }}
      >
        <TopMenu />

        <span className="text-xs ml-1" style={{ color: 'var(--spine-text-dim)' }}>
          {psd ? `*${psd.layers.length}L · ${bones.length}B` : '(未命名)'}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            className={'spine-btn ' + (showLeftPanel ? 'spine-btn-active' : '')}
            onClick={toggleLeftPanel}
            title="切换图层面板"
          >
            🗂 图层
          </button>
          <button
            className={'spine-btn ' + (showRightPanel ? 'spine-btn-active' : '')}
            onClick={toggleRightPanel}
            title="切换属性面板"
          >
            ⚙ 属性
          </button>
          <div className="w-px h-5 mx-1" style={{ background: 'var(--spine-border)' }} />
          <button
            className={'spine-btn ' + (viewMode === 'editor' ? 'spine-btn-active' : '')}
            onClick={() => setViewMode('editor')}
          >
            🦴 编辑器
          </button>
          <button
            className={'spine-btn ' + (viewMode === 'demo' ? 'spine-btn-active' : '')}
            onClick={() => setViewMode('demo')}
          >
            🎬 Demo
          </button>
        </div>
      </header>

      <main className="flex-1 relative flex overflow-hidden">
        {showLeftPanel && <PsdPanel />}
        <BoneEditor />
        {showRightPanel && <PropertyPanel />}
        <BottomToolbar />
      </main>
    </div>
  );
}
