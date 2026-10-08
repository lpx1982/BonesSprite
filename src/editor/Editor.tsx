import { useEffect, type CSSProperties } from 'react';
import { usePixiBonesStore } from './store';
import { HierarchyPanel } from './HierarchyPanel';
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
 *   - 主体：画布（始终 full width） + 右侧可选层级树面板
 *   - 底部：工具栏
 *   - 导入素材走画布拖拽 / 顶部菜单（图片素材显示在层级树的「图片」节点下）
 */
export function Editor() {
  const showRightPanel = usePixiBonesStore((s) => s.showRightPanel);
  const viewGridTool = usePixiBonesStore((s) => s.viewGridTool);
  const viewDockOrder = usePixiBonesStore((s) => s.viewDockOrder);
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

  // 全局键盘快捷键：Cmd+Z / Ctrl+Z 撤销，Cmd+Shift+Z / Ctrl+Y 重做
  // Del / Backspace = 触发"删除确认"事件（由 BoneEditor 监听 + 弹 ConfirmDialog）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦点在输入控件上时让浏览器原生行为走（输入框里的字也要能撤销）
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        const key = e.key;
        // Esc：退出「附件：设置父级」拾取 / 取消网格描绘 / 退出网格编辑
        if (key === 'Escape') {
          const s = usePixiBonesStore.getState();
          if (s.attachingSlotId) {
            e.preventDefault();
            s.cancelAttach();
          } else if (s.meshNewPolygon) {
            e.preventDefault();
            s.setMeshNewPolygon(null);
          } else if (s.meshEditSlotId) {
            e.preventDefault();
            s.setMeshEditSlot(null);
          }
          return;
        }
        if (key === 'Delete' || key === 'Backspace') {
          const s = usePixiBonesStore.getState();
          // ★ 根骨骼禁止删除：剔除选中列表里的根骨后再派发事件
          const deletable = s.selectedBoneIds.filter((id) => {
            const n = s.bones.find((b) => b.id === id);
            return n && n.parentId !== null;
          });
          if (deletable.length > 0) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('spine:ask-delete', {
              detail: { ids: deletable },
            }));
          }
        }
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        usePixiBonesStore.getState().undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        usePixiBonesStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

        {/* header 右上角：hideviews / views 视图菜单（层级树面板由 views 菜单控制） */}
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
        <BoneEditor />
        {/* ★ 右侧停靠区：视图面板横向并排，**越早出现的越靠右**（层级树默认最早，
            所以它贴在最右边缘，后开的「网格工具」依次往左排）。
            DOM 顺序（左→右）= 出现顺序的反转。 */}
        <RightDock />
        <BottomToolbar />
        {/* 动画 tab 时显示底部时间轴（占位 UI） */}
        {editorTab === 'animate' && <AnimationTimeline />}
      </main>
    </div>
  );
}

// =================================================================================
//  右侧停靠区 —— 视图面板横向并排停靠在画布最右侧
//    规则：viewDockOrder 记录各面板「首次出现」的顺序；越早出现的越靠右。
//    停靠区本身绝对定位、右对齐（不挤压画布宽度），面板作为 flex 子项依次排列。
// =================================================================================
function RightDock() {
  const showRightPanel = usePixiBonesStore((s) => s.showRightPanel);
  const viewGridTool = usePixiBonesStore((s) => s.viewGridTool);
  const viewDockOrder = usePixiBonesStore((s) => s.viewDockOrder);

  // 当前开着的面板；反转后 DOM 从左到右 = 从「最晚出现」到「最早出现」
  const open = [...viewDockOrder].reverse().filter((k) =>
    k === 'hierarchy' ? showRightPanel
      : k === 'grid_tool' ? viewGridTool
        : false,
  );
  if (open.length === 0) return null;

  return (
    <div
      className="absolute top-0 right-0 bottom-0 flex"
      style={{ zIndex: 10 }}
    >
      {open.map((k) =>
        k === 'hierarchy' ? <HierarchyPanel key={k} />
          : k === 'grid_tool' ? <MeshToolsPanel key={k} />
            : null,
      )}
    </div>
  );
}

