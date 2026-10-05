import { useEffect, useRef, useState } from 'react';
import { usePixiBonesStore } from './store';

// =================================================================================
//  尺寸 & 样式常量
// =================================================================================
const M = {
  HEADER_HEIGHT:    48,                    // 顶部 logo 区域高度
  ITEM_HEIGHT:      26,                    // 每个菜单项高度
  ITEM_FONT:        12,
  SHORTCUT_FONT:    11,
  ITEM_ICON_SIZE:   16,
  MENU_MIN_WIDTH:   280,
  MENU_BG:          '#2a2a2eff',
  MENU_BORDER:      '1px solid rgba(255, 255, 255, 0.08)',
  MENU_RADIUS:      4,
  ITEM_HOVER_BG:    'rgba(255, 255, 255, 0.08)',
  ITEM_COLOR:       'var(--spine-text)',
  SHORTCUT_COLOR:   'var(--spine-text-dim)',
  DIVIDER:          '1px solid rgba(255, 255, 255, 0.06)',
  TRIAL_BG:         '#1d4ed8',
  TRIAL_COLOR:      '#ffffff',
  LOGO_COLOR:       'var(--spine-accent)',
};

// =================================================================================
//  菜单项定义（按 Spine Trial 截图复刻）
//  - label:    显示文字
//  - shortcut: 右侧快捷键（macOS 风格：Cmd / Shift / 字母）
//  - divider:  在该项上方画一条分隔线
//  - icon:     左侧 16×16 占位 emoji（之后可换 PNG）
//  - action:   点击执行（占位：alert 提示；后续接功能）
// =================================================================================
type MenuItem = {
  label: string;
  shortcut?: string;
  divider?: boolean;
  icon?: React.ReactNode;
  action?: () => void;
};

const MENU_ITEMS: MenuItem[] = [
  { icon: '📄', label: '新建项目',   shortcut: 'Cmd+Shift+N' },
  { icon: '📁', label: '打开项目…',   shortcut: 'Cmd+O' },
  { icon: '🕘', label: '最近的项目', shortcut: '▸' },
  { divider: true } as MenuItem,
  { icon: '💾', label: '保存项目',   shortcut: 'Cmd+S' },
  { icon: '📝', label: '项目另存为…', shortcut: 'Cmd+Shift+S' },
  { icon: '📦', label: '打包项目…' },
  { divider: true } as MenuItem,
  { icon: '🦴', label: '新建骨架',   shortcut: 'Cmd+N' },
  { divider: true } as MenuItem,
  { icon: '📥', label: '导入项目…' },
  { icon: '📊', label: '导入数据…' },
  { icon: '🖼', label: '导入PSD…' },
  { icon: '📤', label: '导出…',     shortcut: 'Cmd+E' },
  { divider: true } as MenuItem,
  { icon: '🧩', label: '纹理打包器…', shortcut: 'Cmd+P' },
  { icon: '🔓', label: '纹理解包器…' },
  { divider: true } as MenuItem,
  { icon: '⚙', label: '设置…',     shortcut: 'F12' },
];

/**
 * 顶部 logo + 版本徽章 + 点击弹下拉菜单（Spine Trial 风格）
 *   - 点击 logo：toggle 菜单
 *   - 点击菜单项：执行 action 后关闭（action 占位 alert）
 *   - 点击菜单外部 / Esc：关闭
 */
