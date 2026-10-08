import { useMemo, useState, useEffect, useRef } from 'react';
import { usePixiBonesStore, findBone, orderLayers, attachmentLayers, type BoneNode, type SlotBinding } from './store';
import { type PixiBonesLayer, type PixiBonesSlot } from '@psd/index';
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
  /**
   * slot  = 插槽行（◉ 插槽名），其下挂它全部附件行
   * asset = 附件行（🖼 图片名）
   */
  kind: 'project' | 'bone' | 'section' | 'asset' | 'slot';
  /** 缩进层级：project=0，根骨/分区=1，更深 = 子骨 / 插槽 / 附件 */
  depth: number;
  /** 是否是同层最后一个（决定连线画「└」还是「├」） */
  isLast: boolean;
  node?: BoneNode;
  /** 插槽行（kind='slot'）对应的数据 */
  slot?: PixiBonesSlot;
  /** 附件行（kind='asset'）对应的数据 */
  asset?: PixiBonesLayer;
  /** 附件行所属的插槽 id */
  slotId?: string;
  /** 附件行是否是所属插槽「当前显示」的附件 */
  attachmentActive?: boolean;
  /** 是否可拖拽（「绘制顺序」里的插槽行） */
  draggableRow?: boolean;
  icon: string;
  label: string;
  /** 是否可折叠（有子节点才显示 ⊖/⊕） */
  collapsible: boolean;
}

/** 按附件 id 反查插槽 id（本地版，避免 import 顺序问题）。 */
function slotIdOfSlot(slots: PixiBonesSlot[], attachmentId: string): string | null {
  for (const s of slots) if (s.attachmentIds.includes(attachmentId)) return s.id;
  return null;
}

