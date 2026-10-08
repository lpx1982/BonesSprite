import { create } from 'zustand';
import type { Skeleton } from '@engine/Skeleton';
import type { Animation } from '@engine/Animation';
import type { PixiBonesPsd, PixiBonesLayer, PixiBonesSlot } from '@psd/types';
import { flattenLayers } from '@psd/index';
import type { Locale } from './i18n';

export type ViewMode = 'editor' | 'demo';
export type EditorTab = 'setup' | 'animate';

/**
 * 骨骼的可序列化表示。所有 BoneNode 共同构成一棵骨树（parentId === null 是根）。
 *
 * - id 是稳定的（解析时生成，整个生命周期内不变）
 * - parentId 引用同数组里其它节点的 id
 * - x/y/rotation/scaleX/scaleY/length 是 Bone 的 local 字段
 * - slotId 可选：该骨骼绑定的插槽 id（绑定时由 bindSlot 写入）
 */
export interface BoneNode {
  id: string;
  name: string;
  parentId: string | null;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  length: number;
  slotId: string | null;
}

/**
 * 「图层 → 骨骼」绑定。
 *
 * ref = 绑定那一刻该骨骼的世界矩阵（列主序 6 元组 [a, b, c, d, tx, ty]，等价 PIXI Matrix）。
 * 渲染时用增量变换 delta = 当前世界矩阵 × ref⁻¹ 去驱动图层，
 * 这样「绑定」这个动作本身不会让图层跳动，之后骨骼怎么动图层就怎么跟。
 */
export interface SlotBinding {
  boneId: string;
  ref: number[];
}

export interface PixiBonesState {
  // ---- Day 1 残留字段（Demo 用自己的 skeleton，这里保留兼容）----
  skeleton: Skeleton | null;
  animations: Animation[];
  currentTime: number;
  playing: boolean;
  selectedBoneName: string | null;

  // ---- Day 2 ----
  psd: PixiBonesPsd | null;
  /** 单独导入的图片素材（PNG/JPG 等，非 PSD 图层）。
   *  和 PSD 图层一起作为「附件」，挂在层级树的「图片」节点下。 */
  images: PixiBonesLayer[];
  addImage: (layer: PixiBonesLayer) => void;
  removeImage: (id: string) => void;
  /**
   * 插槽列表（仿 Spine）。导入时「1 图层 = 1 插槽，该图层作为第 1 个附件」。
   *
   * ★ 下面所有字段（slotOrder / slotVisibility / slotTransforms /
   *   slotBindings / selectedSlotId）的 key 都是 **slotId**，不是 attachmentId：
   *   绘制顺序、显隐、变换、绑定骨骼都属于插槽（附件只是槽里的一张图）。
   */
  slots: PixiBonesSlot[];
  /** 切换某插槽当前显示的附件（null = 不显示任何附件） */
  setActiveAttachment: (slotId: string, attachmentId: string | null) => void;
  /** 把一个已有附件移到目标插槽（从其原插槽移除；原插槽空了就删掉） */
  addAttachmentToSlot: (slotId: string, attachmentId: string) => void;
  /** 把附件从插槽里移出，放回一个以它命名的独立插槽 */
  detachAttachment: (slotId: string, attachmentId: string) => void;
  /** 插槽可见性（key = slotId） */
  slotVisibility: Record<string, boolean>;
  /** 仿 Spine SlotTransform：每个插槽自己的局部变换（key = slotId）。
   *  - rotation：弧度
   *  - scaleX/scaleY：缩放
   *  - skewX/skewY：倾斜（弧度）
   *  - tx/ty：相对原 (left, top) 锚点的额外平移
   *  未设置 = 单位变换。原始 left/top/width/height 不变。 */
  slotTransforms: Record<string, { tx: number; ty: number; rotation: number; scaleX: number; scaleY: number; skewX: number; skewY: number }>;
  setSlotTransform: (id: string, t: { tx: number; ty: number; rotation: number; scaleX: number; scaleY: number; skewX: number; skewY: number }) => void;
  resetSlotTransform: (id: string) => void;
  /** 插槽的颜色与混合模式（key = slotId）。
   *  - color：CSS hex（如 '#ff8800'）；'' = 不覆盖
   *  - blend：PIXI v8 合法 blend 字符串（'normal' / 'add' / 'multiply' / 'screen' …）
   *  渲染：最终颜色 = 插槽 color × 附件 color（逐分量相乘）；最终混合 = 附件 blend 优先，否则插槽 blend。 */
  slotStyle: Record<string, { color: string; blend: string }>;
  setSlotStyle: (slotId: string, patch: Partial<{ color: string; blend: string }>) => void;
  /** 附件的颜色与混合模式（key = attachmentId = PixiBonesLayer.id）。语义同 slotStyle。 */
  attachmentStyle: Record<string, { color: string; blend: string }>;
  setAttachmentStyle: (attachmentId: string, patch: Partial<{ color: string; blend: string }>) => void;
  /** 绘制顺序（slotId 列表，索引 0 = 最先绘制 = 最底层）。
   *  空数组 = 用自然顺序。 */
  slotOrder: string[];
  /** 设置整份绘制顺序（在「绘制顺序」分区里拖拽排序后写入） */
  setSlotOrder: (ids: string[]) => void;
  /** 单选兼容字段：= selectedSlotIds[0]。**key = slotId** */
  selectedSlotId: string | null;
  /** 多选插槽（画布框选 / Shift 加选）。**key = slotId**
   *  - 单选：selectedSlotIds = [id]，selectedSlotId = id
   *  - 多选：selectedSlotIds = [a,b,c]，selectedSlotId = 第一个（兼容旧代码）
   */
  selectedSlotIds: string[];
  /** 当前选中的**附件** id（= PixiBonesLayer.id）。null = 选中的是插槽本身。
   *  用途：底部面板由此区分「插槽属性」与「附件属性」。 */
  selectedAttachmentId: string | null;
  /** 当前选中的**树行 key**（如 'slot:xxx' / 'slotatt:xxx:yyy'）。
   *  仅用于层级树高亮 —— 精确到「被点击的那一行」，避免同一插槽在
   *  主树 / 绘制顺序 / 图片分区多处同时高亮。 */
  selectedRowKey: string | null;
  /** 选中一个附件（同时选中它所属的插槽）。rowKey = 被点击的树行 key。 */
  selectAttachment: (slotId: string, attachmentId: string, rowKey?: string) => void;
  /** 删除插槽。★ 只允许删**空插槽**（有附件时请先把附件移出，避免素材丢失）——
   *  插槽的生命周期由用户显式控制，不会被附件移走自动删除。 */
  removeSlot: (slotId: string) => void;
  /** 按**附件 id** 反查它所属的插槽 id（找不到返回 null） */
  slotIdOfAttachment: (attachmentId: string | null) => string | null;
  /** 多选插槽。additive=true 增量追加，false 替换 */
  selectSlots: (ids: string[], additive?: boolean) => void;
  /** 只设置「目标素材」，**不改变骨骼选中**。
   *  创建模式下 ⌘ 点击素材用它 —— 这样父骨骼链不会断（新骨仍是当前骨骼的子骨）。 */
  setTargetSlot: (id: string | null) => void;
  /** 框选：一次性设置骨骼 + 素材两个选中集（两者互不清空）。 */
  selectBox: (boneIds: string[], slotIds: string[]) => void;
  /** 当前选中的分区节点 key（如 'images'）。null = 未选中分区。 */
  selectedSectionKey: string | null;
  /** 选中分区节点（如 'images'）。会清掉骨骼 / 素材选中态。 */
  selectSection: (key: string | null) => void;
  viewMode: ViewMode;
  /** 正在等待拾取父级骨骼的素材 id。非 null = 「附件：设置父级」拾取模式。 */
  attachingSlotId: string | null;
  /** 进入拾取父级模式（点击图片属性面板的「父级」按钮） */
  startAttach: (slotId: string) => void;
  /** 退出拾取父级模式 */
  cancelAttach: () => void;