export function TopMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
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

  const onItemClick = (item: MenuItem) => {
    if (item.action) item.action();
    else console.log(`[TopMenu] 点击: ${item.label}（功能未实现）`);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative flex items-center" style={{ height: M.HEADER_HEIGHT }}>
      {/* Logo + 版本徽章（点击区）
          - 关闭时显示 🩻 PixiBones + TRIAL
          - 打开时变成透明（宽度不变），让面板里的 logo 接管视觉效果 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-full px-2"
        style={{
          background: open ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
          color: M.LOGO_COLOR,
          border: 'none',
          cursor: 'pointer',
        }}
        title="主菜单"
      >
        {!open && (
          <>
            <span style={{ fontSize: 14, fontWeight: 600 }}>🩻 PixiBones</span>
            {/* header 平时态：只显示 Trial 缩写（不显示版本号数字） */}
            <span
              style={{
                color: M.LOGO_COLOR,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: 1,
              }}
            >
              TRIAL
            </span>
          </>
        )}
      </button>

      {/* 快捷按钮：打开 / 保存 / 撤消 / 重做（Spine 风格） */}
      {!open && (
        <div className="flex items-center" style={{ gap: 2, paddingLeft: 4 }}>
          <QuickBtn title="打开项目…  (Cmd+O)" onClick={() => console.log('[QuickBtn] 打开项目')}>
            <IconOpen />
          </QuickBtn>
          <QuickBtn title="保存项目 (Cmd+S) / Shift+点击 = 另存为" onClick={(e) => {
            if (e.shiftKey) console.log('[QuickBtn] 另存为');
            else console.log('[QuickBtn] 保存');
          }}>
            <IconSave />
          </QuickBtn>
          <QuickBtn title="撤消 (Cmd+Z)" onClick={() => console.log('[QuickBtn] 撤消（未实现）')}>
            <IconUndo />
          </QuickBtn>
          <QuickBtn title="重做 (Cmd+Shift+Z)" onClick={() => console.log('[QuickBtn] 重做（未实现）')}>
            <IconRedo />
          </QuickBtn>
        </div>
      )}

      {/* 下拉菜单：从窗口最左上角弹出，盖住 header 和左侧 ruler */}
      {open && (
        <div
          className="fixed z-50 shadow-2xl topmenu-dropdown"
          style={{
            top: 0,
            left: 0,
            minWidth: M.MENU_MIN_WIDTH,
            background: M.MENU_BG,
            border: M.MENU_BORDER,
            borderRadius: M.MENU_RADIUS,
            padding: '4px 0',
            transformOrigin: 'top left',
          }}
        >
          {/* 面板顶部：完整 logo + 完整版本徽章（Spine 风格面板头） */}
          <div
            className="flex items-center"
            style={{
              height: 36,
              padding: '0 10px',
              marginBottom: 4,
              borderBottom: M.DIVIDER,
            }}
          >
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: M.LOGO_COLOR,
                marginRight: 12,
              }}
            >
              🩻 PixiBones
            </span>
            <span
              style={{
                background: M.TRIAL_BG,
                color: M.TRIAL_COLOR,
                fontSize: 11,
                fontWeight: 500,
                padding: '2px 8px',
                borderRadius: 3,
              }}
            >
              0.1.0 Trial
            </span>
          </div>
          {MENU_ITEMS.map((item, i) =>
            item.divider ? (
              <div key={`d-${i}`} style={{ height: 1, background: M.DIVIDER, margin: '4px 0' }} />
            ) : (
              <button
                key={`i-${i}`}
                type="button"
                onClick={() => onItemClick(item)}
                className="w-full flex items-center"
                style={{
                  height: M.ITEM_HEIGHT,
                  padding: '0 10px',
                  background: 'transparent',
                  border: 'none',
                  color: M.ITEM_COLOR,
                  fontSize: M.ITEM_FONT,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = M.ITEM_HOVER_BG;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
              >
                <span
                  style={{
                    width: M.ITEM_ICON_SIZE,
                    height: M.ITEM_ICON_SIZE,
                    marginRight: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: 'none',
                  }}
                >
                  {item.icon}
                </span>
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.shortcut && (
                  <span
                    style={{
                      color: M.SHORTCUT_COLOR,
                      fontSize: M.SHORTCUT_FONT,
                      fontFamily: 'monospace',
                      marginLeft: 16,
                    }}
                  >
                    {item.shortcut}
                  </span>
                )}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// =================================================================================
//  快捷按钮 + inline SVG icons（打开 / 保存 / 撤消 / 重做）
// =================================================================================
const QUICK_BTN_SIZE = 24;

function QuickBtn({
  title, onClick, children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: QUICK_BTN_SIZE,
        height: QUICK_BTN_SIZE,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: hover ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
        border: 'none',
        borderRadius: 3,
        cursor: 'pointer',
        color: 'var(--spine-text-dim)',
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

const ICON_BTN_PROPS = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function IconOpen() {
  // 文件夹 + 打开箭头
  return (
    <svg {...ICON_BTN_PROPS}>
      <path d="M1.5 4 L6 4 L7.5 5.5 L14.5 5.5 L14.5 12 L1.5 12 Z" />
      <path d="M4 9 L8 9" />
      <path d="M6 7 L8 9 L6 11" />
    </svg>
  );
}

function IconSave() {
  // 软盘
  return (
    <svg {...ICON_BTN_PROPS}>
      <path d="M2.5 2.5 L10.5 2.5 L13.5 5.5 L13.5 13.5 L2.5 13.5 Z" />
      <rect x="4.5" y="2.5" width="5" height="4" />
      <rect x="4.5" y="9.5" width="7" height="4" />
    </svg>
  );
}

function IconUndo() {
  // 左弯箭头
  return (
    <svg {...ICON_BTN_PROPS}>
      <path d="M3.5 8 L6 5.5 M3.5 8 L6 10.5 M3.5 8 L9 8 A4 4 0 0 1 13 12" />
    </svg>
  );
}

function IconRedo() {
  // 右弯箭头
  return (
    <svg {...ICON_BTN_PROPS}>
      <path d="M12.5 8 L10 5.5 M12.5 8 L10 10.5 M12.5 8 L7 8 A4 4 0 0 0 3 12" />
    </svg>
  );
}