/** 素材缩略图 dataURL 缓存（toDataURL 较贵，按素材 id 缓存一次）。 */
const thumbCache = new Map<string, string>();
function attachmentThumb(layer: PixiBonesLayer): string | null {
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
  // 素材（附件）与插槽相关
  const psd = usePixiBonesStore((s) => s.psd);
  const images = usePixiBonesStore((s) => s.images);
  const slots = usePixiBonesStore((s) => s.slots);
  const setActiveAttachment = usePixiBonesStore((s) => s.setActiveAttachment);
  const addAttachmentToSlot = usePixiBonesStore((s) => s.addAttachmentToSlot);
  const detachAttachment = usePixiBonesStore((s) => s.detachAttachment);
  const slotVisibility = usePixiBonesStore((s) => s.slotVisibility);
  const slotOrder = usePixiBonesStore((s) => s.slotOrder);
  const setSlotOrder = usePixiBonesStore((s) => s.setSlotOrder);
  const selectedSlotId = usePixiBonesStore((s) => s.selectedSlotId);
  const selectedSlotIds = usePixiBonesStore((s) => s.selectedSlotIds);
  const selectSlot = usePixiBonesStore((s) => s.selectSlot);
  const toggleSlotVisibility = usePixiBonesStore((s) => s.toggleSlotVisibility);
  const slotBindings = usePixiBonesStore((s) => s.slotBindings);
  const selectedSectionKey = usePixiBonesStore((s) => s.selectedSectionKey);
  const selectSection = usePixiBonesStore((s) => s.selectSection);
  const startAttach = usePixiBonesStore((s) => s.startAttach);
  const unbindSlot = usePixiBonesStore((s) => s.unbindSlot);
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

  /** 全部附件（可渲染素材），按 id 索引 */
  const attachments = useMemo<PixiBonesLayer[]>(
    () => attachmentLayers(psd, images),
    [psd, images],
  );
  const attachmentById = useMemo(
    () => new Map(attachments.map((l) => [l.id, l])),
    [attachments],
  );
  /** 当前选中的插槽 */
  const selectedSlot = selectedSlotId ? slots.find((s) => s.id === selectedSlotId) ?? null : null;
  /** 当前选中插槽的激活附件（用于底部面板标题等） */
  const selectedSlotActive = selectedSlot?.activeAttachmentId
    ? attachmentById.get(selectedSlot.activeAttachmentId) ?? null
    : null;

  /** 插槽按绘制顺序排列（层级树 & 「绘制顺序」拖拽排序共用） */
  const orderedSlots = useMemo<PixiBonesSlot[]>(
    () => orderLayers(slots, slotOrder),
    [slots, slotOrder],
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
    const ids = orderedSlots.map((s) => s.id);
    if (!ids.includes(from)) return;
    const rest = ids.filter((id) => id !== from);
    const lastId = ids[ids.length - 1];
    const at = targetId === lastId ? rest.length : Math.max(0, rest.indexOf(targetId));
    rest.splice(at, 0, from);
    setSlotOrder(rest);
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
      /** 插槽：展开成「◉ 插槽行 + 它全部附件行 🖼」 */
      | { kind: 'slot'; slot: PixiBonesSlot };
    // 按绑定关系分组：绑定了骨骼的插槽挂到该骨骼下（骨骼 = 插槽的父级）；未绑定的挂 root 下
    const boneIdSet = new Set(bones.map((b) => b.id));
    const slotsByBone = new Map<string, PixiBonesSlot[]>();
    const unboundSlots: PixiBonesSlot[] = [];
    for (const s of orderedSlots) {
      const b = slotBindings[s.id];
      if (b && boneIdSet.has(b.boneId)) {
        const arr = slotsByBone.get(b.boneId) ?? [];
        arr.push(s);
        slotsByBone.set(b.boneId, arr);
      } else {
        unboundSlots.push(s);
      }
    }
    const slotDesc = (s: PixiBonesSlot): Desc => ({ kind: 'slot', slot: s });

    /** 一个插槽 → 插槽行 + 它的附件行 */
    const pushSlot = (slot: PixiBonesSlot, depth: number, isLast: boolean) => {
      const slotKey = 'slot:' + slot.id;
      const isCollapsed = collapsed.has(slotKey);
      out.push({
        key: slotKey,
        kind: 'slot',
        depth,
        isLast,
        slot,
        icon: '◉',
        label: slot.name,
        collapsible: true,
      });
      if (isCollapsed) return;
      slot.attachmentIds.forEach((aid, j) => {
        const l = attachmentById.get(aid);
        if (!l) return;
        out.push({
          key: 'slotatt:' + slot.id + ':' + aid,
          kind: 'asset',
          depth: depth + 1,
          isLast: j === slot.attachmentIds.length - 1,
          asset: l,
          slotId: slot.id,
          attachmentActive: aid === slot.activeAttachmentId,
          icon: '🖼',
          label: l.name,
          collapsible: false,
        });
      });
    };

    const emit = (list: Desc[], depth: number) => {
      list.forEach((d, i) => {
        const isLast = i === list.length - 1;
        if (d.kind === 'section') {
          const isImagesNode = d.section.key === 'images';
          const isDrawOrderNode = d.section.key === 'drawOrder';
          const sectionKey = 'section:' + d.section.key;
          const isCollapsed = collapsed.has(sectionKey);
          const kids = (isImagesNode || isDrawOrderNode) ? orderedSlots : [];
          out.push({
            key: sectionKey,
            kind: 'section',
            depth,
            isLast,
            icon: d.section.icon,
            label: d.section.label,
            collapsible: kids.length > 0,
          });
          // 「图片」分区 = 素材库：列出全部附件（点它 = 选中所属插槽）
          if (isImagesNode && !isCollapsed) {
            attachments.forEach((l, j) => {
              const sid = slotIdOfSlot(orderedSlots, l.id);
              out.push({
                key: 'asset:' + l.id,
                kind: 'asset',
                depth: depth + 1,
                isLast: j === attachments.length - 1,
                asset: l,
                slotId: sid ?? undefined,
                attachmentActive: sid ? orderedSlots.find((s) => s.id === sid)?.activeAttachmentId === l.id : false,
                icon: '🖼',
                label: l.name,
                collapsible: false,
              });
            });
          }
          // 「绘制顺序」节点下：只列插槽（◉ 插槽名），可拖拽排序
          if (isDrawOrderNode && !isCollapsed) {
            orderedSlots.forEach((s, j) => {
              out.push({
                key: 'drawslot:' + s.id,
                kind: 'slot',
                depth: depth + 1,
                isLast: j === orderedSlots.length - 1,
                slot: s,
                icon: '◉',
                label: s.name,
                collapsible: false,
                draggableRow: true,
              });
            });
          }
          return;
        }
        // 插槽：插槽行 + 附件行
        if (d.kind === 'slot') {
          pushSlot(d.slot, depth, isLast);
          return;
        }
        const node = d.node;
        const boneKids: Desc[] = (childMap.get(node.id) ?? []).map((k) => ({ kind: 'bone', node: k }));
        const isRootBone = node.parentId === null;
        // ★ 仿 Spine：插槽排在子骨骼之前
        //   - 绑定了本骨骼的插槽：挂在本骨骼下（骨骼 = 插槽的父级）
        //   - 未绑定任何骨骼的插槽：挂在 root 下
        const boundHere = (slotsByBone.get(node.id) ?? []).map(slotDesc);
        const kids: Desc[] = isRootBone
          ? [...unboundSlots.map(slotDesc), ...boundHere, ...boneKids]
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
  }, [projectName, collapsed, childMap, filteredRoots, orderedSlots, attachments, attachmentById, bones, slotBindings]);

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
                // 插槽行：👁 显隐（key = slotId）
                if (r.kind === 'slot' && r.slot) {
                  const vis = slotVisibility[r.slot.id] ?? true;
                  const sel = selectedSlotId === r.slot.id;
                  return (
                    <button
                      key={r.key}
                      className="h-[22px] flex items-center justify-center text-[10px] shrink-0"
                      title={vis ? '隐藏插槽' : '显示插槽'}
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: sel ? C.accent : (vis ? C.dim : 'rgba(255,255,255,0.25)'),
                      }}
                      onClick={() => toggleSlotVisibility(r.slot!.id)}
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
                      selectedSlotIds={selectedSlotIds}
                      onSelectSlot={selectSlot}
                      onActivateAttachment={setActiveAttachment}
                      selectedSectionKey={selectedSectionKey}
                      onSelectSection={selectSection}
                      slotBindings={slotBindings}
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
      ) : selectedSlotId ? (
        <SlotPropsBlock
          slot={selectedSlot}
          activeAttachment={selectedSlotActive}
          attachments={attachments}
          attachmentById={attachmentById}
          bindingBoneName={
            slotBindings[selectedSlotId]
              ? new Map(bones.map((b) => [b.id, b.name])).get(slotBindings[selectedSlotId].boneId) ?? null
              : null
          }
          onSetActive={(aid) => setActiveAttachment(selectedSlotId, aid)}
          onAddAttachment={(aid) => addAttachmentToSlot(selectedSlotId, aid)}
          onDetach={(aid) => detachAttachment(selectedSlotId, aid)}
          onParent={() => startAttach(selectedSlotId)}
          onUnbind={() => unbindSlot(selectedSlotId)}
          onOpen={() => toggleSlotVisibility(selectedSlotId)}
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
  /** 插槽相关：多选插槽（画布框选 / Shift 加选） */
  selectedSlotIds: string[];
  /** 选中一个插槽（key = slotId） */
  onSelectSlot: (slotId: string) => void;
  /** 切换插槽当前显示的附件 */
  onActivateAttachment: (slotId: string, attachmentId: string) => void;
  /** 分区节点（约束 / 图片 / …）相关 */
  selectedSectionKey: string | null;
  onSelectSection: (key: string) => void;
  slotBindings: Record<string, SlotBinding>;
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
    selectedSlotIds, onSelectSlot, onActivateAttachment, selectedSectionKey, onSelectSection,
    slotBindings, boneNameById, onImport, dnd,
  } = props;
  const isBone = row.kind === 'bone';
  /** 附件行（🖼） */
  const isAsset = row.kind === 'asset';
  const isSection = row.kind === 'section';
  /** 插槽行（◉） */
  const isSlot = row.kind === 'slot';
  /** 分区原始 key（'section:images' → 'images'） */
  const sectionKey = isSection && row.key.startsWith('section:') ? row.key.slice('section:'.length) : null;
  const node = row.node;
  const asset = row.asset;
  const slot = row.slot;
  /** 附件行归属的插槽 id */
  const assetSlotId = row.slotId ?? null;
  const isSelected =
    (isBone && !!node && selectedBoneId === node.id) ||
    (isSlot && !!slot && selectedSlotIds.includes(slot.id)) ||
    (isSection && sectionKey !== null && selectedSectionKey === sectionKey) ||
    // 附件行：所属插槽被选中时高亮
    (isAsset && !!assetSlotId && selectedSlotIds.includes(assetSlotId));

  // 绑定信息（按插槽查；附件行显示它所属插槽的绑定）
  const binding = assetSlotId ? slotBindings[assetSlotId] : (slot ? slotBindings[slot.id] : undefined);
  const boundBoneName = binding ? boneNameById.get(binding.boneId) ?? null : null;

  // 搜索命中片段高亮（仅骨行）
  const nameEl =
    isBone && node && search && node.name.toLowerCase().includes(search.toLowerCase())
      ? <Highlight text={node.name} q={search} C={C} />
      : row.label;

  const isCollapsed = collapsed.has(row.key);
  const thumb = isAsset && asset ? attachmentThumb(asset) : null;
  const clickable = isBone || isAsset || isSection || isSlot;

  /** 绑定/解绑「该行对应的插槽」 */
  const doBindToggle = () => {
    const sid = assetSlotId ?? slot?.id ?? null;
    if (!sid) return;
    if (binding) {
      window.dispatchEvent(new CustomEvent('spine:unbind-slot', { detail: { slotId: sid } }));
    } else if (selectedBoneId) {
      window.dispatchEvent(new CustomEvent('spine:bind-slot', { detail: { slotId: sid } }));
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
        else if (isSection && sectionKey !== null) onSelectSection(sectionKey);
        else if (isSlot && slot) onSelectSlot(slot.id);
        else if (isAsset && asset) {
          // 附件行：切换为「当前显示」+ 选中它所属的插槽
          if (assetSlotId) {
            onActivateAttachment(assetSlotId, asset.id);
            onSelectSlot(assetSlotId);
          }
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

      {/* 附件行：标记「当前显示」 */}
      {isAsset && row.attachmentActive && (
        <span className="shrink-0 text-[9px] px-1 rounded mr-0.5" style={{ color: C.accent, border: '1px solid ' + C.accent }} title="该插槽当前显示的附件">
          当前
        </span>
      )}

      {/* 插槽行 / 附件行：绑定状态 / 绑定按钮（都作用于插槽） */}
      {(isSlot && slot) || (isAsset && assetSlotId) ? (
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
      ) : null}

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
//  选中插槽的属性块（Spine 风格：插槽名 + 附件列表 / 添加附件 + 父级 / 显示 / 解除绑定）
// =================================================================================
interface SlotPropsBlockProps {
  slot: PixiBonesSlot | null;
  /** 插槽当前显示的附件 */
  activeAttachment: PixiBonesLayer | null;
  /** 全部附件（供「添加附件」挑选） */
  attachments: PixiBonesLayer[];
  attachmentById: Map<string, PixiBonesLayer>;
  /** 已绑定的父级骨骼名（null = 未绑定） */
  bindingBoneName: string | null;
  onSetActive: (attachmentId: string) => void;
  onAddAttachment: (attachmentId: string) => void;
  onDetach: (attachmentId: string) => void;
  onParent: () => void;
  onUnbind: () => void;
  onOpen: () => void;
  C: any;
}

function SlotPropsBlock(props: SlotPropsBlockProps) {
  const {
    slot, activeAttachment, attachments, attachmentById,
    bindingBoneName, onSetActive, onAddAttachment, onDetach, onParent, onUnbind, onOpen, C,
  } = props;
  // 「添加附件」选择器：插槽之外的附件
  const [picking, setPicking] = useState(false);
  const candidates = attachments.filter((l) => !slot?.attachmentIds.includes(l.id));
  const name = slot?.name ?? '（未知插槽）';
  const btnStyle: React.CSSProperties = {
    background: C.panel,
    color: C.text,
    border: '1px solid ' + C.border,
    cursor: 'pointer',
  };
  return (
    <div style={{ borderTop: '1px solid ' + C.border, background: C.panelDk }}>
      {/* 标题行：插槽: <name> */}
      <div className="flex items-center px-2 py-1.5 gap-1" style={{ background: C.toolbar, borderBottom: '1px solid ' + C.border }}>
        <span className="text-xs shrink-0" style={{ color: C.dim }}>插槽:</span>
        <span className="text-xs font-semibold truncate" style={{ color: C.selected }} title={name}>{name}</span>
        <span className="ml-auto text-[10px] shrink-0" style={{ color: C.dim }}>
          {slot ? `${slot.attachmentIds.length} 附件` : ''}
        </span>
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

      {/* 附件列表：当前显示的附件高亮；点其他附件 = 切换成它 */}
      <div className="px-2 py-1" style={{ borderTop: '1px solid ' + C.border }}>
        <div className="flex items-center gap-1 text-[10px] mb-1" style={{ color: C.dim }}>
          <span>附件</span>
          <span className="text-[9px] opacity-70">（点击切换当前显示）</span>
          <button
            className="ml-auto rounded px-1"
            style={{ ...btnStyle, fontSize: 10, padding: '0 4px' }}
            onClick={() => setPicking((v) => !v)}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)}
            onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}
            title="把已有素材加进这个插槽"
          >
            {picking ? '收起' : '＋ 添加附件'}
          </button>
        </div>

        {/* 选择要加入的附件 */}
        {picking && (
          <div className="mb-1 rounded" style={{ background: C.panel, border: '1px solid ' + C.border, maxHeight: 132, overflowY: 'auto' }}>
            {candidates.length === 0 ? (
              <div className="px-2 py-1 text-[10px]" style={{ color: C.dim }}>没有可添加的素材</div>
            ) : candidates.map((l) => (
              <button
                key={l.id}
                className="w-full flex items-center gap-1 px-2 py-1 text-[10px] text-left"
                style={{ background: 'transparent', border: 'none', color: C.text, cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => { onAddAttachment(l.id); setPicking(false); }}
                title="加入该插槽并设为当前显示"
              >
                <span>🖼</span>
                <span className="truncate">{l.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* 当前附件列表 */}
        {slot?.attachmentIds.map((aid) => {
          const l = attachmentById.get(aid);
          if (!l) return null;
          const isActive = aid === slot.activeAttachmentId;
          return (
            <div
              key={aid}
              className="group flex items-center gap-1 rounded px-1 py-[2px] text-[10px]"
              style={{
                background: isActive ? C.accentDk : 'transparent',
                color: isActive ? '#fff' : C.text,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              onClick={() => { if (!isActive) onSetActive(aid); }}
              title={isActive ? '当前显示' : '点击切换为当前显示'}
            >
              <span style={{ color: isActive ? '#fff' : C.accent }}>{isActive ? '◉' : '○'}</span>
              <span className="truncate flex-1">{l.name}</span>
              {/* 从插槽移出（放回独立插槽） */}
              <button
                className="shrink-0 opacity-0 group-hover:opacity-100"
                style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); onDetach(aid); }}
                title="移出插槽（变成独立插槽）"
              >✕</button>
            </div>
          );
        })}
        {activeAttachment === null && (
          <div className="text-[10px] py-1" style={{ color: C.dim }}>该插槽当前不显示任何附件</div>
        )}
      </div>

      {/* 操作按钮：父级 / 显示 */}
      <div className="px-2 pb-2 pt-1 grid grid-cols-2 gap-1 text-[10px]">
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
          title="显示 / 隐藏该插槽"
        >
          <span>📂</span> 显示
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