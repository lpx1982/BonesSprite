import { useMemo, useRef, useState, useLayoutEffect, useEffect } from 'react';
import { usePixiBonesStore, findBone, type BoneNode } from './store';
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
  LABEL_BOX_WIDTH:   80,
  LABEL_BOX_PAD_L:   8,
  LABEL_ICON_SIZE:   18,
  ROW_H_PAD:         4,
  INPUT_HEIGHT:      26,
  INPUT_FONT_SIZE:   11,
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
  const setEditorMode = usePixiBonesStore((s) => s.setEditorMode);
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
  const { t } = useT();

  // 卡片组横向拖动：pointer events + setPointerCapture（在卡片下方同一目标下）
  // 不需要 window listener —— pointer capture 让 pointermove 即使移出 wrapper 也能继续触发到 wrapper
  const dragRef = useRef<{ startX: number; startOffset: number; pointerId: number } | null>(null);
  const lockButtonRef = useRef<HTMLButtonElement>(null);

  // 测 wrapper 实际宽度，让锁按钮贴在卡片组左外侧
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [wrapperLeft, setWrapperLeft] = useState(0);
  useLayoutEffect(() => {
    const update = () => {
      if (wrapperRef.current) {
        const rect = wrapperRef.current.getBoundingClientRect();
        const parentRect = wrapperRef.current.parentElement!.getBoundingClientRect();
        // 锁按钮在父容器坐标系下的 left = wrapper.left - parentRect.left - 22px
        setWrapperLeft(rect.left - parentRect.left - 22);
      }
    };
    update();
    window.addEventListener('resize', update);
    // toolbarOffsetX / toolbarLocked 变化时 wrapper 位置变化，重测
    const ro = new ResizeObserver(update);
    if (wrapperRef.current) ro.observe(wrapperRef.current);
    return () => {
      window.removeEventListener('resize', update);
      ro.disconnect();
    };
  }, [toolbarOffsetX, toolbarLocked]);

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
      startOffset = toolbarOffsetX;
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

    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [toolbarLocked, toolbarOffsetX, setToolbarOffsetX]);

  const selected = selectedBoneId ? findBone(bones, selectedBoneId) : null;
  const breadcrumb = useMemo(() => buildPath(bones, selectedBoneId), [bones, selectedBoneId]);

  // transform 4 行 —— 默认选中第一行（旋转）
  const activeTransform: TransformKey = 'rotate' as TransformKey;
  // reference / space 默认值
  const activeSpace: SpaceKey = (transformSpace === 'world' ? 'world' : 'local') as SpaceKey;
  const activeRef: RefKey = 'bone' as RefKey;

  return (
    <div
      className="absolute left-0 right-0 z-10 flex justify-center pointer-events-none"
      style={{
        // 动画 tab 时贴在时间轴（store.timelineHeight）上方 + 12px 间距
        // 装配 tab 时正常贴底 12px
        bottom: editorTab === 'animate' ? timelineHeight + 12 : 12,
      }}
    >
      {/* 锁按钮：放在外层，pointer events 独立，不被 wrapper 的 setPointerCapture 劫持
        位置由 wrapperRef.getBoundingClientRect() 实时测出（卡片组大小变化时自动跟随） */}
      <button
        ref={lockButtonRef}
        type="button"
        onClick={toggleToolbarLocked}
        onPointerDown={(e) => e.stopPropagation()}  // 阻止 document 上的 pointerdown 进入拖动判定
        className="absolute pointer-events-auto"
        title={toolbarLocked ? t('toolbar.lock_unlock') : t('toolbar.lock_lock')}
        style={{
          // 由 useLayoutEffect 测量出的 wrapper 实际左侧（包含 toolbarOffsetX 偏移）
          left: wrapperLeft,
          // 跟 wrapper 一样贴底，跟 mode 卡底边对齐
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
          zIndex: 11,  // 高于 wrapper(zIndex:10) 确保不被卡片遮住
        }}
      >
        {toolbarLocked ? <IconLock /> : <IconUnlockArrows />}
      </button>

      <div
        ref={wrapperRef}
        className="relative flex items-start pointer-events-auto"
        style={{
          gap: T.CARDS_GAP,
          // 解锁状态下卡片组跟随 toolbarOffsetX 横向偏移
          transform: toolbarLocked ? 'translateX(0)' : `translateX(${toolbarOffsetX}px)`,
          transition: toolbarLocked ? 'transform 0.15s' : 'none',
          cursor: toolbarLocked ? 'default' : 'ew-resize',
        }}
      >
        {/* 卡片 1：mode 切换 */}
        <Card>
          <ModeButton
            icon={<IconPose />}
            label={t('toolbar.mode_pose')}
            active={editorMode === 'pose'}
            onClick={() => setEditorMode('pose')}
          />
          <ModeButton
            icon={<IconWeights />}
            label={t('toolbar.mode_weights')}
            badge="PRO"
            active={editorMode === 'weights'}
            onClick={() => setEditorMode('weights')}
          />
          <ModeButton
            icon={<IconCreate />}
            label={t('toolbar.mode_create')}
            active={editorMode === 'create'}
            onClick={() => setEditorMode('create')}
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
          />
          <TransformRow
            icon={<IconMove />}
            label={t('toolbar.tx_move')}
            xValue={selected ? selected.x.toFixed(1) : '0.0'}
            yValue={selected ? selected.y.toFixed(1) : '0.0'}
            active={activeTransform === 'move'}
            columns="two"
          />
          <TransformRow
            icon={<IconScale />}
            label={t('toolbar.tx_scale')}
            xValue={selected ? selected.scaleX.toFixed(2) : '1.00'}
            yValue={selected ? selected.scaleY.toFixed(2) : '1.00'}
            active={activeTransform === 'scale'}
            columns="two"
          />
          <TransformRow
            icon={<IconShear />}
            label={t('toolbar.tx_shear')}
            xValue="0.0"
            yValue="0.0"
            active={activeTransform === 'shear'}
            columns="two"
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
function ModeButton({
  icon, label, badge, active, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 relative"
      style={{
        height: 26,
        minWidth: 80,
        padding: '0 10px',
        // 暂时不做 active 高亮（功能未实现，避免误导用户）
        background: 'rgba(255, 255, 255, 0.06)',
        color: 'var(--spine-text)',
        fontWeight: 400,
        fontSize: 12,
        borderRadius: 4,
      }}
    >
      <span style={{ width: 16, height: 16, display: 'flex' }}>{icon}</span>
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
      {badge && (
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
      )}
    </button>
  );
}

function TransformRow({
  icon, label, xValue, yValue, active, columns,
}: {
  icon: React.ReactNode;
  label: string;
  xValue: string;
  yValue?: string;
  active: boolean;
  columns: 'one' | 'two';
}) {
  return (
    <div
      className="flex items-center relative"
      style={{
        height: T.ROW_HEIGHT,
        background: T.ROW_BG,
        color: 'var(--spine-text)',
        fontSize: T.ROW_FONT_SIZE,
        borderRadius: T.ROW_RADIUS,
        paddingLeft: T.ROW_H_PAD,
        paddingRight: T.ROW_H_PAD,
      }}
    >
      <span
        className="flex items-center gap-2 shrink-0"
        style={{ width: T.LABEL_BOX_WIDTH, paddingLeft: T.LABEL_BOX_PAD_L }}
      >
        <span style={{ width: T.LABEL_ICON_SIZE, height: T.LABEL_ICON_SIZE, display: 'flex' }}>{icon}</span>
        <span>{label}</span>
      </span>
      {columns === 'two' && yValue !== undefined ? (
        <>
          <input
            readOnly
            value={xValue}
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
            readOnly
            value={yValue}
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
          readOnly
          value={xValue}
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
      <span
        className="flex items-center justify-center shrink-0"
        style={{ width: T.KEYFRAME_BTN_W, height: T.KEYFRAME_BTN_H, color: 'var(--spine-text-dim)' }}
        title="link"
      >
        <IconLink />
      </span>
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
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3"
      style={{
        height: 26,
        minWidth: 80,
        padding: '0 10px',
        // 暂时不做 active 高亮（功能未实现，避免误导用户）
        background: 'rgba(255, 255, 255, 0.06)',
        color: 'var(--spine-text)',
        fontWeight: 400,
        fontSize: 12,
        borderRadius: 4,
      }}
    >
      <span style={{ width: 16, height: 16, display: 'flex' }}>{icon}</span>
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
    </button>
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
type TransformKey = 'rotate' | 'move' | 'scale' | 'shear';
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
