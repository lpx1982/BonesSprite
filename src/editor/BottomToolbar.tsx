import { useMemo, useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePixiBonesStore, findBone, DOCK_PANEL_DEFAULT_WIDTH, DOCK_RESIZER_WIDTH, type BoneNode } from './store';
import { useT } from './i18n';
import moveIcon from './icons/move.png';
import rotateIcon from './icons/rotate.png';
import scaleIcon from './icons/scale.png';
import shearIcon from './icons/shear.png';
import frameKeyIcon from './icons/frame_key.png';

// =================================================================================
//  尺寸常量 —— 集中在这里改，调一处全卡生效
// ============================================================================
//
//  transform 卡片（旋转/移动/缩放/倾斜）排布参数：
//    ROW_HEIGHT:       每行高度（px）
//    LABEL_BOX_WIDTH:  左侧 icon+label 区域宽度
//    LABEL_ICON_SIZE:  左侧 icon 大小
//    ROW_H_PAD:        行左右内边距
//    INPUT_HEIGHT:     中间输入框高度
//    INPUT_FONT_SIZE:  输入框字号
//    KEYFRAME_BTN_W:   右侧"关键帧"按钮宽度
//    KEYFRAME_BTN_H:   右侧"关键帧"按钮高度
//    ROW_RADIUS:       行圆角
//    INPUT_RADIUS:     输入框圆角
//
const T = {
  ROW_HEIGHT:        26,
  LABEL_BOX_WIDTH:   70,                                      // 左侧按钮宽度（旋转/移动/缩放/倾斜 4 行共用）
  LABEL_BOX_PAD_L:   8,
  LABEL_ICON_SIZE:   18,
  ROW_H_PAD:         4,
  INPUT_HEIGHT:      26,
  INPUT_FONT_SIZE:   13,
  INPUT_WIDTH:       60,                                          // 单个 input 框宽度（双 input 行每个用这个）
  INPUT_GAP:         4,                                          // 双 input 之间的间距（保留备查；当前由 DIVIDER_WIDTH 替代）
  DIVIDER_WIDTH:    1,                                          // 双 input 中间的分隔竖线宽度
  // 单 input 行（旋转栏）的总宽 = 双 input 行（移动/缩放/倾斜）的总宽（两个 input + 中间竖线），保证对齐
  SINGLE_INPUT_WIDTH: (60 + 60 + 1),                             // = INPUT_WIDTH * 2 + DIVIDER_WIDTH
  KEYFRAME_BTN_W:    30,
  KEYFRAME_BTN_H:    26,
  ROW_RADIUS:        4,
  INPUT_RADIUS:      0,
  ROW_BG:            'rgba(255, 255, 255, 0.06)',
  ROW_BG_HOVER:      'rgba(255, 255, 255, 0.14)',   // 悬停时的行底色（比默认亮一档）
  KEYFRAME_GREEN:    'rgba(0, 253, 93, 0.45)',     // 动画 tab 下钥匙按钮的激活底色
  KEYFRAME_GREEN_HOVER: 'rgba(34, 197, 94, 0.65)',  // 动画 tab 下钥匙按钮 hover 的更亮一档

  // ===== 通用按钮（5 张卡片共用）：active + hover 样式常量 =====
  BTN_BG_ACTIVE:    'var(--spine-accent)',                      // mode 卡激活（蓝）；transform/space/reference 激活也是它
  BTN_BG_HOVER:     'rgba(255, 255, 255, 0.14)',                // hover（亮一档）
  BTN_BG_DEFAULT:   'rgba(255, 255, 255, 0.06)',
  BTN_COLOR_ACTIVE: '#fff',                                       // 激活时文字白
  BTN_COLOR_DEFAULT: 'var(--spine-text)',

  ROW_FONT_SIZE:     13,

  // Card 卡片外壳（5 张卡片共用）尺寸
  CARD_PADDING:      6,       // ← 卡片内边距（按钮到面板边缘的距离）
  CARD_GAP:          4,       // ← 卡片内部按钮之间的间距
  CARD_BG:           'rgba(35, 35, 38, 0.78)',     // ← 卡片背景色
  CARD_BORDER:       '1px solid rgba(255, 255, 255, 0.08)', // ← 卡片边框
  CARD_RADIUS:       6,       // ← 卡片圆角
  // 卡片之间间距（外层容器 gap）
  CARDS_GAP:         8,       // ← 5 张卡片之间的水平间距
};

// ===== 悬停说明（tooltip）延迟 =====
const TOOLTIP_DELAY = 2000;    // 首次悬停等待（ms）
const TOOLTIP_RESET_MS = 500;  // 离开后重置"已弹过"（ms）：行间快速切换不重置

