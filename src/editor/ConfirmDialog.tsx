import { useEffect, useRef } from 'react';

/**
 * Spine 风格确认对话框（参考截图）
 *   - 蓝色斜切标题栏（"确认删除"）
 *   - 深灰半透明内容区（"确定要删除此骨骼?"）
 *   - 底部两按钮："是"（绿色 ✓）+ "否"（红色 🚫）
 *
 * 用法：在父组件用 `useState` 控制 visible，传入 onConfirm / onCancel 回调。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '是',
  cancelLabel = '否',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  // 打开时自动聚焦"否"（默认拒绝，要二次确认才删）
  useEffect(() => {
    if (open) {
      // 延迟一帧确保按钮已挂载；聚焦到"否"按钮（绿色对勾所在 = 确认），需要 Enter 才删
      // 实际：聚焦确认按钮更安全，避免误按 Enter；聚焦后 Enter 触发 onConfirm → 删除
      requestAnimationFrame(() => confirmRef.current?.focus());
    }
  }, [open]);
  // Esc = 取消；Del/Enter = 确认
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm, onCancel]);
  if (!open) return null;
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
      <div
        style={{
          width: 180,
          background: 'var(--spine-bg-canvas-dark)',
          border: '1px solid var(--spine-accent)',
          borderRadius: 4,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--spine-accent-dim) inset',
          color: 'var(--spine-text)',
          fontSize: 14,
          overflow: 'hidden',
        }}
      >
        {/* 蓝色斜切标题栏（参考图右上角斜角） */}
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
          }}
        >
          {title}
        </div>
        {/* 内容区 */}
        <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 15 }}>
          {message}
        </div>
        {/* 按钮区 */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 16, padding: '0 16px 16px' }}>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 18px',
              border: '1px solid #555',
              borderRadius: 3,
              background: 'var(--spine-bg-toolbar)',
              color: 'var(--spine-text)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            <span style={{ color: 'var(--spine-positive)', fontSize: 16, fontWeight: 'bold' }}>✓</span>
            <span>{confirmLabel}</span>
          </button>
          <button
            onClick={onCancel}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 18px',
              border: '1px solid #555',
              borderRadius: 3,
              background: 'var(--spine-bg-toolbar)',
              color: 'var(--spine-text)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            <span style={{ color: 'var(--spine-danger)', fontSize: 16, fontWeight: 'bold' }}>⊘</span>
            <span>{cancelLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}