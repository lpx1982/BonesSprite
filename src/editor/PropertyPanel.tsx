import { useMemo } from 'react';
import { usePixiBonesStore, findBone, type BoneNode } from './store';
import type { PixiBonesLayer, PixiBonesPsd } from '@psd/types';

/**
 * Day 3 · 右侧属性面板
 *   - 选中骨时：显示 x/y/rotation/length 数字输入 + 父级下拉 + 删除按钮
 *   - 选中图层时：显示图层名 + opacity
 *   - 都没选时：空态 + "添加根骨"按钮
 */
export function PropertyPanel() {
  const bones = usePixiBonesStore((s) => s.bones);
  const selectedBoneId = usePixiBonesStore((s) => s.selectedBoneId);
  const psd = usePixiBonesStore((s) => s.psd);
  const selectedLayerId = usePixiBonesStore((s) => s.selectedLayerId);

  const selectedBone = selectedBoneId ? findBone(bones, selectedBoneId) : null;
  const selectedLayer = selectedLayerId && psd ? findLayerInPsd(psd, selectedLayerId) : null;

  const mode: 'bone' | 'layer' | 'none' = selectedBone
    ? 'bone'
    : selectedLayer
    ? 'layer'
    : 'none';

  return (
    <aside className="w-72 bg-gray-800 text-white p-3 flex flex-col gap-3 text-sm overflow-hidden">
      <h2 className="font-semibold">属性面板</h2>

      {mode === 'bone' && selectedBone && (
        <BoneProps node={selectedBone} allBones={bones} />
      )}

      {mode === 'layer' && selectedLayer && (
        <LayerProps layer={selectedLayer} />
      )}

      {mode === 'none' && (
        <div className="text-xs text-gray-500 text-center py-4">
          选中图层或骨查看属性
        </div>
      )}

      <div className="mt-auto pt-3 border-t border-gray-700 text-xs text-gray-500">
        Day 3 · 拖 tip handle 移位 / 拖 gizmo 旋转
      </div>
    </aside>
  );
}

// ============================================================
//  骨属性
// ============================================================
function BoneProps({ node, allBones }: { node: BoneNode; allBones: BoneNode[] }) {
  const moveBone = usePixiBonesStore((s) => s.moveBone);
  const setBoneRotation = usePixiBonesStore((s) => s.setBoneRotation);
  const setBoneLength = usePixiBonesStore((s) => s.setBoneLength);
  const setBoneParent = usePixiBonesStore((s) => s.setBoneParent);
  const removeBone = usePixiBonesStore((s) => s.removeBone);
  const addBone = usePixiBonesStore((s) => s.addBone);

  const parentOptions = useMemo(
    () =>
      allBones
        .filter((b) => b.id !== node.id)
        .map((b) => ({ id: b.id, name: b.name })),
    [allBones, node.id],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 flex-1 truncate">🦴 {node.name}</span>
        <span className="text-[10px] text-gray-500">{node.id}</span>
      </div>

      <NumField
        label="X"
        value={node.x}
        step={1}
        onChange={(v) => moveBone(node.id, v, node.y)}
      />
      <NumField
        label="Y"
        value={node.y}
        step={1}
        onChange={(v) => moveBone(node.id, node.x, v)}
      />
      <NumField
        label="Rotation (°)"
        value={(node.rotation * 180) / Math.PI}
        step={1}
        onChange={(v) => setBoneRotation(node.id, (v * Math.PI) / 180)}
      />
      <NumField
        label="Length"
        value={node.length}
        step={1}
        onChange={(v) => setBoneLength(node.id, v)}
      />

      <div>
        <label className="text-xs text-gray-400 block mb-1">父级</label>
        <select
          value={node.parentId ?? ''}
          onChange={(e) => setBoneParent(node.id, e.target.value || null)}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs"
        >
          <option value="">(根)</option>
          {parentOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-2 pt-2">
        <button
          className="flex-1 px-2 py-1 bg-green-700 hover:bg-green-600 rounded text-xs"
          onClick={() => addBone(node.id)}
        >
          + 子骨
        </button>
        <button
          className="flex-1 px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-xs"
          onClick={() => {
            if (confirm(`删除 "${node.name}" 及其子骨？`)) removeBone(node.id);
          }}
        >
          删除
        </button>
      </div>
    </div>
  );
}

// ============================================================
//  图层属性
// ============================================================
function LayerProps({ layer }: { layer: PixiBonesLayer }) {
  const addBone = usePixiBonesStore((s) => s.addBone);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 flex-1 truncate">🖼 {layer.name}</span>
      </div>

      <KV label="位置" value={`${layer.left}, ${layer.top}`} />
      <KV label="尺寸" value={`${layer.width} × ${layer.height}`} />
      <KV label="透明度" value={`${(layer.opacity * 100).toFixed(0)}%`} />
      <KV label="混合" value={layer.blendMode} />

      <button
        className="w-full mt-3 px-3 py-2 bg-green-700 hover:bg-green-600 rounded text-xs"
        onClick={() => {
          // 在图层中心创建一根根骨
          addBone(null, {
            x: layer.left + layer.width / 2,
            y: layer.top + layer.height / 2,
            length: Math.max(20, layer.width / 4),
            layerId: layer.id,
          });
        }}
      >
        + 在此图层创建根骨
      </button>
    </div>
  );
}

// ============================================================
//  小工具
// ============================================================
interface NumFieldProps {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}
function NumField({ label, value, step = 1, onChange }: NumFieldProps) {
  return (
    <div>
      <label className="text-xs text-gray-400 block mb-0.5">{label}</label>
      <input
        type="number"
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        step={step}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs"
      />
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-gray-400 w-16">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function findLayerInPsd(psd: PixiBonesPsd, id: string): PixiBonesLayer | null {
  const visit = (layers: PixiBonesLayer[]): PixiBonesLayer | null => {
    for (const l of layers) {
      if (l.id === id) return l;
      const r = visit(l.children);
      if (r) return r;
    }
    return null;
  };
  return visit(psd.layers);
}