/**
 * Day 3.5 · 底部工具栏（严格 Spine 风格）
 *
 * 5 张卡片，左→右：
 *   1. mode 卡（姿势/权重/创建）
 *   2. transform 卡（旋转/移动/缩放/倾斜）
 *   3. space 卡（本地/父级/世界）
 *   4. reference 卡（骨骼/图片/像素）
 *   5. visibility 卡（3×3 眼睛网格）
 *
 * 卡片间用细竖线分隔。每张卡片都是独立深灰面板 + 1px 描边。
 *
 * 图标用 inline SVG 占位（每个 16×16 viewBox），方便后续替换。
 */
export function BottomToolbar() {
  const editorMode = usePixiBonesStore((s) => s.editorMode);
  const setTool = usePixiBonesStore((s) => s.setTool);
  const activeTool = usePixiBonesStore((s) => s.activeTool);
  const transformSpace = usePixiBonesStore((s) => s.transformSpace);
  const setTransformSpace = usePixiBonesStore((s) => s.setTransformSpace);
  const bones = usePixiBonesStore((s) => s.bones);
  const selectedBoneId = usePixiBonesStore((s) => s.selectedBoneId);
  const selectBone = usePixiBonesStore((s) => s.selectBone);
  const editorTab = usePixiBonesStore((s) => s.editorTab);
  const timelineHeight = usePixiBonesStore((s) => s.timelineHeight);
  const toolbarLocked = usePixiBonesStore((s) => s.toolbarLocked);
  const toggleToolbarLocked = usePixiBonesStore((s) => s.toggleToolbarLocked);
  const toolbarOffsetX = usePixiBonesStore((s) => s.toolbarOffsetX);
  const setToolbarOffsetX = usePixiBonesStore((s) => s.setToolbarOffsetX);
  const showRightPanel = usePixiBonesStore((s) => s.showRightPanel);
  const viewGridTool = usePixiBonesStore((s) => s.viewGridTool);
  const viewWeights = usePixiBonesStore((s) => s.viewWeights);
  const dockPanelWidths = usePixiBonesStore((s) => s.dockPanelWidths);
  // 右侧停靠区总宽度 = 各已开面板宽度之和 + 每块面板左边缘那根拖动分隔条的宽度
  const viewGridToolMinimized = usePixiBonesStore((s) => s.viewGridToolMinimized);
  const viewWeightsMinimized  = usePixiBonesStore((s) => s.viewWeightsMinimized);
  // ★ 停靠区"实际占的宽度"：只算"正在显示"的面板。
  //   - hierarchy：showRightPanel
  //   - grid_tool / weights：view 标记 + 不是最小化（被最小化后 dock 不渲染，应释放宽度）
  const dockOpen = [
    showRightPanel && 'hierarchy',
    (viewGridTool && !viewGridToolMinimized) && 'grid_tool',
    (viewWeights && !viewWeightsMinimized) && 'weights',
  ].filter(Boolean) as string[];
  const dockWidth = dockOpen.reduce(
    (sum, k) => sum + (dockPanelWidths[k] ?? DOCK_PANEL_DEFAULT_WIDTH[k] ?? 300) + DOCK_RESIZER_WIDTH,
    0,
  );
  /** 网格编辑模式：底部卡片组向下渐隐让位给「编辑网格」浮动面板 */
  const meshEditSlotId = usePixiBonesStore((s) => s.meshEditSlotId);
  const toolbarHidden = !!meshEditSlotId;
  const { t } = useT();

  // 卡片组横向拖动：pointer events + setPointerCapture（在卡片下方同一目标下）
  // 不需要 window listener —— pointer capture 让 pointermove 即使移出 wrapper 也能继续触发到 wrapper
  const dragRef = useRef<{ startX: number; startOffset: number; pointerId: number } | null>(null);
  const lockButtonRef = useRef<HTMLButtonElement>(null);

  // wrapper ref：用于 document capture pointerdown 时判定 target 是否在 toolbar 区域内
  const wrapperRef = useRef<HTMLDivElement>(null);

  // 全局 pointer 监听：解锁后整个卡片组可拖，不依赖 wrapper onPointerDown 是否被触发
  useEffect(() => {
    if (toolbarLocked) return;
    let activePointerId: number | null = null;
    let startX = 0;
    let startOffset = 0;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // 只响应来自 toolbar 区域的 pointerdown
      const target = e.target as HTMLElement;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      // 锁按钮位置（也在外层）需要排除
      const lockBtn = lockButtonRef.current;
      if (lockBtn && lockBtn.contains(target)) return;
      // 只接受 wrapper 内的 pointerdown
      if (!wrapper.contains(target)) return;
      activePointerId = e.pointerId;
      startX = e.clientX;
      // 用 ref 读最新 toolbarOffsetX，避免 useEffect 依赖导致重挂
      startOffset = usePixiBonesStore.getState().toolbarOffsetX;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    };
    const onMove = (e: PointerEvent) => {
      if (activePointerId === null || e.pointerId !== activePointerId) return;
      setToolbarOffsetX(startOffset + (e.clientX - startX));
    };
    const onUp = (e: PointerEvent) => {
      if (activePointerId === null || e.pointerId !== activePointerId) return;
      activePointerId = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    // 用 capture phase 第一时间捕获，不受 Card 内 button 拦截
    document.addEventListener('pointerdown', onDown, { capture: true });
    document.addEventListener('pointermove', onMove, { capture: true });
    document.addEventListener('pointerup', onUp, { capture: true });
    document.addEventListener('pointercancel', onUp, { capture: true });
    return () => {
      document.removeEventListener('pointerdown', onDown, { capture: true });
      document.removeEventListener('pointermove', onMove, { capture: true });
      document.removeEventListener('pointerup', onUp, { capture: true });
      document.removeEventListener('pointercancel', onUp, { capture: true });
    };
    // 依赖里只有 toolbarLocked（锁定状态变化时重挂）
    // toolbarOffsetX 变化时不重挂（用 getState 读最新值）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolbarLocked]);

  const selected = selectedBoneId ? findBone(bones, selectedBoneId) : null;
  const breadcrumb = useMemo(() => buildPath(bones, selectedBoneId), [bones, selectedBoneId]);

  // transform 4 行 —— 当前激活的工具（activeTool 为 null 表示未选中任何 transform 工具）
  const activeTransform = activeTool;
  const activeSpace: SpaceKey = (transformSpace === 'world' ? 'world' : 'local') as SpaceKey;
  const activeRef: RefKey = 'bone' as RefKey;

  // ===== 悬停说明（tooltip）：7 个工具按钮悬停时显示「功能 + 快捷键」 =====
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  // ★ 共享"已弹过"状态：任一按钮弹过一次后，同一次连续悬停内切换到其他按钮也立即显示
  const tipSharedRef = useRef<{ shown: boolean; resetTimer: number | null }>({ shown: false, resetTimer: null });

  return (
    <div
      className="absolute left-0 z-10 flex justify-center pointer-events-none"
      style={{
        // 动画 tab 时贴在时间轴（store.timelineHeight）上方 + 12px 间距
        // 装配 tab 时正常贴底 12px
        bottom: editorTab === 'animate' ? timelineHeight + 12 : 12,
        // 右侧停靠区（层级树 / 网格工具…）打开时让出宽度，卡片组就不会被面板压住
        right: dockWidth > 0 ? dockWidth + 12 : 0,
        // 网格编辑时向下渐隐（让位给底部中央的「编辑网格」浮动面板）
        transform: toolbarHidden ? 'translateY(110px)' : 'translateY(0)',
        opacity: toolbarHidden ? 0 : 1,
        transition: 'transform 0.24s ease, opacity 0.24s ease',
      }}
    >
      {/* 锁按钮：作为 wrapper 的第一个子元素，跟随 wrapper translateX 自动跟随
          onPointerDown stopPropagation 阻止 document capture listener 进入拖动判定 */}
      <div
        ref={wrapperRef}
        className="relative flex items-start pointer-events-auto"
        style={{
          gap: T.CARDS_GAP,
          // 卡片组 + 锁按钮 始终跟随 toolbarOffsetX 横向偏移
          transform: `translateX(${toolbarOffsetX}px)`,
          transition: 'transform 0.15s',
          cursor: toolbarLocked ? 'default' : 'ew-resize',
          // 渐隐后不再接收鼠标事件
          pointerEvents: toolbarHidden ? 'none' : 'auto',
        }}
      >
        <button
          ref={lockButtonRef}
          type="button"
          onClick={toggleToolbarLocked}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute pointer-events-auto"
          title={toolbarLocked ? t('toolbar.lock_unlock') : t('toolbar.lock_lock')}
          style={{
            // 贴在 mode 卡左外侧（wrapper 坐标）
            left: -22,
            bottom: 0,
            width: 18,
            height: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--spine-text-dim)',
            fontSize: 13,
            padding: 0,
            zIndex: 1,
          }}
        >
          {toolbarLocked ? <IconLock /> : <IconUnlockArrows />}
        </button>

        {/* 卡片 1：mode 切换 */}
        <Card>
          <ModeButton
            icon={<IconPose />}
            label={t('toolbar.mode_pose')}
            active={editorMode === 'pose'}
            tip="姿势：编辑骨骼和图片的姿态\n快捷键 B"
            onTip={setTooltip}
            tipShared={tipSharedRef.current}
            onClick={() => {
              const st = usePixiBonesStore.getState();
              // 点击当前激活的工具 = 保持 pose（只有"右键空白处"才回退到上一个工具）
              if (st.currentTool !== 'pose') setTool('pose');
            }}
          />
          <ModeButton
            icon={<IconWeights />}
            label={t('toolbar.mode_weights')}
            active={editorMode === 'weights'}
            tip="权重：编辑网格顶点的骨骼权重\n快捷键 G"
            onTip={setTooltip}
            tipShared={tipSharedRef.current}
            onClick={() => {
              const st = usePixiBonesStore.getState();
              if (st.currentTool !== 'weights') setTool('weights');
              // ★ 底部「权重」按钮也打开右侧权重面板（与视图菜单「权重」同效果）
              const st2 = usePixiBonesStore.getState();
              if (!st2.viewWeights) st2.toggleViewWeights();
            }}
          />
          <ModeButton
            icon={<IconCreate />}
            label={t('toolbar.mode_create')}
            active={editorMode === 'create'}
            tip="创建：在画布上创建骨骼\n快捷键 N"
            onTip={setTooltip}
            tipShared={tipSharedRef.current}
            onClick={() => {
              const st = usePixiBonesStore.getState();
              if (st.currentTool !== 'create') setTool('create');
            }}
          />
        </Card>
          {/* 卡片 2：transform 值（4 行） */}
        <Card>
          <TransformRow
            icon={<IconRotate />}
            label={t('toolbar.tx_rotate')}
            xValue="0.0"
            active={activeTransform === 'rotate'}
            columns="one"
            hoverable
            transformType="rotate"
            tip="旋转：旋转骨骼和图片\n快捷键 R"
            onTip={setTooltip}
            tipShared={tipSharedRef.current}
          />
          <TransformRow
            icon={<IconMove />}
            label={t('toolbar.tx_move')}
            xValue={selected ? selected.x.toFixed(1) : '0.0'}
            yValue={selected ? selected.y.toFixed(1) : '0.0'}
            active={activeTransform === 'move'}
            columns="two"
            hoverable
            transformType="move"
            tip="移动：移动骨骼和图片\n快捷键 M"
            onTip={setTooltip}
            tipShared={tipSharedRef.current}
          />
          <TransformRow
            icon={<IconScale />}
            label={t('toolbar.tx_scale')}
            xValue={selected ? selected.scaleX.toFixed(2) : '1.00'}
            yValue={selected ? selected.scaleY.toFixed(2) : '1.00'}
            active={activeTransform === 'scale'}
            columns="two"
            hoverable
            transformType="scale"
            tip="缩放：缩放骨骼和图片\n快捷键 S"
            onTip={setTooltip}
            tipShared={tipSharedRef.current}
          />
          <TransformRow
            icon={<IconShear />}
            label={t('toolbar.tx_shear')}
            xValue="0.0"
            yValue="0.0"
            active={activeTransform === 'shear'}
            columns="two"
            hoverable
            transformType="shear"
            tip="倾斜：倾斜骨骼和图片\n快捷键 Z"
            onTip={setTooltip}
            tipShared={tipSharedRef.current}
          />
        </Card>
          {/* 卡片 3：transform space */}
        <Card>
          <RadioButton
            icon={<IconLocal />}
            label={t('toolbar.space_local')}
            active={activeSpace === 'local'}
            onClick={() => setTransformSpace('local')}
          />
          <RadioButton
            icon={<IconParent />}
            label={t('toolbar.space_parent')}
            active={activeSpace === 'parent'}
            onClick={() => setTransformSpace('local')}
          />
          <RadioButton
            icon={<IconWorld />}
            label={t('toolbar.space_world')}
            active={activeSpace === 'world'}
            onClick={() => setTransformSpace('world')}
          />
        </Card>
          {/* 卡片 4：reference */}
        <Card>
          <RadioButton
            icon={<IconBone />}
            label={t('toolbar.ref_bone')}
            active={activeRef === 'bone'}
            onClick={() => {}}
          />
          <RadioButton
            icon={<IconImage />}
            label={t('toolbar.ref_image')}
            active={activeRef === 'image'}
            onClick={() => {}}
          />
          <RadioButton
            icon={<IconPixel />}
            label={t('toolbar.ref_pixel')}
            active={activeRef === 'pixel'}
            onClick={() => {}}
          />
        </Card>
          {/* 卡片 5：visibility 3×3 眼睛网格 */}
        <Card>
          <VisibilityTable
            rows={[
              { label: t('toolbar.vis_bone'),  eyes: [true, false, false] },
              { label: t('toolbar.vis_image'), eyes: [true, false, false] },
              { label: t('toolbar.vis_other'), eyes: [false, false, false] },
            ]}
          />
        </Card>
      </div>

      {/* ===== 悬停说明浮层：portal 到 body，避开卡片 overflow 裁剪 ===== */}
      {tooltip && createPortal(
        <div
          style={{
            position: 'fixed',
            left: tooltip.x + 14,
            top: tooltip.y + 18,
            zIndex: 9999,
            pointerEvents: 'none',
            padding: '5px 9px',
            background: '#2D2D30',
            border: '1px solid #3F3F46',
            borderRadius: 4,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre',
            color: 'var(--spine-text)',
          }}
        >
          {tooltip.text}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ============================================================
//  卡片 + 分隔线
// ============================================================
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col rounded-md overflow-hidden self-end"
      style={{
        background: T.CARD_BG,
        border: T.CARD_BORDER,
        padding: T.CARD_PADDING,
        gap: T.CARD_GAP,
        borderRadius: T.CARD_RADIUS,
      }}
    >
      {children}
    </div>
  );
}

// ============================================================
//  按钮们
// ============================================================
function Toolbutton({
  active, hover, onHoverChange, onClick, height, minWidth, padding, extraSlot, children,
  tipText, onTip, tipShared,
}: {
  active: boolean;
  hover: boolean;
  onHoverChange: (v: boolean) => void;
  onClick: () => void;
  height: number;
  minWidth: number;
  padding: string;
  extraSlot?: React.ReactNode;
  children: React.ReactNode;
  /** 悬停说明（功能 + 快捷键），支持 \n 换行 */
  tipText?: string;
  onTip?: (tip: { text: string; x: number; y: number } | null) => void;
  /** 共享"已弹过"状态（所有工具按钮共用） */
  tipShared?: { shown: boolean; resetTimer: number | null };
}) {
  // ===== 悬停说明延迟逻辑（仿层级树悬停预览）：
  //  首次悬停等 2s 才弹出；任一按钮弹过一次后，同一次连续悬停内切换到其他按钮也立即显示；
  //  离开超过 500ms（未进入其他按钮）才重置，下次重新等 2s。 =====
  const tipTimerRef = useRef<number | null>(null);
  const tipPosRef = useRef({ x: 0, y: 0 });
  useEffect(() => () => {
    if (tipTimerRef.current !== null) clearTimeout(tipTimerRef.current);
    if (tipShared && tipShared.resetTimer !== null) clearTimeout(tipShared.resetTimer);
  }, [tipShared]);
  /** 悬停进入：首次等 2s，弹过后立即显示 */
  const scheduleTip = (clientX: number, clientY: number) => {
    if (!tipText || !onTip) return;
    tipPosRef.current = { x: clientX, y: clientY };
    if (tipShared && tipShared.resetTimer !== null) {
      clearTimeout(tipShared.resetTimer);
      tipShared.resetTimer = null;
    }
    if (tipTimerRef.current !== null) {
      clearTimeout(tipTimerRef.current);
      tipTimerRef.current = null;
    }
    const delay = (tipShared?.shown) ? 0 : TOOLTIP_DELAY;
    tipTimerRef.current = window.setTimeout(() => {
      onTip({ text: tipText, x: tipPosRef.current.x, y: tipPosRef.current.y });
      if (tipShared) tipShared.shown = true;
      tipTimerRef.current = null;
    }, delay);
  };
  /** 悬停离开：清掉提示 + 延迟重置共享"已弹过"（快速切换按钮不重置） */
  const cancelTip = () => {
    if (tipTimerRef.current !== null) {
      clearTimeout(tipTimerRef.current);
      tipTimerRef.current = null;
    }
    if (onTip) onTip(null);
    if (!tipShared) return;
    if (tipShared.resetTimer !== null) {
      clearTimeout(tipShared.resetTimer);
      tipShared.resetTimer = null;
    }
    tipShared.resetTimer = window.setTimeout(() => {
      tipShared.shown = false;
      tipShared.resetTimer = null;
    }, TOOLTIP_RESET_MS);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={(e) => {
        onHoverChange(true);
        if (tipText && onTip) scheduleTip(e.clientX, e.clientY);
      }}
      onMouseMove={(e) => {
        if (tipText && onTip) {
          tipPosRef.current = { x: e.clientX, y: e.clientY };
          // 已显示才跟随更新位置（等待期间不显示，只记录坐标）
          if (tipShared?.shown) onTip({ text: tipText, x: e.clientX, y: e.clientY });
        }
      }}
      onMouseLeave={() => {
        onHoverChange(false);
        if (tipText && onTip) cancelTip();
      }}
      className="relative flex items-center gap-2 transition-colors"
      style={{
        height,
        minWidth,
        padding,
        background: active ? T.BTN_BG_ACTIVE : (hover ? T.BTN_BG_HOVER : T.BTN_BG_DEFAULT),
        color: active ? T.BTN_COLOR_ACTIVE : T.BTN_COLOR_DEFAULT,
        border: 'none',
        borderRadius: T.ROW_RADIUS,
        fontSize: 12,
        fontWeight: 400,
        cursor: 'pointer',
        lineHeight: 1,
      }}
    >
      {extraSlot}
      {children}
    </button>
  );
}

function ModeButton({
  icon, label, badge, active, onClick, tip, onTip, tipShared,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: string;
  active: boolean;
  onClick: () => void;
  /** 悬停说明（功能 + 快捷键），支持 \n 换行 */
  tip?: string;
  onTip?: (tip: { text: string; x: number; y: number } | null) => void;
  /** 共享"已弹过"状态（所有工具按钮共用） */
  tipShared?: { shown: boolean; resetTimer: number | null };
}) {
  const [hover, setHover] = useState(false);
  // 复用通用 ToolButton 颜色逻辑，badge 专属逻辑保留
  return (
    <Toolbutton
      active={active}
      hover={hover}
      onHoverChange={setHover}
      onClick={onClick}
      height={26}
      minWidth={80}
      padding="0 10px"
      tipText={tip}
      onTip={onTip}
      tipShared={tipShared}
      extraSlot={badge ? (
        <span
          style={{
            position: 'absolute',
            top: -2,
            right: 4,
            fontSize: 9,
            fontWeight: 700,
            color: '#E61E1E',
            background: '#2D0A0A',
            padding: '0 3px',
            borderRadius: 2,
          }}
        >
          {badge}
        </span>
      ) : null}
    >
      <span style={{ width: 16, height: 16, display: 'flex' }}>{icon}</span>
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
    </Toolbutton>
  );
}

function TransformRow({
  icon, label, xValue, yValue, columns, hoverable = false, active = false, transformType,
  tip, onTip, tipShared,
}: {
  icon: React.ReactNode;
  label: string;
  xValue: string;
  yValue?: string;
  active?: boolean;
  columns: 'one' | 'two';
  /** 该行是否已解锁（解锁后才有鼠标悬停效果） */
  hoverable?: boolean;
  /** 点击左侧按钮时切换到该工具；点击同一个则取消激活 */
  transformType: 'rotate' | 'move' | 'scale' | 'shear';
  /** 悬停说明（功能 + 快捷键），支持 \n 换行 */
  tip?: string;
  onTip?: (tip: { text: string; x: number; y: number } | null) => void;
  /** 共享"已弹过"状态（所有工具按钮共用） */
  tipShared?: { shown: boolean; resetTimer: number | null };
}) {
  // 两块独立 hover：左按钮 / 中输入
  // 钥匙按钮自身锁死与否取决于外部 editorTab（设置 / 动画）
  const [hoverLeft, setHoverLeft] = useState(false);
  const [hoverMid, setHoverMid] = useState(false);
  const setTool = usePixiBonesStore((s) => s.setTool);
  const editorTab = usePixiBonesStore((s) => s.editorTab);
  // 关键帧锁：设置 tab 锁死（深灰、不可点）；动画 tab 可开关。
  //   true = 变换骨骼时自动在 currentTime 写关键帧（亮绿）；false = 不写（灰绿、hover 可点亮）
  const keyframeLock = usePixiBonesStore((s) => s.keyframeLock);
  const toggleKeyframeLock = usePixiBonesStore((s) => s.toggleKeyframeLock);
  const keyframeLocked = editorTab !== 'animate';
  // 钥匙按钮自己的 hover（动画 tab 才生效）
  const [hoverKey, setHoverKey] = useState(false);
  const keyframeBg = keyframeLocked ? T.ROW_BG
    : (keyframeLock ? (hoverKey ? T.KEYFRAME_GREEN_HOVER : T.KEYFRAME_GREEN) : T.ROW_BG);
  return (
    <div
      className="flex items-center"
      style={{
        height: T.ROW_HEIGHT,
        color: 'var(--spine-text)',
        fontSize: T.ROW_FONT_SIZE,
        gap: 0,           // 三块紧贴
      }}
    >
      {/* 块 1：左侧功能按钮（旋转 / 移动 / 缩放 / 倾斜）—— 复用 Toolbutton：active 蓝、hover 亮 */}
      <div
        style={{
          flex: 'none',
          // 整行紧贴：左侧按钮靠右不要圆角，与中间输入框衔接成一条直线
          borderRadius: `${T.ROW_RADIUS}px 0 0 ${T.ROW_RADIUS}px`,
          overflow: 'hidden',
        }}
      >
        <Toolbutton
          active={active}
          hover={hoverable && hoverLeft}
          onHoverChange={hoverable ? setHoverLeft : () => {}}
          onClick={() => {
            // 工具栏点击 = 切到该工具；点击当前已激活的 = 什么都不做（保持当前）。
            // 只有"右键空白处"才回退到上一个工具。
            const k = transformType;
            const st = usePixiBonesStore.getState();
            if (st.currentTool === k) return;
            setTool(k);
          }}
          height={T.ROW_HEIGHT}
          minWidth={T.LABEL_BOX_WIDTH}
          padding={`0 0 0 ${T.LABEL_BOX_PAD_L}px`}
          tipText={tip}
          onTip={onTip}
          tipShared={tipShared}
        >
          <span style={{ width: T.LABEL_ICON_SIZE, height: T.LABEL_ICON_SIZE, display: 'flex' }}>{icon}</span>
          <span>{label}</span>
        </Toolbutton>
      </div>

      {/* 块 2：中间输入框（接受用户输入数字来改 transform 值） */}
      <div
        onMouseEnter={hoverable ? () => setHoverMid(true) : undefined}
        onMouseLeave={hoverable ? () => setHoverMid(false) : undefined}
        className="flex items-center transition-colors"
        style={{
          height: T.ROW_HEIGHT,
          background: hoverable && hoverMid ? T.ROW_BG_HOVER : T.ROW_BG,
          borderRadius: T.ROW_RADIUS,
          // 输入框自己撑满，不需要左右内边距（之前留的 4px 让边框和 input 之间出现灰带）
          paddingLeft: 0,
          paddingRight: 0,
          cursor: hoverable ? 'text' : 'default',
          flex: 'none',
        }}
      >
      {columns === 'two' && yValue !== undefined ? (
        <>
          <input
            value={xValue}
            readOnly
            className="px-2 text-center"
            style={{
              background: 'var(--spine-bg-panel-dark)',
              border: 'none',
              color: 'inherit',
              fontFamily: 'monospace',
              fontSize: T.INPUT_FONT_SIZE,
              height: T.INPUT_HEIGHT,
              outline: 'none',
              flex: 'none',
              width: T.INPUT_WIDTH,
              borderRadius: 0,
            }}
          />
          {/* 中间分隔竖线（与 input 等高） */}
          <span
            aria-hidden
            style={{
              width: T.DIVIDER_WIDTH,
              height: T.INPUT_HEIGHT,
              background: 'rgba(255, 255, 255, 0.12)',
              flex: 'none',
            }}
          />
          <input
            value={yValue}
            readOnly
            className="px-2 text-center"
            style={{
              background: 'var(--spine-bg-panel-dark)',
              border: 'none',
              color: 'inherit',
              fontFamily: 'monospace',
              fontSize: T.INPUT_FONT_SIZE,
              height: T.INPUT_HEIGHT,
              outline: 'none',
              flex: 'none',
              width: T.INPUT_WIDTH,
              borderRadius: 0,
            }}
          />
        </>
      ) : (
        <input
          value={xValue}
          readOnly
          className="px-2 text-center"
          style={{
            background: 'var(--spine-bg-panel-dark)',
            border: 'none',
            color: 'inherit',
            fontFamily: 'monospace',
            fontSize: T.INPUT_FONT_SIZE,
            height: T.INPUT_HEIGHT,
            outline: 'none',
            flex: 'none',
            width: T.SINGLE_INPUT_WIDTH,
            borderRadius: T.INPUT_RADIUS,
          }}
        />
      )}
      </div>

      {/* 块 3：右侧关键帧按钮
            - 设置 tab：锁死（深灰、不可点、无 hover）
            - 动画 tab：激活（亮绿、hover 提亮、可点；写入关键帧时再变红） */}
      <button
        type="button"
        disabled={keyframeLocked}
        onClick={keyframeLocked ? undefined : toggleKeyframeLock}
        onMouseEnter={() => !keyframeLocked && setHoverKey(true)}
        onMouseLeave={() => setHoverKey(false)}
        className="flex items-center justify-center shrink-0 transition-colors"
        style={{
          width: T.KEYFRAME_BTN_W,
          height: T.KEYFRAME_BTN_H,
          padding: 0,
          lineHeight: 1,
          // 设置 tab 用淡灰，动画 tab 且关键帧锁开启时用浅绿图标
          color: keyframeLocked || !keyframeLock ? 'rgba(187, 187, 187, 0.35)' : '#A8F0B8',
          background: keyframeLocked ? T.ROW_BG : keyframeBg,
          border: 'none',
          // 整行紧贴：右侧关键帧按钮靠左不要圆角，与中间输入框衔接成一条直线
          borderRadius: `0 ${T.ROW_RADIUS}px ${T.ROW_RADIUS}px 0`,
          cursor: keyframeLocked ? 'not-allowed' : 'pointer',
        }}
        title={keyframeLocked
          ? '关键帧（设置模式下不可用）'
          : (keyframeLock ? '关键帧锁开启：变换骨骼时自动写入关键帧（点击关闭）' : '关键帧锁关闭：变换骨骼不写入关键帧（点击开启）')}
      >
        <IconLink />
      </button>
    </div>
  );
}

function RadioButton({
  icon, label, active, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <Toolbutton
      active={active}
      hover={hover}
      onHoverChange={setHover}
      onClick={onClick}
      height={26}
      minWidth={80}
      padding="0 10px"
    >
      <span style={{ width: 16, height: 16, display: 'flex' }}>{icon}</span>
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
    </Toolbutton>
  );
}

function VisibilityTable({
  rows,
}: {
  rows: Array<{ label: string; eyes: [boolean, boolean, boolean] }>;
}) {
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td style={{ padding: '2px 6px', color: 'var(--spine-text)' }}>{r.label}</td>
            {r.eyes.map((on, j) => (
              <td
                key={j}
                style={{
                  padding: '2px 6px',
                  color: on ? 'var(--spine-text)' : 'var(--spine-text-dim)',
                  fontSize: 13,
                }}
              >
                {on ? '👁' : '○'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ============================================================
//  图标
//    PNG 资源统一放 src/editor/icons/，用 <ImgIcon> 渲染
//    还没有 PNG 的占位仍用 inline SVG（保留 ICON_PROPS）
// ============================================================
const ICON_PROPS = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor' };

function ImgIcon({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      width={T.LABEL_ICON_SIZE}
      height={T.LABEL_ICON_SIZE}
      style={{ display: 'block' }}
    />
  );
}

function IconPose() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="8" cy="3" r="2" />
      <path d="M8 5 L8 11 M8 7 L5 10 M8 7 L11 10 M8 11 L5.5 15 M8 11 L10.5 15"
        stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <circle cx="13" cy="3" r="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M14.5 3.5 L11 7" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function IconWeights() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2 14 L7 9 L10 12 L5 17 Z" />
      <path d="M8 8 L11 5 L14 8 L11 11 Z" />
      <circle cx="12" cy="6.5" r="0.6" fill="#2D2D30" />
    </svg>
  );
}

function IconCreate() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M1 15 L3 13 L11 5 L13 7 L5 15 Z" />
      <path d="M11 5 L13 3 L15 5 L13 7 Z" />
      <path d="M1 15 L5 15" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconRotate() {
  return <ImgIcon src={rotateIcon} alt="旋转" />;
}

function IconMove() {
  return <ImgIcon src={moveIcon} alt="移动" />;
}

function IconScale() {
  return <ImgIcon src={scaleIcon} alt="缩放" />;
}

function IconShear() {
  return <ImgIcon src={shearIcon} alt="倾斜" />;
}

function IconLocal() {
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="5" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
    </svg>
  );
}

function IconParent() {
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="3.5" r="2" />
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M8 5.5 L4 10 M8 5.5 L12 10" />
    </svg>
  );
}

function IconWorld() {
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="3" ry="6" />
      <path d="M2 8 L14 8" />
    </svg>
  );
}

function IconBone() {
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="4" cy="4" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M5.5 5.5 L10.5 10.5" strokeLinecap="round" />
    </svg>
  );
}

function IconImage() {
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1.5" y="2.5" width="13" height="11" />
      <circle cx="5" cy="6" r="1.2" fill="currentColor" />
      <path d="M2 12 L6 8 L9 11 L14 5" />
    </svg>
  );
}

function IconPixel() {
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="2" y="2" width="5" height="5" fill="currentColor" />
      <rect x="9" y="2" width="5" height="5" />
      <rect x="2" y="9" width="5" height="5" />
      <rect x="9" y="9" width="5" height="5" fill="currentColor" />
    </svg>
  );
}

