import { create } from 'zustand';
import type { Skeleton } from '@engine/Skeleton';
import type { Animation } from '@engine/Animation';
import type { PixiBonesPsd, PixiBonesLayer } from '@psd/types';
import type { Locale } from './i18n';

export type ViewMode = 'editor' | 'demo';
export type EditorTab = 'setup' | 'animate';

/**
 * 骨骼的可序列化表示。所有 BoneNode 共同构成一棵骨树（parentId === null 是根）。
 *
 * - id 是稳定的（解析时生成，整个生命周期内不变）
 * - parentId 引用同数组里其它节点的 id
 * - x/y/rotation/scaleX/scaleY/length 是 Bone 的 local 字段
 * - layerId 可选：未来用作"绑到哪个 PSD 图层"，Day 3 不强制
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
  layerId: string | null;
}

/**
 * 「图层 → 骨骼」绑定。
 *
 * ref = 绑定那一刻该骨骼的世界矩阵（列主序 6 元组 [a, b, c, d, tx, ty]，等价 PIXI Matrix）。
 * 渲染时用增量变换 delta = 当前世界矩阵 × ref⁻¹ 去驱动图层，
 * 这样「绑定」这个动作本身不会让图层跳动，之后骨骼怎么动图层就怎么跟。
 */
export interface LayerBinding {
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
   *  和 PSD 图层一起挂在层级树的「图片」节点下。 */
  images: PixiBonesLayer[];
  addImage: (layer: PixiBonesLayer) => void;
  removeImage: (id: string) => void;
  layerVisibility: Record<string, boolean>;
  /** 绘制顺序（layerId 列表，索引 0 = 最先绘制 = 最底层）。
   *  空数组 = 用自然顺序（PSD 图层 + 单独导入图片的原始顺序）。 */
  layerOrder: string[];
  /** 设置整份绘制顺序（在「绘制顺序」分区里拖拽排序后写入） */
  setLayerOrder: (ids: string[]) => void;
  /** 单选兼容字段：= selectedLayerIds[0]。见 selectedLayerIds 注释。 */
  selectedLayerId: string | null;
  /** 多选素材（画布框选 / Shift 加选）。
   *  - 单选：selectedLayerIds = [id]，selectedLayerId = id
   *  - 多选：selectedLayerIds = [a,b,c]，selectedLayerId = 第一个（兼容旧代码）
   */
  selectedLayerIds: string[];
  /** 多选素材。additive=true 增量追加，false 替换 */
  selectLayers: (ids: string[], additive?: boolean) => void;
  /** 只设置「目标素材」，**不改变骨骼选中**。
   *  创建模式下 ⌘ 点击素材用它 —— 这样父骨骼链不会断（新骨仍是当前骨骼的子骨）。 */
  setTargetLayer: (id: string | null) => void;
  /** 框选：一次性设置骨骼 + 素材两个选中集（两者互不清空）。 */
  selectBox: (boneIds: string[], layerIds: string[]) => void;
  /** 当前选中的分区节点 key（如 'images'）。null = 未选中分区。 */
  selectedSectionKey: string | null;
  /** 选中分区节点（如 'images'）。会清掉骨骼 / 素材选中态。 */
  selectSection: (key: string | null) => void;
  viewMode: ViewMode;
  /** 正在等待拾取父级骨骼的素材 id。非 null = 「附件：设置父级」拾取模式。 */
  attachingLayerId: string | null;
  /** 进入拾取父级模式（点击图片属性面板的「父级」按钮） */
  startAttach: (layerId: string) => void;
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
  // ===== Undo/Redo 撤销重做（仅记录 bones 的快照） =====
  /** 历史快照栈（最多 50 步），每项是 bones + selectedBoneId 的快照 */
  historyPast:  Array<{ bones: BoneNode[]; selectedBoneId: string | null }>;
  historyFuture: Array<{ bones: BoneNode[]; selectedBoneId: string | null }>;
  /** 把当前 bones 快照推入 past（结构性变化前调用） */
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  viewport: { panX: number; panY: number; zoom: number };
  /** 图层 → 骨骼 的绑定表（key = layerId）。见初始值处注释。 */
  layerBindings: Record<string, LayerBinding>;
  /** 把一个图层绑定到骨骼（ref = 绑定那一刻骨骼的世界矩阵，做参考基准） */
  bindLayer: (layerId: string, binding: LayerBinding) => void;
  /** 解除某个图层的绑定 */
  unbindLayer: (layerId: string) => void;
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
  toggleLayerVisibility: (id: string) => void;
  selectLayer: (id: string | null) => void;
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

export const usePixiBonesStore = create<PixiBonesState>((set, get) => ({
  skeleton: null,
  hoveredBoneId: null,
  animations: [],
  currentTime: 0,
  playing: true,
  selectedBoneName: null,

  psd: null,
  images: [],
  layerVisibility: {},
  layerOrder: [],
  setLayerOrder: (ids) => set({ layerOrder: ids }),
  selectedLayerId: null,
  selectedLayerIds: [],
  selectedSectionKey: null,
  viewMode: 'editor',
  attachingLayerId: null,
  startAttach: (layerId) => set({ attachingLayerId: layerId }),
  cancelAttach: () => set({ attachingLayerId: null }),

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
  /** 图层 → 骨骼 的绑定表：key = layerId。语义见 LayerBinding 注释。 */
  layerBindings: {},

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
          layerId: null,
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

  // ===== Undo / Redo（快照 bones + selectedBoneId）=====
  historyPast:  [],
  historyFuture: [],
  pushHistory: () => {
    const s = get();
    // 深拷贝当前 bones 快照
    const snap = { bones: JSON.parse(JSON.stringify(s.bones)), selectedBoneId: s.selectedBoneId };
    const past = [...s.historyPast, snap].slice(-50);  // 最多 50 步
    set({ historyPast: past, historyFuture: [] });
  },
  undo: () => {
    const s = get();
    if (s.historyPast.length === 0) return;
    const past = [...s.historyPast];
    const prev = past.pop()!;
    // 当前状态推到 future
    const currentSnap = { bones: JSON.parse(JSON.stringify(s.bones)), selectedBoneId: s.selectedBoneId };
    const future = [currentSnap, ...s.historyFuture];
    set({
      historyPast: past,
      historyFuture: future,
      bones: prev.bones,
      selectedBoneId: prev.selectedBoneId,
    });
  },
  redo: () => {
    const s = get();
    if (s.historyFuture.length === 0) return;
    const [next, ...rest] = s.historyFuture;
    // 当前状态推到 past
    const currentSnap = { bones: JSON.parse(JSON.stringify(s.bones)), selectedBoneId: s.selectedBoneId };
    const past = [...s.historyPast, currentSnap];
    set({
      historyPast: past,
      historyFuture: rest,
      bones: next.bones,
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
    set({
      psd: p,
      layerVisibility: {},
      layerOrder: [],
      selectedLayerId: null,
      selectedLayerIds: [],
      bones: rootId
        ? [{
            id: rootId,
            name: 'root',
            parentId: null,
            x: 0, y: 0,
            rotation: 0,
            scaleX: 1, scaleY: 1,
            length: 0,
            layerId: null,
          }]
        : [],
      selectedBoneId: rootId,
      selectedBoneIds: rootId ? [rootId] : [],
      selectedSectionKey: null,
      attachingLayerId: null,
      layerBindings: {},   // 新 PSD：清空所有绑定
    });
  },
  bindLayer: (layerId, binding) =>
    set((state) => {
      // 仿 Spine：绑定后该骨骼成为「图层插槽的父级」，并以图层名重命名
      const layer = findLayer(state.psd, layerId) ?? state.images.find((l) => l.id === layerId) ?? null;
      const bones = layer
        ? state.bones.map((b) =>
            b.id === binding.boneId && b.name !== layer.name ? { ...b, name: layer.name } : b,
          )
        : state.bones;
      return {
        bones,
        layerBindings: { ...state.layerBindings, [layerId]: binding },
        attachingLayerId: null,   // 绑定完成即退出拾取模式
      };
    }),
  unbindLayer: (layerId) =>
    set((state) => {
      const next = { ...state.layerBindings };
      delete next[layerId];
      return { layerBindings: next };
    }),
  // 单独导入的图片素材（PNG/JPG）：追加到 images，默认可见
  addImage: (layer) =>
    set((state) => ({
      images: [...state.images, layer],
      layerVisibility: { ...state.layerVisibility, [layer.id]: true },
      selectedLayerId: layer.id,
      selectedLayerIds: [layer.id],
      selectedBoneId: null,
      selectedSectionKey: null,
      attachingLayerId: null,
    })),
  removeImage: (id) =>
    set((state) => ({
      images: state.images.filter((l) => l.id !== id),
      selectedLayerId: state.selectedLayerId === id ? null : state.selectedLayerId,
      selectedLayerIds: state.selectedLayerIds.filter((lid) => lid !== id),
      layerBindings: Object.fromEntries(
        Object.entries(state.layerBindings).filter(([k]) => k !== id),
      ),
    })),
  toggleLayerVisibility: (id) =>
    set((state) => {
      const cur = state.layerVisibility[id];
      // 素材可能来自 PSD 图层，也可能是单独导入的图片
      const src = findLayer(state.psd, id) ?? state.images.find((l) => l.id === id) ?? null;
      const effective = cur ?? src?.visible ?? true;
      return { layerVisibility: { ...state.layerVisibility, [id]: !effective } };
    }),
  selectLayer: (id) => set({
    selectedLayerId: id,
    selectedLayerIds: id ? [id] : [],
    selectedBoneId: null,
    selectedBoneIds: [],
    selectedSectionKey: null,
    attachingLayerId: null,
  }),
  // 多选素材：additive=true 增量追加，false 替换
  selectLayers: (ids, additive = false) => set((s) => {
    const next = additive ? Array.from(new Set([...s.selectedLayerIds, ...ids])) : ids;
    return {
      selectedLayerIds: next,
      selectedLayerId: next[0] ?? null,
      selectedBoneId: null,
      selectedBoneIds: [],
      selectedSectionKey: null,
      attachingLayerId: null,
    };
  }),
  // 只设置目标素材，保留骨骼选中（创建模式 ⌘ 点击素材用）
  setTargetLayer: (id) => set({
    selectedLayerId: id,
    selectedLayerIds: id ? [id] : [],
    selectedSectionKey: null,
    attachingLayerId: null,
  }),
  // 框选：同时设置骨骼 + 素材（互不清空）
  selectBox: (boneIds, layerIds) => set({
    selectedBoneIds: boneIds,
    selectedBoneId: boneIds[0] ?? null,
    selectedLayerIds: layerIds,
    selectedLayerId: layerIds[0] ?? null,
    selectedSectionKey: null,
    attachingLayerId: null,
  }),
  selectSection: (key) => set({
    selectedSectionKey: key,
    selectedBoneId: null,
    selectedBoneIds: [],
    selectedLayerId: null,
    selectedLayerIds: [],
    attachingLayerId: null,
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
setEditorMode: (m) => set({ editorMode: m, activeTool: null }),
setActiveTool: (t) => set({
  activeTool: t,
  // 选 transform tool 时退出 pose/weights/create；其他情况保持现状
  editorMode: t !== null ? 'idle' as const : 'pose' as const,
}),
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
        layerId: partial.layerId ?? null,
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
      const nextBindings = { ...state.layerBindings };
      for (const [layerId, b] of Object.entries(nextBindings)) {
        if (toRemove.has(b.boneId)) delete nextBindings[layerId];
      }
      return {
        bones: state.bones.filter((n) => !toRemove.has(n.id)),
        selectedBoneId: removedSel ? null : state.selectedBoneId,
        selectedBoneIds: removedSel ? [] : state.selectedBoneIds.filter((bid) => !toRemove.has(bid)),
        layerBindings: nextBindings,
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
    selectedLayerId: null,
    selectedLayerIds: [],
    selectedSectionKey: null,
  }),
  // 多选：additive=true 增量追加，false 替换
  selectBones: (ids, additive = false) => set((s) => {
    if (additive) {
      const next = Array.from(new Set([...s.selectedBoneIds, ...ids]));
      return {
        selectedBoneIds: next,
        selectedBoneId: next[0] ?? null,
        selectedLayerId: null,
        selectedLayerIds: [],
        selectedSectionKey: null,
      };
    }
    return {
      selectedBoneIds: ids,
      selectedBoneId: ids[0] ?? null,
      selectedLayerId: null,
      selectedLayerIds: [],
      selectedSectionKey: null,
    };
  }),

  // 设置 hover 骨骼 id（不进入 history、不影响选中态）
  setHoveredBoneId: (id) => set({ hoveredBoneId: id }),
}));  // end usePixiBonesStore = create<PixiBonesState>((set, get) => ({

// 兼容：导出供 store 外的消费者复用
export { findBone, collectDescendants };

/**
 * 按「绘制顺序」重排素材。
 *   - 在 order 里的按 order 的位置排；
 *   - 不在 order 里的（新导入的）按原始相对顺序跟在最后。
 * order 为空时原样返回。
 */
export function orderLayers(layers: PixiBonesLayer[], order: string[]): PixiBonesLayer[] {
  if (order.length === 0) return layers;
  const pos = new Map(order.map((id, i) => [id, i]));
  const n = order.length;
  return layers
    .map((l, i) => ({ l, k: pos.has(l.id) ? pos.get(l.id)! : n + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.l);
}
