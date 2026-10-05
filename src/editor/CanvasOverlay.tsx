import { useEffect, useMemo, useRef, useState } from 'react';
import { usePixiBonesStore } from './store';

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
        className="absolute left-[28px] bottom-2 p-1 pointer-events-auto flex flex-col items-center gap-1 rounded"
        style={{
          // 纯半透明（去掉 backdrop-blur，否则会把画布棋盘格模糊成均匀暗色，看起来还是实心）
          background: 'rgba(31, 31, 31, 0.55)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          width: 26,
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
            max="16"
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
        bottom: 176,
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
        bottom: 148,
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
