import { useEffect, useRef, useState } from 'react';
import { usePixiBonesStore } from './store';
import { useT } from './i18n';
import viewsIcon from './icons/views.png';

/**
 * header 右上角"视图"按钮下的下拉菜单
 *   - 11 个 toggle 项（Spine 视图风格：emoji + 名称 + Opt+快捷键）
 *   - 第 6 项（层级树）后插入一条分隔线
 *   - 点击外部 / Esc 关闭
 *
 * 依赖：
 *   - store.viewXxx / toggleViewXxx  各项开关
 *   - i18n.view_menu.<key>.{zh,en,sc}
 */
export function ViewMenu() {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { t } = useT();

  // store
  const viewAllHidden      = usePixiBonesStore((s) => s.viewAllHidden);
  const viewWeights        = usePixiBonesStore((s) => s.viewWeights);
  const viewSkin           = usePixiBonesStore((s) => s.viewSkin);
  const viewGridTool       = usePixiBonesStore((s) => s.viewGridTool);
  const viewColor          = usePixiBonesStore((s) => s.viewColor);
  const viewAnimation      = usePixiBonesStore((s) => s.viewAnimation);
  const viewHierarchy      = usePixiBonesStore((s) => s.viewHierarchy);
  const viewIndicators     = usePixiBonesStore((s) => s.viewIndicators);
  const viewOutline        = usePixiBonesStore((s) => s.viewOutline);
  const viewIssues         = usePixiBonesStore((s) => s.viewIssues);
  const viewPreview        = usePixiBonesStore((s) => s.viewPreview);
  const toggleViewWeights  = usePixiBonesStore((s) => s.toggleViewWeights);
  const toggleViewSkin     = usePixiBonesStore((s) => s.toggleViewSkin);
  const toggleViewGridTool = usePixiBonesStore((s) => s.toggleViewGridTool);
  const toggleViewColor    = usePixiBonesStore((s) => s.toggleViewColor);
  const toggleViewAnimation= usePixiBonesStore((s) => s.toggleViewAnimation);
  const toggleViewHierarchy= usePixiBonesStore((s) => s.toggleViewHierarchy);
  const toggleViewIndicators=usePixiBonesStore((s) => s.toggleViewIndicators);
  const toggleViewOutline  = usePixiBonesStore((s) => s.toggleViewOutline);
  const toggleViewIssues   = usePixiBonesStore((s) => s.toggleViewIssues);
  const toggleViewPreview  = usePixiBonesStore((s) => s.toggleViewPreview);
  const toggleRightPanel   = usePixiBonesStore((s) => s.toggleRightPanel);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 11 项菜单定义
  type LabelKey = 'weights' | 'skin' | 'grid_tool' | 'color' | 'animation' | 'hierarchy' | 'indicators' | 'outline' | 'issues' | 'preview';
  type Item = {
    key: string;
    icon: string;
    labelKey: LabelKey;
    on: boolean;
    toggle: () => void;
    shortcut: string;
  };

  // 快捷键常量（Opt+W / S / E / C / A / T / M / O / B / R）
  const SHORTCUTS: Record<LabelKey, string> = {
    weights:    'Opt+W',
    skin:       'Opt+S',
    grid_tool:  'Opt+E',
    color:      'Opt+C',
    animation:  'Opt+A',
    hierarchy:  'Opt+T',
    indicators: 'Opt+M',
    outline:    'Opt+O',
    issues:     'Opt+B',
    preview:    'Opt+R',
  };
  const items: Item[] = [
    { key: 'weights',    icon: '🎚', labelKey: 'weights',    on: viewWeights,    toggle: toggleViewWeights,    shortcut: SHORTCUTS.weights },
    { key: 'skin',       icon: '🧍', labelKey: 'skin',       on: viewSkin,       toggle: toggleViewSkin,       shortcut: SHORTCUTS.skin },
    { key: 'grid_tool',  icon: '▦',  labelKey: 'grid_tool',  on: viewGridTool,   toggle: toggleViewGridTool,   shortcut: SHORTCUTS.grid_tool },
    { key: 'color',      icon: '🎨', labelKey: 'color',      on: viewColor,      toggle: toggleViewColor,      shortcut: SHORTCUTS.color },
    { key: 'animation',  icon: '🏃', labelKey: 'animation',  on: viewAnimation,  toggle: toggleViewAnimation,  shortcut: SHORTCUTS.animation },
    { key: 'hierarchy',  icon: '🌳', labelKey: 'hierarchy',  on: viewHierarchy,  toggle: () => { toggleViewHierarchy(); toggleRightPanel(); }, shortcut: SHORTCUTS.hierarchy },
    { key: 'indicators', icon: '📊', labelKey: 'indicators', on: viewIndicators, toggle: toggleViewIndicators, shortcut: SHORTCUTS.indicators },
    { key: 'outline',    icon: '🖼', labelKey: 'outline',    on: viewOutline,    toggle: toggleViewOutline,    shortcut: SHORTCUTS.outline },
    { key: 'issues',     icon: '⚠', labelKey: 'issues',     on: viewIssues,     toggle: toggleViewIssues,     shortcut: SHORTCUTS.issues },
    { key: 'preview',    icon: '👁', labelKey: 'preview',    on: viewPreview,    toggle: toggleViewPreview,    shortcut: SHORTCUTS.preview },
  ];

  // "隐藏所有视图"总开关在菜单外（hideviews 按钮），菜单本身不再显示状态条

  // 视图菜单样式（跟 TopMenu 一致的暗色风格）
  const M = {
    BG:      '#2a2a2eff',
    BORDER:  '1px solid rgba(255, 255, 255, 0.08)',
    RADIUS:  4,
    HOVER:   'rgba(255, 255, 255, 0.08)',
    DIVIDER: '1px solid rgba(255, 255, 255, 0.06)',
    TEXT:    'var(--spine-text)',
    DIM:     'var(--spine-text-dim)',
    ROW_H:   26,
    FONT:    12,
    SC_FONT: 11,
    ICON:    16,
    PAD_X:   10,
    MIN_W:   200,
    TOP_OFFSET: 4,  // 菜单顶部距离按钮底部的距离
  };

  // 计算菜单弹出位置：紧贴按钮正下方，右对齐按钮右边缘
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (open && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      setPos({
        top: r.bottom + M.TOP_OFFSET,
        right: window.innerWidth - r.right,
      });
    }
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        className="spine-btn-icon"
        onClick={() => setOpen((v) => !v)}
        title={t('header.view_tip')}
      >
        <img src={viewsIcon} alt="视图" width={14} height={14} style={{ display: 'block' }} />
      </button>

      {open && pos && (
        <div
          className="fixed z-50 shadow-2xl topmenu-dropdown"
          style={{
            top: pos.top,
            right: pos.right,
            minWidth: M.MIN_W,
            background: M.BG,
            border: M.BORDER,
            borderRadius: M.RADIUS,
            padding: '4px 0',
            transformOrigin: 'top right',
          }}
        >
          {items.map((item, i) => (
            <div key={item.key}>
              {/* 在 hierarchy 之后插一条分隔线（第 6 项后 = index 5） */}
              {i === 6 && (
                <div style={{
                  height: 1, background: M.DIVIDER, margin: '4px 0',
                }} />
              )}
              <button
                type="button"
                onClick={() => {
                  item.toggle();
                  // 点击 toggle 后保持菜单开启，方便连续勾选
                }}
                onMouseEnter={() => setHover(item.key)}
                onMouseLeave={() => setHover(null)}
                className="w-full flex items-center"
                style={{
                  height: M.ROW_H,
                  padding: `0 ${M.PAD_X}px`,
                  background: hover === item.key ? M.HOVER : 'transparent',
                  border: 'none',
                  color: M.TEXT,
                  fontSize: M.FONT,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                {/* emoji 图标 */}
                <span
                  style={{
                    width: M.ICON,
                    height: M.ICON,
                    marginRight: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                    flex: 'none',
                  }}
                >
                  {item.icon}
                </span>
                {/* 标签 */}
                <span style={{ minWidth: 70 }}>{t(`header.view_menu.${item.labelKey}`)}</span>
                {/* 快捷键：固定在右侧（不依赖名字长度） */}
                <span
                  style={{
                    color: M.DIM,
                    fontSize: M.SC_FONT,
                    fontFamily: 'monospace',
                    flex: 'none',
                  }}
                >
                  {item.shortcut}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
