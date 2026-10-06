import { useMemo } from 'react';
import { usePixiBonesStore, type BoneNode } from './store';

/**
 * 骨骼层级树（Spine 风格 · setup 模式）
 *
 *   - 树状展示根骨及其后代
 *   - 每行：左图标 · 骨名称 · +加子骨按钮
 *   - 点击行 = 选中该骨
 *   - 选中态和 PropertyPanel、BoneEditor 双向同步（共享 store.selectedBoneId）
 *
 * Spine 原版层级树在右侧面板上半部分，本组件可以独立渲染或塞进 PropertyPanel。
 */

// 根骨在 bones 数组里 parentId === null；按 parentId 构建邻接表
function buildChildMap(nodes: BoneNode[]): Map<string | null, BoneNode[]> {
  const m = new Map<string | null, BoneNode[]>();
  for (const n of nodes) {
    const list = m.get(n.parentId) ?? [];
    list.push(n);
    m.set(n.parentId, list);
  }
  return m;
}

export function HierarchyPanel() {
  const bones = usePixiBonesStore((s) => s.bones);
  const selectedBoneId = usePixiBonesStore((s) => s.selectedBoneId);
  const selectBone = usePixiBonesStore((s) => s.selectBone);
  const addBone = usePixiBonesStore((s) => s.addBone);

  const childMap = useMemo(() => buildChildMap(bones), [bones]);
  const rootNodes = childMap.get(null) ?? [];

  const handleAddChild = (parentId: string) => {
    addBone(parentId);
  };

  return (
    <div className="flex flex-col overflow-hidden text-sm p-3 gap-2" style={{ minHeight: 0 }}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">🦴 层级树</h2>
        <span className="text-[10px] text-gray-500">{bones.length} 骨</span>
      </div>

      <div className="flex-1 overflow-y-auto bg-gray-900/50 rounded" style={{ minHeight: 80 }}>
        {rootNodes.length === 0 ? (
          <div className="text-xs text-gray-500 text-center py-6">还没有骨骼</div>
        ) : (
          <ul className="py-1">
            {rootNodes.map((root) => (
              <BoneNodeItem
                key={root.id}
                node={root}
                depth={0}
                selectedBoneId={selectedBoneId}
                onSelect={selectBone}
                onAddChild={handleAddChild}
                childMap={childMap}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface BoneNodeItemProps {
  node: BoneNode;
  depth: number;
  selectedBoneId: string | null;
  onSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
  childMap: Map<string | null, BoneNode[]>;
}

function BoneNodeItem(props: BoneNodeItemProps) {
  const { node, depth, selectedBoneId, onSelect, onAddChild, childMap } = props;
  const children = childMap.get(node.id) ?? [];
  const isSelected = selectedBoneId === node.id;
  const isRoot = depth === 0;

  return (
    <li>
      <div
        className={
          'group flex items-center gap-1 pr-1 rounded cursor-pointer text-gray-200 select-none ' +
          (isSelected ? 'bg-blue-700/60 text-white' : 'hover:bg-gray-700/60')
        }
        style={{
          paddingLeft: 4 + depth * 14,
          height: 22,
        }}
        onClick={() => onSelect(node.id)}
      >
        {/* 左侧占位图标：根骨用圆点；非根骨用竖线模拟"骨线"小图 */}
        <span className="w-4 h-4 flex items-center justify-center text-[10px] shrink-0 text-gray-400">
          {isRoot ? '●' : '│'}
        </span>

        {/* 骨名称 */}
        <span
          className="truncate flex-1 text-xs"
          title={node.name}
          style={{ fontWeight: isSelected ? 600 : 400 }}
        >
          {node.name}
        </span>

        {/* 右侧 + 按钮（hover 才显示；点 = 给它加一个子骨） */}
        <button
          className="w-4 h-4 flex items-center justify-center text-xs shrink-0 text-gray-400 opacity-0 group-hover:opacity-100 hover:text-white"
          onClick={(e) => {
            e.stopPropagation();
            onAddChild(node.id);
          }}
          title="添加子骨"
        >
          +
        </button>
      </div>

      {/* 子骨递归 */}
      {children.length > 0 && (
        <ul>
          {children.map((c) => (
            <BoneNodeItem
              key={c.id}
              node={c}
              depth={depth + 1}
              selectedBoneId={selectedBoneId}
              onSelect={onSelect}
              onAddChild={onAddChild}
              childMap={childMap}
            />
          ))}
        </ul>
      )}
    </li>
  );
}