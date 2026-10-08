import { useMemo, useState, useEffect, useRef } from 'react';
import { usePixiBonesStore, findBone, orderLayers, type BoneNode, type LayerBinding } from './store';
import { flattenLayers, type PixiBonesLayer } from '@psd/index';
import { importAssetFile } from './importAsset';

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

/** 工程节点（根骨的父节点，仿 Spine 的 skeleton 节点）的折叠 key */
const PROJECT_KEY = '__project__';

/** 骨骼下方的分区节点（仿 Spine：约束 / 绘制顺序 / 皮肤 / 事件 / 动画 / 图片 / 音频） */
const SECTIONS: Array<{ key: string; label: string; icon: string }> = [
  { key: 'constraints', label: '约束',     icon: '🪢' },
  { key: 'drawOrder',   label: '绘制顺序', icon: '📚' },
  { key: 'skins',       label: '皮肤',     icon: '🧥' },
  { key: 'events',      label: '事件',     icon: '🎬' },
  { key: 'animations',  label: '动画',     icon: '🏃' },
  { key: 'images',      label: '图片',     icon: '🖼' },
  { key: 'audio',       label: '音频',     icon: '🔊' },
];

/** 树里的一行（扁平行数组，左列 / 右列共用，保证行对齐） */
interface TreeRow {
  key: string;
  /** slot = 图层插槽节点（◉ 图层名），其下挂一个 asset 行（▪ 图片）—— 仿 Spine */
  kind: 'project' | 'bone' | 'section' | 'asset' | 'slot';
  /** 缩进层级：project=0，根骨/分区=1，更深 = 子骨 / 素材 */
  depth: number;
  /** 是否是同层最后一个（决定连线画「└」还是「├」） */
  isLast: boolean;
  node?: BoneNode;
  /** 素材行（PSD 图层 / 单独导入的图片）对应的数据 */
  asset?: PixiBonesLayer;
  icon: string;
  label: string;
  /** 是否可折叠（有子节点才显示 ⊖/⊕） */
  collapsible: boolean;
}

