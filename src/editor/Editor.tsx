import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePixiBonesStore, DOCK_PANEL_DEFAULT_WIDTH, DOCK_PANEL_MIN_WIDTH, DOCK_RESIZER_WIDTH, type EditorTool } from './store';
import { HierarchyPanel } from './HierarchyPanel';
import { BoneEditor } from './BoneEditor';
import { BottomToolbar } from './BottomToolbar';
import { TopMenu } from './TopMenu';
import { AnimationTimeline } from './AnimationTimeline';
import { useT } from './i18n';
import { ViewMenu } from './ViewMenu';
import { PromptDialog } from './PromptDialog';
import { useProjectPersistence } from './projectIO';
import type { MeshData } from '@psd/types';
import hideViewsIcon from './icons/hideviews.png';
import { MinimizedIcon, PANEL_ICONS, MinimizeControl } from './MinimizeControl';

/**
 * Day 3.5 · Spine 风格主编辑器
 *   - 顶部 header：logo + 快捷按钮 + 项目名 + 面板 toggle / view mode
 *   - 主体：画布（始终 full width） + 右侧可选层级树面板
 *   - 底部：工具栏
 *   - 导入素材走画布拖拽 / 顶部菜单（图片素材显示在层级树的「图片」节点下）
 */
export function Editor() {
  // 工程持久化：打开工程时自动载入存档 + 变更防抖自动保存 + 关闭/隐藏前保存
  useProjectPersistence();
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
  // 「隐藏所有视图」时实际收起的面板（= 当时打开的面板快照），
  //   没打开过的面板不会出现在 header 缩略图里
  const lastOpenedDockOrder = usePixiBonesStore((s) => s.lastOpenedDockOrder);
  const viewHierarchy = usePixiBonesStore((s) => s.viewHierarchy);
  const toggleRightPanel = usePixiBonesStore((s) => s.toggleRightPanel);
  const setHierarchyRestorePending = usePixiBonesStore((s) => s.setHierarchyRestorePending);
  const setGridRestorePending = usePixiBonesStore((s) => s.setGridRestorePending);
  const setWeightsRestorePending = usePixiBonesStore((s) => s.setWeightsRestorePending);
  const toggleViewGridTool = usePixiBonesStore((s) => s.toggleViewGridTool);
  const toggleViewWeights = usePixiBonesStore((s) => s.toggleViewWeights);
  const viewWeights = usePixiBonesStore((s) => s.viewWeights);
  const viewGridToolMinimized = usePixiBonesStore((s) => s.viewGridToolMinimized);
  const viewWeightsMinimized  = usePixiBonesStore((s) => s.viewWeightsMinimized);
  const setViewGridToolMinimized = usePixiBonesStore((s) => s.setViewGridToolMinimized);
  const setViewWeightsMinimized  = usePixiBonesStore((s) => s.setViewWeightsMinimized);
  // hideviews 总开关：开启时把 10 个单项 toggle 全部关掉；再次点击 = 全部恢复
  const toggleAll = () => {
    const cur = usePixiBonesStore.getState();
    if (!viewAllHidden) {
      // 当前 → 全部隐藏：先把"已开启的面板"快照下来，下次点击恢复
      const opened: string[] = [];
      if (cur.viewHierarchy) opened.push('hierarchy');
      if (cur.viewWeights)   opened.push('weights');
      if (cur.viewSkin)      opened.push('skin');
      if (cur.viewGridTool)  opened.push('grid_tool');
      if (cur.viewColor)     opened.push('color');
      if (cur.viewAnimation) opened.push('animation');
      if (cur.viewIndicators) opened.push('indicators');
      if (cur.viewOutline)   opened.push('outline');
      if (cur.viewIssues)    opened.push('issues');
      if (cur.viewPreview)   opened.push('preview');
      cur.lastOpenedDockOrder = opened;
      cur.viewAllHidden = true;
      // 触发 useEffect（依赖 viewAllHidden）去执行关面板的实际逻辑
      cur.setViewAllHidden(true);
    } else {
      // 已隐藏 → 全部恢复：按快照把 view 标记 / dock / 最小化状态全部还原
      const toOpen = cur.lastOpenedDockOrder;
      cur.viewAllHidden = false;
      cur.setViewAllHidden(false);
      const reopen = (k: string) => {
        if (k === 'hierarchy' && !cur.viewHierarchy) cur.toggleViewHierarchy();
        if (k === 'hierarchy' && !cur.showRightPanel) cur.toggleRightPanel();
        if (k === 'grid_tool' && !cur.viewGridTool) cur.toggleViewGridTool();
        if (k === 'weights' && !cur.viewWeights) cur.toggleViewWeights();
        if (k === 'skin' && !cur.viewSkin) cur.toggleViewSkin();
        if (k === 'color' && !cur.viewColor) cur.toggleViewColor();
        if (k === 'animation' && !cur.viewAnimation) cur.toggleViewAnimation();
        if (k === 'indicators' && !cur.viewIndicators) cur.toggleViewIndicators();
        if (k === 'outline' && !cur.viewOutline) cur.toggleViewOutline();
        if (k === 'issues' && !cur.viewIssues) cur.toggleViewIssues();
        if (k === 'preview' && !cur.viewPreview) cur.toggleViewPreview();
      };
      toOpen.forEach(reopen);
      cur.setViewGridToolMinimized(false);
      cur.setViewWeightsMinimized(false);
    }
  };

  // 当 viewAllHidden 从 false→true 时，自动关掉所有单项
  useEffect(() => {
    if (!viewAllHidden) return;
    const s = usePixiBonesStore.getState();
    // 层级树面板：关 view 标记 + 折叠 dock + 清最小化（让"全部隐藏"彻底生效）
    if (s.viewHierarchy) {
      s.toggleViewHierarchy();
      if (s.showRightPanel) s.toggleRightPanel();
    }
    if (s.viewWeights)         s.toggleViewWeights();
    if (s.viewSkin)            s.toggleViewSkin();
    if (s.viewGridTool)        s.toggleViewGridTool();
    if (s.viewColor)           s.toggleViewColor();
    if (s.viewAnimation)       s.toggleViewAnimation();
    if (s.viewIndicators)      s.toggleViewIndicators();
    if (s.viewOutline)         s.toggleViewOutline();
    if (s.viewIssues)          s.toggleViewIssues();
    if (s.viewPreview)         s.toggleViewPreview();
    s.setViewGridToolMinimized(false);
    s.setViewWeightsMinimized(false);
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
        // Opt+T：唤醒 / 切换层级树面板（对齐 Spine 层级树快捷键）
        // ★ 用 e.code（物理键位）而非 e.key：Mac 上 Option+T 会输出字符，用 KeyT 才能稳定识别。
        if (e.altKey && (e.code === 'KeyT' || e.key === 't' || e.key === 'T')) {
          e.preventDefault();
          const s = usePixiBonesStore.getState();
          const on = !s.showRightPanel;
          s.toggleRightPanel();
          const s2 = usePixiBonesStore.getState();
          if (on) { if (!s2.viewHierarchy) s2.toggleViewHierarchy(); }
          else { if (s2.viewHierarchy) s2.toggleViewHierarchy(); }
          return;
        }
        // 工具卡片快捷键（仿 Spine 风格）：7 个工具统一走 setTool，
        //   这样右键空白处能在最近两个工具之间来回切换。
        //   R = 旋转 / M = 移动 / S = 缩放 / Z = 倾斜
        //   B = 姿势 / G = 权重 / N = 创建
        // ★ 用 e.code 物理键位，避免 IME / 中文输入法的干扰
        if (!e.altKey && !e.shiftKey) {
          const toolByCode: Record<string, EditorTool> = {
            KeyR: 'rotate', KeyM: 'move', KeyS: 'scale', KeyZ: 'shear',
            KeyB: 'pose', KeyG: 'weights', KeyN: 'create',
          };
          const tool = toolByCode[e.code];
          if (tool) {
            e.preventDefault();
            const s = usePixiBonesStore.getState();
            // 同一个工具再按一次 = 什么都不做（保持当前工具）。
            // 只有"右键空白处"才回退到上一个工具。
            if (s.currentTool === tool) return;
            s.setTool(tool);
            // 切到 weights 时自动打开权重视图（仿 Spine，底部卡片行为一致）
            const s2 = usePixiBonesStore.getState();
            if (tool === 'weights' && !s2.viewWeights) s2.toggleViewWeights();
            return;
          }
        }
        // Esc：退出「附件：设置父级」拾取 / IK 目标拾取 / 取消网格描绘 / 退出网格编辑
        if (key === 'Escape') {
          const s = usePixiBonesStore.getState();
          if (s.attachingSlotId) {
            e.preventDefault();
            s.cancelAttach();
          } else if (s.ikPickBoneId) {
            e.preventDefault();
            s.cancelIkPick();
          } else if (s.pcPickMode) {
            e.preventDefault();
            s.cancelPathConstraintPick();
          } else if (s.weightBindMode) {
            // 退出权重绑定模式
            e.preventDefault();
            s.toggleWeightBindMode();
          } else if (s.meshNewPolygon) {
            e.preventDefault();
            s.setMeshNewPolygon(null);
          } else if (s.meshEditSlotId) {
            e.preventDefault();
            s.setMeshEditSlot(null);
          } else if (s.pathEditAttachmentId) {
            // 退出路径编辑（清新建顶点模式 / 选中 / 工具归 create）
            e.preventDefault();
            s.setPathEdit(null);
          }
          return;
        }
        // 空格：也退出权重绑定模式 / 路径编辑
        if (key === ' ' || key === 'Spacebar') {
          const s = usePixiBonesStore.getState();
          if (s.weightBindMode) {
            e.preventDefault();
            s.toggleWeightBindMode();
            return;
          }
          if (s.pathEditAttachmentId) {
            e.preventDefault();
            s.setPathEdit(null);
            return;
          }
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
          {/* ★ 视图面板"被最小化"的图标条：每个面板独立显示
              点击 = 还原对应面板（动画由面板自身的 useEffect 播放）
              显示条件：
                - 正常状态：单面板被用户主动最小化（view 标记仍 true + 被 minimized / showRightPanel false）
                - 全隐藏状态（viewAllHidden）：所有面板都视为"已隐藏"，显示缩略图让用户点回 */}
          {(viewHierarchy && !showRightPanel || (viewAllHidden && lastOpenedDockOrder.includes('hierarchy'))) && (
            <MinimizedIcon
              panelKey="hierarchy"
              paths={PANEL_ICONS.hierarchy.paths}
              color={PANEL_ICONS.hierarchy.color}
              onClick={() => {
                setHierarchyRestorePending(true);
                toggleRightPanel();
                // 如果处于"全隐藏"状态，先恢复 view 标记
                if (!viewHierarchy) usePixiBonesStore.getState().toggleViewHierarchy();
              }}
            />
          )}
          {(viewGridTool && viewGridToolMinimized || (viewAllHidden && lastOpenedDockOrder.includes('grid_tool'))) && (
            <MinimizedIcon
              panelKey="grid_tool"
              paths={PANEL_ICONS.grid_tool.paths}
              color={PANEL_ICONS.grid_tool.color}
              onClick={() => {
                setGridRestorePending(true);
                setViewGridToolMinimized(false);
                if (!viewGridTool) usePixiBonesStore.getState().toggleViewGridTool();
              }}
            />
          )}
          {(viewWeights && viewWeightsMinimized || (viewAllHidden && lastOpenedDockOrder.includes('weights'))) && (
            <MinimizedIcon
              panelKey="weights"
              paths={PANEL_ICONS.weights.paths}
              color={PANEL_ICONS.weights.color}
              onClick={() => {
                setWeightsRestorePending(true);
                setViewWeightsMinimized(false);
                if (!viewWeights) usePixiBonesStore.getState().toggleViewWeights();
              }}
            />
          )}
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
        {/* IK 约束创建流程：顶部横幅 + PICK 光标 + 命名弹窗 */}
        <IkPickOverlay />
        {/* 路径约束创建流程：顶部横幅 + PICK 光标 + 命名弹窗 */}
        <PathConstraintPickOverlay />
      </main>
    </div>
  );
}

// =================================================================================
//  IK 约束创建流程（仿 Spine）
//    1. 选中骨 → 属性面板「新建」→「约束 → IK 约束」→ 进入拾取模式（ikPickBoneId 非 null）
//    2. 屏幕上方显示「新建 ik 约束：选择目标」横幅；鼠标旁显示 PICK
//    3. 点击画布上一根骨 = 拾取目标骨（ikPickTargetBoneId 非 null）→ 弹命名对话框
//    4. 确认 → 创建约束 → 清空拾取态并选中新约束
// =================================================================================
function IkPickOverlay() {
  const ikPickBoneId = usePixiBonesStore((s) => s.ikPickBoneId);
  const ikPickTargetBoneId = usePixiBonesStore((s) => s.ikPickTargetBoneId);
  const constraints = usePixiBonesStore((s) => s.constraints);
  const bones = usePixiBonesStore((s) => s.bones);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // PICK 光标跟随鼠标
  useEffect(() => {
    if (!ikPickBoneId) { setCursor(null); return; }
    const onMove = (e: MouseEvent) => setCursor({ x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [ikPickBoneId]);

  if (ikPickTargetBoneId) {
    // 已拾取目标 → 弹命名对话框
    const sNow = usePixiBonesStore.getState();
    const constrainedName = bones.find((b) => b.id === ikPickBoneId)?.name ?? '';
    const childName = sNow.ikPickChildBoneId
      ? bones.find((b) => b.id === sNow.ikPickChildBoneId)?.name ?? ''
      : '';
    const defaultName = `IK ${constraints.length + 1}`;
    return (
      <PromptDialog
        open
        title="新建 IK 约束"
        message={
          childName
            ? `受约束骨「${constrainedName} + ${childName}」→ 目标骨。为此约束输入一个新名称:`
            : `受约束骨「${constrainedName}」→ 目标骨。为此约束输入一个新名称:`
        }
        initialValue={defaultName}
        select="all"
        confirmLabel="确定"
        cancelLabel="取消"
        onCancel={() => usePixiBonesStore.getState().cancelIkPick()}
        onConfirm={(value) => {
          const s = usePixiBonesStore.getState();
          const name = value.trim() || defaultName;
          // ★ 双骨 IK：ikPickChildBoneId 非 null 时创建 parent + child 两骨约束
          const id = s.addIkConstraint(s.ikPickBoneId!, s.ikPickTargetBoneId!, s.ikPickChildBoneId, name);
          s.cancelIkPick();
          if (id) s.selectConstraint(id);
        }}
      />
    );
  }

  if (!ikPickBoneId) return null;

  return (
    <>
      {/* 顶部横幅：新建 ik 约束：选择目标 */}
      <div
        className="fixed z-[9997] pointer-events-none"
        style={{
          top: 0, left: 0, right: 0,
          display: 'flex', justifyContent: 'center',
          paddingTop: 8,
        }}
      >
        <div
          style={{
            background: 'var(--spine-accent-dim)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            padding: '4px 14px',
            borderRadius: 4,
            border: '1px solid var(--spine-accent)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}
        >
          新建 ik 约束：选择目标
        </div>
      </div>
      {/* 鼠标旁 PICK 文字（对齐 Spine：出现在指针左侧） */}
      {cursor && (
        <div
          className="fixed z-[9997] pointer-events-none"
          style={{
            left: Math.max(4, cursor.x - 62),
            top: cursor.y + 8,
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            textShadow: '0 1px 3px rgba(0,0,0,0.9)',
            background: 'rgba(0,0,0,0.55)',
            padding: '1px 6px',
            borderRadius: 3,
            letterSpacing: 1,
          }}
        >
          PICK
        </div>
      )}
    </>
  );
}

// =================================================================================
//  路径约束创建流程（仿 Spine）
//    1. 选中骨 → 属性面板「新建」→「约束 → 路径约束」→ 进入拾取模式（pcPickMode = 'path'）
//    2. 屏幕上方显示横幅「新建路径约束：选择目标路径」；鼠标旁显示 PICK
//    3. 点击画布路径 / 层级树路径行 = 拾取目标路径（pcPickMode → 'bone'）
//    4. 横幅变「选择受约束骨骼」；Shift+点骨累加，单击骨完成（pcPickMode → 'done'）
//    5. 弹命名对话框 → addPathConstraint(slotId, boneIds) → 选中新约束
// =================================================================================
function PathConstraintPickOverlay() {
  const pcPickMode = usePixiBonesStore((s) => s.pcPickMode);
  const pcPickPathSlotId = usePixiBonesStore((s) => s.pcPickPathSlotId);
  const pcPickBoneIds = usePixiBonesStore((s) => s.pcPickBoneIds);
  const slots = usePixiBonesStore((s) => s.slots);
  const bones = usePixiBonesStore((s) => s.bones);
  const pathConstraints = usePixiBonesStore((s) => s.pathConstraints);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // PICK 光标跟随鼠标
  useEffect(() => {
    if (!pcPickMode || pcPickMode === 'done') { setCursor(null); return; }
    const onMove = (e: MouseEvent) => setCursor({ x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [pcPickMode]);

  // 已完成（选好路径 + 骨骼）→ 弹命名对话框
  if (pcPickMode === 'done') {
    const pathSlot = slots.find((s) => s.id === pcPickPathSlotId) ?? null;
    const pathName = pathSlot?.name ?? '';
    const boneNames = pcPickBoneIds
      .map((id) => bones.find((b) => b.id === id)?.name ?? '')
      .filter((x) => !!x);
    const defaultName = `路径约束 ${pathConstraints.length + 1}`;
    return (
      <PromptDialog
        open
        title="新建路径约束"
        message={
          boneNames.length > 0
            ? `目标路径「${pathName}」→ 受约束骨骼「${boneNames.join('、')}」。为此约束输入一个新名称:`
            : `目标路径「${pathName}」。为此约束输入一个新名称:`
        }
        initialValue={defaultName}
        select="all"
        confirmLabel="确定"
        cancelLabel="取消"
        onCancel={() => usePixiBonesStore.getState().cancelPathConstraintPick()}
        onConfirm={(value) => {
          const s = usePixiBonesStore.getState();
          const name = value.trim() || defaultName;
          const id = s.addPathConstraint(s.pcPickPathSlotId!, s.pcPickBoneIds);
          s.cancelPathConstraintPick();
          if (id) s.selectConstraint(id);
        }}
      />
    );
  }

  if (!pcPickMode) return null;

  const bannerText = pcPickMode === 'path' ? '新建路径约束：选择目标路径' : '新建路径约束：选择受约束骨骼（Shift 多选）';
  return (
    <>
      {/* 顶部横幅 */}
      <div
        className="fixed z-[9997] pointer-events-none"
        style={{
          top: 0, left: 0, right: 0,
          display: 'flex', justifyContent: 'center',
          paddingTop: 8,
        }}
      >
        <div
          style={{
            background: 'var(--spine-accent-dim)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            padding: '4px 14px',
            borderRadius: 4,
            border: '1px solid var(--spine-accent)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}
        >
          {bannerText}
        </div>
      </div>
      {/* 鼠标旁 PICK 文字 */}
      {cursor && (
        <div
          className="fixed z-[9997] pointer-events-none"
          style={{
            left: Math.max(4, cursor.x - 62),
            top: cursor.y + 8,
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            textShadow: '0 1px 3px rgba(0,0,0,0.9)',
            background: 'rgba(0,0,0,0.55)',
            padding: '1px 6px',
            borderRadius: 3,
            letterSpacing: 1,
          }}
        >
          PICK
        </div>
      )}
    </>
  );
}

// =================================================================================
//  右侧停靠区 —— 视图面板横向并排停靠在画布最右侧（无空隙，紧贴）
//    规则：
//      - 层级树永远在最右侧（不管 viewDockOrder 顺序如何）
//      - 其它面板按 viewDockOrder 中「首次出现」的顺序，从右往左依次排列
//        （DOM 左 → 右 = 视觉右 → 左）
//      - 面板之间不留空隙；每块面板的「右边缘」是一根可拖动分隔条
//        （最右边的那块没有分隔条）
// =================================================================================
function RightDock() {
  const showRightPanel = usePixiBonesStore((s) => s.showRightPanel);
  const viewGridTool = usePixiBonesStore((s) => s.viewGridTool);
  const viewWeights = usePixiBonesStore((s) => s.viewWeights);
  const viewDockOrder = usePixiBonesStore((s) => s.viewDockOrder);
  // ★ 动画 tab 时右侧停靠区抬高到时间轴上方（底部留出 timelineHeight），
  //   否则时间轴(z-20)会盖住面板下半部（属性块 / 树底行都点不到）。
  const editorTab = usePixiBonesStore((s) => s.editorTab);
  const timelineHeight = usePixiBonesStore((s) => s.timelineHeight);

  // 判断每个面板是否真正应该渲染（开关 + 最小化）
  const isVisible = (k: string) =>
    k === 'hierarchy' ? showRightPanel
      : k === 'grid_tool' ? (viewGridTool && !usePixiBonesStore.getState().viewGridToolMinimized)
        : k === 'weights' ? (viewWeights && !usePixiBonesStore.getState().viewWeightsMinimized)
          : false;

  // 当前开着的面板列表（按视觉顺序：右→左）
  //   1) hierarchy 永远在最后（DOM 顺序的尾 = 视觉最右）
  //   2) 其它面板按 viewDockOrder 的反序（早出现的在视觉上更靠近右侧）
  // 最终 DOM 从左到右 = [其它面板按出现晚→早] + [hierarchy]
  const others = viewDockOrder.filter((k) => k !== 'hierarchy' && isVisible(k));
  const isHierarchyVisible = isVisible('hierarchy');
  const ordered = [...others, ...(isHierarchyVisible ? ['hierarchy'] : [])];
  if (ordered.length === 0) return null;

  return (
    <div
      className="absolute top-0 right-0 flex"
      style={{
        zIndex: 10,
        bottom: editorTab === 'animate' ? timelineHeight : 0,
        // 面板之间不要 gap，紧贴
        gap: 0,
        // ★ 让 DockResizer 的绝对定位（覆盖在面板右边缘）能正确定位到此 div 内
        position: 'absolute',
        top: 0,
        right: 0,
      }}
    >
      {ordered.map((k, i) => (
        <Fragment key={k}>
          {/*
           * 拖动分隔条：每块面板的**右边缘**（不是左边缘）作为可拖动手柄。
           *   - 最右边那块的右边不需要分隔条（已经贴到画布边缘）
           *   - 分隔条绝对定位在面板右边界上（覆盖整高），不占布局宽度 → 面板间 0 间距
           * 但是这样面板之间没有视觉分界 —— 用 borderLeft 当分界线（1px 像素）
           */}
          {k === 'hierarchy' ? <HierarchyPanel />
            : k === 'grid_tool' ? <MeshToolsPanel />
              : k === 'weights' ? <WeightsPanel />
                : null}
          {/* 每块面板的右边缘放拖手柄（最右那块不需要）；overlay 不占布局空间 */}
          {i < ordered.length - 1 && <DockResizer panelKey={k} side="right" />}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * 停靠面板的横向缩放手柄。
 *
 * 设计为**绝对定位覆盖在面板边缘上**，不占布局空间（这样面板之间可以 0 间距紧贴）：
 *   - `side="right"`：定位在面板右边界，作为"拖右边那条线"改宽度
 *   - `side="left"`：定位在面板左边界（旧行为，保留兼容）
 * 拖动方向：往左拖 = 变宽，往右拖 = 变窄
 * 用 Pointer Capture 保证鼠标移出手柄/面板后仍然跟着走。
 */
function DockResizer({ panelKey, side = 'right' }: { panelKey: string; side?: 'left' | 'right' }) {
  const width = usePixiBonesStore(
    (s) => s.dockPanelWidths[panelKey] ?? DOCK_PANEL_DEFAULT_WIDTH[panelKey] ?? 300,
  );
  const setPanelWidth = usePixiBonesStore((s) => s.setDockPanelWidth);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { startX: e.clientX, startW: width };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const max = Math.max(d.startW, DOCK_PANEL_MIN_WIDTH + 60, window.innerWidth * 0.6);
    const w = Math.round(
      Math.max(DOCK_PANEL_MIN_WIDTH, Math.min(d.startW + (d.startX - e.clientX), max)),
    );
    if (w !== width) setPanelWidth(panelKey, w);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    document.body.style.userSelect = '';
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整面板宽度"
      title="按住拖动可调整面板宽度"
      className={'dock-resizer' + (dragging ? ' dragging' : '')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        // 绝对定位：覆盖在面板边缘上（宽度 = DOCK_RESIZER_WIDTH，不占 flex 布局）
        position: 'absolute',
        top: 0,
        bottom: 0,
        [side]: -DOCK_RESIZER_WIDTH / 2,
        width: DOCK_RESIZER_WIDTH,
        cursor: 'col-resize',
        touchAction: 'none',
        zIndex: 1,
      }}
    />
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
  // 宽度由左边缘的拖动分隔条控制（store 里的 dockPanelWidths）
  const width = usePixiBonesStore((s) => s.dockPanelWidths.grid_tool ?? DOCK_PANEL_DEFAULT_WIDTH.grid_tool);
  // 监听顶部 ☰ 的最小化 / 关闭事件（panel:minimize / panel:close）
  //   - 最小化：直接关闭 viewGridTool（header 显示图标；点击图标 → 重新开）
  //   - 关闭：彻底从视图菜单移除（仍由 view 菜单控制）
  const toggleViewGridTool = usePixiBonesStore((s) => s.toggleViewGridTool);
  const setViewGridTool    = usePixiBonesStore((s) => s.setViewGridTool);
  const setViewGridToolMinimized = usePixiBonesStore((s) => s.setViewGridToolMinimized);
  useEffect(() => {
    const onMin = (e: Event) => {
      if ((e as CustomEvent).detail?.panelKey !== 'grid_tool') return;
      // 最小化：view 仍为 true，但"最小化"标记打开 → RightDock 不渲染 + header 显示缩略图
      setViewGridToolMinimized(true);
    };
    const onClose = (e: Event) => {
      if ((e as CustomEvent).detail?.panelKey !== 'grid_tool') return;
      // 关闭：彻底关掉 view 标记 + 清最小化
      setViewGridTool(false);
      setViewGridToolMinimized(false);
    };
    window.addEventListener('panel:minimize', onMin);
    window.addEventListener('panel:close', onClose);
    return () => {
      window.removeEventListener('panel:minimize', onMin);
      window.removeEventListener('panel:close', onClose);
    };
  }, [setViewGridTool, setViewGridToolMinimized]);

  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
  const labelStyle: CSSProperties = {
    width: 42, textAlign: 'right', fontSize: 12.5, color: 'var(--spine-text)', flex: 'none',
  };
  const checkStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    fontSize: 12.5, color: 'var(--spine-text)', cursor: 'pointer', userSelect: 'none',
  };
  const SIZE_MIN = 1, SIZE_MAX = 200;

  return (
    <aside
      className="flex flex-col overflow-hidden shrink-0"
      style={{
        width,
        background: 'var(--spine-bg-panel)',
        color: 'var(--spine-text)',
        borderLeft: '1px solid var(--spine-border)',
        position: 'relative',
      }}
    >
      {/* 标题栏：ℹ + 「网格工具」+ 最小化控件 */}
      <div
        className="flex items-center px-2"
        style={{ height: 28, borderBottom: '1px solid var(--spine-border)', background: 'var(--spine-bg-toolbar)' }}
      >
        <InfoIcon />
        <span style={{ marginLeft: 6, fontSize: 13, fontWeight: 600 }}>网格工具</span>
        <MinimizeControl panelKey="grid_tool" />
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
//  权重视图（仿 Spine 的「权重」）
//    权重 = 把附件顶点绑定到骨骼（线性混合蒙皮）；骨骼一动，网格跟着变形。
//    面板分区（对齐 Spine 截图）：
//      影响 / 模式 / 权重 → 平滑·自动·焊接 → 饼图·叠加·已选 → 骨骼列表 → 绑定·交换·删除
//    ★ 除「影响 / 模式 / 权重 / 饼图 / 叠加 / 已选」这些纯 UI 状态外，
//      绑定 / 自动 / 平滑 / 焊接 / 修剪 / 更新 / 交换 / 删除 及骨骼列表暂为占位。
// =================================================================================
function WeightsPanel() {
  // 监听顶部 ☰ 的最小化 / 关闭事件（panel:minimize / panel:close）
  const setViewWeights = usePixiBonesStore((s) => s.setViewWeights);
  const setViewWeightsMinimized = usePixiBonesStore((s) => s.setViewWeightsMinimized);
  useEffect(() => {
    const onMin = (e: Event) => {
      if ((e as CustomEvent).detail?.panelKey !== 'weights') return;
      // 最小化：view 仍为 true，标记最小化（RightDock 不渲染 + header 显示缩略图）
      setViewWeightsMinimized(true);
    };
    const onClose = (e: Event) => {
      if ((e as CustomEvent).detail?.panelKey !== 'weights') return;
      // 关闭：彻底关 view 标记 + 清最小化
      setViewWeights(false);
      setViewWeightsMinimized(false);
    };
    window.addEventListener('panel:minimize', onMin);
    window.addEventListener('panel:close', onClose);
    return () => {
      window.removeEventListener('panel:minimize', onMin);
      window.removeEventListener('panel:close', onClose);
    };
  }, [setViewWeights, setViewWeightsMinimized]);
  const influence     = usePixiBonesStore((s) => s.weightInfluence);
  const setInfluence  = usePixiBonesStore((s) => s.setWeightInfluence);
  const mode          = usePixiBonesStore((s) => s.weightMode);
  const setMode       = usePixiBonesStore((s) => s.setWeightMode);
  const value         = usePixiBonesStore((s) => s.weightValue);
  const setValue      = usePixiBonesStore((s) => s.setWeightValue);
  const pie           = usePixiBonesStore((s) => s.weightPie);
  const setPie        = usePixiBonesStore((s) => s.setWeightPie);
  const overlay       = usePixiBonesStore((s) => s.weightOverlay);
  const setOverlay    = usePixiBonesStore((s) => s.setWeightOverlay);
  const selectedOnly  = usePixiBonesStore((s) => s.weightSelectedOnly);
  const setSelOnly    = usePixiBonesStore((s) => s.setWeightSelectedOnly);
  // 绑定模式相关
  const bindMode      = usePixiBonesStore((s) => s.weightBindMode);
  const toggleBind    = usePixiBonesStore((s) => s.toggleWeightBindMode);
  // 当前选中状态（用于决定「绑定」按钮走哪条流程）
  const selectedBoneIds    = usePixiBonesStore((s) => s.selectedBoneIds);
  const selectedSlotIds    = usePixiBonesStore((s) => s.selectedSlotIds);
  const selectedAttachment = usePixiBonesStore((s) => s.selectedAttachmentId);
  const slots              = usePixiBonesStore((s) => s.slots);
  const meshes             = usePixiBonesStore((s) => s.attachmentMeshes);
  const bones              = usePixiBonesStore((s) => s.bones);
  const unbindBoneFromMesh = usePixiBonesStore((s) => s.unbindBoneFromMesh);
  const recomputeWeights   = usePixiBonesStore((s) => s.recomputeMeshWeights);
  const setVertexWeights   = usePixiBonesStore((s) => s.setVertexWeights);
  const pushHistory        = usePixiBonesStore((s) => s.pushHistory);
  // 权重模式下选中的顶点（饼图）；用于骨骼列表显示权重数值 + 滑块改权重
  const meshSelectedVertices = usePixiBonesStore((s) => s.meshSelectedVertices);
  // 滑块拖动状态：一次拖动只在开始时推一次历史；拖动期间不同步滑块值
  const draggingRef = useRef(false);
  const dragCommittedRef = useRef(false);
  /**
   * 权重视图「当前作用的网格」。
   * ★ 优先用 store.weightMeshId —— 它在「选中骨骼」时**不会**被清空，
   *   所以在骨骼列表里点骨骼后，列表仍能继续显示该网格绑定的骨骼。
   *   兜底：若还没设过，就按当前选中插槽/附件推断。
   */
  const weightMeshId       = usePixiBonesStore((s) => s.weightMeshId);
  const setWeightMesh      = usePixiBonesStore((s) => s.setWeightMesh);
  const currentAttachmentId: string | null = (() => {
    if (weightMeshId) return weightMeshId;
    if (selectedAttachment) return selectedAttachment;
    if (selectedSlotIds.length === 1) {
      const s = slots.find((x) => x.id === selectedSlotIds[0]);
      return s?.activeAttachmentId ?? null;
    }
    return null;
  })();
  const currentMesh = currentAttachmentId ? meshes[currentAttachmentId] ?? null : null;
  const boundBoneIds = currentMesh?.bones ?? [];
  // 当前选中的、且绑在本网格上的骨骼（「权重」滑块只对它生效）
  const selBoneId = boundBoneIds.find((bid) => selectedBoneIds.includes(bid)) ?? null;
  // 选中顶点 / 选中骨骼变化时，把「权重」滑块同步成该骨骼对选中顶点的权重
  // （单选或所有选中顶点值相同才同步；多选值不同或正在拖滑块则保持不动）
  useEffect(() => {
    if (draggingRef.current) return;
    const mesh = currentMesh;
    if (!mesh?.weights || !mesh.bones || mesh.bones.length === 0 || !selBoneId) return;
    const verts = meshSelectedVertices;
    if (verts.length === 0) return;
    const idx = mesh.bones.indexOf(selBoneId);
    if (idx < 0) return;
    const nb = mesh.bones.length;
    const vc = mesh.vertices.length / 2;
    let w = -1;
    for (const vi of verts) {
      if (vi < 0 || vi >= vc) continue;
      const wv = mesh.weights[vi * nb + idx];
      if (w < 0) w = wv;
      else if (Math.abs(w - wv) > 1e-6) return;   // 多选且值不同 → 不动滑块
    }
    if (w >= 0 && Math.abs(w - value) > 0.0001) setValue(w);
  }, [currentMesh, selBoneId, meshSelectedVertices, value, setValue]);
  // 宽度由左边缘的拖动分隔条控制（store 里的 dockPanelWidths）
  const width = usePixiBonesStore((s) => s.dockPanelWidths.weights ?? DOCK_PANEL_DEFAULT_WIDTH.weights);

  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
  const labelStyle: CSSProperties = {
    width: 34, textAlign: 'right', fontSize: 12.5, color: 'var(--spine-text)', flex: 'none',
  };
  const checkStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5,
    color: 'var(--spine-text)', cursor: 'pointer', userSelect: 'none',
  };
  const selectStyle: CSSProperties = {
    flex: 1, height: 20, background: '#4A4A4A', color: '#DDDDDD',
    border: '1px solid #555555', borderRadius: 3, fontSize: 11, padding: '0 4px',
    cursor: 'pointer', outline: 'none',
  };

  return (
    <aside
      className="flex flex-col overflow-hidden shrink-0"
      style={{
        width,
        background: 'var(--spine-bg-panel)',
        color: 'var(--spine-text)',
        borderLeft: '1px solid var(--spine-border)',
        position: 'relative',
      }}
    >
      {/* 标题栏：ℹ + 权重图标 + 「权重」+ 折叠图标 */}
      <div
        className="flex items-center px-2"
        style={{ height: 28, borderBottom: '1px solid var(--spine-border)', background: 'var(--spine-bg-toolbar)' }}
      >
        <InfoIcon />
        <span style={{ marginLeft: 5, display: 'inline-flex' }}><WeightsTitleIcon /></span>
        <span style={{ marginLeft: 5, fontSize: 13, fontWeight: 600 }}>权重</span>
        <MinimizeControl panelKey="weights" />
      </div>

      {/* 内容卡片（撑满剩余高度，骨骼列表占满下半部分） */}
      <div style={{ padding: 8, flex: 1, minHeight: 0, display: 'flex' }}>
        <div
          style={{
            flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 13,
            background: 'var(--spine-bg-panel-dark)',
            border: '1px solid var(--spine-border)',
            borderRadius: 3,
            padding: '12px 9px 9px',
          }}
        >
          {/* 影响 */}
          <div style={rowStyle}>
            <span style={labelStyle}>影响:</span>
            <input
              type="range" className="soft-slider" min={0} max={1} step={0.01}
              value={influence} title="权重工具的施加强度"
              onChange={(e) => setInfluence(parseFloat(e.target.value))}
              style={{ flex: 1, background: trackBg(influence, 0, 1) }}
            />
            <ProBtn label="修剪" icon={<IconScissors />} />
          </div>

          {/* 模式 */}
          <div style={rowStyle}>
            <span style={labelStyle}>模式:</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'direct' | 'brush')}
              style={selectStyle}
              title="直接 = 精确设值；画笔 = 拖动涂抹"
            >
              <option value="direct">直接</option>
              <option value="brush">画笔</option>
            </select>
            <ProBtn label="更新" icon={<IconUpdate />} />
          </div>

          {/* 权重 */}
          <div style={rowStyle}>
            <span style={labelStyle}>权重:</span>
            <input
              type="range" className="soft-slider" min={0} max={1} step={0.01}
              value={value}
              title="直接模式下设置的精确权重值（选中顶点后：把选中骨骼的权重设为该值，其余骨骼按比例归一）"
              onPointerDown={() => { draggingRef.current = true; dragCommittedRef.current = false; }}
              onPointerUp={() => { draggingRef.current = false; }}
              onPointerCancel={() => { draggingRef.current = false; }}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setValue(v);
                // 有当前网格 + 选中的已绑骨骼 + 选中顶点 → 实时改权重
                if (currentAttachmentId && selBoneId && meshSelectedVertices.length > 0) {
                  // 一次拖动只推一次历史（避免每个 onChange 都产生一步 undo）
                  if (!dragCommittedRef.current) { pushHistory(); dragCommittedRef.current = true; }
                  setVertexWeights(currentAttachmentId, selBoneId, meshSelectedVertices, v);
                }
              }}
              style={{ flex: 1, background: trackBg(value, 0, 1) }}
            />
          </div>

          {/* 平滑 / 自动 / 焊接 */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
            <ProBtn label="平滑" icon={<IconDroplet />} />
            {/* 自动：按当前 mesh 的骨骼表重算权重 */}
            <button
              type="button"
              title={boundBoneIds.length > 0
                ? '按当前网格的骨骼重新计算权重（就近主控 + 距离衰减）'
                : '当前网格未绑定骨骼，无可计算的权重'}
              disabled={boundBoneIds.length === 0}
              onClick={() => { if (currentAttachmentId) recomputeWeights(currentAttachmentId); }}
              style={{
                ...weightBtn,
                opacity: boundBoneIds.length === 0 ? 0.55 : 1,
                cursor: boundBoneIds.length === 0 ? 'not-allowed' : 'pointer',
              }}
            ><IconRefresh />自动</button>
            <ProBtn label="焊接" icon={<IconWand />} />
          </div>

          {/* 饼图 / 叠加 / 已选 */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <label style={checkStyle} title="为每个顶点画权重饼图">
              <input type="checkbox" checked={pie} onChange={(e) => setPie(e.target.checked)} style={{ accentColor: 'var(--spine-accent)' }} />
              饼图
            </label>
            <label style={checkStyle} title="用骨骼颜色填充网格来显示权重">
              <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} style={{ accentColor: 'var(--spine-accent)' }} />
              叠加
            </label>
            <label style={checkStyle} title="只显示选中顶点 / 选中骨骼的饼图">
              <input type="checkbox" checked={selectedOnly} onChange={(e) => setSelOnly(e.target.checked)} style={{ accentColor: 'var(--spine-accent)' }} />
              已选
            </label>
          </div>

          {/* 分隔线 */}
          <div style={{ borderTop: '1px dashed rgba(255,255,255,0.14)' }} />

          {/* 骨骼：标题行 + 3 个小图标按钮 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12.5 }}>骨骼:</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
              <MiniIconBtn title="复制骨骼列表（待实现）"><IconCopyBones /></MiniIconBtn>
              <MiniIconBtn title="骨骼列表（待实现）"><IconListLines /></MiniIconBtn>
              <MiniIconBtn title="按曲线排序（待实现）"><IconCurve /></MiniIconBtn>
            </div>
          </div>

          {/* 骨骼列表（显示当前网格绑定的骨骼；选中骨骼在此可选 / 右键定位到画布） */}
          <div
            style={{
              flex: 1, minHeight: 120, background: '#2b2b2b',
              border: '1px solid var(--spine-border)', borderRadius: 2, overflow: 'auto',
              padding: 4,
            }}
          >
            {!currentMesh || boundBoneIds.length === 0 ? (
              <div style={{ padding: '12px 6px', textAlign: 'center', fontSize: 11, color: 'var(--spine-text-dim)' }}>
                {currentMesh ? '未绑定骨骼' : '先在层级树选中一个网格'}
              </div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {boundBoneIds.map((bid, i) => {
                  const bone = bones.find((b) => b.id === bid);
                  const color = boneColor(i);
                  const isSelected = selectedBoneIds.includes(bid);
                  // 该骨骼对选中顶点的权重值（单选=数值；多选值不同=*；未选顶点=空）
                  const wLabel = boneWeightLabel(currentMesh, i, meshSelectedVertices);
                  return (
                    <li
                      key={bid}
                      title={`${bone?.name ?? bid}\n左键：选中；右键：在画布上选中并跳转视角`}
                      onClick={(e) => {
                        // 仿 Spine：左键替换选中集（可配合 Shift 加选）
                        const s = usePixiBonesStore.getState();
                        if (e.shiftKey) s.selectBones([bid], true);
                        else s.selectBone(bid);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        const s = usePixiBonesStore.getState();
                        s.selectBone(bid);
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '3px 5px', borderRadius: 2, cursor: 'pointer',
                        background: isSelected ? '#3a5a8a' : 'transparent',
                        color: 'var(--spine-text)', fontSize: 11,
                      }}
                    >
                      <span style={{
                        display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                        background: color,
                      }} />
                      <span style={{ flex: 1 }}>{bone?.name ?? bid}</span>
                      <span style={{
                        fontSize: 10.5, color: 'var(--spine-text-dim)',
                        minWidth: 40, textAlign: 'right', userSelect: 'none', fontVariantNumeric: 'tabular-nums',
                      }}>{wLabel}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 绑定 / 交换 / 删除 */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
            {/* 绑定：两种流程都走「再点一次 = 退出绑定模式」的开关式按钮 */}
            <button
              type="button"
              title={bindMode
                ? '退出绑定模式（Esc）'
                : '进入绑定模式：先选网格则点骨骼绑定；先选骨骼则点网格绑全部骨骼'}
              onClick={() => {
                if (bindMode) { toggleBind(); return; }
                // 进入绑定模式前：把「当前网格」登记到 weightMeshId，
                // 画布上该网格会变成「只显示选中蓝外轮廓」并出现顶部提示条。
                let target = currentAttachmentId;
                if (!target) {
                  // 兜底：场景里只有一个网格时自动用它（避免"拾取骨骼没反应"）
                  const keys = Object.keys(usePixiBonesStore.getState().attachmentMeshes);
                  if (keys.length === 1) target = keys[0];
                }
                if (target) setWeightMesh(target);
                // 有「当前网格」→ 流程 A（点骨骼往上绑）；否则流程 B（先选骨骼再点网格）
                toggleBind();
              }}
              style={{
                ...weightBtn,
                background: bindMode ? '#2E8BD8' : '#4A4A4A',
                borderColor: bindMode ? '#2E7FC0' : '#555555',
                color: bindMode ? '#FFFFFF' : '#DDDDDD',
              }}
            ><IconBind />{bindMode ? '退出' : '绑定'}</button>
            <ProBtn label="交换" icon={<IconSwap />} />
            <button
              type="button"
              title={boundBoneIds.length > 0
                ? '解绑当前选中的骨骼（多选则全部解绑）'
                : '当前网格未绑定任何骨骼'}
              disabled={boundBoneIds.length === 0 || selectedBoneIds.length === 0}
              onClick={() => {
                if (!currentAttachmentId) return;
                for (const bid of selectedBoneIds) unbindBoneFromMesh(currentAttachmentId, bid);
              }}
              style={{
                ...weightBtn,
                opacity: (boundBoneIds.length === 0 || selectedBoneIds.length === 0) ? 0.55 : 1,
                cursor: (boundBoneIds.length === 0 || selectedBoneIds.length === 0) ? 'not-allowed' : 'pointer',
              }}
            >
              <IconCross />删除
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** 权重面板里的按钮外观（仿 Spine：中灰底 + 图标 + 文字） */
const weightBtn: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 3,
  padding: '3px 7px', borderRadius: 3,
  border: '1px solid #555555', background: '#4A4A4A',
  color: '#DDDDDD', fontSize: 11, lineHeight: '14px',
  whiteSpace: 'nowrap', userSelect: 'none', cursor: 'pointer',
};

/**
 * 带「PRO」角标的按钮。Spine 里 PRO = 该功能需要 Pro 版；
 * 我们这里把还没实现的按钮都标成 PRO（占位），功能接入后再去掉。
 */
function ProBtn({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
      <span
        style={{
          position: 'absolute', top: -7, left: -1, zIndex: 1, pointerEvents: 'none',
          background: '#C0261F', color: '#fff', fontSize: 8, lineHeight: '10px',
          padding: '0 3px', borderRadius: 2, letterSpacing: 0.2, fontWeight: 700,
        }}
      >PRO</span>
      <button type="button" disabled title={`${label}（待实现）`} style={{ ...weightBtn, opacity: 0.55, cursor: 'not-allowed' }}>
        {icon}{label}
      </button>
    </span>
  );
}

/** 骨骼列表右上角的 18×20 小图标按钮（图标自带 svg 外壳） */
function MiniIconBtn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <button
      type="button" title={title}
      className="flex items-center justify-center"
      style={{
        width: 20, height: 18, padding: 0, borderRadius: 2,
        background: '#4A4A4A', border: '1px solid #555555',
        color: '#CCCCCC', cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

/**
 * 权重面板小图标的统一外壳（13×13、viewBox 14×14）。
 * ★ 必须先包 <svg> 再放 <circle>/<path>，否则 React 会把它们当未知 HTML 标签报警告。
 */
function WIcon({ children }: { children: React.ReactNode }) {
  return <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>{children}</svg>;
}

// ---- 权重面板的小图标（几何风格）----
function WeightsTitleIcon() {
  return (
    <svg width="15" height="14" viewBox="0 0 16 14" aria-hidden>
      <rect x="1" y="4" width="14" height="6" rx="1" fill="#8A5A2B" />
      <rect x="1" y="4" width="5" height="6" fill="#C0392B" />
      <rect x="10" y="4" width="5" height="6" fill="#4A6FA5" />
      <rect x="1" y="4" width="14" height="6" rx="1" fill="none" stroke="#E0A050" strokeWidth="0.8" />
    </svg>
  );
}
function IconScissors() {
  return (
    <WIcon>
      <circle cx="3.4" cy="10.6" r="1.9" stroke="#DDD" strokeWidth="1.2" />
      <circle cx="10.6" cy="10.6" r="1.9" stroke="#DDD" strokeWidth="1.2" />
      <path d="M4.6 9.3 L11 2.2 M9.4 9.3 L3 2.2" stroke="#DDD" strokeWidth="1.2" strokeLinecap="round" />
    </WIcon>
  );
}
function IconUpdate() {
  return (
    <WIcon>
      <path d="M11.6 5.2 A4.6 4.6 0 1 0 12.2 8.4" stroke="#DDD" strokeWidth="1.3" strokeLinecap="round" fill="none" />
      <path d="M8.4 2.2 L12 5.2 L8.8 7.6" stroke="#DDD" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </WIcon>
  );
}
function IconDroplet() {
  return <WIcon><path d="M7 1.6 C9.6 5, 11 6.6, 11 8.6 A4 4 0 0 1 3 8.6 C3 6.6, 4.4 5, 7 1.6 Z" fill="#DDD" /></WIcon>;
}
function IconRefresh() {
  return (
    <WIcon>
      <path d="M12 7 A5 5 0 1 1 10.2 3.2" stroke="#DDD" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M10.6 1.2 L11.4 4.2 L8.4 4.4" stroke="#DDD" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </WIcon>
  );
}
function IconWand() {
  return (
    <WIcon>
      <path d="M2.2 11.8 L9.4 4.6" stroke="#DDD" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9.6 2.2 L10.3 3.8 L11.9 4.5 L10.3 5.2 L9.6 6.8 L8.9 5.2 L7.3 4.5 L8.9 3.8 Z" fill="#DDD" />
    </WIcon>
  );
}
function IconCopyBones() {
  return (
    <WIcon>
      <rect x="1.6" y="2.4" width="7.6" height="8" rx="1" stroke="#CCC" strokeWidth="1.1" fill="none" />
      <rect x="4.8" y="4.4" width="7.6" height="8" rx="1" stroke="#CCC" strokeWidth="1.1" fill="none" />
    </WIcon>
  );
}
function IconListLines() {
  return (
    <WIcon>
      <rect x="1.6" y="2.2" width="10.8" height="9.6" rx="1" stroke="#CCC" strokeWidth="1.1" fill="none" />
      <path d="M3.6 5.4 H10.4 M3.6 7.6 H10.4 M3.6 9.8 H8" stroke="#CCC" strokeWidth="1" strokeLinecap="round" />
    </WIcon>
  );
}
function IconCurve() {
  return <WIcon><path d="M1.6 11.6 C4.4 3, 9.2 3, 12.4 11.6" stroke="#CCC" strokeWidth="1.3" fill="none" strokeLinecap="round" /></WIcon>;
}
function IconBind() {
  return (
    <WIcon>
      <circle cx="4.2" cy="9.4" r="2.4" stroke="#DDD" strokeWidth="1.2" fill="none" />
      <circle cx="4.2" cy="4.6" r="2.4" stroke="#DDD" strokeWidth="1.2" fill="none" />
      <path d="M6.4 6.2 L12.2 10.6" stroke="#DDD" strokeWidth="1.3" strokeLinecap="round" />
    </WIcon>
  );
}
function IconSwap() {
  return (
    <WIcon>
      <path d="M2.4 5.2 H11.4 M9 2.8 L11.4 5.2 L9 7.6" stroke="#DDD" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M11.6 9.2 H2.6 M5 6.8 L2.6 9.2 L5 11.6" stroke="#DDD" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </WIcon>
  );
}
function IconCross() {
  return (
    <WIcon>
      <circle cx="7" cy="7" r="5.6" fill="#8A8A8A" />
      <path d="M4.8 4.8 L9.2 9.2 M9.2 4.8 L4.8 9.2" stroke="#2b2b2b" strokeWidth="1.5" strokeLinecap="round" />
    </WIcon>
  );
}

/** 滑轨：左半浅灰（已填充）、右半深灰（仿 Spine 的两段式轨道） */
function trackBg(v: number, min: number, max: number) {
  const pct = Math.max(0, Math.min(1, (v - min) / (max - min))) * 100;
  return `linear-gradient(to right, #8b8b8b 0 ${pct}%, #464646 ${pct}% 100%)`;
}

/**
 * 骨骼颜色（仿 Spine 给每个骨骼一个稳定颜色）。
 * 索引 → 色：循环 12 种区分度高的色。
 */
const BONE_PALETTE = [
  '#E61E1E', '#1E78E6', '#2EC75E', '#F0A020', '#9B59B6', '#16A085',
  '#E67E22', '#3498DB', '#E84393', '#27AE60', '#8E44AD', '#D35400',
];
function boneColor(index: number): string {
  return BONE_PALETTE[index % BONE_PALETTE.length];
}

/**
 * 某根骨骼对选中顶点的权重显示（仿 Spine 权重面板骨骼列表）。
 *  - 单选：显示该骨骼的权重值（百分比）
 *  - 多选：所有选中顶点值相同 → 显示该值；值不同 → 显示 `*`
 *  - 未选中顶点 → 空字符串
 */
function boneWeightLabel(mesh: MeshData | null, boneIdx: number, selVerts: number[]): string {
  if (!mesh?.weights || !mesh.bones || mesh.bones.length === 0 || selVerts.length === 0) return '';
  const nb = mesh.bones.length;
  const vc = mesh.vertices.length / 2;
  let w = -1;
  for (const vi of selVerts) {
    if (vi < 0 || vi >= vc) continue;
    const wv = mesh.weights[vi * nb + boneIdx];
    if (w < 0) w = wv;
    else if (Math.abs(w - wv) > 1e-6) return '*';
  }
  return w < 0 ? '' : `${(w * 100).toFixed(2)}%`;
}
// =================================================================================
//  header 右上角：hideviews.png（隐藏所有视图）+ ViewMenu 组件（11 项 toggle）
//  旧的 views.png / IconEye / IconGear svg 已删除
// =================================================================================
