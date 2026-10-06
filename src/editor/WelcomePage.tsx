import { useEffect, useRef, useState } from 'react';
import { usePixiBonesStore } from './store';
import { useT } from './i18n';
import logoImg from '/logo.png';
import folderIcon from './icons/folder.png';

/**
 * 欢迎页 / 工程选择页
 *   - 中央 logo + 三个大入口卡片（新建 / 打开 / 最近）
 *   - "最近" 卡片显示 localStorage 持久化的最近工程列表（最多 8 个）
 *   - 点击新建/打开/最近工程 → 调用 openProject(id, name) 切到编辑器
 */
export function WelcomePage() {
  const { t, locale } = useT();
  const recentProjects   = usePixiBonesStore((s) => s.recentProjects);
  const openProject      = usePixiBonesStore((s) => s.openProject);
  const setLocale        = usePixiBonesStore((s) => s.setLocale);

  // 新建工程对话框
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');

  // 打开工程对话框（file input）
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ESC 关闭对话框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowNew(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const handleCreate = () => {
    const name = newName.trim() || 'untitled';
    const id = `proj-${Date.now().toString(36)}`;
    openProject(id, name);
    setShowNew(false);
    setNewName('');
  };

  const handleOpenFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 用文件名（去掉扩展名）作为工程名
    const name = file.name.replace(/\.[^.]+$/, '');
    const id = `proj-${Date.now().toString(36)}`;
    openProject(id, name);
    // TODO: 真正读文件解析工程数据
    e.target.value = '';
  };

  const handleOpenRecent = (id: string, name: string) => {
    openProject(id, name);
  };

  // 通用样式（跟编辑器风格统一）
  const C = {
    BG:          '#1a1a1c',
    CARD_BG:     '#25252aff',
    CARD_HOVER:  '#2f2f36ff',
    BORDER:      'rgba(255,255,255,0.08)',
    TEXT:        'var(--spine-text)',
    DIM:         'var(--spine-text-dim)',
    ACCENT:      'var(--spine-accent)',
  };

  return (
    <div
      className="flex flex-col h-screen w-screen"
      style={{ background: C.BG, color: C.TEXT }}
    >
      {/* 顶栏：logo + 语言切换 */}
      <header
        className="flex items-center justify-between px-6 h-14 shrink-0 border-b"
        style={{ borderColor: C.BORDER }}
      >
        <div className="flex items-center gap-3">
          <img src={logoImg} alt="PixiBones" style={{ height: 24, width: 'auto', display: 'block' }} />
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setLocale('zh')}
            className="px-2 py-1 rounded transition-colors"
            style={{
              background: locale === 'zh' ? C.CARD_HOVER : 'transparent',
              color: locale === 'zh' ? C.TEXT : C.DIM,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            中文
          </button>
          <button
            type="button"
            onClick={() => setLocale('en')}
            className="px-2 py-1 rounded transition-colors"
            style={{
              background: locale === 'en' ? C.CARD_HOVER : 'transparent',
              color: locale === 'en' ? C.TEXT : C.DIM,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            English
          </button>
        </div>
      </header>

      {/* 中央内容 */}
      <main className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-4xl">
          {/* 大 logo */}
          <div className="flex flex-col items-center mb-10">
            <img
              src={logoImg}
              alt="PixiBones"
              style={{ height: 64, width: 'auto', display: 'block', marginBottom: 16 }}
            />
            <p className="text-base" style={{ color: C.DIM }}>
              {t('welcome.subtitle')}
            </p>
          </div>

          {/* 三个入口卡片 */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            {/* 新建工程 */}
            <WelcomeCard
              icon="📄"
              title={t('welcome.new')}
              desc={t('welcome.new_desc')}
              onClick={() => setShowNew(true)}
            />

            {/* 打开工程 */}
            <WelcomeCard
              icon="📁"
              title={t('welcome.open')}
              desc={t('welcome.open_desc')}
              onClick={() => fileInputRef.current?.click()}
            />

            {/* 导入 PSD（额外入口，做工程用） */}
            <WelcomeCard
              icon="🖼"
              title={t('welcome.import_psd')}
              desc={t('welcome.import_psd_desc')}
              onClick={() => {
                // PSD 走顶部菜单的导入功能，这里只是占位
                fileInputRef.current?.click();
              }}
            />
          </div>

          {/* 最近工程 */}
          {recentProjects.length > 0 && (
            <div>
              <h3 className="text-sm mb-3" style={{ color: C.DIM }}>
                {t('welcome.recent')}
              </h3>
              <div
                className="rounded-lg overflow-hidden"
                style={{ background: C.CARD_BG, border: `1px solid ${C.BORDER}` }}
              >
                {recentProjects.map((p, i) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleOpenRecent(p.id, p.name)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      borderTop: i > 0 ? `1px solid ${C.BORDER}` : 'none',
                      color: C.TEXT,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = C.CARD_HOVER; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <img src={folderIcon} alt="" width={20} height={20} style={{ display: 'block' }} />
                    <span className="flex-1 text-sm">{p.name}</span>
                    <span className="text-xs" style={{ color: C.DIM }}>
                      {new Date(p.openedAt).toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 隐藏的 file input（点击打开按钮触发） */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.pbs,.psd,.zip"
        style={{ display: 'none' }}
        onChange={handleOpenFile}
      />

      {/* 新建工程对话框 */}
      {showNew && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setShowNew(false)}
        >
          <div
            className="rounded-lg shadow-2xl"
            style={{
              background: C.CARD_BG,
              border: `1px solid ${C.BORDER}`,
              padding: 24,
              minWidth: 360,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base mb-4">{t('welcome.new')}</h2>
            <input
              type="text"
              autoFocus
              placeholder={t('welcome.name_placeholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              className="w-full px-3 py-2 rounded text-sm mb-4 outline-none"
              style={{
                background: '#1a1a1c',
                border: `1px solid ${C.BORDER}`,
                color: C.TEXT,
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNew(false)}
                className="px-3 py-1.5 rounded text-sm transition-colors"
                style={{ background: 'transparent', border: `1px solid ${C.BORDER}`, color: C.DIM, cursor: 'pointer' }}
              >
                {t('welcome.cancel')}
              </button>
              <button
                type="button"
                onClick={handleCreate}
                className="px-3 py-1.5 rounded text-sm transition-colors"
                style={{ background: C.ACCENT, border: 'none', color: '#fff', cursor: 'pointer' }}
              >
                {t('welcome.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
//  大入口卡片（新建 / 打开 / 导入）
// ============================================================================
function WelcomeCard({
  icon, title, desc, onClick,
}: {
  icon: string;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex flex-col items-center text-center rounded-lg p-6 transition-colors"
      style={{
        background: hover ? '#2f2f36ff' : '#25252aff',
        border: '1px solid rgba(255,255,255,0.08)',
        color: 'var(--spine-text)',
        cursor: 'pointer',
        minHeight: 140,
        justifyContent: 'center',
      }}
    >
      <div style={{ fontSize: 40, marginBottom: 12 }}>{icon}</div>
      <div className="text-sm font-medium mb-1">{title}</div>
      <div className="text-xs" style={{ color: 'var(--spine-text-dim)' }}>{desc}</div>
    </button>
  );
}
