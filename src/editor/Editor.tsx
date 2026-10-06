import { usePixiBonesStore } from './store';
import { PsdPanel } from './PsdPanel';
import { PropertyPanel } from './PropertyPanel';
import { BoneEditor } from './BoneEditor';
import { BottomToolbar } from './BottomToolbar';
import { TopMenu } from './TopMenu';
import { AnimationTimeline } from './AnimationTimeline';
import { useT } from './i18n';

/**
 * Day 3.5 · Spine 风格主编辑器
 *   - 顶部 header：logo + 快捷按钮 + 项目名 + 面板 toggle / view mode
 *   - 主体：左侧可选 PsdPanel（toggle） + 画布（永远在中间，full width） + 右侧可选 PropertyPanel
 *   - 底部：工具栏
 *   - 导入 PSD 走画布拖拽 / 顶部菜单（不再在 header 放按钮）
 */
export function Editor() {
  const showLeftPanel = usePixiBonesStore((s) => s.showLeftPanel);
  const showRightPanel = usePixiBonesStore((s) => s.showRightPanel);
  const editorTab = usePixiBonesStore((s) => s.editorTab);
  const psd = usePixiBonesStore((s) => s.psd);
  const bones = usePixiBonesStore((s) => s.bones);
  const projectName = usePixiBonesStore((s) => s.projectName);
  const { t } = useT();

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--spine-bg-base)' }}>
      <header
        className="flex items-center gap-2 px-3 h-9 shrink-0 border-b"
        style={{ background: 'var(--spine-bg-toolbar)', borderColor: 'var(--spine-border)' }}
      >
        <TopMenu />

        <span className="text-xs ml-1" style={{ color: 'var(--spine-text-dim)' }}>
          {projectName}
        </span>

        {/* header 右上角占位 icon：视图（眼睛）/ 设置（齿轮）—— 后续接功能 */}
        <div className="ml-auto flex items-center gap-1">
          <button
            className="spine-btn-icon"
            onClick={() => console.log('[Header] 视图（占位）')}
            title={t('header.view_tip')}
          >
            <IconEye />
          </button>
          <button
            className="spine-btn-icon"
            onClick={() => console.log('[Header] 设置（占位）')}
            title={t('header.settings_tip')}
          >
            <IconGear />
          </button>
        </div>
      </header>

      <main className="flex-1 relative flex overflow-hidden">
        {showLeftPanel && <PsdPanel />}
        <BoneEditor />
        {showRightPanel && <PropertyPanel />}
        <BottomToolbar />
        {/* 动画 tab 时显示底部时间轴（占位 UI） */}
        {editorTab === 'animate' && <AnimationTimeline />}
      </main>
    </div>
  );
}

// =================================================================================
//  header 右上角占位 icon（视图 / 设置）—— 功能后续接
// =================================================================================
function IconEye() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8 C3.5 4, 12.5 4, 14.5 8 C12.5 12, 3.5 12, 1.5 8 Z" />
      <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.5 L8 3.5 M8 12.5 L8 14.5 M1.5 8 L3.5 8 M12.5 8 L14.5 8 M3.4 3.4 L4.8 4.8 M11.2 11.2 L12.6 12.6 M3.4 12.6 L4.8 11.2 M11.2 4.8 L12.6 3.4" />
    </svg>
  );
}
