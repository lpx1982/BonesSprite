import { useEffect, useRef } from 'react';

/**
 * Spine 风格重命名对话框（参考截图）
 *   - 蓝色斜切标题栏
 *   - 副标题（"为此 XXX 输入一个新名称:"）
 *   - 单行输入框，初值自动全选（方便直接覆盖输入）
 *   - ✓ 确定 / ⊘ 取消
 *
 * 用法：
 *   open=true → 显示；onConfirm(name) / onCancel()。
 *   Esc = 取消；Enter = 确认。
 */
export function PromptDialog({
  open,
  title,
  message,
  initialValue = '',
  confirmLabel = '确定',
  cancelLabel = '取消',
  /** 选中范围：'all' = 全部选中（默认，按 Spine 行为）；'none' = 末尾 | 'range' = 自定义 */
  select = 'all',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  select?: 'all' | 'none' | 'range';
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 打开时聚焦 + 选中（按 Spine 习惯：自动全选，方便直接改）
  useEffect(() => {
    if (!open) return;
    // 延迟一帧确保 input 已挂载
    const raf = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (select === 'all') {
        el.setSelectionRange(0, el.value.length);
      } else if (select === 'none') {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, initialValue, select]);

  // Esc = 取消；Enter = 确认（按钮同包在 form 内就能触发 submit）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(inputRef.current?.value ?? '');
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // 点击遮罩 = 取消
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.35)',
        backdropFilter: 'blur(1px)',
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: 280,
          background: 'var(--spine-bg-canvas-dark)',
          border: '1px solid var(--spine-accent)',
          borderRadius: 4,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--spine-accent-dim) inset',
          color: 'var(--spine-text)',
          fontSize: 14,
          overflow: 'hidden',
        }}
      >
        {/* 蓝色斜切标题栏（参考 Spine 重命名对话框） */}
        <div
          style={{
            position: 'relative',
            padding: '10px 16px',
            color: '#fff',
            fontWeight: 600,
            background:
              'linear-gradient(135deg, var(--spine-accent) 0%, var(--spine-accent) 70%, var(--spine-bg-canvas-dark) 70%, var(--spine-bg-canvas-dark) 100%)',
            borderBottom: '1px solid var(--spine-border)',
            clipPath:
              'polygon(0 0, calc(100% - 24px) 0, 100% 24px, 100% 100%, 0 100%)',
            fontSize: 15,
          }}
        >
          {title}
        </div>

        {/* 副标题 */}
        <div style={{ padding: '14px 16px 6px', fontSize: 14 }}>
          {message}
        </div>

        {/* 输入框 */}
        <div style={{ padding: '0 16px 14px' }}>
          <input
            ref={inputRef}
            defaultValue={initialValue}
            spellCheck={false}
            autoComplete="off"
            // 阻止失焦被外层 onMouseDown 误取消
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // 这里避免外层 div 的 mousedown 取消：仅在 Escape / Enter 转发即可
              if (e.key === 'Enter') {
                e.preventDefault();
                onConfirm((e.target as HTMLInputElement).value);
              }
            }}
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 14,
              fontFamily: 'inherit',
              color: 'var(--spine-text)',
              background: 'var(--spine-bg-canvas)',
              border: '1px solid var(--spine-accent)',
              borderRadius: 3,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 按钮区（参考截图：绿色 ✓ + 红色 ⊘） */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 18, padding: '0 16px 16px' }}>
          <button
            type="submit"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 22px',
              border: '1px solid #555',
              borderRadius: 3,
              background: 'var(--spine-bg-toolbar)',
              color: 'var(--spine-text)',
              cursor: 'pointer',
              fontSize: 15,
            }}
          >
            <span style={{ color: 'var(--spine-positive)', fontSize: 17, fontWeight: 'bold' }}>✓</span>
            <span>{confirmLabel}</span>
          </button>
          <button
            type="button"
            onClick={onCancel}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 22px',
              border: '1px solid #555',
              borderRadius: 3,
              background: 'var(--spine-bg-toolbar)',
              color: 'var(--spine-text)',
              cursor: 'pointer',
              fontSize: 15,
            }}
          >
            <span style={{ color: 'var(--spine-danger)', fontSize: 17, fontWeight: 'bold' }}>⊘</span>
            <span>{cancelLabel}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