  // ---- Day 3 ----
  bones: BoneNode[];
  selectedBoneId: string | null;
  /** 多选（Shift / 框选）。为兼容旧的 selectBone(id)，单独成 Set。
   *  - 单选：selectedBoneIds = [id]，selectedBoneId = id
   *  - 多选：selectedBoneIds = [a,b,c]，selectedBoneId = 第一个（兼容旧代码）
   */
  selectedBoneIds: string[];
  /** 鼠标悬停的骨骼 id（用于显示 hover 高亮） */
  hoveredBoneId: string | null;

  // ---- UI state ----
  showLeftPanel: boolean;
  showRightPanel: boolean;
  showRulers: boolean;
  // ---- 视图菜单 11 个开关（Spine 视图风格，全部默认关闭）----
  viewWeights:        boolean; toggleViewWeights:        () => void;
  viewSkin:           boolean; toggleViewSkin:           () => void;
  viewGridTool:       boolean; toggleViewGridTool:       () => void;
  viewColor:          boolean; toggleViewColor:          () => void;
  viewAnimation:      boolean; toggleViewAnimation:      () => void;
  viewHierarchy:      boolean; toggleViewHierarchy:      () => void;
  viewIndicators:     boolean; toggleViewIndicators:     () => void;
  viewOutline:        boolean; toggleViewOutline:        () => void;
  viewIssues:         boolean; toggleViewIssues:         () => void;
  viewPreview:        boolean; toggleViewPreview:        () => void;
  viewAllHidden:      boolean; setViewAllHidden:         (v: boolean) => void;
  editorMode: 'idle' | 'pose' | 'weights' | 'create';
  transformSpace: 'local' | 'world';
  /** 工具栏上「旋转 / 移动 / 缩放 / 倾斜」四张卡片的当前激活工具 */
  activeTool: 'rotate' | 'move' | 'scale' | 'shear' | null;
  /** 当前项目名（默认 raptor-pro，可被 setProjectName 覆盖，如导入 PSD 后用文件名） */
  projectName: string;
  setProjectName: (name: string) => void;
  /** 当前打开的工程 id。null = 在欢迎页（未进入编辑器） */
  currentProjectId: string | null;
  openProject:    (id: string, name: string) => void;
  closeProject:   () => void;
  /** 最近工程列表（按打开时间倒序，最多 8 个，localStorage 持久化） */
  recentProjects: Array<{ id: string; name: string; openedAt: number }>;
  pushRecentProject: (id: string, name: string) => void;
  // ===== Undo/Redo 撤销重做（记录 bones + slotTransforms 的快照） =====
  /** 历史快照栈（最多 50 步），每项是 bones + slotTransforms + selectedBoneId 的快照 */
  historyPast:  Array<{ bones: BoneNode[]; slotTransforms: Record<string, { tx: number; ty: number; rotation: number; scaleX: number; scaleY: number; skewX: number; skewY: number }>; selectedBoneId: string | null }>;
  historyFuture: Array<{ bones: BoneNode[]; slotTransforms: Record<string, { tx: number; ty: number; rotation: number; scaleX: number; scaleY: number; skewX: number; skewY: number }>; selectedBoneId: string | null }>;
  /** 把当前快照推入 past（结构性变化前调用） */
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  viewport: { panX: number; panY: number; zoom: number };
  /** 图层 → 骨骼 的绑定表（key = slotId）。见初始值处注释。 */
  slotBindings: Record<string, SlotBinding>;
  /** 把一个图层绑定到骨骼（ref = 绑定那一刻骨骼的世界矩阵，做参考基准） */
  bindSlot: (slotId: string, binding: SlotBinding) => void;
  /** 解除某个图层的绑定 */
  unbindSlot: (slotId: string) => void;
  /** BoneEditor 的实际渲染原点/缩放，用于标尺换算（世界 0,0 在屏幕的哪里） */
  render: { x: number; y: number; scale: number };
  /** 编辑器顶部 tab：setup（装配/骨骼）/ animate（动画） */
  editorTab: EditorTab;
  setEditorTab: (t: EditorTab) => void;
  /** 动画时间轴高度（px），拖动 resize 时同步 */
  timelineHeight: number;
  setTimelineHeight: (h: number) => void;
  /** 底部卡片组是否锁定居中（true=居中 / false=可拖动横向） */
  toolbarLocked: boolean;
  toggleToolbarLocked: () => void;
  /** 底部卡片组水平偏移（px，正向右、负向左）。锁定时为 0。 */
  toolbarOffsetX: number;
  setToolbarOffsetX: (n: number) => void;

