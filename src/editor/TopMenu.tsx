import { useEffect, useRef, useState } from 'react';
import { usePixiBonesStore } from './store';
import { useT, type Locale } from './i18n';
import { saveProjectToFile, loadProjectFromFile, PROJECT_FILE_EXT } from './projectIO';
import { importDataFromFiles } from '../exporters/importDataFlow';
import { PromptDialog } from './PromptDialog';
import logoImg from '/logo.png';
import folderIcon from './icons/folder.png';
import saveIcon from './icons/save.png';
import forwardIcon from './icons/forward.png';
import replyIcon from './icons/reply.png';

// =================================================================================
//  尺寸 & 样式常量
// =================================================================================
const M = {
  HEADER_HEIGHT:    48,
  ITEM_HEIGHT:      26,
  ITEM_FONT:        12,
  SHORTCUT_FONT:    11,
  ITEM_ICON_SIZE:   16,
  MENU_MIN_WIDTH:   280,
  SUBMENU_OFFSET:   6,                       // 子菜单相对主菜单右移
  MENU_BG:          '#2a2a2eff',
  MENU_BORDER:      '1px solid rgba(255, 255, 255, 0.08)',
  MENU_RADIUS:      4,
  ITEM_HOVER_BG:    'rgba(255, 255, 255, 0.08)',
  ITEM_COLOR:       'var(--spine-text)',
  SHORTCUT_COLOR:   'var(--spine-text-dim)',
  DIVIDER:          '1px solid rgba(255, 255, 255, 0.06)',

  // ===== 4 个 quickbtn 整组配置（打开/保存/撤消/重做）=====
  // 改这里一处即可同时控制所有按钮的容器 + 按钮框 + 图标位置/尺寸
  ICON_GRP: {
    TOP:           5,     // 整组距离 header 顶部的距离（最上面那条黑色横条）
    LEFT:          4,    // 整组距离 logo 的左边距
    GAP:           2,    // 4 个按钮之间的间距
    BTN_SIZE:      24,   // 按钮框尺寸（24×24）
    ICON_SIZE:     14,   // 按钮内 PNG 图标尺寸（14×14）
    HOVER_BG:      'rgba(255, 255, 255, 0.08)',
    RADIUS:        3,
    COLOR:         'var(--spine-text-dim)',
  },

  // 早期版本有 TRIAL 徽章（spine trial 风格），现版本作为正式完整版发布，徽章已移除
  // 保留字段位置占位以便未来扩展
  LOGO_COLOR:       'var(--spine-accent)',
};

// =================================================================================
//  菜单项定义（label 用 i18n key，运行时按 locale 取真实字符串）
// =================================================================================
type MenuItem = {
  labelKey: string;
  shortcutKey?: string;
  divider?: boolean;
  icon?: React.ReactNode;
  /** true 表示该行 hover 弹语言子菜单，不在主菜单里触发 action */
  isLanguageSubmenu?: boolean;
  action?: () => void;
};

const MENU_ITEMS: MenuItem[] = [
  { icon: '📄', labelKey: 'menu.new_project',     shortcutKey: 'shortcut.cmd_shift_n' },
  // 关闭工程返回欢迎页（快捷键 Cmd+W）
  { icon: '🔙', labelKey: 'menu.close_project',   shortcutKey: 'shortcut.cmd_w', action: () => usePixiBonesStore.getState().closeProject() },
  { icon: '📁', labelKey: 'menu.open_project',    shortcutKey: 'shortcut.cmd_o' },
  { icon: '🕘', labelKey: 'menu.recent',          shortcutKey: 'shortcut.arrow_right' },
  { divider: true } as MenuItem,
  { icon: '💾', labelKey: 'menu.save',            shortcutKey: 'shortcut.cmd_s' },
  { icon: '📝', labelKey: 'menu.save_as',         shortcutKey: 'shortcut.cmd_shift_s' },
  { icon: '📦', labelKey: 'menu.pack' },
  { divider: true } as MenuItem,
  { icon: '🦴', labelKey: 'menu.new_skeleton',    shortcutKey: 'shortcut.cmd_n' },
  { divider: true } as MenuItem,
  { icon: '📥', labelKey: 'menu.import_project' },
  { icon: '📊', labelKey: 'menu.import_data', action: () => { void importDataFromFiles(); } },
  { icon: '🖼', labelKey: 'menu.import_psd' },
  { icon: '📤', labelKey: 'menu.export',          shortcutKey: 'shortcut.cmd_e' },
  { divider: true } as MenuItem,
  { icon: '🧩', labelKey: 'menu.texture_packer',  shortcutKey: 'shortcut.cmd_p' },
  { icon: '🔓', labelKey: 'menu.texture_unpacker' },
  { divider: true } as MenuItem,
  // 设置… 点击后弹出语言子菜单（isLanguageSubmenu=true）
  { icon: '⚙', labelKey: 'menu.settings', shortcutKey: 'shortcut.f12', isLanguageSubmenu: true },
];

