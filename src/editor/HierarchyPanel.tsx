import { useMemo, useState } from 'react';
import { usePixiBonesStore, findBone, type BoneNode } from './store';

/**
 * 层级树面板（Spine 风格 · setup 模式）
 *
 *   整个右侧面板 = 顶部搜索 + 工具按钮条 + 树列表 + 选中骨属性块
 *
 *   - 树状展示根骨及其后代
 *   - 每行：👁 可见 · 🔒 锁定 · 骨图标 · 骨名称 · +加子骨
 *   - 点击行 = 选中该骨（同步画布黄色高亮 + 底部属性块）
 *   - 底部"骨骼: xxx"属性块：长度、继承、旋转/缩放/反射 checkbox
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
  const removeBone = usePixiBonesStore((s) => s.removeBone);
  const moveBone = usePixiBonesStore((s) => s.moveBone);
  const setBoneRotation = usePixiBonesStore((s) => s.setBoneRotation);
  const setBoneLength = usePixiBonesStore((s) => s.setBoneLength);
  const setBoneParent = usePixiBonesStore((s) => s.setBoneParent);

  const [search, setSearch] = useState('');
  const [showTree, setShowTree] = useState(true);  // 🔼 折叠 / 展开树
  const [hideNonSelected, setHideNonSelected] = useState(false);  // 仅显示选中骨及其后代

  const childMap = useMemo(() => buildChildMap(bones), [bones]);
  const rootNodes = childMap.get(null) ?? [];

  const selectedBone = selectedBoneId ? findBone(bones, selectedBoneId) : null;

  // 过滤后的根集合（搜索匹配或隐藏非选中模式）
  const filteredRoots = useMemo(() => {
    let list = rootNodes;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((n) => n.name.toLowerCase().includes(q));
    }
    if (hideNonSelected && selectedBoneId) {
      // 选中骨的祖先链 + 自身 + 后代：保留选中骨那一条分支
      const ancestors: string[] = [];
      let cur: string | null = selectedBoneId;
      while (cur) {
        ancestors.push(cur);
        const n = findBone(bones, cur);
        cur = n ? n.parentId : null;
      }
      const visible = new Set(ancestors);
      // 选中骨的后代
      const stack = [selectedBoneId];
      while (stack.length) {
        const id = stack.pop()!;
        const children = childMap.get(id) ?? [];
        for (const c of children) {
          visible.add(c.id);
          stack.push(c.id);
        }
      }
      list = list.filter((n) => visible.has(n.id));
    }
    return list;
  }, [rootNodes, search, hideNonSelected, selectedBoneId, bones, childMap]);

  const parentOptions = useMemo(() => {
    if (!selectedBone) return [];
    return bones.filter((b) => b.id !== selectedBone.id).map((b) => ({ id: b.id, name: b.name }));
  }, [bones, selectedBone]);

  return (
    <aside className="w-72 bg-gray-800 text-white flex flex-col overflow-hidden text-sm">
      {/* ============ 顶部：标题 + 折叠按钮 ============ */}
      <div className="flex items-center px-2 py-1.5 border-b border-gray-700">
        <button
          className="flex items-center gap-1 text-white hover:text-gray-300 text-xs font-semibold"
          onClick={() => setShowTree((v) => !v)}
          title={showTree ? '折叠层级树' : '展开层级树'}
        >
          <span className="text-yellow-400">↳</span>
          <span>层级树</span>
          <span className="text-gray-500 text-[10px] ml-1">{bones.length} 骨</span>
        </button>
        <div className="ml-auto flex items-center gap-1 text-gray-400">
          <button className="px-1 hover:text-white" title="全部展开">✕</button>
          <button className="px-1 hover:text-white" title="排序">≡</button>
        </div>
      </div>

      {/* ============ 搜索框 + 8 个工具按钮（Spine 风格占位）============ */}
      {showTree && (
        <>
          <div className="px-2 py-1.5 border-b border-gray-700 flex items-center gap-1">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索骨骼"
              className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-gray-500"
            />
            <button className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white" title="上">↶</button>
            <button className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white" title="下">↷</button>
          </div>

          {/* 8 个工具按钮（Spine 顶部条：编辑/可见/连接/选中/移动/复制/复制设置/粘贴） */}
          <div className="px-2 py-1 border-b border-gray-700 flex items-center justify-between">
            <ToolBtn icon="✏" title="编辑骨骼" />
            <ToolBtn icon="◉" title="可见性" />
            <ToolBtn icon="🔗" title="链接" />
            <ToolBtn icon="⛶" title="选中" active />
            <ToolBtn icon="🔍" title="缩放" />
            <ToolBtn icon="📋" title="复制" />
            <ToolBtn icon="📑" title="复制设置" />
            <ToolBtn icon="📥" title="粘贴" />
          </div>

          {/* 树主体：眼/锁头列 + 列表 */}
          <div className="flex flex-1 min-h-0">
            {/* 左列：👁 / 🔒 按 depth 排 */}
            <div className="w-4 bg-gray-900/30 border-r border-gray-700 flex flex-col">
              {filteredRoots.map((root) => (
                <BoneIconColumn
                  key={root.id}
                  node={root}
                  depth={0}
                  selectedBoneId={selectedBoneId}
                  childMap={childMap}
                />
              ))}
            </div>

            {/* 右列：骨树 */}
            <div className="flex-1 overflow-y-auto bg-gray-900/50">
              {filteredRoots.length === 0 ? (
                <div className="text-xs text-gray-500 text-center py-6">
                  {search ? '没有匹配的骨' : '还没有骨骼'}
                </div>
              ) : (
                <ul className="py-1">
                  {filteredRoots.map((root) => (
                    <BoneNodeItem
                      key={root.id}
                      node={root}
                      depth={0}
                      selectedBoneId={selectedBoneId}
                      onSelect={selectBone}
                      onAddChild={(id) => addBone(id)}
                      childMap={childMap}
                      search={search}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      {/* ============ 底部：选中骨的属性块（Spine "骨骼: bone3" 风格）============ */}
      {selectedBone && (
        <BonePropsBlock
          node={selectedBone}
          parentOptions={parentOptions}
          onMove={(x, y) => moveBone(selectedBone.id, x, y)}
          onRotate={(d) => setBoneRotation(selectedBone.id, (d * Math.PI) / 180)}
          onLength={(l) => setBoneLength(selectedBone.id, l)}
          onParent={(pid) => setBoneParent(selectedBone.id, pid)}
          onAddChild={() => addBone(selectedBone.id)}
          onDelete={() => {
            if (confirm(`删除 "${selectedBone.name}" 及其子骨？`)) removeBone(selectedBone.id);
          }}
          onToggleIsolate={() => setHideNonSelected((v) => !v)}
          isolated={hideNonSelected}
        />
      )}
    </aside>
  );
}

// =================================================================================
//  顶部工具按钮（占位 icon，目前无字体实现）
// =================================================================================
function ToolBtn({ icon, title, active }: { icon: string; title: string; active?: boolean }) {
  return (
    <button
      className={
        'w-6 h-6 flex items-center justify-center text-xs rounded ' +
        (active ? 'bg-blue-700/60 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700/60')
      }
      title={title}
    >
      {icon}
    </button>
  );
}

// =================================================================================
//  骨树行（递归）
// =================================================================================
interface BoneNodeItemProps {
  node: BoneNode;
  depth: number;
  selectedBoneId: string | null;
  onSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
  childMap: Map<string | null, BoneNode[]>;
  search: string;
}

function BoneNodeItem(props: BoneNodeItemProps) {
  const { node, depth, selectedBoneId, onSelect, onAddChild, childMap, search } = props;
  const children = childMap.get(node.id) ?? [];
  const isSelected = selectedBoneId === node.id;
  const isRoot = depth === 0;

  // 高亮搜索匹配片段
  const nameEl = search && node.name.toLowerCase().includes(search.toLowerCase()) ? (
    <Highlight text={node.name} q={search} />
  ) : node.name;

  return (
    <li>
      <div
        className={
          'group flex items-center pr-1 rounded cursor-pointer text-gray-200 select-none ' +
          (isSelected ? 'bg-blue-700/70 text-white' : 'hover:bg-gray-700/60')
        }
        style={{
          paddingLeft: 4 + depth * 12,
          height: 22,
        }}
        onClick={() => onSelect(node.id)}
      >
        {/* 左侧骨图标：根骨十字 / 非根骨骨线 */}
        <span className="w-4 h-4 flex items-center justify-center text-[10px] shrink-0 text-gray-400 mr-0.5">
          {isRoot ? '✦' : '│'}
        </span>

        {/* 骨名称 */}
        <span
          className="truncate flex-1 text-xs"
          title={node.name}
          style={{ fontWeight: isSelected ? 600 : 400 }}
        >
          {nameEl}
        </span>

        {/* 右侧 + 按钮（hover 才显示） */}
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
              search={search}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// =================================================================================
//  左列：👁 / 🔒 列（按 depth 平铺，所有骨用同一缩进）
// =================================================================================
function BoneIconColumn(props: {
  node: BoneNode;
  depth: number;
  selectedBoneId: string | null;
  childMap: Map<string | null, BoneNode[]>;
}) {
  const { node, depth, selectedBoneId, childMap } = props;
  const children = childMap.get(node.id) ?? [];
  const isSelected = selectedBoneId === node.id;
  return (
    <>
      <div
        className={
          'h-[22px] flex items-center justify-center text-[10px] ' +
          (isSelected ? 'text-blue-400' : 'text-gray-400')
        }
        title={node.name}
        style={{ paddingLeft: 0 }}
      >
        {/* Spine 风格：左边第一列是隐藏 toggle（👁），第二列是锁定（🔒） */}
        👁
      </div>
      {/* 对齐到右边树列每一行，不放行也跳过子列递归 */}
      {children.map((c) => (
        <BoneIconColumn
          key={c.id}
          node={c}
          depth={depth + 1}
          selectedBoneId={selectedBoneId}
          childMap={childMap}
        />
      ))}
    </>
  );
}

// =================================================================================
//  搜索高亮
// =================================================================================
function Highlight({ text, q }: { text: string; q: string }) {
  const lower = text.toLowerCase();
  const lq = q.toLowerCase();
  const i = lower.indexOf(lq);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="bg-yellow-500 text-black rounded px-0.5">{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}

// =================================================================================
//  选中骨的属性块（Spine 风格底部：继承 / 旋转 / 缩放 / 反射 checkbox + 长度输入）
// =================================================================================
interface BonePropsBlockProps {
  node: BoneNode;
  parentOptions: Array<{ id: string; name: string }>;
  onMove: (x: number, y: number) => void;
  onRotate: (deg: number) => void;
  onLength: (l: number) => void;
  onParent: (pid: string | null) => void;
  onAddChild: () => void;
  onDelete: () => void;
  onToggleIsolate: () => void;
  isolated: boolean;
}

function BonePropsBlock(props: BonePropsBlockProps) {
  const { node, parentOptions, onMove, onRotate, onLength, onParent, onAddChild, onDelete, onToggleIsolate, isolated } = props;
  const rotDeg = (node.rotation * 180) / Math.PI;
  return (
    <div className="border-t border-gray-700 bg-gray-900/40">
      {/* 第一行：骨名 + 图标按钮 */}
      <div className="flex items-center px-2 py-1.5">
        <span className="text-xs text-white font-semibold flex-1 truncate" title={node.name}>
          🦴 {node.name}
        </span>
        <button className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white" title="定位到画布" onClick={onToggleIsolate}>
          {isolated ? '🟢' : '📍'}
        </button>
        <button className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white" title="复制">⎘</button>
        <button className="w-6 h-6 flex items-center justify-center text-red-400 hover:text-red-300" title="删除" onClick={onDelete}>✕</button>
      </div>

      {/* 第二行：继承 / 旋转 / 缩放 / 反射 checkbox */}
      <div className="px-2 pb-1 grid grid-cols-4 gap-1 text-[10px]">
        <CheckChip label="继承" defaultChecked />
        <CheckChip label="旋转" defaultChecked />
        <CheckChip label="缩放" defaultChecked />
        <CheckChip label="反射" defaultChecked />
      </div>

      {/* 第三行：长度 / 选择 / 名称 */}
      <div className="px-2 pb-1.5 flex items-center gap-2 text-xs">
        <span className="text-gray-400 shrink-0">📏 长度</span>
        <input
          type="number"
          value={Math.round(node.length * 100) / 100}
          step={1}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onLength(v);
          }}
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs w-0 min-w-0"
        />
        <CheckChip label="选择" defaultChecked />
        <CheckChip label="名称" defaultChecked />
      </div>

      {/* 第四行：X / Y 数字输入 */}
      <div className="px-2 pb-1.5 grid grid-cols-2 gap-2">
        <input
          type="number"
          value={Math.round(node.x * 100) / 100}
          step={1}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onMove(v, node.y);
          }}
          placeholder="X"
          className="bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs"
        />
        <input
          type="number"
          value={Math.round(node.y * 100) / 100}
          step={1}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onMove(node.x, v);
          }}
          placeholder="Y"
          className="bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs"
        />
      </div>

      {/* 第五行：Rotation (°) */}
      <div className="px-2 pb-1.5 flex items-center gap-2 text-xs">
        <span className="text-gray-400 shrink-0 w-12">↻ Rotation</span>
        <input
          type="number"
          value={Math.round(rotDeg * 100) / 100}
          step={1}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onRotate(v);
          }}
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs w-0 min-w-0"
        />
      </div>

      {/* 父级下拉 */}
      <div className="px-2 pb-1.5 flex items-center gap-2 text-xs">
        <span className="text-gray-400 shrink-0 w-12">父级</span>
        <select
          value={node.parentId ?? ''}
          onChange={(e) => onParent(e.target.value || null)}
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs"
        >
          <option value="">(根)</option>
          {parentOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* 第六行：底部操作按钮（新建 / 父级 / 拆分 / 皮肤） */}
      <div className="px-2 pb-2 grid grid-cols-4 gap-1 text-[10px]">
        <button onClick={onAddChild} className="bg-gray-700 hover:bg-gray-600 rounded px-1 py-1 flex items-center justify-center gap-0.5">
          <span className="text-blue-400">+</span> 新建
        </button>
        <button className="bg-gray-700 hover:bg-gray-600 rounded px-1 py-1 flex items-center justify-center gap-0.5">
          <span>↗</span> 父级
        </button>
        <button className="bg-gray-700 hover:bg-gray-600 rounded px-1 py-1 flex items-center justify-center gap-0.5">
          <span>✂</span> 拆分
        </button>
        <button className="bg-red-700 hover:bg-red-600 rounded px-1 py-1 flex items-center justify-center gap-0.5 relative">
          <span>🧴</span> 皮肤
          <span className="absolute -top-1 -right-1 bg-orange-500 text-[8px] text-black px-0.5 rounded font-bold">PRO</span>
        </button>
      </div>
    </div>
  );
}

function CheckChip({ label, defaultChecked }: { label: string; defaultChecked?: boolean }) {
  return (
    <label className="flex items-center gap-1 text-gray-300 cursor-pointer select-none">
      <input type="checkbox" defaultChecked={defaultChecked} className="w-3 h-3" />
      <span>{label}</span>
    </label>
  );
}