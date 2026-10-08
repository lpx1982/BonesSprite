import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePixiBonesStore } from './store';
import { useT } from './i18n';

/**
 * Day 3.5 · 画布 overlay UI（Spine 风格）
 *
 * 4 块 UI：
 *   1. 顶横标尺（horizontal ruler）
 *   2. 左竖标尺（vertical ruler）
 *   3. 十字光标（HTML 层，永远在 rulers 之上；之前在 PixiJS 画，被 rulers 盖住）
 *   4. 左下角 zoom 控制条（ruler slider + magnifier + +/- buttons）
 */
export function CanvasOverlay() {
  const viewport = usePixiBonesStore((s) => s.viewport);
  const setViewport = usePixiBonesStore((s) => s.setViewport);
  const render = usePixiBonesStore((s) => s.render);
  const showRulers = usePixiBonesStore((s) => s.showRulers);
  const toggleRulers = usePixiBonesStore((s) => s.toggleRulers);
  const requestFitContent = usePixiBonesStore((s) => s.requestFitContent);
  const editorTab = usePixiBonesStore((s) => s.editorTab);
  const setEditorTab = usePixiBonesStore((s) => s.setEditorTab);
  const timelineHeight = usePixiBonesStore((s) => s.timelineHeight);
  const { t } = useT();

  const [canvasSize, setCanvasSize] = useState({ width: 1000, height: 600 });
  useEffect(() => {
    const host = document.querySelector('.canvas-host');
    if (!host) return;
    const update = () => {
      const r = host.getBoundingClientRect();
      setCanvasSize({
        width: Math.max(0, r.width - 20),
        height: Math.max(0, r.height - 30),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const tickValuesX = useMemo(
    () => generateTicks(render.x, render.scale, canvasSize.width, 'h'),
    [render.x, render.scale, canvasSize.width],
  );
  const tickValuesY = useMemo(
    // Y 轴向上为正（数学坐标系），所以 screenPos = render.y - worldValue * scale
    () => generateTicks(render.y, render.scale, canvasSize.height, 'v', true),
    [render.y, render.scale, canvasSize.height],
  );

  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* 左上角 tab 切换：装配（设置）/ 动画 —— Spine 风格 */}
      <EditorTabSwitch
        active={editorTab}
        onChange={setEditorTab}
        t={t}
      />

      {/* 顶横标尺 —— Spine 风格：ruler 高度 22px，黑色背景 + 纯黑下边线 */}
      {showRulers && (
      <div
        className="absolute top-0 left-0 right-0 h-[22px] pointer-events-none"
        style={{
          background: '#272727ff',
          zIndex: 0,
        }}
      >
        {tickValuesX.map((t, i) => (
          <RulerTick
            key={`h${i}`}
            worldValue={t.worldValue}
            screenPos={t.screenPos}
            isMajor={t.isMajor}
            orientation="h"
          />
        ))}
      </div>
      )}

      {/* 左竖标尺 —— 跟顶横 ruler 统一：宽度 22px、同款深灰背景。完整到底。 */}
      {showRulers && (
      <div
        className="absolute left-0 top-0 bottom-0 w-[22px] pointer-events-none"
        style={{
          background: '#272727ff',
          borderRight: '1px solid #272727ff',
          zIndex: 1,
        }}
      >
        {tickValuesY.map((t, i) => (
          <RulerTick
            key={`v${i}`}
            worldValue={t.worldValue}
            screenPos={t.screenPos}
            isMajor={t.isMajor}
            orientation="v"
          />
        ))}
      </div>
      )}

      {/* 十字光标 — HTML 层，永远在 ruler 之上（之前在 PixiJS 画，被 rulers 遮住） */}
      {/* 左下角 zoom 控制条 —— 按 Spine 布局：[zoom in] → [slider] → [zoom out]，放大镜独立在最下面 */}
      <div
        className="absolute left-[28px] p-1 pointer-events-auto flex flex-col items-center gap-1 rounded"
        style={{
          // 纯半透明（去掉 backdrop-blur，否则会把画布棋盘格模糊成均匀暗色，看起来还是实心）
          background: 'rgba(31, 31, 31, 0.55)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          width: 26,
          // 动画 tab 时贴在时间轴（timelineHeight）上方 + 8px 间距
          bottom: editorTab === 'animate' ? timelineHeight + 8 : 8,
        }}
      >
        {/* zoom in（顶部）—— 纯 + 号 */}
        <IconButton title="zoom in">
          <line x1="3" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="8" y1="2" x2="8" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </IconButton>

        {/* slider（中间） */}
        <div
          style={{
            width: 26,
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <input
            type="range"
            className="zoom-slider-track"
            min="0.1"
            max="8"
            step="0.1"
            value={viewport.zoom}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setViewport({ ...viewport, zoom: v });
            }}
            style={{
              width: 60,
              height: 14,
              padding: 0,
              margin: 0,
              transform: 'rotate(-90deg)',
              transformOrigin: 'center',
            }}
          />
        </div>

        {/* zoom out（slider 下方）—— 纯 - 号 */}
        <IconButton title="zoom out">
          <line x1="3" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </IconButton>
      </div>

    {/* ruler 开关 —— 最顶部。zoom 顶在 120px，每个按钮高 16px，间距 12px。
        ruler: 120 + 16 + 12 + 16 + 12 = 176 */}
    <div
      className="absolute left-[33px] pointer-events-auto w-4"
      style={{
        // 动画 tab 时上移 timelineHeight（与 zoom 容器同步）
        bottom: editorTab === 'animate' ? 176 + timelineHeight : 176,
      }}
    >
      <IconButton
        title={showRulers ? 'hide rulers' : 'show rulers'}
        onClick={toggleRulers}
      >
        <rect x="1" y="3" width="14" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <line x1="4" y1="3" x2="4" y2="6" stroke="currentColor" strokeWidth="1" />
        <line x1="7" y1="3" x2="7" y2="6" stroke="currentColor" strokeWidth="1" />
        <line x1="10" y1="3" x2="10" y2="6" stroke="currentColor" strokeWidth="1" />
        <line x1="13" y1="3" x2="13" y2="6" stroke="currentColor" strokeWidth="1" />
      </IconButton>
    </div>

    {/* fit to content 按钮 —— 中间。zoom 顶在 120px，间距 12px。
        fit bottom = 120 + 16 + 12 = 148 */}
    <div
      className="absolute left-[33px] pointer-events-auto w-4"
      style={{
        // 动画 tab 时上移 timelineHeight（与 zoom 容器同步）
        bottom: editorTab === 'animate' ? 148 + timelineHeight : 148,
      }}
    >
      <IconButton
        title="fit to content"
        onClick={requestFitContent}
      >
        {/* fit-to-content 图标：四个箭头从中心向四角 —— 视觉宽度对齐 ruler (rect x=1 y=3 w=14 h=9) */}
        <rect x="1" y="3" width="14" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <path d="M2 6 L8 6 M2 6 L3 5 M2 6 L3 7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none" />
        <path d="M14 9 L8 9 M14 9 L13 8 M14 9 L13 10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none" />
        <path d="M14 6 L8 6 M14 6 L13 5 M14 6 L13 7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none" />
        <path d="M2 9 L8 9 M2 9 L3 8 M2 9 L3 10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none" />
      </IconButton>
    </div>

      {/* 网格编辑浮动面板（勾选「网格」+ 点「编辑网格」后出现） */}
      <MeshEditPanel />
    </div>
  );
}

// ============================================================
//  十字光标（HTML 层，z-index 在 rulers 之上）
// ============================================================
function Crosshair({
  render,
  canvasSize,
}: {
  render: { x: number; y: number; scale: number };
  canvasSize: { width: number; height: number };
}) {
  // rulers 现在都从 canvas 边缘 (0) 开始，十字直接对齐 render.x / render.y
  const cx = render.x;
  const cy = render.y;

  // 只有在画布可见区域才画
  if (cx < -10 || cx > canvasSize.width + 10 || cy < -10 || cy > canvasSize.height + 10) {
    return null;
  }

  return (
    <>
      {/* 横线 */}
      <div
        className="absolute"
        style={{
          left: 0,
          top: cy,
          width: canvasSize.width,
          height: 1,
          background: 'rgba(0,0,0,0.6)',
          pointerEvents: 'none',
        }}
      />
      {/* 竖线 */}
      <div
        className="absolute"
        style={{
          top: 0,
          left: cx,
          width: 1,
          height: canvasSize.height,
          background: 'rgba(0,0,0,0.6)',
          pointerEvents: 'none',
        }}
      />
      {/* 中心点 */}
      <div
        className="absolute"
        style={{
          top: cy - 2,
          left: cx - 2,
          width: 4,
          height: 4,
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.7)',
          pointerEvents: 'none',
        }}
      />
    </>
  );
}

// ============================================================
//  标尺刻度
// ============================================================
function RulerTick({
  worldValue,
  screenPos,
  isMajor,
  orientation,
}: {
  worldValue: number;
  screenPos: number;
  isMajor: boolean;
  orientation: 'h' | 'v';
}) {
  const tickLen = isMajor ? 8 : 4;
  const label = worldValue === 0 ? '0' : Math.round(worldValue).toString();

  if (orientation === 'h') {
    return (
      <div
        className="absolute"
        style={{ left: screenPos, bottom: 0, width: 1, height: '100%' }}
      >
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: 1,
            height: tickLen,
            background: 'var(--spine-text-dim)',
          }}
        />
        {isMajor && (
          <div
            style={{
              // Spine 风格：数字贴 ruler 底部（即 canvas 上边缘上方），
              // 数字中点正对刻度短线位置（translateX(-50%) + left:3 起点在刻度左缘）
              position: 'absolute',
              bottom: tickLen + 1,
              left: 3,
              fontSize: 9,
              fontWeight: 600,
              color: '#8e8c8cff',
              fontFamily: 'monospace',
              whiteSpace: 'nowrap',
              transform: 'translateX(-50%)',
              transformOrigin: 'left center',
            }}
          >
            {label}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className="absolute"
      style={{ top: screenPos, right: 0, width: '100%', height: 1 }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: tickLen,
          height: 1,
          background: 'var(--spine-text-dim)',
        }}
      />
      {isMajor && (
        <div
          style={{
            // Spine 风格：数字旋转 -90°、竖排、白字粗体。
            // 外层 div 高度只有 1px（短线），需要让文字中心 = 短线水平位置 = screenPos + 0.5px。
            // ruler 22px 宽，让所有数字（不管 1字符还是 4字符）都在 ruler 水平中线：
            //   right: 11px (= ruler 中线)
            //   transformOrigin: right center + translateY(-50%) + rotate(-90deg)
            // 旋转后所有数字水平居中到 ruler 中线，垂直对齐到对应短线。
            position: 'absolute',
            right: 16,
            top: -4,
            fontSize: 9,
            fontWeight: 600,
            color: '#8e8c8cff',
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
            transform: 'translateY(-50%) rotate(-90deg)',
            transformOrigin: 'right center',
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

// ============================================================
//  工具函数
// ============================================================
interface TickInfo {
  worldValue: number;
  screenPos: number;
  isMajor: boolean;
}

/** 生成屏幕可见范围内的标尺刻度（自动适配 zoom） */
function generateTicks(
  renderOrigin: number,
  scale: number,
  canvasSize: number,
  orientation: 'h' | 'v',
  invertAxis: boolean = false,
): TickInfo[] {
  if (scale <= 0) return [];

  const targetMajorScreen = 80;
  const baseWorldMajor = targetMajorScreen / scale;
  const majorStep = niceNumber(baseWorldMajor);
  const minorStep = majorStep / 5;

  // Y 轴反转时：worldValue +（数学向上）→ screenPos 减小（屏幕上移）
  //   screenPos = renderOrigin - roundedV * scale
  // X 轴不反转：worldValue + → screenPos +
  //   screenPos = renderOrigin + roundedV * scale
  const invert = invertAxis;
  const sign = invert ? -1 : 1;

  // 计算屏幕 [0, canvasSize] 对应的 worldValue 范围，保证 start <= end
  // sign=1:  screen=0 对应 worldA=(0-renderOrigin)/scale, screen=canvasSize 对应 worldB=(canvasSize-renderOrigin)/scale
  // sign=-1: screen=0 对应 worldA=(renderOrigin-0)/scale, screen=canvasSize 对应 worldB=(renderOrigin-canvasSize)/scale
  const worldA0 = (0 - renderOrigin) / scale * sign;
  const worldB0 = (canvasSize - renderOrigin) / scale * sign;
  const worldLo = Math.min(worldA0, worldB0);
  const worldHi = Math.max(worldA0, worldB0);

  const start = Math.floor(worldLo / majorStep) * majorStep - majorStep;
  const end = Math.ceil(worldHi / majorStep) * majorStep + majorStep;

  const ticks: TickInfo[] = [];
  for (let v = start; v <= end + 0.001; v += minorStep) {
    const roundedV = Math.round(v / minorStep) * minorStep;
    // Y 反转：worldValue + → screenPos -（用减号）
    // X 不反转：worldValue + → screenPos +（用加号）
    const screenPos = renderOrigin + roundedV * scale * sign;
    if (screenPos < -20 || screenPos > canvasSize + 20) continue;
    const isMajor = Math.abs(roundedV - Math.round(roundedV / majorStep) * majorStep) < minorStep / 2;
    ticks.push({ worldValue: roundedV, screenPos, isMajor });
  }
  return ticks;
}

/** 选最接近 base 的"漂亮"数 (1/2/5 × 10^n) */
function niceNumber(base: number): number {
  if (base <= 0) return 1;
  const exp = Math.floor(Math.log10(base));
  const frac = base / Math.pow(10, exp);
  let nice: number;
  if (frac < 1.5) nice = 1;
  else if (frac < 3) nice = 2;
  else if (frac < 7) nice = 5;
  else nice = 10;
  return nice * Math.pow(10, exp);
}

function IconButton({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex items-center justify-center"
      style={{
        width: 16,
        height: 16,
        color: 'var(--spine-text)',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <svg width="16" height="16" viewBox="0 0 18 14" fill="currentColor">
        {children}
      </svg>
    </button>
  );
}

function SmallBtn({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <button
      title={title}
      className="flex items-center justify-center"
      style={{
        width: 11,
        height: 14,
        color: 'var(--spine-text)',
        background: 'var(--spine-bg-panel-dark)',
        border: '1px solid var(--spine-border)',
        cursor: 'pointer',
        fontSize: 11,
        padding: 0,
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

// =================================================================================
//  编辑器 tab 切换：装配（设置）/ 动画 —— Sp  ine 风格
//   - 左上角浮在 ruler 之上（pointer-events-auto）
//   - 两个 tab：设置（双臂伸展小人）+ 动画（跑步小人）
//   - 当前 tab 文字加粗
// =================================================================================
function EditorTabSwitch({
  active, onChange, t,
}: {
  active: 'setup' | 'animate';
  onChange: (v: 'setup' | 'animate') => void;
  t: (k: string) => string;
}) {
  return (
    <div
      className="absolute flex pointer-events-auto"
      style={{ top: 28, left: 28, zIndex: 5, gap: 6 }}
    >
      <TabButton active={active === 'setup'} onClick={() => onChange('setup')}>
        <IconPersonSetup />
        <span style={{ fontWeight: active === 'setup' ? 700 : 400 }}>{t('tab.setup')}</span>
      </TabButton>
      <TabButton active={active === 'animate'} onClick={() => onChange('animate')}>
        <IconPersonRun />
        <span style={{ fontWeight: active === 'animate' ? 700 : 400 }}>{t('tab.animate')}</span>
      </TabButton>
    </div>
  );
}

function TabButton({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center"
      style={{
        gap: 6,
        padding: '4px 8px',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: active ? 'var(--spine-text)' : 'var(--spine-text-dim)',
        fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}

// 双臂伸展小人（setup tab icon）
function IconPersonSetup() {
  return (
    <svg width="18" height="22" viewBox="0 0 18 22" fill="currentColor">
      {/* 头 */}
      <circle cx="9" cy="3" r="1.8" />
      {/* 身体 */}
      <path d="M9 5 L9 14" stroke="currentColor" strokeWidth="1.6" fill="none" />
      {/* 双臂伸展 */}
      <path d="M9 8 L1 5 M9 5 L17 5 M9 8 L1 11 M9 8 L17 11" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      {/* 双腿 */}
      <path d="M9 14 L5 20 M9 14 L13 20" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// 跑步姿态小人（animate tab icon）
function IconPersonRun() {
  return (
    <svg width="20" height="22" viewBox="0 0 20 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      {/* 头 */}
      <circle cx="12" cy="3" r="1.8" fill="currentColor" stroke="none" />
      {/* 躯干前倾 */}
      <path d="M12 4 L7 11" />
      {/* 前后摆臂 */}
      <path d="M9 6 L4 4 M9 6 L14 9" />
      {/* 跑步跨腿 */}
      <path d="M7 11 L4 18 M7 11 L11 17" />
    </svg>
  );
}

// =================================================================================
//  网格编辑浮动面板（仿 Spine 的「编辑网格」）
//    工具：修改（拖顶点 / 双击删除 / 空白框选）、创建（点边细分 / 点三角形加点）、删除（点顶点删除）
//    开关：三角形（显示三角剖分）、变形；底部显示顶点数。生成/吸附/克隆为占位（待实现）。
// =================================================================================
function MeshEditPanel() {
  const editSlotId = usePixiBonesStore((s) => s.meshEditSlotId);
  const setMeshEditSlot = usePixiBonesStore((s) => s.setMeshEditSlot);
  const meshTool = usePixiBonesStore((s) => s.meshTool);
  const setMeshTool = usePixiBonesStore((s) => s.setMeshTool);
  const showTriangles = usePixiBonesStore((s) => s.meshShowTriangles);
  const setShowTriangles = usePixiBonesStore((s) => s.setMeshShowTriangles);
  const deformed = usePixiBonesStore((s) => s.meshDeformed);
  const setDeformed = usePixiBonesStore((s) => s.setMeshDeformed);
  const dim = usePixiBonesStore((s) => s.meshDim);
  const setDim = usePixiBonesStore((s) => s.setMeshDim);
  const isolate = usePixiBonesStore((s) => s.meshIsolate);
  const setIsolate = usePixiBonesStore((s) => s.setMeshIsolate);
  const resetMesh = usePixiBonesStore((s) => s.resetMesh);
  const setTraceDialogOpen = usePixiBonesStore((s) => s.setTraceDialogOpen);
  /** 描绘弹窗是否打开 → 本面板向下渐隐让位 */
  const traceOpen = usePixiBonesStore((s) => s.traceDialogOpen);
  const newPolygon = usePixiBonesStore((s) => s.meshNewPolygon);
  const setNewPolygon = usePixiBonesStore((s) => s.setMeshNewPolygon);
  const slots = usePixiBonesStore((s) => s.slots);
  const meshes = usePixiBonesStore((s) => s.attachmentMeshes);

  if (!editSlotId) return null;
  const slot = slots.find((s) => s.id === editSlotId) ?? null;
  const attachmentId = slot?.activeAttachmentId ?? null;
  const mesh = attachmentId ? meshes[attachmentId] ?? null : null;
  if (!slot || !attachmentId || !mesh) return null;
  const vertexCount = Math.floor(mesh.vertices.length / 2);

  /** 面板里的小按钮（仿 Spine：中灰底、激活蓝底、图标 + 文字） */
  const meshBtnStyle = (active: boolean, disabled: boolean) => ({
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: 3,
    padding: '3px 7px',
    borderRadius: 3,
    border: '1px solid ' + (active ? '#2E7FC0' : '#555555'),
    background: active ? '#2E8BD8' : '#4A4A4A',
    color: active ? '#FFFFFF' : (disabled ? 'var(--spine-text-dim)' : '#DDDDDD'),
    fontSize: 11,
    lineHeight: '14px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap' as const,
    userSelect: 'none' as const,
  });

  /** 行内的 checkbox + 文字（三角形 / 变暗 / 隔离 / 变形） */
  const meshCheck: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: 'var(--spine-text)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };

  return (
    <div
      className="absolute pointer-events-auto"
      style={{
        left: '50%',
        // 描绘弹窗打开时：本面板向下渐隐 + 缩小，让位给底部的描绘面板（仿 Spine）
        transform: traceOpen
          ? 'translateX(-50%) translateY(110px) scale(0.86)'
          : 'translateX(-50%)',
        transformOrigin: 'bottom center',
        opacity: traceOpen ? 0 : 1,
        pointerEvents: traceOpen ? 'none' : 'auto',
        transition: 'transform 0.24s ease, opacity 0.24s ease',
        bottom: 12,
        background: 'var(--spine-bg-panel)',
        border: '1px solid var(--spine-border)',
        borderRadius: 4,
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.55)',
        zIndex: 30,
        overflow: 'hidden',
      }}
    >
      {/* 标题栏：编辑网格 + 退出（深色底） */}
      <div
        className="flex items-center"
        style={{
          background: 'var(--spine-bg-panel-dark)',
          padding: '4px 6px 4px 10px',
          borderBottom: '1px solid var(--spine-border)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--spine-text)' }}>编辑网格</span>
        <button
          style={{
            marginLeft: 16, background: 'transparent', border: 'none',
            color: 'var(--spine-text)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px',
          }}
          title="退出网格编辑（Esc）"
          onClick={() => setMeshEditSlot(null)}
        >✕</button>
      </div>

      {/* 内容区 */}
      <div style={{ padding: '6px 8px' }}>
        {/* 行 1：三个编辑工具 */}
        <div className="flex items-center justify-center" style={{ gap: 4, marginBottom: 5 }}>
          <button
            style={meshBtnStyle(meshTool === 'modify', false)}
            title="修改：拖动顶点；双击顶点删除；空白处拖动框选"
            onClick={() => setMeshTool('modify')}
          ><MeshIconModify />修改</button>
          <button
            style={meshBtnStyle(meshTool === 'create', false)}
            title="创建：点边的中点细分该边；点三角形内部加顶点"
            onClick={() => setMeshTool('create')}
          ><MeshIconCreate />创建</button>
          <button
            style={meshBtnStyle(meshTool === 'delete', false)}
            title="删除：点击顶点删除（顶点塌陷，网格保持封闭）"
            onClick={() => setMeshTool('delete')}
          ><MeshIconDelete />删除</button>
        </div>

        {/* 行 2：新建 / 重置 / 生成 / 描绘 */}
        <div className="flex items-center justify-center" style={{ gap: 4, marginBottom: 5 }}>
          <button
            style={meshBtnStyle(!!newPolygon, false)}
            title={newPolygon
              ? '取消描绘（Esc）'
              : '新建：在图上逐点描绘轮廓，点回起点闭合（图片裁到轮廓内）'}
            onClick={() => setNewPolygon(newPolygon ? null : [])}
          ><MeshIconNew />新建</button>
          <button
            style={meshBtnStyle(false, false)}
            title="把顶点移回 UV 位置，消除变形"
            onClick={() => resetMesh(attachmentId)}
          ><MeshIconReset />重置</button>
          <button
            style={meshBtnStyle(false, true)}
            title="自动补充顶点（待实现）"
            disabled
          ><MeshIconGenerate />生成</button>
          <button
            style={meshBtnStyle(false, false)}
            title="描绘：弹出参数对话框（细节/凹度/精致度/统一/Alpha 阈值）"
            onClick={() => setTraceDialogOpen(true)}
          ><MeshIconTrace />描绘</button>
        </div>

        {/* 行 3：三角形 / 变暗 / 隔离 */}
        <div className="flex items-center justify-center" style={{ gap: 10, marginBottom: 4 }}>
          <label style={meshCheck} title="显示三角剖分">
            <input
              type="checkbox"
              checked={showTriangles}
              onChange={(e) => setShowTriangles(e.target.checked)}
              style={{ accentColor: 'var(--spine-accent)' }}
            />
            三角形
          </label>
          <label style={{ ...meshCheck, opacity: 0.6 }} title="变暗（待实现）">
            <input
              type="checkbox"
              checked={dim}
              onChange={(e) => setDim(e.target.checked)}
              style={{ accentColor: 'var(--spine-accent)' }}
            />
            变暗
          </label>
          <label style={{ ...meshCheck, opacity: 0.6 }} title="隔离（待实现）">
            <input
              type="checkbox"
              checked={isolate}
              onChange={(e) => setIsolate(e.target.checked)}
              style={{ accentColor: 'var(--spine-accent)' }}
            />
            隔离
          </label>
        </div>

        {/* 行 4：顶点数 + 变形 */}
        <div className="flex items-center justify-center" style={{ gap: 12 }}>
          <span style={{ fontSize: 11, color: 'var(--spine-text)' }}>顶点: {vertexCount}</span>
          <label style={meshCheck} title="勾选：编辑时也套用网格（预览裁切/变形）；不勾选：显示完整原图，只编辑顶点">
            <input
              type="checkbox"
              checked={deformed}
              onChange={(e) => setDeformed(e.target.checked)}
              style={{ accentColor: 'var(--spine-accent)' }}
            />
            变形
          </label>
        </div>
      </div>

      {/* 描绘参数对话框（仿 Spine 的 Trace Settings） */}
      <TraceDialog />
    </div>
  );
}

// =================================================================================
//  描绘参数对话框（仿 Spine 的 Trace Settings 弹窗）
//    5 个滑块：细节 / 凹度 / 精致度 / 统一 / Alpha 阈值 + 填充
//    「实时」调整 → 调 store 即可，BoneEditor 订阅后会实时算出顶点数显示
//    「确定」→ 写入网格 + 入历史；「取消」→ 仅关闭弹窗
// =================================================================================
const traceBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5,
  height: 26, padding: '0 12px', borderRadius: 3,
  border: '1px solid #5a5a5a',
  background: '#3a3a3a',
  color: '#e6e6e6', fontSize: 13, cursor: 'pointer',
};

/**
 * 描绘弹窗的尺寸与配色（集中在这里改，方便对齐 Spine 截图）。
 */
const TDIALOG = {
  W: 560,
  TITLE_H: 30,
  ROW_H: 26,
  FOOTER_H: 46,
  PAD_H: 14,
  PAD_V: 10,
  FIELD_W: 150,        // 常规「名称 + 数值」框宽
  FIELD_W_LONG: 150,   // Alpha阈值（名字长）
  FIELD_W_SHORT: 96,   // 填充
  SLIDER_S: 92,        // 填充那根短滑条
  BG: '#303032',
  TITLE_BG: '#3f3f3f',
  FIELD_BG: '#363638',
  BORDER: '#4d4d4d',
  TEXT: '#dcdcdc',
  VALUE: '#f0f0f0',
  /** 滑条两段式配色：左 = 已选（灰蓝），右 = 剩余（近黑） */
  FILL: '#93a6ae',
  REST: '#0f0f0f',
  track: (v: number, min: number, max: number): React.CSSProperties => {
    const pct = Math.max(0, Math.min(1, (v - min) / (max - min))) * 100;
    return {
      height: TDIALOG.ROW_H,
      borderRadius: 3,
      border: `1px solid ${TDIALOG.BORDER}`,
      // flex 子项默认 min-width:auto（等于 input 的固有最小宽度），会撑破容器 → 必须归零
      minWidth: 0,
      background: `linear-gradient(to right, ${TDIALOG.FILL} 0 ${pct}%, ${TDIALOG.REST} ${pct}% 100%)`,
    };
  },
};

/** 弹窗里的一行参数（水平排列：方框 + 滑条，可多组） */
function TDRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center" style={{ height: TDIALOG.ROW_H, margin: '5px 0', gap: 10 }}>
      {children}
    </div>
  );
}

/** 描绘按钮里的小画笔图标 */
function TraceIconBrush() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2 11.5 C4 6, 7 4, 12 3.5" stroke="#8FC7E8" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M3 12.4 L4 9.6 L2.2 9.6 L2.6 11 L1.6 11.6 L3 12.4 Z" fill="#8FC7E8" />
    </svg>
  );
}
/** 调整按钮里的小循环箭头 */
function TraceIconAdjust() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M12 7 A5 5 0 1 1 10.2 3.2" stroke="#5BBE5D" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M10.6 1.2 L11.4 4.2 L8.4 4.4" stroke="#5BBE5D" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
/** 取消按钮：红圈 + 白斜杠 */
function TraceIconCancel() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
      <circle cx="7.5" cy="7.5" r="6.4" fill="#C0392B" />
      <path d="M4.6 4.6 L10.4 10.4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
/** 确定按钮：绿圈 + 白勾 */
function TraceIconConfirm() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
      <circle cx="7.5" cy="7.5" r="6.4" fill="#4CAF50" />
      <path d="M4.3 7.7 L6.6 10 L10.7 5.4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function TraceDialog() {
  const open = usePixiBonesStore((s) => s.traceDialogOpen);
  const setOpen = usePixiBonesStore((s) => s.setTraceDialogOpen);
  const detail        = usePixiBonesStore((s) => s.traceDetail);
  const concavity     = usePixiBonesStore((s) => s.traceConcavity);
  const refinement    = usePixiBonesStore((s) => s.traceRefinement);
  const merge         = usePixiBonesStore((s) => s.traceMerge);
  const alphaThr      = usePixiBonesStore((s) => s.traceAlphaThreshold);
  const padding       = usePixiBonesStore((s) => s.tracePadding);
  const vertexCount   = usePixiBonesStore((s) => s.traceVertexCount);
  const meshEditSlot  = usePixiBonesStore((s) => s.meshEditSlotId);
  const setDetail     = usePixiBonesStore((s) => s.setTraceDetail);
  const setConcavity  = usePixiBonesStore((s) => s.setTraceConcavity);
  const setRefinement = usePixiBonesStore((s) => s.setTraceRefinement);
  const setMerge      = usePixiBonesStore((s) => s.setTraceMerge);
  const setAlpha      = usePixiBonesStore((s) => s.setTraceAlphaThreshold);
  const setPadding    = usePixiBonesStore((s) => s.setTracePadding);
  const requestTrace  = usePixiBonesStore((s) => s.requestTrace);
  const apply         = usePixiBonesStore((s) => s.applyTraceWithDialogSettings);
  const setVertexCount= usePixiBonesStore((s) => s.setTraceVertexCount);

  if (!open) return null;

  /** 参数行左侧的「名称 + 数值」方框（仿 Spine：和滑条同高、同款描边） */
  const field = (lbl: string, v: string | number, w: number) => (
    <div
      className="flex items-center"
      style={{
        width: w, height: TDIALOG.ROW_H, flex: 'none',
        border: `1px solid ${TDIALOG.BORDER}`, borderRadius: 3,
        background: TDIALOG.FIELD_BG, padding: '0 8px',
      }}
    >
      <span style={{ fontSize: 13, color: TDIALOG.TEXT }}>{lbl}</span>
      <span style={{ marginLeft: 'auto', fontSize: 13, color: TDIALOG.VALUE }}>{v}</span>
    </div>
  );

  const slider = (
    v: number, setV: (n: number) => void, min: number, max: number, step: number,
    extra?: React.CSSProperties,
  ) => (
    <input
      type="range" className="trace-slider"
      min={min} max={max} step={step} value={v}
      onChange={(e) => setV(parseFloat(e.target.value))}
      onMouseUp={() => requestTrace()}   // 松开后按当前参数实时重算
      style={{ ...TDIALOG.track(v, min, max), ...extra }}
    />
  );

  // ★ 必须 portal 到 body：本组件挂在 MeshEditPanel 里，而它的祖先有 transform，
  //   会让 position:fixed 相对该祖先定位（对话框跑到面板里、底栏被挤出视口）。
  //   portal 到 body 后 fixed 才真正相对视口定位。
  // ★ 停靠在**屏幕下方居中**（和「编辑网格」面板同一位置），并「从中间往两侧生长」。
  return createPortal((
    <div
      // 外层负责定位：铺满视口底部、flex 居中（不用 translate，方便内层做 scaleX 生长动画）
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 12,
        display: 'flex', justifyContent: 'center', alignItems: 'flex-end',
        zIndex: 200, pointerEvents: 'none',
      }}
    >
      <div
        role="dialog" aria-label="编辑网格：描绘"
        className="trace-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: TDIALOG.W, pointerEvents: 'auto',
          background: TDIALOG.BG,
          border: '1px solid #1b1b1b', borderRadius: 5,
          boxShadow: '0 12px 32px rgba(0,0,0,0.62)',
          padding: 0, color: TDIALOG.TEXT, userSelect: 'none',
        }}
      >
      {/* 标题栏 */}
      <div
        className="flex items-center"
        style={{
          height: TDIALOG.TITLE_H, background: TDIALOG.TITLE_BG,
          padding: '0 10px 0 14px', borderBottom: '1px solid #262626',
          borderTopLeftRadius: 5, borderTopRightRadius: 5,
        }}
      >
        <span style={{ fontSize: 13.5, fontWeight: 500 }}>编辑网格: 描绘</span>
        <button
          type="button" title="关闭（取消）"
          onClick={() => { setVertexCount(0); setOpen(false); }}
          style={{
            marginLeft: 'auto', background: 'transparent', border: 'none',
            color: '#b9b9b9', cursor: 'pointer', fontSize: 17, lineHeight: 1, padding: 0,
          }}
        >✕</button>
      </div>

      {/* 参数行 */}
      <div style={{ padding: `${TDIALOG.PAD_V}px ${TDIALOG.PAD_H}px 2px` }}>
        <TDRow>
          {field('细节', detail, TDIALOG.FIELD_W)}
          {slider(detail, setDetail, 1, 100, 1, { flex: 1 })}
        </TDRow>
        <TDRow>
          {field('凹度', concavity, TDIALOG.FIELD_W)}
          {slider(concavity, setConcavity, 1, 100, 1, { flex: 1 })}
        </TDRow>
        <TDRow>
          {field('精致度', refinement, TDIALOG.FIELD_W)}
          {slider(refinement, setRefinement, 1, 100, 1, { flex: 1 })}
        </TDRow>
        <TDRow>
          {field('统一', merge, TDIALOG.FIELD_W)}
          {slider(merge, setMerge, 0, 1, 0.01, { flex: 1 })}
        </TDRow>
        {/* 最后一行两组：Alpha阈值 + 填充 */}
        <TDRow>
          {field('Alpha阈值', alphaThr, TDIALOG.FIELD_W_LONG)}
          {slider(alphaThr, setAlpha, 0, 255, 1, { flex: 1 })}
          {field('填充', padding, TDIALOG.FIELD_W_SHORT)}
          {slider(padding, setPadding, 0, 32, 1, { width: TDIALOG.SLIDER_S })}
        </TDRow>
      </div>

      {/* 底部：左侧「描绘 / 调整」+ 顶点数，右侧「取消 / 确定」 */}
      <div
        className="flex items-center"
        style={{
          height: TDIALOG.FOOTER_H, padding: `0 ${TDIALOG.PAD_H}px`,
          borderTop: '1px solid #262626', marginTop: 6,
        }}
      >
        <button type="button"
          title="按当前参数重新描绘（实时刷新）"
          onClick={() => { if (meshEditSlot) requestTrace(); }}
          style={traceBtnStyle}
        ><TraceIconBrush />描绘</button>
        <button type="button" title="调整（占位）" disabled
          style={{ ...traceBtnStyle, marginLeft: 6, opacity: 0.55, cursor: 'not-allowed' }}
        ><TraceIconAdjust />调整</button>
        <span style={{ marginLeft: 18, fontSize: 13, color: TDIALOG.TEXT }}>顶点: {vertexCount}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" title="取消（不写入网格）"
            onClick={() => { setVertexCount(0); setOpen(false); }}
            style={traceBtnStyle}
          ><TraceIconCancel />取消</button>
          <button type="button" title="应用当前参数到网格"
            onClick={() => { if (meshEditSlot) apply(); }}
            style={traceBtnStyle}
          ><TraceIconConfirm />确定</button>
        </div>
      </div>
      </div>
    </div>
  ), document.body);
}

// ---- 「编辑网格」面板的小图标（几何风格，颜色对齐 Spine）----

function MeshIconModify() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="8.5" height="8.5" rx="1" stroke="#4FB8F8" strokeWidth="1.4" />
      <path
        d="M7.5 7.5 L12.6 12.6 M12.6 9 L12.6 12.6 L9 12.6"
        stroke="#4FB8F8" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function MeshIconCreate() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="3" y="3" width="8" height="8" stroke="#5BBE5D" strokeWidth="1.2" />
      <rect x="1" y="1" width="2.8" height="2.8" fill="#5BBE5D" />
      <rect x="10.2" y="1" width="2.8" height="2.8" fill="#5BBE5D" />
      <rect x="1" y="10.2" width="2.8" height="2.8" fill="#5BBE5D" />
      <rect x="10.2" y="10.2" width="2.8" height="2.8" fill="#5BBE5D" />
    </svg>
  );
}

function MeshIconDelete() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="3" y="3" width="8" height="8" stroke="#E61E1E" strokeWidth="1.2" />
      <rect x="1" y="1" width="2.8" height="2.8" fill="#E61E1E" />
      <rect x="10.2" y="1" width="2.8" height="2.8" fill="#E61E1E" />
      <rect x="1" y="10.2" width="2.8" height="2.8" fill="#E61E1E" />
      <rect x="10.2" y="10.2" width="2.8" height="2.8" fill="#E61E1E" />
    </svg>
  );
}

function MeshIconNew() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2.5 1.5 L2.5 11 L5.3 8.4 L7.2 12.4 L8.9 11.5 L7 7.6 L10.8 7.6 Z"
        fill="#BBBBBB" stroke="#888888" strokeWidth="0.6" strokeLinejoin="round"
      />
      <path d="M11.6 1.6 L11.6 6 M9.4 3.8 L13.8 3.8" stroke="#5BBE5D" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MeshIconReset() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2.4 7.2 A4.6 4.6 0 1 1 4.6 11.2"
        stroke="#F0A020" strokeWidth="1.6" strokeLinecap="round" fill="none"
      />
      <path
        d="M2.2 3.6 L2.4 7.4 L6.2 7.2"
        stroke="#F0A020" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
    </svg>
  );
}

function MeshIconGenerate() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="3" y="3" width="8" height="8" stroke="#5BBE5D" strokeWidth="1.2" />
      <rect x="1" y="1" width="2.6" height="2.6" fill="#5BBE5D" />
      <rect x="10.4" y="1" width="2.6" height="2.6" fill="#5BBE5D" />
      <rect x="1" y="10.4" width="2.6" height="2.6" fill="#5BBE5D" />
      <rect x="10.4" y="10.4" width="2.6" height="2.6" fill="#5BBE5D" />
      <circle cx="7" cy="7" r="1.5" fill="#5BBE5D" />
    </svg>
  );
}

function MeshIconTrace() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M1.8 11.4 C3.2 5.6, 6.2 2.4, 12.2 3.2"
        stroke="#4FB8F8" strokeWidth="1.5" strokeLinecap="round" fill="none"
      />
      <circle cx="1.9" cy="11.4" r="1.5" fill="#4FB8F8" />
    </svg>
  );
}
