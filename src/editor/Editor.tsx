import { useEffect } from 'react';
import { usePixiBonesStore } from './store';
import { PsdPanel } from './PsdPanel';
import { PropertyPanel } from './PropertyPanel';
import { BoneEditor } from './BoneEditor';
import { BottomToolbar } from './BottomToolbar';
import { TopMenu } from './TopMenu';
import { AnimationTimeline } from './AnimationTimeline';
import { useT } from './i18n';
import { ViewMenu } from './ViewMenu';
import hideViewsIcon from './icons/hideviews.png';

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
  const { t } = useT();
  const projectName = usePixiBonesStore((s) => s.projectName);
  const viewAllHidden   = usePixiBonesStore((s) => s.viewAllHidden);
  const setViewAllHidden= usePixiBonesStore((s) => s.setViewAllHidden);
  // hideviews 总开关：开启时把 10 个单项 toggle 全部关掉
  const toggleAll = () => setViewAllHidden(!viewAllHidden);

  // 当 viewAllHidden 从 false→true 时，自动关掉所有单项
  useEffect(() => {
    if (!viewAllHidden) return;
    const s = usePixiBonesStore.getState();
    if (s.viewWeights)    s.toggleViewWeights();
    if (s.viewSkin)       s.toggleViewSkin();
    if (s.viewGridTool)   s.toggleViewGridTool();
    if (s.viewColor)      s.toggleViewColor();
    if (s.viewAnimation)  s.toggleViewAnimation();
    if (s.viewHierarchy)  s.toggleViewHierarchy();
    if (s.viewIndicators) s.toggleViewIndicators();
    if (s.viewOutline)    s.toggleViewOutline();
    if (s.viewIssues)     s.toggleViewIssues();
    if (s.viewPreview)    s.toggleViewPreview();
  }, [viewAllHidden]);

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--spine-bg-base)' }}>
      <header
        className="flex items-center gap-2 px-3 h-9 shrink-0 border-b"
        style={{ background: 'var(--spine-bg-toolbar)', borderColor: 'var(--spine-border)' }}
      >
        <TopMenu />

        {/* 项目名称（header 中央 / 偏左；右上角的 ml-auto 会把它推到左边） */}
        <div
          className="flex items-center gap-2 ml-6"
          style={{ color: '#fff' }}
        >
          <span
            style={{
              fontSize: 15,
              fontWeight: 500,
              maxWidth: 320,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: '#fff',
            }}
            title={projectName}
          >
            {projectName}
          </span>
          {/* 未保存指示点（占位：以后接 unsaved 状态） */}
          <span
            style={{
              width: 6, height: 6, borderRadius: 3,
              background: '#fff',
              opacity: 0.5,
            }}
          />
        </div>

        {/* header 右上角：hideviews（隐藏所有视图） / views（视图菜单） —— 视图菜单 ViewMenu 组件 */}
        <div className="ml-auto flex items-center gap-1">
          <button
            className="spine-btn-icon"
            onClick={toggleAll}
            title={t('header.hide_views_tip')}
            style={{ opacity: viewAllHidden ? 0.5 : 1 }}
          >
            <img src={hideViewsIcon} alt="隐藏视图" width={14} height={14} style={{ display: 'block' }} />
          </button>
          <ViewMenu />
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
//  header 右上角：hideviews.png（隐藏所有视图）+ ViewMenu 组件（11 项 toggle）
//  旧的 views.png / IconEye / IconGear svg 已删除
// =================================================================================