/**
 * 顶部 logo + 版本徽章 + 点击弹下拉菜单（Spine Trial 风格）
 *   - 点击 logo：toggle 菜单
 *   - 点击菜单项：执行 action 后关闭（action 占位 console.log）
 *   - 设置…项 hover 弹出语言子菜单
 *   - 点击菜单外部 / Esc：关闭
 */
export function TopMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeProject = usePixiBonesStore((s) => s.closeProject);
  const newProject = usePixiBonesStore((s) => s.newProject);
  const { t, locale } = useT();
  const setLocale = usePixiBonesStore((s) => s.setLocale);
  const [hoverSettings, setHoverSettings] = useState(false);
  const [settingsRowRect, setY] = useState<{ top: number; left: number } | null>(null);
  const settingsRowRef = useRef<HTMLButtonElement>(null);
  // ★ 新建项目对话框（Spine 风格 PromptDialog，输入项目名）
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // ★ 打开 / 导入 .pbs 工程文件的隐藏 input
  const openFileRef = useRef<HTMLInputElement>(null);
  const [openFileError, setOpenFileError] = useState(false);

  const handleOpenFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const ok = await loadProjectFromFile(file);
    setOpenFileError(!ok);
    if (ok) {
      setOpen(false);
      setHoverSettings(false);
    }
  };

  const handleSave = () => {
    // ★ 保存 = 导出 .pbs 文件（仿 Spine 的 .spine：一个 JSON 装全部数据）
    saveProjectToFile();
    setOpen(false);
    setHoverSettings(false);
  };

  const handleSaveAs = () => {
    saveProjectToFile();
    setOpen(false);
    setHoverSettings(false);
  };

  // 点击外部关闭（仅关闭主菜单，不干扰子菜单 hover）
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHoverSettings(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setHoverSettings(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 计算子菜单位置（紧贴 Settings 行右边）
  useEffect(() => {
    if (hoverSettings && settingsRowRef.current) {
      const r = settingsRowRef.current.getBoundingClientRect();
      setY({ top: r.top, left: r.right });
    }
  }, [hoverSettings, open]);

  const onItemClick = (item: MenuItem) => {
    if (item.isLanguageSubmenu) return; // 设置项只弹子菜单，不关闭
    // ★ 新建项目：打开命名对话框（不执行其它 action）
    if (item.labelKey === 'menu.new_project') {
      setNewProjectOpen(true);
      setOpen(false);
      setHoverSettings(false);
      return;
    }
    // ★ 打开工程：选择 .pbs 文件
    if (item.labelKey === 'menu.open_project') {
      openFileRef.current?.click();
      setOpen(false);
      setHoverSettings(false);
      return;
    }
    // ★ 保存 / 另存为：导出 .pbs 文件
    if (item.labelKey === 'menu.save' || item.labelKey === 'menu.save_as') {
      saveProjectToFile();
      setOpen(false);
      setHoverSettings(false);
      return;
    }
    if (item.action) item.action();
    else console.log(`[TopMenu] ${t(item.labelKey)} (功能未实现)`);
    setOpen(false);
    setHoverSettings(false);
  };

  return (
    <div ref={rootRef} className="relative flex items-center" style={{ height: M.HEADER_HEIGHT }}>
      {/* Logo + 版本徽章（点击区）
          - 关闭时显示 PixiBones logo
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
        title={t('header.main_menu')}
      >
        {!open && (
          <img
            src={logoImg}
            alt="PixiBones"
            style={{
              height: 18,
              width: 'auto',
              display: 'block',
            }}
          />
        )}
      </button>

      {/* 快捷按钮：打开 / 保存 / 撤消 / 重做（Spine 风格） */}
      {!open && (
        <div
          className="flex items-center"
          style={{
            gap:           M.ICON_GRP.GAP,
            paddingLeft:    M.ICON_GRP.LEFT,
            paddingTop:     M.ICON_GRP.TOP,
          }}
        >
          <QuickBtn title={t('quickbtn.open_tip')} onClick={() => openFileRef.current?.click()}>
            <img src={folderIcon} alt="打开" width={M.ICON_GRP.ICON_SIZE} height={M.ICON_GRP.ICON_SIZE} style={{ display: 'block' }} />
          </QuickBtn>
          <QuickBtn title={t('quickbtn.save_tip')} onClick={() => saveProjectToFile()}>
            <img src={saveIcon} alt="保存" width={M.ICON_GRP.ICON_SIZE} height={M.ICON_GRP.ICON_SIZE} style={{ display: 'block' }} />
          </QuickBtn>
          <QuickBtn title={t('quickbtn.undo_tip')} onClick={() => usePixiBonesStore.getState().undo()}>
            <img src={replyIcon} alt="撤消" width={M.ICON_GRP.ICON_SIZE} height={M.ICON_GRP.ICON_SIZE} style={{ display: 'block' }} />
          </QuickBtn>
          <QuickBtn title={t('quickbtn.redo_tip')} onClick={() => usePixiBonesStore.getState().redo()}>
            <img src={forwardIcon} alt="重做" width={M.ICON_GRP.ICON_SIZE} height={M.ICON_GRP.ICON_SIZE} style={{ display: 'block' }} />
          </QuickBtn>
        </div>
      )}

      {/* 下拉菜单：从窗口最左上角弹出 */}
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
          {/* 面板顶部：完整 logo + 完整版本徽章 */}
          <div
            className="flex items-center"
            style={{
              height: 36,
              padding: '0 10px',
              marginBottom: 4,
              borderBottom: M.DIVIDER,
            }}
          >
            <img
              src={logoImg}
              alt="PixiBones"
              style={{
                height: 22,
                width: 'auto',
                display: 'block',
              }}
            />
          </div>

          {MENU_ITEMS.map((item, i) =>
            item.divider ? (
              <div key={`d-${i}`} style={{ height: 1, background: M.DIVIDER, margin: '4px 0' }} />
            ) : (
              <button
                key={`i-${i}`}
                ref={item.isLanguageSubmenu ? settingsRowRef : undefined}
                type="button"
                onClick={() => onItemClick(item)}
                onMouseEnter={() => item.isLanguageSubmenu && setHoverSettings(true)}
                onMouseLeave={() => item.isLanguageSubmenu && setHoverSettings(false)}
                className="w-full flex items-center relative"
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
                <span style={{ flex: 1 }}>{t(item.labelKey)}</span>
                {item.shortcutKey && (
                  <span
                    style={{
                      color: M.SHORTCUT_COLOR,
                      fontSize: M.SHORTCUT_FONT,
                      fontFamily: 'monospace',
                      marginLeft: 16,
                    }}
                  >
                    {t(item.shortcutKey)}
                  </span>
                )}
              </button>
            ),
          )}
        </div>
      )}

      {/* 语言子菜单：hover Settings 行时弹出，紧贴该行右侧 */}
      {open && hoverSettings && settingsRowRect && (
        <LanguageSubmenu
          top={settingsRowRect.top}
          left={settingsRowRect.left + M.SUBMENU_OFFSET}
          currentLocale={locale}
          onPick={(l) => {
            setLocale(l);
            setHoverSettings(false);
            setOpen(false);
          }}
          onMouseEnter={() => setHoverSettings(true)}
          onMouseLeave={() => setHoverSettings(false)}
          t={t}
        />
      )}

      {/* ★ 新建项目对话框（Spine 风格 PromptDialog）：输入项目名 → newProject(name) */}
      {newProjectOpen && (
        <PromptDialog
          open
          title={t('menu.new_project')}
          message={t('welcome.name_placeholder')}
          initialValue=""
          select="none"
          confirmLabel={t('welcome.confirm')}
          cancelLabel={t('welcome.cancel')}
          onCancel={() => setNewProjectOpen(false)}
          onConfirm={(value) => {
            newProject(value);
            setNewProjectOpen(false);
          }}
        />
      )}

      {/* ★ 打开 .pbs 工程文件的隐藏 input */}
      <input
        ref={openFileRef}
        type="file"
        accept={PROJECT_FILE_EXT}
        style={{ display: 'none' }}
        onChange={handleOpenFile}
      />
      {/* 打开失败提示（非 .pbs 文件 / 版本不符） */}
      {openFileError && (
        <div
          className="fixed z-[9998]"
          style={{
            top: M.HEADER_HEIGHT + 8,
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#5a1f1f',
            border: '1px solid #e66',
            color: '#fff',
            padding: '6px 16px',
            borderRadius: 4,
            fontSize: 12,
          }}
          onClick={() => setOpenFileError(false)}
        >
          无法打开该文件：不是有效的工程文件（.{PROJECT_FILE_EXT.slice(1)}）
        </div>
      )}
    </div>
  );
}