/** 素材缩略图 dataURL 缓存（toDataURL 较贵，按素材 id 缓存一次）。 */
const thumbCache = new Map<string, string>();
function layerThumb(layer: PixiBonesLayer): string | null {
  if (!layer.canvas || layer.canvas.width === 0) return null;
  let url = thumbCache.get(layer.id);
  if (!url) {
    url = layer.canvas.toDataURL();
    thumbCache.set(layer.id, url);
  }
  return url;
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
  /** 折叠的节点（工程节点 / 骨 id）——折叠后其子树不显示 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const projectName = usePixiBonesStore((s) => s.projectName);
  // 素材（PSD 图层 + 单独导入的图片）相关
  const psd = usePixiBonesStore((s) => s.psd);
  const images = usePixiBonesStore((s) => s.images);
  const layerVisibility = usePixiBonesStore((s) => s.layerVisibility);
  const layerOrder = usePixiBonesStore((s) => s.layerOrder);
  const setLayerOrder = usePixiBonesStore((s) => s.setLayerOrder);
  const selectedLayerId = usePixiBonesStore((s) => s.selectedLayerId);
  const selectedLayerIds = usePixiBonesStore((s) => s.selectedLayerIds);
  const selectLayer = usePixiBonesStore((s) => s.selectLayer);
  const toggleLayerVisibility = usePixiBonesStore((s) => s.toggleLayerVisibility);
  const layerBindings = usePixiBonesStore((s) => s.layerBindings);
  const selectedSectionKey = usePixiBonesStore((s) => s.selectedSectionKey);
  const selectSection = usePixiBonesStore((s) => s.selectSection);
  const startAttach = usePixiBonesStore((s) => s.startAttach);
  const unbindLayer = usePixiBonesStore((s) => s.unbindLayer);
  const importInputRef = useRef<HTMLInputElement>(null);
  // 刷新（清缩略图缓存后强制重渲染）
  const [, setRefreshTick] = useState(0);

  /** 导入素材（.psd → 整个 PSD；图片 → 追加到 images） */
  const onImportFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        await importAssetFile(f);
      } catch (err) {
        console.error('[HierarchyPanel] 素材导入失败:', err);
      }
    }
  };

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
  /** 当前选中的素材（PSD 图层 或 单独导入的图片） */
  const selectedAsset = useMemo<PixiBonesLayer | null>(() => {
    if (!selectedLayerId) return null;
    const inPsd = psd ? flattenLayers(psd).find((l) => l.id === selectedLayerId) : undefined;
    return inPsd ?? images.find((l) => l.id === selectedLayerId) ?? null;
  }, [selectedLayerId, psd, images]);

  /** 所有素材（按绘制顺序排列）——层级树 & 「绘制顺序」拖拽排序共用 */
  const orderedAssets = useMemo<PixiBonesLayer[]>(
    () => orderLayers([...(psd ? flattenLayers(psd) : []), ...images], layerOrder),
    [psd, images, layerOrder],
  );

  // ===== 「绘制顺序」分区的拖拽排序状态 =====
  const [dragLayerId, setDragLayerId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  /** 把 dragLayerId 拖到 targetId 的位置（目标为末行时移到末尾） */
  const dropLayerAt = (targetId: string) => {
    const from = dragLayerId;
    setDragLayerId(null);
    setDropTargetId(null);
    if (!from || from === targetId) return;
    const ids = orderedAssets.map((l) => l.id);
    if (!ids.includes(from)) return;
    const rest = ids.filter((id) => id !== from);
    const lastId = ids[ids.length - 1];
    const at = targetId === lastId ? rest.length : Math.max(0, rest.indexOf(targetId));
    rest.splice(at, 0, from);
    setLayerOrder(rest);
  };

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

  /** 折叠 / 展开某个节点（工程节点或骨） */
  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /**
   * 把「工程节点 + 骨树 + 分区节点」拍平成扁平行数组。
   * 结构（仿 Spine）：
   *   🦴 工程名
   *     ├─ ✦ root              ← 根骨
   *     │   ├─ ◉ 图层名        ← 图层插槽（导入的素材直接挂在 root 下）
   *     │   │   └─ 🖼 图层名   ← 该图层的图片（selectable / 可绑定）
   *     │   └─ ╱ Bone 2        ← 子骨
   *     ├─ 🪢 约束
   *     ├─ 📚 绘制顺序
   *     └─ 🔊 音频
   * 拍平后左列（👁/●）和右列（树）都用同一个数组渲染 → 行永远对齐。
   */
  const rows = useMemo<TreeRow[]>(() => {
    const out: TreeRow[] = [];
    // 1) 工程节点（根骨的父节点）
    out.push({
      key: PROJECT_KEY,
      kind: 'project',
      depth: 0,
      isLast: true,
      icon: '🦴',
      label: projectName || 'untitled',
      collapsible: true,
    });
    if (collapsed.has(PROJECT_KEY)) return out;

    // 项目节点的子节点 = 根骨们 + 7 个分区节点
    type Desc =
      | { kind: 'bone'; node: BoneNode }
      | { kind: 'section'; section: typeof SECTIONS[number] }
      /** 图层（会在树里展开成 插槽 ◉ + 图片 🖼 两行） */
      | { kind: 'layer'; layer: PixiBonesLayer };
    // 所有素材（已按绘制顺序排列）
    const assets: PixiBonesLayer[] = orderedAssets;
    // 按绑定关系分组：绑定了骨骼的图层挂到该骨骼下（骨骼 = 插槽的父级）；未绑定的挂 root 下
    const boneIdSet = new Set(bones.map((b) => b.id));
    const layersByBone = new Map<string, PixiBonesLayer[]>();
    const unboundLayers: PixiBonesLayer[] = [];
    for (const l of assets) {
      const b = layerBindings[l.id];
      if (b && boneIdSet.has(b.boneId)) {
        const arr = layersByBone.get(b.boneId) ?? [];
        arr.push(l);
        layersByBone.set(b.boneId, arr);
      } else {
        unboundLayers.push(l);
      }
    }
    const layerDesc = (l: PixiBonesLayer): Desc => ({ kind: 'layer', layer: l });
    const emit = (list: Desc[], depth: number) => {
      list.forEach((d, i) => {
        const isLast = i === list.length - 1;
        if (d.kind === 'section') {
          const isImagesNode = d.section.key === 'images';
          const isDrawOrderNode = d.section.key === 'drawOrder';
          const sectionKey = 'section:' + d.section.key;
          const isCollapsed = collapsed.has(sectionKey);
          const kids = (isImagesNode || isDrawOrderNode) ? assets : [];
          out.push({
            key: sectionKey,
            kind: 'section',
            depth,
            isLast,
            icon: d.section.icon,
            label: d.section.label,
            collapsible: kids.length > 0,
          });
          // 素材行挂在「图片」节点下（一层缩进）
          if (isImagesNode && !isCollapsed) {
            kids.forEach((l, j) => {
              out.push({
                key: 'asset:' + l.id,
                kind: 'asset',
                depth: depth + 1,
                isLast: j === kids.length - 1,
                asset: l,
                icon: '🖼',
                label: l.name,
                collapsible: false,
              });
            });
          }
          // 「绘制顺序」节点下：只列图层插槽（◉ 图层名），可拖拽排序
          if (isDrawOrderNode && !isCollapsed) {
            kids.forEach((l, j) => {
              out.push({
                key: 'drawslot:' + l.id,
                kind: 'slot',
                depth: depth + 1,
                isLast: j === kids.length - 1,
                asset: l,
                icon: '◉',
                label: l.name,
                collapsible: false,
              });
            });
          }
          return;
        }
        // 图层：展开成「◉ 插槽」+「🖼 图片」两行
        if (d.kind === 'layer') {
          const layer = d.layer;
          const slotKey = 'slot:' + layer.id;
          out.push({
            key: slotKey,
            kind: 'slot',
            depth,
            isLast,
            asset: layer,
            icon: '◉',
            label: layer.name,
            collapsible: true,
          });
          if (!collapsed.has(slotKey)) {
            out.push({
              key: 'rootimg:' + layer.id,   // 与「图片」分区里的 asset 行区分开（避免 key 重复）
              kind: 'asset',
              depth: depth + 1,
              isLast: true,
              asset: layer,
              icon: '🖼',
              label: layer.name,
              collapsible: false,
            });
          }
          return;
        }
        const node = d.node;
        const boneKids: Desc[] = (childMap.get(node.id) ?? []).map((k) => ({ kind: 'bone', node: k }));
        const isRootBone = node.parentId === null;
        // ★ 仿 Spine：图层插槽排在子骨骼之前
        //   - 绑定了本骨骼的图层：挂在本骨骼下（骨骼 = 插槽的父级）
        //   - 未绑定任何骨骼的图层：挂在 root 下
        const boundHere = (layersByBone.get(node.id) ?? []).map(layerDesc);
        const kids: Desc[] = isRootBone
          ? [...unboundLayers.map(layerDesc), ...boundHere, ...boneKids]
          : [...boundHere, ...boneKids];
        out.push({
          key: node.id,
          kind: 'bone',
          depth,
          isLast,
          node,
          icon: isRootBone ? '✦' : '╱',
          label: node.name,
          collapsible: kids.length > 0,
        });
        if (kids.length > 0 && !collapsed.has(node.id)) emit(kids, depth + 1);
      });
    };
    emit(
      [
        ...filteredRoots.map((n) => ({ kind: 'bone', node: n }) as Desc),
        ...SECTIONS.map((s) => ({ kind: 'section', section: s }) as Desc),
      ],
      1,
    );
    return out;
  }, [projectName, collapsed, childMap, filteredRoots, orderedAssets, bones, layerBindings]);

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
    /** 层级连线颜色（Spine 那种暗灰折线） */
    guide:    'rgba(255,255,255,0.18)',
  };

  return (
    <aside
      className="w-72 flex flex-col overflow-hidden text-sm hierarchy-pop-enter"
      style={{
        background: C.panel, color: C.text,
        borderLeft: '1px solid ' + C.border,
        transformOrigin: 'top right',
        // ★ 浮在画布右侧，不参与 flex 布局（避免挤压画布宽度）
        position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 10,
      }}
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

          {/* 树主体：左列（👁/●）+ 右列（树）—— 两列由同一个 rows 数组驱动，保证行对齐 */}
          <div className="flex flex-1 min-h-0 overflow-y-auto">
            {/* 左列：骨行 👁（装饰）、素材行 👁（可点，切显隐）、其它行 ● */}
            <div
              className="w-4 flex flex-col shrink-0"
              style={{ background: C.panelDk, borderRight: '1px solid ' + C.border }}
            >
              {rows.map((r) => {
                if (r.kind === 'asset' && r.asset) {
                  const vis = layerVisibility[r.asset.id] ?? r.asset.visible;
                  const sel = selectedLayerId === r.asset.id;
                  return (
                    <button
                      key={r.key}
                      className="h-[22px] flex items-center justify-center text-[10px] shrink-0"
                      title={vis ? '隐藏' : '显示'}
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: sel ? C.accent : (vis ? C.dim : 'rgba(255,255,255,0.25)'),
                      }}
                      onClick={() => toggleLayerVisibility(r.asset!.id)}
                    >
                      {vis ? '👁' : '🚫'}
                    </button>
                  );
                }
                return (
                  <div
                    key={r.key}
                    className="h-[22px] flex items-center justify-center text-[10px] shrink-0"
                    title={r.label}
                    style={{
                      color: r.kind === 'bone' && r.node && r.node.id === selectedBoneId ? C.accent : C.dim,
                    }}
                  >
                    {r.kind === 'bone' ? '👁' : '●'}
                  </div>
                );
              })}
            </div>

            {/* 右列：树 */}
            <div className="flex-1" style={{ background: C.panelDk }}>
              {rows.length === 0 ? (
                <div className="text-xs text-center py-6" style={{ color: C.dim }}>
                  {search ? '没有匹配的骨' : '还没有骨骼'}
                </div>
              ) : (
                <div className="py-1">
                  {rows.map((r) => {
                    // 「绘制顺序」里的行可拖拽排序
                    const drawId = r.key.startsWith('drawslot:') ? r.key.slice('drawslot:'.length) : null;
                    return (
                    <TreeRowView
                      key={r.key}
                      dnd={drawId ? {
                        isDragging: dragLayerId === drawId,
                        isDropTarget: dropTargetId === drawId,
                        onDragStart: () => setDragLayerId(drawId),
                        onDragOver: (e) => {
                          e.preventDefault();
                          if (dragLayerId && dragLayerId !== drawId) setDropTargetId(drawId);
                        },
                        onDragLeave: () => { if (dropTargetId === drawId) setDropTargetId(null); },
                        onDrop: () => dropLayerAt(drawId),
                        onDragEnd: () => { setDragLayerId(null); setDropTargetId(null); },
                      } : undefined}
                      row={r}
                      selectedBoneId={selectedBoneId}
                      onSelect={selectBone}
                      onAddChild={(id) => addBone(id)}
                      collapsed={collapsed}
                      onToggleCollapse={toggleCollapsed}
                      search={search}
                      C={C}
                      selectedLayerIds={selectedLayerIds}
                      onSelectAsset={selectLayer}
                      selectedSectionKey={selectedSectionKey}
                      onSelectSection={selectSection}
                      layerBindings={layerBindings}
                      boneNameById={new Map(bones.map((b) => [b.id, b.name]))}
                      onImport={r.kind === 'section' && r.key === 'section:images'
                        ? () => importInputRef.current?.click()
                        : undefined}
                    />
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 素材导入用的隐藏 file input（由「图片」节点上的 ＋ 触发） */}
          <input
            ref={importInputRef}
            type="file"
            accept=".psd,image/png,image/jpeg,image/webp,image/gif,image/bmp"
            multiple
            className="hidden"
            onChange={(e) => {
              void onImportFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </>
      )}

      {/* ============ 底部属性块（三选一：骨骼 / 素材 / 「图片」分区）============ */}
      {selectedBone ? (
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
      ) : selectedLayerId ? (
        <AssetPropsBlock
          asset={selectedAsset}
          bindingBoneName={
            layerBindings[selectedLayerId]
              ? new Map(bones.map((b) => [b.id, b.name])).get(layerBindings[selectedLayerId].boneId) ?? null
              : null
          }
          onParent={() => startAttach(selectedLayerId)}
          onUnbind={() => unbindLayer(selectedLayerId)}
          onOpen={() => toggleLayerVisibility(selectedLayerId)}
          C={C}
        />
      ) : selectedSectionKey === 'images' ? (
        <ImagesSectionPropsBlock
          onAddPsd={() => importInputRef.current?.click()}
          onRefresh={() => { thumbCache.clear(); setRefreshTick((t) => t + 1); }}
          C={C}
        />
      ) : null}
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
//  树的一行（工程节点 / 骨 / 分区）+ Spine 风格折线连线
// =================================================================================
/** 行高（像素）——左列 / 右列 / 连线都按它对齐 */
const ROW_H = 22;
/** 每一级缩进的宽度（像素） */
const INDENT_W = 12;

/**
 * 折线连线的「一列」：
 *   - 祖先列（isOwn=false）：只画一条贯穿整行的竖线（把祖先的肘线接下去）
 *   - 本行列（isOwn=true）：竖线 + 向右的横线 → 形成 「├」或「└」
 *     isLast=true 时竖线只画上半段（└），否则贯穿整行（├）
 */
function GuideColumn({ isOwn, isLast, color }: { isOwn: boolean; isLast: boolean; color: string }) {
  const midX = Math.floor(INDENT_W / 2);
  const lineH = isOwn && isLast ? Math.floor(ROW_H / 2) : ROW_H;
  return (
    <div style={{ position: 'relative', width: INDENT_W, height: ROW_H, flex: '0 0 auto' }}>
      {/* 竖线 */}
      <div
        style={{
          position: 'absolute', left: midX, top: 0, width: 1, height: lineH, background: color,
        }}
      />
      {/* 横线：只有「本行列」才有，指向右侧内容 */}
      {isOwn && (
        <div
          style={{
            position: 'absolute', left: midX, top: Math.floor(ROW_H / 2), width: INDENT_W - midX, height: 1, background: color,
          }}
        />
      )}
    </div>
  );
}

interface TreeRowViewProps {
  row: TreeRow;
  selectedBoneId: string | null;
  onSelect: (id: string) => void;
  onAddChild: (id: string) => void;
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
  search: string;
  C: any;
  /** 素材相关：多选素材（画布框选 / Shift 加选） */
  selectedLayerIds: string[];
  onSelectAsset: (id: string) => void;
  /** 分区节点（约束 / 图片 / …）相关 */
  selectedSectionKey: string | null;
  onSelectSection: (key: string) => void;
  layerBindings: Record<string, LayerBinding>;
  boneNameById: Map<string, string>;
  /** 「图片」节点上的 ＋ 导入按钮 */
  onImport?: () => void;
  /** 「绘制顺序」分区的拖拽排序（只有该分区的行会传） */
  dnd?: {
    isDragging: boolean;
    isDropTarget: boolean;
    onDragStart: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: () => void;
    onDragEnd: () => void;
  };
}

function TreeRowView(props: TreeRowViewProps) {
  const {
    row, selectedBoneId, onSelect, onAddChild, collapsed, onToggleCollapse, search, C,
    selectedLayerIds, onSelectAsset, selectedSectionKey, onSelectSection,
    layerBindings, boneNameById, onImport, dnd,
  } = props;
  const isBone = row.kind === 'bone';
  const isAsset = row.kind === 'asset';
  const isSection = row.kind === 'section';
  /** 图层插槽行（◉ 图层名）：只是个折叠容器，点它 = 展开/收起 */
  const isSlot = row.kind === 'slot';
  /** 分区原始 key（'section:images' → 'images'） */
  const sectionKey = isSection && row.key.startsWith('section:') ? row.key.slice('section:'.length) : null;
  const node = row.node;
  const asset = row.asset;
  /** 「绘制顺序」里的插槽行（不可折叠 + 有素材）：点击 = 选中该图层 */
  const isDrawSlot = isSlot && !row.collapsible && !!row.asset;
  const isSelected =
    (isBone && !!node && selectedBoneId === node.id) ||
    (isAsset && !!asset && selectedLayerIds.includes(asset.id)) ||
    (isSection && sectionKey !== null && selectedSectionKey === sectionKey) ||
    (isDrawSlot && selectedLayerIds.includes(row.asset!.id));

  // 绑定信息（仅素材行）
  const binding = isAsset && asset ? layerBindings[asset.id] : undefined;
  const boundBoneName = binding ? boneNameById.get(binding.boneId) ?? null : null;

  // 搜索命中片段高亮（仅骨行）
  const nameEl =
    isBone && node && search && node.name.toLowerCase().includes(search.toLowerCase())
      ? <Highlight text={node.name} q={search} C={C} />
      : row.label;

  const isCollapsed = collapsed.has(row.key);
  const thumb = isAsset && asset ? layerThumb(asset) : null;
  const clickable = isBone || isAsset || isSection || isSlot;

  const doBindToggle = () => {
    if (!asset) return;
    if (binding) {
      window.dispatchEvent(new CustomEvent('spine:unbind-layer', { detail: { layerId: asset.id } }));
    } else if (selectedBoneId) {
      window.dispatchEvent(new CustomEvent('spine:bind-layer', { detail: { layerId: asset.id } }));
    }
  };

  return (
    <div
      className="group flex items-center pr-1 rounded select-none"
      draggable={!!dnd}
      onDragStart={dnd ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.label); dnd.onDragStart(); } : undefined}
      onDragOver={dnd ? (e) => dnd.onDragOver(e) : undefined}
      onDragLeave={dnd ? () => dnd.onDragLeave() : undefined}
      onDrop={dnd ? (e) => { e.preventDefault(); dnd.onDrop(); } : undefined}
      onDragEnd={dnd ? () => dnd.onDragEnd() : undefined}
      style={{
        height: ROW_H,
        cursor: dnd ? 'grab' : (clickable ? 'pointer' : 'default'),
        background: isSelected ? C.accentDk : 'transparent',
        color: isSelected ? '#fff' : C.text,
        fontWeight: isSelected ? 600 : 400,
        opacity: dnd?.isDragging ? 0.45 : 1,
        boxShadow: dnd?.isDropTarget ? `inset 0 2px 0 ${C.accent}` : undefined,
      }}
      title={dnd ? '拖拽调整绘制顺序' : undefined}
      onMouseEnter={(e) => { if (!isSelected && clickable) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
      onClick={() => {
        if (isBone && node) onSelect(node.id);
        else if (isAsset && asset) onSelectAsset(asset.id);
        else if (isSection && sectionKey !== null) onSelectSection(sectionKey);
        else if (isSlot) {
          // 可折叠的插槽（root 下）点 = 展开/收起；「绘制顺序」里的插槽点 = 选中图层
          if (row.collapsible) onToggleCollapse(row.key);
          else if (asset) onSelectAsset(asset.id);
        }
      }}
    >
      {/* 缩进 + 折线连线：深度 = 画几列 */}
      <div className="flex shrink-0" style={{ height: ROW_H }}>
        {Array.from({ length: row.depth }, (_, i) => (
          <GuideColumn
            key={i}
            isOwn={i === row.depth - 1}
            isLast={row.isLast}
            color={C.guide}
          />
        ))}
      </div>

      {/* 折叠圆点（有子节点才显示 ⊖/⊕） */}
      <button
        className="w-3 h-3 mr-0.5 shrink-0 flex items-center justify-center rounded-full text-[9px]"
        style={{
          background: 'transparent',
          border: row.collapsible ? '1px solid ' + C.dim : 'none',
          color: C.dim,
          cursor: row.collapsible ? 'pointer' : 'default',
          visibility: row.collapsible ? 'visible' : 'hidden',
          lineHeight: 1,
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (row.collapsible) onToggleCollapse(row.key);
        }}
        title={row.collapsible ? (isCollapsed ? '展开' : '折叠') : ''}
      >
        {isCollapsed ? '+' : '−'}
      </button>

      {/* 行图标 / 素材缩略图 */}
      {thumb ? (
        <span className="w-4 h-4 flex items-center justify-center shrink-0 mr-1">
          <img
            src={thumb}
            alt=""
            className="w-3.5 h-3.5 object-contain"
            style={{ imageRendering: 'pixelated' }}
            draggable={false}
          />
        </span>
      ) : (
        <span
          className="w-4 h-4 flex items-center justify-center text-[11px] shrink-0 mr-1"
          style={{ color: isSelected ? '#fff' : C.dim }}
        >
          {row.icon}
        </span>
      )}

      {/* 名称 */}
      <span className="truncate flex-1 text-xs" title={row.label}>
        {nameEl}
      </span>

      {/* 素材行：绑定状态 / 绑定按钮 */}
      {isAsset && asset && (
        boundBoneName ? (
          <button
            className="shrink-0 text-[10px] px-1 rounded"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#7dd3a0' }}
            title={`已绑定到骨骼 ${boundBoneName}（点击解绑）`}
            onClick={(e) => { e.stopPropagation(); doBindToggle(); }}
          >
            🔗{boundBoneName}
          </button>
        ) : (
          <button
            className="shrink-0 w-4 h-4 flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100"
            style={{ background: 'transparent', border: 'none', cursor: selectedBoneId ? 'pointer' : 'not-allowed', color: selectedBoneId ? C.text : C.dim }}
            title={selectedBoneId ? '绑定到选中骨骼' : '先在画布/树里选中一根骨骼'}
            onClick={(e) => { e.stopPropagation(); if (selectedBoneId) doBindToggle(); }}
          >
            🔗
          </button>
        )
      )}

      {/* 「图片」节点上的 ＋ 导入素材 */}
      {onImport && (
        <button
          className="w-4 h-4 flex items-center justify-center text-xs shrink-0 opacity-0 group-hover:opacity-100"
          style={{ color: C.text, background: 'transparent', border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={(e) => (e.currentTarget.style.color = C.text)}
          onClick={(e) => { e.stopPropagation(); onImport(); }}
          title="导入素材（.psd / 图片）"
        >
          ＋
        </button>
      )}

      {/* 骨行右侧 + 按钮（hover 才显示） */}
      {isBone && node && (
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
      )}
    </div>
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
        {node.parentId !== null && (
          <button className="w-6 h-6 flex items-center justify-center" style={{ color: C.dim, background: 'transparent', border: 'none', cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.color = '#e88')} onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)} title="删除" onClick={onDelete}>✕</button>
        )}
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

// =================================================================================
//  选中素材的属性块（Spine "图片文件: crosshair" + 父级 / 打开 / 文件夹）
// =================================================================================
interface AssetPropsBlockProps {
  asset: PixiBonesLayer | null;
  /** 已绑定的父级骨骼名（null = 未绑定） */
  bindingBoneName: string | null;
  onParent: () => void;
  onUnbind: () => void;
  onOpen: () => void;
  C: any;
}

function AssetPropsBlock(props: AssetPropsBlockProps) {
  const { asset, bindingBoneName, onParent, onUnbind, onOpen, C } = props;
  const name = asset?.name ?? '（未知素材）';
  const btnStyle: React.CSSProperties = {
    background: C.panel,
    color: C.text,
    border: '1px solid ' + C.border,
    cursor: 'pointer',
  };
  return (
    <div style={{ borderTop: '1px solid ' + C.border, background: C.panelDk }}>
      {/* 标题行：图片文件: <name> */}
      <div className="flex items-center px-2 py-1.5 gap-1" style={{ background: C.toolbar, borderBottom: '1px solid ' + C.border }}>
        <span className="text-xs shrink-0" style={{ color: C.dim }}>图片文件:</span>
        <span className="text-xs font-semibold truncate" style={{ color: C.selected }} title={name}>{name}</span>
      </div>

      {/* 已绑定的父级骨骼 */}
      {bindingBoneName && (
        <div className="px-2 py-1 flex items-center gap-1 text-[10px]" style={{ color: '#7dd3a0' }}>
          <span>🔗 父级: {bindingBoneName}</span>
          <button
            style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', marginLeft: 'auto' }}
            title="解除绑定"
            onClick={onUnbind}
          >✕</button>
        </div>
      )}

      {/* 操作按钮：父级 / 打开 / 文件夹 */}
      <div className="px-2 pb-2 pt-1 grid grid-cols-3 gap-1 text-[10px]">
        <button
          onClick={onParent}
          className="rounded px-1 py-1 flex items-center justify-center gap-0.5"
          style={btnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)}
          onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}
          title="设置父级（拾取骨骼）"
        >
          <span style={{ color: C.accent }}>↗</span> 父级
        </button>
        <button
          onClick={onOpen}
          className="rounded px-1 py-1 flex items-center justify-center gap-0.5"
          style={btnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)}
          onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}
          title="打开 / 关闭该素材"
        >
          <span>📂</span> 打开
        </button>
        <button
          className="rounded px-1 py-1 flex items-center justify-center gap-0.5"
          style={btnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)}
          onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}
          title="在文件夹中显示（暂未实现）"
        >
          <span>📁</span> 文件夹
        </button>
      </div>
    </div>
  );
}

// =================================================================================
//  「图片」分区节点的属性块（Spine：选项 / 限制扫描 · 路径 · PSD · 添加PSD / 刷新）
// =================================================================================
interface ImagesSectionPropsBlockProps {
  onAddPsd: () => void;
  onRefresh: () => void;
  C: any;
}

function ImagesSectionPropsBlock(props: ImagesSectionPropsBlockProps) {
  const { onAddPsd, onRefresh, C } = props;
  const btnStyle: React.CSSProperties = {
    background: C.panel,
    color: C.text,
    border: '1px solid ' + C.border,
    cursor: 'pointer',
  };
  return (
    <div style={{ borderTop: '1px solid ' + C.border, background: C.panelDk }}>
      {/* 标题行：图片文件 */}
      <div className="flex items-center px-2 py-1.5 gap-1" style={{ background: C.toolbar, borderBottom: '1px solid ' + C.border }}>
        <span className="text-xs font-semibold" style={{ color: C.selected }}>图片文件</span>
      </div>

      {/* 选项：限制扫描（checkbox） */}
      <div className="px-2 py-1 flex items-center gap-2 text-[11px]" style={{ color: C.text }}>
        <span style={{ color: C.dim }}>▶ 选项</span>
        <label className="flex items-center gap-1 cursor-pointer select-none ml-auto">
          <input type="checkbox" defaultChecked className="w-3 h-3" />
          <span>限制扫描</span>
        </label>
      </div>

      {/* 路径 ./images/ */}
      <div className="px-2 py-1 flex items-center gap-1 text-[11px]" style={{ color: C.text }}>
        <span className="shrink-0" style={{ color: C.dim }}>路径</span>
        <span className="flex-1 truncate" style={{ color: C.dim }}>./images/</span>
        <span style={{ color: C.warning }} title="设为图片目录">★</span>
        <span style={{ color: C.dim }} title="截图">📷</span>
        <span style={{ color: C.dim }} title="选择文件夹">📁</span>
      </div>

      {/* PSD <无> */}
      <div className="px-2 py-1 flex items-center gap-2 text-[11px]" style={{ color: C.text }}>
        <span className="shrink-0" style={{ color: C.dim }}>PSD</span>
        <span className="flex-1 truncate" style={{ color: C.dim }}>&lt;无&gt;</span>
      </div>

      {/* 底部按钮：添加PSD / 刷新 */}
      <div className="px-2 pb-2 pt-1 grid grid-cols-2 gap-1 text-[10px]">
        <button
          onClick={onAddPsd}
          className="rounded px-1 py-1 flex items-center justify-center gap-0.5"
          style={btnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)}
          onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}
          title="添加 PSD"
        >
          <span style={{ color: C.accent }}>+</span> 添加PSD
        </button>
        <button
          onClick={onRefresh}
          className="rounded px-1 py-1 flex items-center justify-center gap-0.5"
          style={btnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)}
          onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}
          title="刷新素材缩略图"
        >
          <span>⟳</span> 刷新
        </button>
      </div>
    </div>
  );
}