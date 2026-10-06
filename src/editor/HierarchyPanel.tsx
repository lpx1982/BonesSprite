import { useMemo, useState, useEffect, useRef } from 'react';
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
  const [popoverOpen, setPopoverOpen] = useState(false);  // ≡ 按钮的小弹层
  const popoverWrapRef = useRef<HTMLDivElement>(null);

  // 点 popover 外面关闭
  useEffect(() => {
    if (!popoverOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (popoverWrapRef.current && !popoverWrapRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [popoverOpen]);

  // 关闭整个层级树面板（由 popover "关闭" 项触发）
  const closePanel = () => {
    usePixiBonesStore.getState().toggleRightPanel();
    usePixiBonesStore.getState().toggleViewHierarchy();
    setPopoverOpen(false);
  };

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

  // ===== Spine 暗灰配色（直接读 CSS 变量，避免改 Tailwind 主题）=====
  const C = {
    panel:    'var(--spine-bg-panel)',       // #393939 — 面板底
    panelDk:  'var(--spine-bg-panel-dark)',  // #252526 — 深底
    toolbar:  'var(--spine-bg-toolbar)',     // #1F1F1F — header/工具栏底
    border:   'var(--spine-border)',         // #1A1A1A — 分割线
    text:     'var(--spine-text)',            // #BBBBBB — 主文字
    dim:      'var(--spine-text-dim)',       // #777777 — 次文字
    accent:   'var(--spine-accent)',         // #4FB8F8 — 蓝主色
    accentDk: 'var(--spine-accent-dim)',     // #1A6395 — 蓝深色（选中态）
    selected: 'var(--spine-bone-selected)',  // #F0E020 — 骨选中黄
    warning:  'var(--spine-warning)',        // #F0A020 — 警示
  };

  return (
    <aside
      className="w-72 flex flex-col overflow-hidden text-sm hierarchy-pop-enter"
      style={{ background: C.panel, color: C.text, borderLeft: '1px solid ' + C.border, transformOrigin: 'top right' }}
    >
      {/* ============ 顶部：标题 + 折叠按钮 ============ */}
      <div
        className="flex items-center px-2 py-1.5"
        style={{ borderBottom: '1px solid ' + C.border, background: C.toolbar }}
      >
        <button
          className="flex items-center gap-1 text-xs font-semibold"
          style={{ color: C.text, background: 'transparent', border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={(e) => (e.currentTarget.style.color = C.text)}
          onClick={() => setShowTree((v) => !v)}
          title={showTree ? '折叠层级树' : '展开层级树'}
        >
          <span style={{ color: C.warning }}>↳</span>
          <span>层级树</span>
          <span style={{ color: C.dim, fontSize: 10, marginLeft: 4 }}>{bones.length} 骨</span>
        </button>
        <div className="ml-auto flex items-center gap-1" style={{ color: C.dim, position: 'relative' }} ref={popoverWrapRef}>
          {/* ✕ 全部展开（占位，目前点开树） */}
          <button
            style={{ color: C.dim, background: 'transparent', border: 'none', padding: '0 4px', cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
            onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)}
            title="全部展开"
            onClick={() => setShowTree(true)}
          >✕</button>
          {/* ≡ 弹层：最小化 / 关闭 */}
          <button
            style={{ color: popoverOpen ? '#fff' : C.dim, background: 'transparent', border: 'none', padding: '0 4px', cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
            onMouseLeave={(e) => { if (!popoverOpen) e.currentTarget.style.color = C.dim; }}
            title="面板选项"
            onClick={() => setPopoverOpen((v) => !v)}
          >≡</button>
          {/* 弹层（最小化 / 关闭） */}
          {popoverOpen && (
            <div
              className="absolute z-50 shadow-xl"
              style={{
                top: '100%',
                right: 0,
                marginTop: 4,
                minWidth: 180,
                background: C.panel,
                border: '1px solid ' + C.border,
                borderRadius: 4,
                padding: '2px 0',
              }}
            >
              {/* 最小化（高亮蓝） */}
              <button
                className="w-full flex items-center justify-between"
                style={{
                  height: 22,
                  padding: '0 10px',
                  background: 'transparent',
                  border: 'none',
                  color: C.text,
                  fontSize: 12,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => {
                  setShowTree(false);
                  setPopoverOpen(false);
                }}
              >
                <span style={{ color: C.accent, fontWeight: 600 }}>最小化</span>
                <span style={{ color: C.dim, fontSize: 11 }}>右键单击</span>
              </button>
              {/* 关闭 */}
              <button
                className="w-full flex items-center justify-between"
                style={{
                  height: 22,
                  padding: '0 10px',
                  background: 'transparent',
                  border: 'none',
                  color: C.text,
                  fontSize: 12,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={closePanel}
              >
                <span>关闭</span>
                <span style={{ color: C.dim, fontSize: 11 }}>双击</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ============ 搜索框 + 8 个工具按钮（Spine 风格占位）============ */}
      {showTree && (
        <>
          <div
            className="px-2 py-1.5 flex items-center gap-1"
            style={{ borderBottom: '1px solid ' + C.border, background: C.panel }}
          >
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索骨骼"
              className="flex-1 rounded px-2 py-1 text-xs focus:outline-none"
              style={{
                background: C.panelDk,
                border: '1px solid ' + C.border,
                color: C.text,
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = C.accent)}
              onBlur={(e) => (e.currentTarget.style.borderColor = C.border)}
            />
            <button className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white" title="上">↶</button>
            <button className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white" title="下">↷</button>
          </div>

          {/* 8 个工具按钮（Spine 顶部条：编辑/可见/连接/选中/移动/复制/复制设置/粘贴） */}
          <div
            className="px-2 py-1 flex items-center justify-between"
            style={{ borderBottom: '1px solid ' + C.border, background: C.panelDk }}
          >
            <ToolBtn icon="✏" title="编辑骨骼" C={C} />
            <ToolBtn icon="◉" title="可见性" C={C} />
            <ToolBtn icon="🔗" title="链接" C={C} />
            <ToolBtn icon="⛶" title="选中" active C={C} />
            <ToolBtn icon="🔍" title="缩放" C={C} />
            <ToolBtn icon="📋" title="复制" C={C} />
            <ToolBtn icon="📑" title="复制设置" C={C} />
            <ToolBtn icon="📥" title="粘贴" C={C} />
          </div>

          {/* 树主体：眼/锁头列 + 列表 */}
          <div className="flex flex-1 min-h-0">
            {/* 左列：👁 / 🔒 按 depth 排 */}
            <div
              className="w-4 flex flex-col"
              style={{ background: C.panelDk, borderRight: '1px solid ' + C.border }}
            >
              {filteredRoots.map((root) => (
                <BoneIconColumn
                  key={root.id}
                  node={root}
                  depth={0}
                  selectedBoneId={selectedBoneId}
                  childMap={childMap}
                  C={C}
                />
              ))}
            </div>

            {/* 右列：骨树 */}
            <div className="flex-1 overflow-y-auto" style={{ background: C.panelDk }}>
              {filteredRoots.length === 0 ? (
                <div className="text-xs text-center py-6" style={{ color: C.dim }}>
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
                      C={C}
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
          C={C}
        />
      )}
    </aside>
  );
}

// =================================================================================
//  顶部工具按钮（占位 icon，目前无字体实现）
// =================================================================================
function ToolBtn({ icon, title, active, C }: { icon: string; title: string; active?: boolean; C: any }) {
  return (
    <button
      className="w-6 h-6 flex items-center justify-center text-xs rounded"
      style={{
        background: active ? C.accentDk : 'transparent',
        color: active ? '#fff' : C.dim,
        border: 'none',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
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
  C: any;
}

function BoneNodeItem(props: BoneNodeItemProps) {
  const { node, depth, selectedBoneId, onSelect, onAddChild, childMap, search, C } = props;
  const children = childMap.get(node.id) ?? [];
  const isSelected = selectedBoneId === node.id;
  const isRoot = depth === 0;

  // 高亮搜索匹配片段
  const nameEl = search && node.name.toLowerCase().includes(search.toLowerCase()) ? (
    <Highlight text={node.name} q={search} C={C} />
  ) : node.name;

  return (
    <li>
      <div
        className="group flex items-center pr-1 rounded cursor-pointer select-none"
        style={{
          paddingLeft: 4 + depth * 12,
          height: 22,
          background: isSelected ? C.accentDk : 'transparent',
          color: isSelected ? '#fff' : C.text,
          fontWeight: isSelected ? 600 : 400,
        }}
        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
        onClick={() => onSelect(node.id)}
      >
        {/* 左侧骨图标：根骨十字 / 非根骨骨线 */}
        <span className="w-4 h-4 flex items-center justify-center text-[10px] shrink-0 mr-0.5" style={{ color: isSelected ? '#fff' : C.dim }}>
          {isRoot ? '✦' : '│'}
        </span>

        {/* 骨名称 */}
        <span
          className="truncate flex-1 text-xs"
          title={node.name}
        >
          {nameEl}
        </span>

        {/* 右侧 + 按钮（hover 才显示） */}
        <button
          className="w-4 h-4 flex items-center justify-center text-xs shrink-0 opacity-0 group-hover:opacity-100"
          style={{ color: C.text, background: 'transparent', border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={(e) => (e.currentTarget.style.color = C.text)}
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
              C={C}
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
  C: any;
}) {
  const { node, depth, selectedBoneId, childMap, C } = props;
  const children = childMap.get(node.id) ?? [];
  const isSelected = selectedBoneId === node.id;
  return (
    <>
      <div
        className="h-[22px] flex items-center justify-center text-[10px]"
        title={node.name}
        style={{ color: isSelected ? C.accent : C.dim, paddingLeft: 0 }}
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
          C={C}
        />
      ))}
    </>
  );
}

// =================================================================================
//  搜索高亮
// =================================================================================
function Highlight({ text, q, C }: { text: string; q: string; C: any }) {
  const lower = text.toLowerCase();
  const lq = q.toLowerCase();
  const i = lower.indexOf(lq);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="rounded px-0.5" style={{ background: C.warning, color: '#000' }}>{text.slice(i, i + q.length)}</span>
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
  C: any;
}

function BonePropsBlock(props: BonePropsBlockProps) {
  const { node, parentOptions, onMove, onRotate, onLength, onParent, onAddChild, onDelete, onToggleIsolate, isolated, C } = props;
  const rotDeg = (node.rotation * 180) / Math.PI;
  // 输入框统一样式
  const inputStyle: React.CSSProperties = {
    background: C.panelDk,
    border: '1px solid ' + C.border,
    color: C.text,
    borderRadius: 3,
    padding: '2px 6px',
    fontSize: 11,
  };
  return (
    <div style={{ borderTop: '1px solid ' + C.border, background: C.panelDk }}>
      {/* 第一行：骨名 + 图标按钮 */}
      <div className="flex items-center px-2 py-1.5" style={{ background: C.toolbar, borderBottom: '1px solid ' + C.border }}>
        <span className="text-xs font-semibold flex-1 truncate" style={{ color: C.selected }} title={node.name}>
          🦴 {node.name}
        </span>
        <button className="w-6 h-6 flex items-center justify-center" style={{ color: C.dim, background: 'transparent', border: 'none', cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')} onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)} title="定位到画布" onClick={onToggleIsolate}>
          {isolated ? '🟢' : '📍'}
        </button>
        <button className="w-6 h-6 flex items-center justify-center" style={{ color: C.dim, background: 'transparent', border: 'none', cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')} onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)} title="复制">⎘</button>
        <button className="w-6 h-6 flex items-center justify-center" style={{ color: C.dim, background: 'transparent', border: 'none', cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.color = '#e88')} onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)} title="删除" onClick={onDelete}>✕</button>
      </div>

      {/* 第二行：继承 / 旋转 / 缩放 / 反射 checkbox */}
      <div className="px-2 py-1 grid grid-cols-4 gap-1 text-[10px]">
        <CheckChip label="继承" defaultChecked C={C} />
        <CheckChip label="旋转" defaultChecked C={C} />
        <CheckChip label="缩放" defaultChecked C={C} />
        <CheckChip label="反射" defaultChecked C={C} />
      </div>

      {/* 第三行：长度 / 选择 / 名称 */}
      <div className="px-2 pb-1.5 flex items-center gap-2 text-xs">
        <span className="shrink-0" style={{ color: C.dim }}>📏 长度</span>
        <input
          type="number"
          value={Math.round(node.length * 100) / 100}
          step={1}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onLength(v);
          }}
          className="flex-1 w-0 min-w-0"
          style={inputStyle}
        />
        <CheckChip label="选择" defaultChecked C={C} />
        <CheckChip label="名称" defaultChecked C={C} />
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
          style={inputStyle}
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
          style={inputStyle}
        />
      </div>

      {/* 第五行：Rotation (°) */}
      <div className="px-2 pb-1.5 flex items-center gap-2 text-xs">
        <span className="shrink-0 w-12" style={{ color: C.dim }}>↻ Rotation</span>
        <input
          type="number"
          value={Math.round(rotDeg * 100) / 100}
          step={1}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onRotate(v);
          }}
          className="flex-1 w-0 min-w-0"
          style={inputStyle}
        />
      </div>

      {/* 父级下拉 */}
      <div className="px-2 pb-1.5 flex items-center gap-2 text-xs">
        <span className="shrink-0 w-12" style={{ color: C.dim }}>父级</span>
        <select
          value={node.parentId ?? ''}
          onChange={(e) => onParent(e.target.value || null)}
          className="flex-1"
          style={inputStyle}
        >
          <option value="">(根)</option>
          {parentOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* 第六行：底部操作按钮（新建 / 父级 / 拆分 / 皮肤） */}
      <div className="px-2 pb-2 grid grid-cols-4 gap-1 text-[10px]">
        <button onClick={onAddChild} className="rounded px-1 py-1 flex items-center justify-center gap-0.5" style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border, cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)} onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}>
          <span style={{ color: C.accent }}>+</span> 新建
        </button>
        <button className="rounded px-1 py-1 flex items-center justify-center gap-0.5" style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border, cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)} onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}>
          <span>↗</span> 父级
        </button>
        <button className="rounded px-1 py-1 flex items-center justify-center gap-0.5" style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border, cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)} onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}>
          <span>✂</span> 拆分
        </button>
        <button className="rounded px-1 py-1 flex items-center justify-center gap-0.5 relative" style={{ background: 'rgba(230,30,30,0.15)', color: '#e88', border: '1px solid rgba(230,30,30,0.3)', cursor: 'pointer' }}>
          <span>🧴</span> 皮肤
          <span className="absolute -top-1 -right-1 text-[8px] px-0.5 font-bold" style={{ background: C.warning, color: '#000', borderRadius: 2 }}>PRO</span>
        </button>
      </div>
    </div>
  );
}

function CheckChip({ label, defaultChecked, C }: { label: string; defaultChecked?: boolean; C: any }) {
  return (
    <label className="flex items-center gap-1 cursor-pointer select-none" style={{ color: C.text }}>
      <input type="checkbox" defaultChecked={defaultChecked} className="w-3 h-3" />
      <span>{label}</span>
    </label>
  );
}