// =================================================================================
//  语言子菜单（hover Settings 行触发）
// =================================================================================
function LanguageSubmenu({
  top, left, currentLocale, onPick, onMouseEnter, onMouseLeave, t,
}: {
  top: number;
  left: number;
  currentLocale: Locale;
  onPick: (l: Locale) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  t: (k: string) => string;
  }) {
  const options: Array<{ value: Locale; labelKey: string }> = [
    { value: 'zh', labelKey: 'menu.language_zh' },
    { value: 'en', labelKey: 'menu.language_en' },
  ];
  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-50 shadow-2xl"
      style={{
        top,
        left,
        minWidth: 140,
        background: M.MENU_BG,
        border: M.MENU_BORDER,
        borderRadius: M.MENU_RADIUS,
        padding: '4px 0',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === currentLocale;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onPick(opt.value)}
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
              fontWeight: active ? 600 : 400,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = M.ITEM_HOVER_BG;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
          >
            <span style={{ flex: 1 }}>{t(opt.labelKey)}</span>
            {active && (
              <span style={{ color: M.SHORTCUT_COLOR, fontSize: M.SHORTCUT_FONT, marginLeft: 8 }}>✓</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// =================================================================================
//  快捷按钮 + inline SVG icons（打开 / 保存 / 撤消 / 重做）
// =================================================================================
// 样式参数全部来自 M.ICON_GRP（全局集中控制）

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
        width: M.ICON_GRP.BTN_SIZE,
        height: M.ICON_GRP.BTN_SIZE,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: hover ? M.ICON_GRP.HOVER_BG : 'transparent',
        border: 'none',
        borderRadius: M.ICON_GRP.RADIUS,
        cursor: 'pointer',
        color: M.ICON_GRP.COLOR,
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

const ICON_BTN_PROPS = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function IconOpen() {
  return (
    <svg {...ICON_BTN_PROPS}>
      <path d="M1.5 4 L6 4 L7.5 5.5 L14.5 5.5 L14.5 12 L1.5 12 Z" />
      <path d="M4 9 L8 9" />
      <path d="M6 7 L8 9 L6 11" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg {...ICON_BTN_PROPS}>
      <path d="M2.5 2.5 L10.5 2.5 L13.5 5.5 L13.5 13.5 L2.5 13.5 Z" />
      <rect x="4.5" y="2.5" width="5" height="4" />
      <rect x="4.5" y="9.5" width="7" height="4" />
    </svg>
  );
}

function IconUndo() {
  return (
    <svg {...ICON_BTN_PROPS}>
      <path d="M3.5 8 L6 5.5 M3.5 8 L6 10.5 M3.5 8 L9 8 A4 4 0 0 1 13 12" />
    </svg>
  );
}

function IconRedo() {
  return (
    <svg {...ICON_BTN_PROPS}>
      <path d="M12.5 8 L10 5.5 M12.5 8 L10 10.5 M12.5 8 L7 8 A4 4 0 0 0 3 12" />
    </svg>
  );
}