function IconLink() {
  return <ImgIcon src={frameKeyIcon} alt="关键帧" />;
}

// 小锁（锁定态：卡片组居中，不可拖动）
function IconLock() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="10" height="7" rx="1" fill="currentColor" />
      <path d="M5 7 L5 5 A3 3 0 0 1 11 5 L11 7" stroke="currentColor" fill="none" />
    </svg>
  );
}

// 解锁 + 上下双向箭头（解锁态：可横向拖动卡片组）
function IconUnlockArrows() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6 L3 10" />
      <path d="M1 8 L3 6 L5 8" />
      <path d="M13 6 L13 10" />
      <path d="M11 8 L13 6 L15 8" />
      <path d="M7 3 L9 1 M7 3 L9 5 M7 13 L9 11 M7 13 L9 15" />
    </svg>
  );
}

// ============================================================
//  helper
// ============================================================
type SpaceKey = 'local' | 'parent' | 'world';
type RefKey = 'bone' | 'image' | 'pixel';

function buildPath(bones: BoneNode[], selectedId: string | null): BoneNode[] {
  if (!selectedId) return [];
  const out: BoneNode[] = [];
  let cur = findBone(bones, selectedId);
  while (cur) {
    out.unshift(cur);
    if (!cur.parentId) break;
    cur = findBone(bones, cur.parentId);
    if (out.length > 32) break;
  }
  return out;
}