// =================================================================================
//  网格工具视图（仿 Spine 的「网格工具」）—— 软选择
//    - 软选择：拖动顶点时，附近的顶点按距离衰减一起动
//    - 大小：影响半径；羽化：衰减比例（0 = 半径内全部完全选中）
//    - 外壳顶点：未勾选时外壳（边界）顶点不受软选择影响（伪造 3D 时不改外形）
// =================================================================================
function MeshToolsPanel() {
  const softSelect    = usePixiBonesStore((s) => s.meshSoftSelect);
  const setSoftSelect = usePixiBonesStore((s) => s.setMeshSoftSelect);
  const size          = usePixiBonesStore((s) => s.meshSoftSize);
  const setSize       = usePixiBonesStore((s) => s.setMeshSoftSize);
  const feather       = usePixiBonesStore((s) => s.meshSoftFeather);
  const setFeather    = usePixiBonesStore((s) => s.setMeshSoftFeather);
  const hull          = usePixiBonesStore((s) => s.meshSoftHull);
  const setHull       = usePixiBonesStore((s) => s.setMeshSoftHull);

  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
  const labelStyle: CSSProperties = {
    width: 42, textAlign: 'right', fontSize: 12.5, color: 'var(--spine-text)', flex: 'none',
  };
  const checkStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    fontSize: 12.5, color: 'var(--spine-text)', cursor: 'pointer', userSelect: 'none',
  };
  /** 轨道：左半浅灰（已填充）、右半深灰（仿 Spine 的两段式轨道） */
  const trackBg = (v: number, min: number, max: number) => {
    const pct = Math.max(0, Math.min(1, (v - min) / (max - min))) * 100;
    return `linear-gradient(to right, #8b8b8b 0 ${pct}%, #464646 ${pct}% 100%)`;
  };
  const SIZE_MIN = 1, SIZE_MAX = 200;

  return (
    <aside
      className="flex flex-col overflow-hidden shrink-0"
      style={{
        width: 300,
        background: 'var(--spine-bg-panel)',
        color: 'var(--spine-text)',
        borderLeft: '1px solid var(--spine-border)',
        position: 'relative',
      }}
    >
      {/* 标题栏：ℹ + 「网格工具」+ 折叠图标 */}
      <div
        className="flex items-center px-2 py-1.5"
        style={{ borderBottom: '1px solid var(--spine-border)', background: 'var(--spine-bg-toolbar)' }}
      >
        <InfoIcon />
        <span style={{ marginLeft: 6, fontSize: 13, fontWeight: 600 }}>网格工具</span>
        <button
          type="button"
          title="折叠（占位）"
          style={{
            marginLeft: 'auto', background: 'transparent', border: 'none',
            color: 'var(--spine-text)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0,
          }}
        >≡</button>
      </div>

      {/* 内容卡片 */}
      <div style={{ padding: 8 }}>
        <div
          style={{
            background: 'var(--spine-bg-panel-dark)',
            border: '1px solid var(--spine-border)',
            borderRadius: 3,
            padding: '9px 10px 11px',
          }}
        >
          <div className="flex flex-col" style={{ gap: 9 }}>
            <label style={checkStyle}>
              <input
                type="checkbox"
                checked={softSelect}
                onChange={(e) => setSoftSelect(e.target.checked)}
                style={{ accentColor: 'var(--spine-accent)' }}
              />
              软选择
            </label>

            <div style={rowStyle}>
              <span style={labelStyle}>大小:</span>
              <input
                type="range"
                className="soft-slider"
                min={SIZE_MIN} max={SIZE_MAX} step={1}
                value={size}
                title="控制受软选择影响的程度"
                onChange={(e) => setSize(parseFloat(e.target.value))}
                style={{ flex: 1, background: trackBg(size, SIZE_MIN, SIZE_MAX) }}
              />
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>羽化:</span>
              <input
                type="range"
                className="soft-slider"
                min={0} max={1} step={0.01}
                value={feather}
                title="控制受软选择影响的衰减比例"
                onChange={(e) => setFeather(parseFloat(e.target.value))}
                style={{ flex: 1, background: trackBg(feather, 0, 1) }}
              />
            </div>

            <label style={checkStyle}>
              <input
                type="checkbox"
                checked={hull}
                onChange={(e) => setHull(e.target.checked)}
                style={{ accentColor: 'var(--spine-accent)' }}
              />
              外壳顶点
            </label>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** 网格工具标题栏的小 info 图标（蓝底白 i，仿 Spine） */
function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="6.4" fill="#2E8BD8" />
      <circle cx="7" cy="4.1" r="0.95" fill="#fff" />
      <rect x="6.15" y="5.9" width="1.7" height="4.4" rx="0.6" fill="#fff" />
    </svg>
  );
}
// =================================================================================
//  header 右上角：hideviews.png（隐藏所有视图）+ ViewMenu 组件（11 项 toggle）
//  旧的 views.png / IconEye / IconGear svg 已删除
// =================================================================================