  // ---- i18n ----
  locale: Locale;
  setLocale: (l: Locale) => void;

  // ---- Setters ----
  setSkeleton: (s: Skeleton) => void;
  addAnimation: (a: Animation) => void;
  setCurrentTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setSelectedBoneName: (n: string | null) => void;

  setPsd: (p: PixiBonesPsd | null) => void;
  toggleSlotVisibility: (id: string) => void;
  /** 选中插槽。★ 仿 Spine：姿势模式下（画布不可选图层）在层级树选中插槽/图片时，
   *  自动切到「旋转」变换工具（变换工具与 mode 卡互斥，故会一并退出 pose）。 */
  selectSlot: (id: string | null, rowKey?: string) => void;
  setViewMode: (m: ViewMode) => void;

  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleRulers: () => void;
  fitRequestId: number;
  requestFitContent: () => void;
  setEditorMode: (m: 'idle' | 'pose' | 'weights' | 'create') => void;
  setActiveTool: (t: 'rotate' | 'move' | 'scale' | 'shear' | null) => void;
  setTransformSpace: (s: 'local' | 'world') => void;
  setViewport: (v: { panX: number; panY: number; zoom: number }) => void;
  setRender: (r: { x: number; y: number; scale: number }) => void;

  addBone: (parentId: string | null, partial?: Partial<BoneNode>) => void;
  removeBone: (id: string) => void;
  moveBone: (id: string, x: number, y: number) => void;
  setBoneRotation: (id: string, rotation: number) => void;
  setBoneLength: (id: string, length: number) => void;
  /** 单选：替换整个多选集 */
  selectBone: (id: string | null) => void;
  /** 多选（Shift+点击 / 框选）。传入 true = 增量，false = 替换 */
  selectBones: (ids: string[], additive?: boolean) => void;
  /** 设置当前 hover 的骨骼 id（用于图标 hover 高亮） */
  setHoveredBoneId: (id: string | null) => void;
  setBoneParent: (id: string, parentId: string | null) => void;
}

// ---- id 自增（不变量：一次会话内稳定）----
let _boneIdCounter = 0;
function genBoneId(): string {
  _boneIdCounter++;
  return `bone_${_boneIdCounter}`;
}

// ---- 工具：在 bones 数组里找节点 ----
function findBone(nodes: BoneNode[], id: string): BoneNode | null {
  return nodes.find((n) => n.id === id) ?? null;
}

/** 收集某骨及其所有后代 id（用于级联删除）。 */
function collectDescendants(nodes: BoneNode[], rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const n of nodes) {
      if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id);
        added = true;
      }
    }
  }
  return out;
}

/** 校验 parentId：不能指向自己，也不能指向自己的后代。 */
function isValidParent(nodes: BoneNode[], childId: string, parentId: string | null): boolean {
  if (parentId === null) return true;
  if (parentId === childId) return false;
  const descendants = collectDescendants(nodes, childId);
  return !descendants.has(parentId);
}

/** 递归在 psd 里按 id 找图层。 */
function findLayer(psd: PixiBonesPsd | null, id: string): PixiBonesLayer | null {
  if (!psd) return null;
  const walk = (layers: PixiBonesLayer[]): PixiBonesLayer | null => {
    for (const l of layers) {
      if (l.id === id) return l;
      const r = walk(l.children);
      if (r) return r;
    }
    return null;
  };
  return walk(psd.layers);
}

export { findLayer };

// =================================================================================
//  插槽（slot）工具
// =================================================================================

/** 插槽 id 自增（一次会话内稳定）。 */
let _slotIdCounter = 0;
function genSlotId(): string {
  _slotIdCounter++;
  return `slot_${_slotIdCounter}`;
}

/** 判断一个图层是否是「可渲染的附件」（有画布且尺寸非 0）。 */
export function isRenderableAttachment(layer: PixiBonesLayer): boolean {
  return !!layer.canvas && layer.width > 0 && layer.height > 0;
}

/** 解析出全部附件（PSD 图层 + 单独导入的图片），只保留可渲染的。 */
export function attachmentLayers(psd: PixiBonesPsd | null, images: PixiBonesLayer[]): PixiBonesLayer[] {
  return [...(psd ? flattenLayers(psd) : []), ...images].filter(isRenderableAttachment);
}

/**
 * 为一批附件生成「1 图层 = 1 插槽」的初始插槽列表（导入时用）。
 * 每个插槽只持有 1 个附件，且该附件默认激活。
 */
