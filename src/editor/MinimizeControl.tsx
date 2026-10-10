import { useEffect, useRef, useState } from 'react';

/**
 * 通用「最小化控件」—— 给任意右侧停靠面板右上角挂一个 ☰ 按钮（仿 Spine）。
 *
 * 行为：
 *   - 单击 ☰  → 打开小弹层：最小化 / 关闭（+ 提示）
 *   - 右键 ☰  → 直接最小化（dispatch 'panel:minimize'，由上层面板监听并处理动画）
 *   - 双击 ☰  → 直接关闭面板（dispatch 'panel:close'）
 *
 * 监听方约定（HierarchyPanel / MeshToolsPanel / WeightsPanel）：
 *   window.addEventListener('panel:minimize', (e) => {
 *     if (e.detail.panelKey !== 'hierarchy') return;
 *     // 自己的最小化逻辑（动画 + 卸载/折叠）
 *   });
 *
 * Header 里的"被最小化图标"按钮也通过 panelKey 区分，每个面板独立一个，
 * 详见 MinimizedIcon 组件。
 */
export type MinimizeControlPanelKey = 'hierarchy' | 'grid_tool' | 'weights';

interface MinimizeControlProps {
  panelKey: MinimizeControlPanelKey;
}

/** 触发"最小化该面板"事件。调用方可以直接用，不需要 import 自定义事件常量。 */
export function emitMinimize(panelKey: MinimizeControlPanelKey) {
  window.dispatchEvent(new CustomEvent('panel:minimize', { detail: { panelKey } }));
}

/** 触发"关闭该面板"事件。 */
export function emitClose(panelKey: MinimizeControlPanelKey) {
  window.dispatchEvent(new CustomEvent('panel:close', { detail: { panelKey } }));
}

export function MinimizeControl({ panelKey }: MinimizeControlProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const C = {
    panel: 'var(--spine-bg-panel)',
    border: 'var(--spine-border)',
    text: 'var(--spine-text)',
    dim: 'var(--spine-text-dim)',
    accent: 'var(--spine-accent)',
  };

  // 点击外部关弹层
  useEffect(() => {
    if (!popoverOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPopoverOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [popoverOpen]);

  return (
    <div ref={wrapRef} className="relative" style={{ display: 'flex', alignItems: 'center', height: '100%', marginLeft: 'auto' }}>
      <button
        type="button"
        title="面板选项"
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: popoverOpen ? '#fff' : C.dim,
          background: 'transparent',
          border: 'none',
          padding: '0 2px',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
        onMouseLeave={(e) => { if (!popoverOpen) e.currentTarget.style.color = C.dim; }}
        onClick={() => setPopoverOpen((v) => !v)}
        onContextMenu={(e) => {
          e.preventDefault();
          emitMinimize(panelKey);
          setPopoverOpen(false);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          emitClose(panelKey);
        }}
      >
        <svg width="12" height="9" viewBox="0 0 14 10" fill="none">
          <path d="M1 1 H13 M1 5 H13 M1 9 H13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"/>
        </svg>
      </button>
      {popoverOpen && (
        <div
          className="absolute z-50 shadow-xl"
          style={{
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 180,
            background: C.panel as string,
            border: '1px solid ' + (C.border as string),
            borderRadius: 4,
            padding: '2px 0',
          }}
        >
          <button
            className="w-full flex items-center justify-between"
            style={{ height: 22, padding: '0 10px', background: 'transparent', border: 'none', color: C.text as string, fontSize: 13, cursor: 'pointer', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={() => { emitMinimize(panelKey); setPopoverOpen(false); }}
          >
            <span style={{ color: C.accent as string, fontWeight: 600 }}>最小化</span>
            <span style={{ color: C.dim as string, fontSize: 12 }}>右键单击</span>
          </button>
          <button
            className="w-full flex items-center justify-between"
            style={{ height: 22, padding: '0 10px', background: 'transparent', border: 'none', color: C.text as string, fontSize: 12, cursor: 'pointer', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={() => { emitClose(panelKey); setPopoverOpen(false); }}
          >
            <span>关闭</span>
            <span style={{ color: C.dim as string, fontSize: 12 }}>双击</span>
          </button>
        </div>
      )}
    </div>
  );
}

// =================================================================================
//  Header 里的"被最小化的面板图标"
//  每个 panelKey 一个，对齐 Spine 的"视图图标条"
//  点击后让对应面板从图标位置展开回正常状态
// =================================================================================

interface MinimizedIconProps {
  panelKey: MinimizeControlPanelKey;
  /** 显示图标（不同面板不同） */
  paths: JSX.Element;
  /** 图标主色 */
  color: string;
  /** 点击回调：通常设置 store 的 restorePending 标记 */
  onClick: () => void;
}

export function MinimizedIcon({ panelKey, paths, color, onClick }: MinimizedIconProps) {
  return (
    <button
      data-minimize-icon={panelKey}
      className="spine-btn-icon"
      onClick={onClick}
      title="恢复面板"
      style={{ padding: 0, overflow: 'hidden' }}
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" style={{ display: 'block', color }}>
        <rect x="0" y="0" width="20" height="20" rx="3" fill="var(--spine-accent-dim, #1A6395)" />
        {paths}
      </svg>
    </button>
  );
}

// =================================================================================
//  每个面板对应图标的 SVG path 集合（统一管理方便以后复用）
// =================================================================================

export const PANEL_ICONS: Record<MinimizeControlPanelKey, { color: string; paths: JSX.Element }> = {
  hierarchy: {
    color: '#F0A020',
    paths: (
      <>
        <path d="M3 4 H7 V10 H13 V16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" fill="none"/>
        <circle cx="13" cy="16" r="1.6" fill="currentColor"/>
        <path d="M9 4 H17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" fill="none"/>
      </>
    ),
  },
  grid_tool: {
    color: '#7DD3A0',
    paths: (
      <>
        <rect x="3" y="3" width="6" height="6" stroke="currentColor" strokeWidth="1.4" fill="none"/>
        <rect x="11" y="3" width="6" height="6" stroke="currentColor" strokeWidth="1.4" fill="none"/>
        <rect x="3" y="11" width="6" height="6" stroke="currentColor" strokeWidth="1.4" fill="none"/>
        <rect x="11" y="11" width="6" height="6" stroke="currentColor" strokeWidth="1.4" fill="none"/>
      </>
    ),
  },
  weights: {
    color: '#A8B0F0',
    paths: (
      <>
        <path d="M2 14 L7 9 L10 12 L5 17 Z" fill="currentColor"/>
        <path d="M8 8 L11 5 L14 8 L11 11 Z" fill="currentColor"/>
      </>
    ),
  },
};
