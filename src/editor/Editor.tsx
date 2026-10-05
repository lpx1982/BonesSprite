import { useRef } from 'react';
import { usePixiBonesStore } from './store';
import { PsdPanel } from './PsdPanel';
import { PropertyPanel } from './PropertyPanel';
import { BoneEditor } from './BoneEditor';
import { BottomToolbar } from './BottomToolbar';
import { parsePsd } from '@psd/index';

/**
 * Day 3.5 · Spine 风格主编辑器
 *   - 顶部 header：logo + project + 视图 + 导入 PSD + 面板 toggle
 *   - 主体：左侧可选 PsdPanel（toggle） + 画布（永远在中间，full width） + 右侧可选 PropertyPanel
 *   - 底部：工具栏
 *
 *   默认两个侧栏都关（匹配用户截图样式）
 */
export function Editor() {
  const viewMode = usePixiBonesStore((s) => s.viewMode);
  const setViewMode = usePixiBonesStore((s) => s.setViewMode);
  const showLeftPanel = usePixiBonesStore((s) => s.showLeftPanel);
  const showRightPanel = usePixiBonesStore((s) => s.showRightPanel);
  const toggleLeftPanel = usePixiBonesStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = usePixiBonesStore((s) => s.toggleRightPanel);
  const setPsd = usePixiBonesStore((s) => s.setPsd);
  const psd = usePixiBonesStore((s) => s.psd);
  const bones = usePixiBonesStore((s) => s.bones);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const onImportClick = () => fileInputRef.current?.click();

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--spine-bg-base)' }}>
      <header
        className="flex items-center gap-2 px-3 h-9 shrink-0 border-b"
        style={{ background: 'var(--spine-bg-toolbar)', borderColor: 'var(--spine-border)' }}
      >
        <span className="text-sm font-semibold" style={{ color: 'var(--spine-accent)' }}>
          🩻 PixiBones
        </span>
        <span className="text-xs" style={{ color: 'var(--spine-text-dim)' }}>
          {psd ? `*${psd.layers.length}L · ${bones.length}B` : '(未命名)'}
        </span>

        <div className="w-px h-5" style={{ background: 'var(--spine-border)' }} />

        <button
          className="spine-btn spine-btn-primary"
          onClick={onImportClick}
          title="导入 PSD 文件"
        >
          📁 导入 PSD
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".psd"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const result = await parsePsd(f);
              if (result.layers.length > 0) setPsd(result);
            } catch (err) {
              console.error('[Editor] 解析 PSD 失败:', err);
            }
            e.target.value = '';
          }}
        />

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