export function slotsFromAttachments(layers: PixiBonesLayer[]): PixiBonesSlot[] {
  return layers.filter(isRenderableAttachment).map((l) => ({
    id: genSlotId(),
    name: l.name,
    attachmentIds: [l.id],
    activeAttachmentId: l.id,
  }));
}

/** 按附件 id 反查所属插槽 id。 */
export function slotIdOf(slots: PixiBonesSlot[], attachmentId: string | null): string | null {
  if (!attachmentId) return null;
  for (const s of slots) if (s.attachmentIds.includes(attachmentId)) return s.id;
  return null;
}

export const usePixiBonesStore = create<PixiBonesState>((set, get) => ({
  skeleton: null,
  hoveredBoneId: null,
  animations: [],
  currentTime: 0,
  playing: true,
  selectedBoneName: null,

  psd: null,
  images: [],
  slots: [],
  setActiveAttachment: (slotId, attachmentId) => set((state) => ({
    slots: state.slots.map((s) =>
      s.id === slotId && s.attachmentIds.includes(attachmentId ?? '')
        ? { ...s, activeAttachmentId: attachmentId }
        : s,
    ),
  })),
  // 把已有附件移入目标插槽（从其原插槽移除；原插槽空了就删掉）
  addAttachmentToSlot: (slotId, attachmentId) => set((state) => {
    if (!state.slots.some((s) => s.id === slotId)) return state;
    // 1) 先从所有插槽里移除该附件
    const stripped = state.slots.map((s) =>
      s.attachmentIds.includes(attachmentId)
        ? { ...s, attachmentIds: s.attachmentIds.filter((id) => id !== attachmentId) }
        : s,
    );
    // 2) 放进目标插槽，并设为当前显示
    //    ★ 空插槽**保留**（仿 Spine：插槽是结构节点，生命周期由用户显式控制，
    //      不会因为附件被移走而自动消失 —— 被移走附件的原插槽会变成一个空插槽）
    const slots = stripped
      .map((s) => s.id === slotId
        ? { ...s, attachmentIds: [...s.attachmentIds, attachmentId], activeAttachmentId: attachmentId }
        : s)
      // 3) 修正 activeAttachmentId 指向已移走的附件的情况（空插槽 → null）
      .map((s) => (s.activeAttachmentId && s.attachmentIds.includes(s.activeAttachmentId))
        ? s
        : { ...s, activeAttachmentId: s.attachmentIds[0] ?? null });
    return { slots };
  }),
  // 把附件移出，放回一个以它命名的独立插槽
  detachAttachment: (slotId, attachmentId) => set((state) => {
    const src = state.slots.find((s) => s.id === slotId);
    if (!src || !src.attachmentIds.includes(attachmentId)) return state;
    // 从原插槽移除（★ 空插槽保留，不自动删除 —— 同 addAttachmentToSlot）
    let slots = state.slots.map((s) => s.id === slotId
      ? { ...s, attachmentIds: s.attachmentIds.filter((id) => id !== attachmentId) }
      : s);
    // 修正 activeAttachmentId
    slots = slots.map((s) => (s.activeAttachmentId && s.attachmentIds.includes(s.activeAttachmentId))
      ? s
      : { ...s, activeAttachmentId: s.attachmentIds[0] ?? null });
    // 新建独立插槽（用附件名）
    const layer = attachmentLayers(state.psd, state.images).find((l) => l.id === attachmentId) ?? null;
    slots = [...slots, {
      id: genSlotId(),
      name: layer?.name ?? 'attachment',
      attachmentIds: [attachmentId],
      activeAttachmentId: attachmentId,
    }];
    return { slots };
  }),
  slotIdOfAttachment: (attachmentId) => slotIdOf(get().slots, attachmentId),
  slotVisibility: {},
  slotTransforms: {},
  setSlotTransform: (id, t) => set((state) => ({
    slotTransforms: { ...state.slotTransforms, [id]: t },
  })),
  resetSlotTransform: (id) => set((state) => {
    const next = { ...state.slotTransforms };
    delete next[id];
    return { slotTransforms: next };
  }),
  // 插槽 / 附件的颜色与混合模式（渲染时叠加）
  slotStyle: {},
  setSlotStyle: (slotId, patch) => set((state) => ({
    slotStyle: { ...state.slotStyle, [slotId]: { ...state.slotStyle[slotId], ...patch } },
  })),
  attachmentStyle: {},
  setAttachmentStyle: (attachmentId, patch) => set((state) => ({
    attachmentStyle: { ...state.attachmentStyle, [attachmentId]: { ...state.attachmentStyle[attachmentId], ...patch } },
  })),
  slotOrder: [],
  setSlotOrder: (ids) => set({ slotOrder: ids }),
  selectedSlotId: null,
  selectedSlotIds: [],
  selectedAttachmentId: null,
  selectedRowKey: null,
  selectedSectionKey: null,
  viewMode: 'editor',
  attachingSlotId: null,
  startAttach: (slotId) => set({ attachingSlotId: slotId }),
  cancelAttach: () => set({ attachingSlotId: null }),

  bones: [],
  selectedBoneId: null,
  selectedBoneIds: [],

  showLeftPanel: false,
  showRightPanel: false,  // 默认隐藏层级树，用户从 View 菜单手动开启
  showRulers: true,

  // 视图菜单 11 项默认值（false=关闭）
  viewWeights:     false, toggleViewWeights:     () => set((s) => ({ viewWeights:    !s.viewWeights })),
  viewSkin:        false, toggleViewSkin:        () => set((s) => ({ viewSkin:       !s.viewSkin })),
  viewGridTool:    false, toggleViewGridTool:    () => set((s) => ({ viewGridTool:   !s.viewGridTool })),
  viewColor:       false, toggleViewColor:       () => set((s) => ({ viewColor:      !s.viewColor })),
  viewAnimation:   false, toggleViewAnimation:   () => set((s) => ({ viewAnimation:  !s.viewAnimation })),
  viewHierarchy:   false, toggleViewHierarchy:   () => set((s) => ({ viewHierarchy:  !s.viewHierarchy })),
  viewIndicators:  false, toggleViewIndicators:  () => set((s) => ({ viewIndicators: !s.viewIndicators })),
  viewOutline:     false, toggleViewOutline:     () => set((s) => ({ viewOutline:    !s.viewOutline })),
  viewIssues:      false, toggleViewIssues:      () => set((s) => ({ viewIssues:     !s.viewIssues })),
  viewPreview:     false, toggleViewPreview:     () => set((s) => ({ viewPreview:    !s.viewPreview })),
  viewAllHidden:   false, setViewAllHidden:      (v) => set({ viewAllHidden: v }),
  fitRequestId: 0,
  editorMode: 'idle',
    transformSpace: 'local',
    activeTool: 'rotate',
  viewport: { panX: 0, panY: 0, zoom: 1 },
  render: { x: 0, y: 0, scale: 1 },
  /** 图层 → 骨骼 的绑定表：key = slotId。语义见 SlotBinding 注释。 */
  slotBindings: {},

  locale: 'zh',
  setLocale: (l) => set({ locale: l }),

  editorTab: 'setup',
  setEditorTab: (t) => set({ editorTab: t }),

  projectName: 'raptor-pro',
  setProjectName: (name) => set({ projectName: name }),
  // 工程路由状态（欢迎页 ↔ 编辑器）
  currentProjectId: null,
  openProject:      (id, name) => {
    set({ currentProjectId: id, projectName: name });
    get().pushRecentProject(id, name);
    // Spine 风格：新工程自动创建根骨骼（length=0 = 十字图标）
    if (get().bones.length === 0) {
      const rootId = genBoneId();
      set(() => ({
        bones: [{
          id: rootId,
          name: 'root',
          parentId: null,
          x: 0, y: 0,
          rotation: 0,
          scaleX: 1, scaleY: 1,
          length: 0,
          slotId: null,
        }],
        selectedBoneId: rootId,
        selectedBoneIds: [rootId],
      }));
    }
  },
  closeProject:     () => set({ currentProjectId: null, selectedBoneId: null, selectedBoneIds: [] }),
  // 从 localStorage 加载最近工程
  recentProjects: (() => {
    try {
      const raw = localStorage.getItem('pixibones.recent');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  })(),
  pushRecentProject: (id, name) => {
    const list = get().recentProjects.filter((p) => p.id !== id);
    list.unshift({ id, name, openedAt: Date.now() });
    const trimmed = list.slice(0, 8);
    set({ recentProjects: trimmed });
    try { localStorage.setItem('pixibones.recent', JSON.stringify(trimmed)); } catch {}
  },

  // ===== Undo / Redo（快照 bones + slotTransforms + selectedBoneId）=====
  historyPast:  [],
  historyFuture: [],
  pushHistory: () => {
    const s = get();
    // 深拷贝当前 bones 快照 + slotTransforms（解构后是 plain object，可直接 JSON 化）
    const snap = {
      bones: JSON.parse(JSON.stringify(s.bones)),
      slotTransforms: JSON.parse(JSON.stringify(s.slotTransforms)),
      selectedBoneId: s.selectedBoneId,
    };
    const past = [...s.historyPast, snap].slice(-50);  // 最多 50 步
    set({ historyPast: past, historyFuture: [] });
  },
  undo: () => {
    const s = get();
    if (s.historyPast.length === 0) return;
    const past = [...s.historyPast];
    const prev = past.pop()!;
    // 当前状态推到 future
    const currentSnap = {
      bones: JSON.parse(JSON.stringify(s.bones)),
      slotTransforms: JSON.parse(JSON.stringify(s.slotTransforms)),
      selectedBoneId: s.selectedBoneId,
    };
    const future = [currentSnap, ...s.historyFuture];
    set({
      historyPast: past,
      historyFuture: future,
      bones: prev.bones,
      slotTransforms: prev.slotTransforms,
      selectedBoneId: prev.selectedBoneId,
    });
  },
  redo: () => {
    const s = get();
    if (s.historyFuture.length === 0) return;
    const [next, ...rest] = s.historyFuture;
    // 当前状态推到 past
    const currentSnap = {
      bones: JSON.parse(JSON.stringify(s.bones)),
      slotTransforms: JSON.parse(JSON.stringify(s.slotTransforms)),
      selectedBoneId: s.selectedBoneId,
    };
    const past = [...s.historyPast, currentSnap];
    set({
      historyPast: past,
      historyFuture: rest,
      bones: next.bones,
      slotTransforms: next.slotTransforms,
      selectedBoneId: next.selectedBoneId,
    });
  },

  timelineHeight: 240,
  setTimelineHeight: (h) => set({ timelineHeight: h }),

  toolbarLocked: true,
  toggleToolbarLocked: () =>
    set((s) => ({
      toolbarLocked: !s.toolbarLocked,
      // 锁定切换不影响偏移：卡片组始终留在用户拖到的位置
      toolbarOffsetX: s.toolbarOffsetX,
    })),
  toolbarOffsetX: 0,
  setToolbarOffsetX: (n) => set({ toolbarOffsetX: n }),

  // Day 1 setters
  setSkeleton: (s) => set({ skeleton: s }),
  addAnimation: (a) => set((state) => ({ animations: [...state.animations, a] })),
  setCurrentTime: (t) => set({ currentTime: t }),
  setPlaying: (p) => set({ playing: p }),
  setSelectedBoneName: (n) => set({ selectedBoneName: n }),

  // Day 2 setters
  setPsd: (p) => {
    // 切 / 导入 PSD 时骨全清，但必须重建一根根骨骼：
    //   - 没有根骨时「创建模式」找不到父骨骼，会导致新建子骨骼直接失败
    const rootId = p ? genBoneId() : null;
    // ★ 为每个可渲染图层建一个同名插槽（1 图层 = 1 插槽）
    const slots = p ? slotsFromAttachments(flattenLayers(p)) : [];
    set({
      psd: p,
      slots,
      slotVisibility: {},
      slotTransforms: {},
      slotStyle: {},
      attachmentStyle: {},
      slotOrder: [],
      selectedSlotId: null,
      selectedSlotIds: [],
      selectedAttachmentId: null,
      selectedRowKey: null,
      bones: rootId
        ? [{
            id: rootId,
            name: 'root',
            parentId: null,
            x: 0, y: 0,
            rotation: 0,
            scaleX: 1, scaleY: 1,
            length: 0,
            slotId: null,
          }]
        : [],
      selectedBoneId: rootId,
      selectedBoneIds: rootId ? [rootId] : [],
      selectedSectionKey: null,
      attachingSlotId: null,
      slotBindings: {},   // 新 PSD：清空所有绑定
    });
  },
  bindSlot: (slotId, binding) =>
    set((state) => {
      // 仿 Spine：绑定后该骨骼成为「插槽的父级」，并以插槽名重命名
      const slot = state.slots.find((s) => s.id === slotId) ?? null;
      const bones = slot
        ? state.bones.map((b) =>
            b.id === binding.boneId && b.name !== slot.name ? { ...b, name: slot.name } : b,
          )
        : state.bones;
      return {
        bones,
        slotBindings: { ...state.slotBindings, [slotId]: binding },
        attachingSlotId: null,   // 绑定完成即退出拾取模式
      };
    }),
  unbindSlot: (slotId) =>
    set((state) => {
      const next = { ...state.slotBindings };
      delete next[slotId];
      return { slotBindings: next };
    }),
  // 删除插槽（★ 只允许删空插槽：有附件时请先把附件移出，避免素材丢失）
  removeSlot: (slotId) => set((state) => {
    const slot = state.slots.find((s) => s.id === slotId);
    if (!slot || slot.attachmentIds.length > 0) return state;
    const omit = <T,>(rec: Record<string, T>) => {
      const next = { ...rec };
      delete next[slotId];
      return next;
    };
    return {
      slots: state.slots.filter((s) => s.id !== slotId),
      selectedSlotId: state.selectedSlotId === slotId ? null : state.selectedSlotId,
      selectedSlotIds: state.selectedSlotIds.filter((id) => id !== slotId),
      selectedRowKey: state.selectedRowKey === 'slot:' + slotId ? null : state.selectedRowKey,
      slotVisibility: omit(state.slotVisibility),
      slotStyle: omit(state.slotStyle),
      slotBindings: omit(state.slotBindings),
      slotTransforms: omit(state.slotTransforms),
      slotOrder: state.slotOrder.filter((id) => id !== slotId),
    };
  }),
  // 单独导入的图片素材（PNG/JPG）：追加到 images，并建一个同名插槽
  addImage: (layer) =>
    set((state) => {
      const slot: PixiBonesSlot = {
        id: genSlotId(),
        name: layer.name,
        attachmentIds: [layer.id],
        activeAttachmentId: layer.id,
      };
      return {
        images: [...state.images, layer],
        slots: [...state.slots, slot],
        slotVisibility: { ...state.slotVisibility, [slot.id]: true },
        // 选中新建的插槽
        selectedSlotId: slot.id,
        selectedSlotIds: [slot.id],
        selectedAttachmentId: null,
        selectedRowKey: 'slot:' + slot.id,
        selectedBoneId: null,
        selectedSectionKey: null,
        attachingSlotId: null,
      };
    }),
  removeImage: (id) =>
    set((state) => {
      // 该附件所属插槽：把附件从插槽里移除（插槽空了就删掉整条插槽 + 它的绑定/变换/显隐）
      const ownerSlots = state.slots.filter((s) => s.attachmentIds.includes(id));
      const ownerIds = new Set(ownerSlots.map((s) => s.id));
      const slots = state.slots
        .map((s) => s.attachmentIds.includes(id)
          ? { ...s, attachmentIds: s.attachmentIds.filter((a) => a !== id) }
          : s)
        .filter((s) => s.attachmentIds.length > 0)
        .map((s) => (s.activeAttachmentId && s.attachmentIds.includes(s.activeAttachmentId))
          ? s
          : { ...s, activeAttachmentId: s.attachmentIds[0] ?? null });
      // 被删掉的空插槽：连带清掉它的绑定 / 变换 / 显隐
      const deadSlots = new Set(
        [...ownerIds].filter((sid) => !slots.some((s) => s.id === sid)),
      );
      const dropKeys = <T,>(rec: Record<string, T>) =>
        Object.fromEntries(Object.entries(rec).filter(([k]) => !deadSlots.has(k)));
      const selDead = state.selectedSlotId !== null && deadSlots.has(state.selectedSlotId);
      // 附件级样式：删掉该附件的记录
      const nextAttachmentStyle = { ...state.attachmentStyle };
      delete nextAttachmentStyle[id];
      const attSelected = state.selectedAttachmentId === id;
      return {
        images: state.images.filter((l) => l.id !== id),
        slots,
        selectedSlotId: selDead ? null : state.selectedSlotId,
        selectedSlotIds: selDead ? [] : state.selectedSlotIds.filter((sid) => !deadSlots.has(sid)),
        selectedAttachmentId: attSelected ? null : state.selectedAttachmentId,
        selectedRowKey: (selDead || attSelected) ? null : state.selectedRowKey,
        slotBindings: dropKeys(state.slotBindings),
        slotTransforms: dropKeys(state.slotTransforms),
        slotVisibility: dropKeys(state.slotVisibility),
        slotStyle: dropKeys(state.slotStyle),
        attachmentStyle: nextAttachmentStyle,
        slotOrder: state.slotOrder.filter((sid) => !deadSlots.has(sid)),
      };
    }),
  // 插槽显隐（key = slotId）
  toggleSlotVisibility: (slotId) =>
    set((state) => ({
      slotVisibility: { ...state.slotVisibility, [slotId]: !(state.slotVisibility[slotId] ?? true) },
    })),
  selectSlot: (id, rowKey) => set((s) => ({
    selectedSlotId: id,
    selectedSlotIds: id ? [id] : [],
    // 选中插槽 = 未选中具体附件（底部面板显示「插槽属性」）
    selectedAttachmentId: null,
    // 高亮精确到「被点击的那一行」（默认 = 主树的插槽行）
    selectedRowKey: rowKey ?? (id ? 'slot:' + id : null),
    selectedBoneId: null,
    selectedBoneIds: [],
    selectedSectionKey: null,
    attachingSlotId: null,
    // ★ 仿 Spine：姿势模式下在层级树选中插槽/图片 → 自动切到「旋转」工具。
    //   变换工具与 mode 卡互斥，因此同时退出 pose（editorMode = 'idle'）。
    ...(id && s.editorMode === 'pose'
      ? { activeTool: 'rotate' as const, editorMode: 'idle' as const }
      : {}),
  })),
  // 选中一个附件（层级树附件行 / 点小圆点切当前）：同时选中它所属插槽
  selectAttachment: (slotId, attachmentId, rowKey) => set((s) => ({
    selectedSlotId: slotId,
    selectedSlotIds: [slotId],
    selectedAttachmentId: attachmentId,
    selectedRowKey: rowKey ?? ('slotatt:' + slotId + ':' + attachmentId),
    selectedBoneId: null,
    selectedBoneIds: [],
    selectedSectionKey: null,
    attachingSlotId: null,
    // 与 selectSlot 一致：pose 模式下切到旋转工具
    ...(s.editorMode === 'pose'
      ? { activeTool: 'rotate' as const, editorMode: 'idle' as const }
      : {}),
  })),
  // 多选素材：additive=true 增量追加，false 替换
  selectSlots: (ids, additive = false) => set((s) => {
    const next = additive ? Array.from(new Set([...s.selectedSlotIds, ...ids])) : ids;
    return {
      selectedSlotIds: next,
      selectedSlotId: next[0] ?? null,
      selectedAttachmentId: null,
      selectedRowKey: next[0] ? 'slot:' + next[0] : null,
      selectedBoneId: null,
      selectedBoneIds: [],
      selectedSectionKey: null,
      attachingSlotId: null,
    };
  }),
  // 只设置目标素材，保留骨骼选中（创建模式 ⌘ 点击素材用）
  setTargetSlot: (id) => set({
    selectedSlotId: id,
    selectedSlotIds: id ? [id] : [],
    selectedAttachmentId: null,
    selectedRowKey: id ? 'slot:' + id : null,
    selectedSectionKey: null,
    attachingSlotId: null,
  }),
  // 框选：同时设置骨骼 + 素材（互不清空）
  selectBox: (boneIds, slotIds) => set((s) => {
    // ★ 变换工具（旋转/移动/缩放/倾斜）激活时，图层与骨骼不能同时选中 —— 以骨骼为主：
    //   只要框中有骨骼，就丢弃图层选中。
    const layers = (s.activeTool !== null && boneIds.length > 0) ? [] : slotIds;
    return {
      selectedBoneIds: boneIds,
      selectedBoneId: boneIds[0] ?? null,
      selectedSlotIds: layers,
      selectedSlotId: layers[0] ?? null,
      selectedAttachmentId: null,
      // 画布框选只有插槽粒度 → 高亮对应主树插槽行
      selectedRowKey: layers[0] ? 'slot:' + layers[0] : null,
      selectedSectionKey: null,
      attachingSlotId: null,
    };
  }),
  selectSection: (key) => set({
    selectedSectionKey: key,
    selectedBoneId: null,
    selectedBoneIds: [],
    selectedSlotId: null,
    selectedSlotIds: [],
    selectedAttachmentId: null,
    selectedRowKey: null,
    attachingSlotId: null,
  }),
  setViewMode: (m) => set({ viewMode: m }),

  toggleLeftPanel: () => set((s) => ({ showLeftPanel: !s.showLeftPanel })),
  toggleRightPanel: () => set((s) => ({ showRightPanel: !s.showRightPanel })),
  toggleRulers: () => set((s) => ({ showRulers: !s.showRulers })),
  requestFitContent: () => set((s) => ({ fitRequestId: s.fitRequestId + 1 })),
  // mode 卡（姿势/权重/创建）和 transform 卡（旋转/移动/缩放/倾斜）互斥：
//   - 选 mode ⇒ editorMode = m，activeTool = null
//   - 选 transform tool ⇒ activeTool = t，editorMode = 'idle'
// 调用方不需要关心互斥，store 自动保证两者只有一个高亮。
setEditorMode: (m) => set({
  editorMode: m,
  activeTool: null,
  // ★ 姿势模式下画布上的图层不可选：进入 pose 时清空图层选中（避免高亮残留）
  ...(m === 'pose'
    ? { selectedSlotId: null, selectedSlotIds: [], selectedAttachmentId: null, selectedRowKey: null }
    : {}),
}),
setActiveTool: (t) => set((s) => ({
  activeTool: t,
  // 选 transform tool 时退出 pose/weights/create；其他情况保持现状
  editorMode: t !== null ? 'idle' as const : 'pose' as const,
  // 关闭 transform tool ⇒ 回到 pose ⇒ 同样清空图层选中
  ...(t === null
    ? { selectedSlotId: null, selectedSlotIds: [], selectedAttachmentId: null, selectedRowKey: null }
    : {}),
  // ★ 激活变换工具时：若骨骼与图层同时被选中，以骨骼为主（清掉图层）
  ...(t !== null && s.selectedBoneIds.length > 0
    ? { selectedSlotId: null, selectedSlotIds: [], selectedAttachmentId: null, selectedRowKey: null }
    : {}),
})),
  setTransformSpace: (s) => set({ transformSpace: s }),
  setViewport: (v) => set({ viewport: v }),
  setRender: (r) => set({ render: r }),

  // Day 3 setters
  addBone: (parentId, partial = {}) => {
    get().pushHistory();
    set((state) => {
      const newBone: BoneNode = {
        id: genBoneId(),
        name: partial.name ?? `Bone ${state.bones.length + 1}`,
        parentId,
        x: partial.x ?? 0,
        y: partial.y ?? 0,
        rotation: partial.rotation ?? 0,
        scaleX: partial.scaleX ?? 1,
        scaleY: partial.scaleY ?? 1,
        length: partial.length ?? 100,
        slotId: partial.slotId ?? null,
      };
      return {
        bones: [...state.bones, newBone],
        selectedBoneId: newBone.id,
        selectedBoneIds: [newBone.id],
      };
    });
  },

  removeBone: (id) => {
    // ★ 硬要求：根骨骼（parentId === null）禁止删除
    const target = get().bones.find((n) => n.id === id);
    if (!target || target.parentId === null) return;
    get().pushHistory();
    set((state) => {
      const toRemove = collectDescendants(state.bones, id);
      const removedSel = state.selectedBoneId && toRemove.has(state.selectedBoneId);
      // 被删骨骼上的图层绑定也一并清掉
      const nextBindings = { ...state.slotBindings };
      for (const [slotId, b] of Object.entries(nextBindings)) {
        if (toRemove.has(b.boneId)) delete nextBindings[slotId];
      }
      return {
        bones: state.bones.filter((n) => !toRemove.has(n.id)),
        selectedBoneId: removedSel ? null : state.selectedBoneId,
        selectedBoneIds: removedSel ? [] : state.selectedBoneIds.filter((bid) => !toRemove.has(bid)),
        slotBindings: nextBindings,
      };
    });
  },

  moveBone: (id, x, y) => {
    get().pushHistory();
    set((state) => ({
      bones: state.bones.map((n) => (n.id === id ? { ...n, x, y } : n)),
    }));
  },

  setBoneRotation: (id, rotation) => {
    get().pushHistory();
    set((state) => ({
      bones: state.bones.map((n) => (n.id === id ? { ...n, rotation } : n)),
    }));
  },

  setBoneLength: (id, length) => {
    get().pushHistory();
    set((state) => ({
      bones: state.bones.map((n) => (n.id === id ? { ...n, length: Math.max(1, length) } : n)),
    }));
  },

  setBoneParent: (id, parentId) =>
    set((state) => {
      if (!isValidParent(state.bones, id, parentId)) return state;
      return {
        bones: state.bones.map((n) => (n.id === id ? { ...n, parentId } : n)),
      };
    }),

  selectBone: (id) => set({
    selectedBoneId: id,
    selectedBoneIds: id ? [id] : [],
    selectedSlotId: null,
    selectedSlotIds: [],
    selectedAttachmentId: null,
    selectedRowKey: null,
    selectedSectionKey: null,
  }),
  // 多选：additive=true 增量追加，false 替换
  selectBones: (ids, additive = false) => set((s) => {
    if (additive) {
      const next = Array.from(new Set([...s.selectedBoneIds, ...ids]));
      return {
        selectedBoneIds: next,
        selectedBoneId: next[0] ?? null,
        selectedSlotId: null,
        selectedSlotIds: [],
        selectedAttachmentId: null,
        selectedRowKey: null,
        selectedSectionKey: null,
      };
    }
    return {
      selectedBoneIds: ids,
      selectedBoneId: ids[0] ?? null,
      selectedSlotId: null,
      selectedSlotIds: [],
      selectedAttachmentId: null,
      selectedRowKey: null,
      selectedSectionKey: null,
    };
  }),

  // 设置 hover 骨骼 id（不进入 history、不影响选中态）
  setHoveredBoneId: (id) => set({ hoveredBoneId: id }),
}));  // end usePixiBonesStore = create<PixiBonesState>((set, get) => ({

// 兼容：导出供 store 外的消费者复用
export { findBone, collectDescendants };

/**
 * 按 `order`（一串 id）重排任意带 `id` 的对象数组。
 *   - 在 order 里的按 order 的位置排；
 *   - 不在 order 里的（新导入的）按原始相对顺序跟在最后。
 * order 为空时原样返回。
 */
export function orderLayers<T extends { id: string }>(items: T[], order: string[]): T[] {
  if (order.length === 0) return items;
  const pos = new Map(order.map((id, i) => [id, i]));
  const n = order.length;
  return items
    .map((l, i) => ({ l, k: pos.has(l.id) ? pos.get(l.id)! : n + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.l);
}
