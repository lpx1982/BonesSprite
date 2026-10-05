import { useMemo } from 'react';
import { usePixiBonesStore, findBone, type BoneNode } from './store';

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

  const selected = selectedBoneId ? findBone(bones, selectedBoneId) : null;
  const breadcrumb = useMemo(() => buildPath(bones, selectedBoneId), [bones, selectedBoneId]);

  // transform 4 行 —— 默认选中第一行（旋转）
  const activeTransform: TransformKey = 'rotate' as TransformKey;
  // reference / space 默认值
  const activeSpace: SpaceKey = (transformSpace === 'world' ? 'world' : 'local') as SpaceKey;
  const activeRef: RefKey = 'bone' as RefKey;

  return (
    <div
      className="absolute bottom-3 left-0 right-0 z-10 flex justify-center pointer-events-none"
    >
      <div className="flex items-end gap-2 pointer-events-auto">
        {/* 卡片 1：mode 切换 */}
        <Card>
          <ModeButton
            icon={<IconPose />}
            label="姿势"
            active={editorMode === 'pose'}
            onClick={() => setEditorMode('pose')}
          />
          <ModeButton
            icon={<IconWeights />}
            label="权重"
            badge="PRO"
            active={editorMode === 'weights'}
            onClick={() => setEditorMode('weights')}
          />
          <ModeButton
            icon={<IconCreate />}
            label="创建"
            active={editorMode === 'create'}
            onClick={() => setEditorMode('create')}
          />
        </Card>
          {/* 卡片 2：transform 值（4 行） */}
        <Card>
          <TransformRow
            icon={<IconRotate />}
            label="旋转"
            xValue="0.0"
            active={activeTransform === 'rotate'}
            columns="one"
          />
          <TransformRow
            icon={<IconMove />}
            label="移动"
            xValue={selected ? selected.x.toFixed(1) : '0.0'}
            yValue={selected ? selected.y.toFixed(1) : '0.0'}
            active={activeTransform === 'move'}
            columns="two"
          />
          <TransformRow
            icon={<IconScale />}
            label="缩放"
            xValue={selected ? selected.scaleX.toFixed(2) : '1.00'}
            yValue={selected ? selected.scaleY.toFixed(2) : '1.00'}
            active={activeTransform === 'scale'}
            columns="two"
          />
          <TransformRow
            icon={<IconShear />}
            label="倾斜"
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
            label="本地"
            active={activeSpace === 'local'}
            onClick={() => setTransformSpace('local')}
          />
          <RadioButton
            icon={<IconParent />}
            label="父级"
            active={activeSpace === 'parent'}
            onClick={() => setTransformSpace('local')}
          />
          <RadioButton
            icon={<IconWorld />}
            label="世界"
            active={activeSpace === 'world'}
            onClick={() => setTransformSpace('world')}
          />
        </Card>
          {/* 卡片 4：reference */}
        <Card>
          <RadioButton
            icon={<IconBone />}
            label="骨骼"
            active={activeRef === 'bone'}
            onClick={() => {}}
          />
          <RadioButton
            icon={<IconImage />}
            label="图片"
            active={activeRef === 'image'}
            onClick={() => {}}
          />
          <RadioButton
            icon={<IconPixel />}
            label="像素"
            active={activeRef === 'pixel'}
            onClick={() => {}}
          />
        </Card>
          {/* 卡片 5：visibility 3×3 眼睛网格 */}
        <Card>
          <VisibilityTable
            rows={[
              { label: '骨骼', eyes: [true, false, false] },
              { label: '图片', eyes: [true, false, false] },
              { label: '其他', eyes: [false, false, false] },
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
      className="flex flex-col rounded-md overflow-hidden self-end backdrop-blur-md"
      style={{
        // 更透明的半透明效果：让画布网格能透过来
        background: 'rgba(45, 45, 48, 0.55)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
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
        background: active ? 'var(--spine-positive)' : 'transparent',
        color: active ? 'white' : 'var(--spine-text)',
        fontWeight: active ? 600 : 400,
        fontSize: 12,
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
        height: 26,
        background: active ? 'var(--spine-accent-dim)' : 'transparent',
        color: active ? 'white' : 'var(--spine-text)',
        fontSize: 13,
      }}
    >
      <span
        className="flex items-center gap-2 px-2 shrink-0"
        style={{ width: 100 }}
      >
        <span style={{ width: 16, height: 16, display: 'flex' }}>{icon}</span>
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
              fontSize: 11,
              height: 22,
          outline: 'none',
          width: 55,
              minWidth: 0,
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
              fontSize: 11,
              height: 22,
          outline: 'none',
          width: 55,
              minWidth: 0,
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
            fontSize: 11,
            height: 22,
            outline: 'none',
            width: 55,
            minWidth: 0,
          }}
        />
      )}
      <span
        className="flex items-center justify-center shrink-0"
        style={{ width: 18, height: 22, color: 'var(--spine-text-dim)' }}
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
        background: active ? 'var(--spine-accent-dim)' : 'transparent',
        color: active ? 'white' : 'var(--spine-text)',
        fontWeight: active ? 600 : 400,
        fontSize: 12,
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
//  inline SVG 图标（占位，16×16）
// ============================================================
const ICON_PROPS = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor' };

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
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M3 8 A5 5 0 1 1 8 13" />
      <path d="M3 8 L5.5 5.5 M3 8 L6 6" />
      <text x="8" y="11" textAnchor="middle" fontSize="6" fill="currentColor" stroke="none" fontWeight="600">°</text>
    </svg>
  );
}

function IconMove() {
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M8 2 L8 14 M2 8 L14 8" />
      <path d="M8 2 L5 5 L11 5 Z M8 14 L5 11 L11 11 Z" fill="currentColor" />
      <path d="M2 8 L5 5 L5 11 Z M14 8 L11 5 L11 11 Z" fill="currentColor" />
    </svg>
  );
}

function IconScale() {
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 14 L14 2" />
      <path d="M2 4 L4 2 L2 2 L2 4 Z M14 12 L12 14 L14 14 L14 12 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconShear() {
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2 4 L9 4 L13 12 L6 12 Z" />
      <path d="M11 2 L11 6 L14 4 Z" fill="currentColor" stroke="none" />
    </svg>
  );
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
  return (
    <svg {...ICON_PROPS} fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6 10 L10 6" strokeLinecap="round" />
      <circle cx="5" cy="11" r="2" />
      <circle cx="11" cy="5" r="2" />
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
