import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { usePixiBonesStore, findBone, orderLayers, attachmentLayers, DOCK_PANEL_DEFAULT_WIDTH, DEFAULT_PATH_COLOR, type BoneNode, type SlotBinding, type IkConstraintDef, type PathConstraintDef, type PathSpacingMode, type PathRotateMode } from './store';
import { type PixiBonesLayer, type PixiBonesSlot, type PathData } from '@psd/index';
import { importAssetFile } from './importAsset';
import { PromptDialog } from './PromptDialog';

/** 附件大预览悬停延迟（ms）。2 秒 = Spine 行为。 */
const HOVER_PREVIEW_DELAY = 2000;

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

/** 层级树顶部「动画」节点的固定 key（显示当前动画名，仿 Spine） */
const ANIM_KEY = 'animation';

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
  kind: 'project' | 'bone' | 'section' | 'asset' | 'slot' | 'animation' | 'constraint' | 'path-constraint';
  /** 缩进层级：project=0，根骨/分区=1，更深 = 子骨 / 插槽 / 附件 */
  depth: number;
  /** 是否是同层最后一个（决定连线画「└」还是「├」） */
  isLast: boolean;
  node?: BoneNode;
  /** 插槽行（kind='slot'）对应的数据 */
  slot?: PixiBonesSlot;
  /** 附件行（kind='asset'）对应的数据 */
  asset?: PixiBonesLayer;
  /** 约束行（kind='constraint'）对应的数据 */
  constraint?: IkConstraintDef;
  /** 路径约束行（kind='path-constraint'）对应的数据 */
  pathConstraint?: PathConstraintDef;
  /** 约束行在所在列表里的下标 / 长度（▲▼ 按钮禁用判断用） */
  listIndex?: number;
  listLength?: number;
  /** 路径约束行的副标签（小字：槽名 → 骨1,骨2） */
  subLabel?: string;
  /** 附件行所属的插槽 id */
  slotId?: string;
  /** 附件行是否是所属插槽「当前显示」的附件 */
  attachmentActive?: boolean;
  /** 附件行是否已转成网格（曲面）：有 attachmentMeshes 记录 */
  isMesh?: boolean;
  /** 附件行是否为路径附件（有 attachmentPaths 记录；无素材图层） */
  isPath?: boolean;
  /** 路径附件行对应的附件 id（kind='asset' 且 isPath 时有效） */
  pathAttachmentId?: string;
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
  // 宽度由左边缘的拖动分隔条控制（store 里的 dockPanelWidths）
  const panelWidth = usePixiBonesStore(
    (s) => s.dockPanelWidths.hierarchy ?? DOCK_PANEL_DEFAULT_WIDTH.hierarchy,
  );

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
  /** 当前选中的附件 id（null = 选中的是插槽本身） */
  const selectedAttachmentId = usePixiBonesStore((s) => s.selectedAttachmentId);
  /** 当前选中的树行 key —— 用于「点哪行亮哪行」的精确高亮 */
  const selectedRowKey = usePixiBonesStore((s) => s.selectedRowKey);
  const selectSlot = usePixiBonesStore((s) => s.selectSlot);
  const selectAttachment = usePixiBonesStore((s) => s.selectAttachment);
  const toggleSlotVisibility = usePixiBonesStore((s) => s.toggleSlotVisibility);
  const slotBindings = usePixiBonesStore((s) => s.slotBindings);
  const slotStyle = usePixiBonesStore((s) => s.slotStyle);
  const setSlotStyle = usePixiBonesStore((s) => s.setSlotStyle);
  const attachmentStyle = usePixiBonesStore((s) => s.attachmentStyle);
  const setAttachmentStyle = usePixiBonesStore((s) => s.setAttachmentStyle);
  // 网格（仿 Spine）
  const attachmentMeshes = usePixiBonesStore((s) => s.attachmentMeshes);
  const createMesh = usePixiBonesStore((s) => s.createMesh);
  const removeMesh = usePixiBonesStore((s) => s.removeMesh);
  const resetMesh = usePixiBonesStore((s) => s.resetMesh);
  const freezeMesh = usePixiBonesStore((s) => s.freezeMesh);
  const meshWireframe = usePixiBonesStore((s) => s.meshWireframe);
  const setMeshWireframe = usePixiBonesStore((s) => s.setMeshWireframe);
  const meshEditSlotId = usePixiBonesStore((s) => s.meshEditSlotId);
  const setMeshEditSlot = usePixiBonesStore((s) => s.setMeshEditSlot);
  // 路径附件（仿 Spine 路径附件）
  const attachmentPaths = usePixiBonesStore((s) => s.attachmentPaths);
  const pathEditAttachmentId = usePixiBonesStore((s) => s.pathEditAttachmentId);
  const setPathEdit = usePixiBonesStore((s) => s.setPathEdit);
  const createPathAttachment = usePixiBonesStore((s) => s.createPathAttachment);
  const createPathSlotForBone = usePixiBonesStore((s) => s.createPathSlotForBone);
  const removePathAttachment = usePixiBonesStore((s) => s.removePathAttachment);
  const freezePath = usePixiBonesStore((s) => s.freezePath);
  const resetPath = usePixiBonesStore((s) => s.resetPath);
  const reversePath = usePixiBonesStore((s) => s.reversePath);
  const setPathClosed = usePixiBonesStore((s) => s.setPathClosed);
  const setPathConstantSpeed = usePixiBonesStore((s) => s.setPathConstantSpeed);
  const setPathColor = usePixiBonesStore((s) => s.setPathColor);
  const setPathOption = usePixiBonesStore((s) => s.setPathOption);
  const startPathConstraintPick = usePixiBonesStore((s) => s.startPathConstraintPick);
  const pushHistory = usePixiBonesStore((s) => s.pushHistory);
  const selectedSectionKey = usePixiBonesStore((s) => s.selectedSectionKey);
  const selectSection = usePixiBonesStore((s) => s.selectSection);
  // ★ 动画节点（层级树顶部，显示当前动画名；选中它 = 高亮并清空其它选中）
  const animations = usePixiBonesStore((s) => s.animations);
  const activeAnimationId = usePixiBonesStore((s) => s.activeAnimationId);
  const selectAnimationNode = usePixiBonesStore((s) => s.selectAnimationNode);
  const startAttach = usePixiBonesStore((s) => s.startAttach);
  const unbindSlot = usePixiBonesStore((s) => s.unbindSlot);
  const removeSlot = usePixiBonesStore((s) => s.removeSlot);
  const duplicateSlot = usePixiBonesStore((s) => s.duplicateSlot);
  const duplicateBone = usePixiBonesStore((s) => s.duplicateBone);
  const duplicateAttachment = usePixiBonesStore((s) => s.duplicateAttachment);
  // ===== IK 约束（仿 Spine「约束」分区）=====
  const constraints = usePixiBonesStore((s) => s.constraints);
  const selectedConstraintId = usePixiBonesStore((s) => s.selectedConstraintId);
  const selectConstraint = usePixiBonesStore((s) => s.selectConstraint);
  const addIkConstraint = usePixiBonesStore((s) => s.addIkConstraint);
  const removeConstraint = usePixiBonesStore((s) => s.removeConstraint);
  const renameConstraint = usePixiBonesStore((s) => s.renameConstraint);
  const renameBone = usePixiBonesStore((s) => s.renameBone);
  const renameSlot = usePixiBonesStore((s) => s.renameSlot);
  const renameAttachment = usePixiBonesStore((s) => s.renameAttachment);
  const renameAnimation = usePixiBonesStore((s) => s.renameAnimation);
  const setConstraintTarget = usePixiBonesStore((s) => s.setConstraintTarget);
  const setConstraintMix = usePixiBonesStore((s) => s.setConstraintMix);
  const setConstraintBendDirection = usePixiBonesStore((s) => s.setConstraintBendDirection);
  const moveConstraint = usePixiBonesStore((s) => s.moveConstraint);
  // ===== 路径约束（仿 Spine「约束」分区；与 IK 共用 selectedConstraintId，id 前缀 pc_）=====
  const pathConstraints = usePixiBonesStore((s) => s.pathConstraints);
  const addPathConstraint = usePixiBonesStore((s) => s.addPathConstraint);
  const removePathConstraint = usePixiBonesStore((s) => s.removePathConstraint);
  const renamePathConstraint = usePixiBonesStore((s) => s.renamePathConstraint);
  const duplicatePathConstraint = usePixiBonesStore((s) => s.duplicatePathConstraint);
  const setPathConstraintTarget = usePixiBonesStore((s) => s.setPathConstraintTarget);
  const setPathConstraintBones = usePixiBonesStore((s) => s.setPathConstraintBones);
  const setPathConstraintPositionMode = usePixiBonesStore((s) => s.setPathConstraintPositionMode);
  const setPathConstraintPosition = usePixiBonesStore((s) => s.setPathConstraintPosition);
  const setPathConstraintSpacingMode = usePixiBonesStore((s) => s.setPathConstraintSpacingMode);
  const setPathConstraintSpacing = usePixiBonesStore((s) => s.setPathConstraintSpacing);
  const setPathConstraintRotateMode = usePixiBonesStore((s) => s.setPathConstraintRotateMode);
  const setPathConstraintRotateMix = usePixiBonesStore((s) => s.setPathConstraintRotateMix);
  const setPathConstraintTranslateMix = usePixiBonesStore((s) => s.setPathConstraintTranslateMix);
  const setPathConstraintRotationOffset = usePixiBonesStore((s) => s.setPathConstraintRotationOffset);
  const setPathConstraintBoneOrder = usePixiBonesStore((s) => s.setPathConstraintBoneOrder);
  const movePathConstraint = usePixiBonesStore((s) => s.movePathConstraint);
  const importInputRef = useRef<HTMLInputElement>(null);
  // 刷新（清缩略图缓存后强制重渲染）
  const [, setRefreshTick] = useState(0);

  // ===== 重命名对话框（Spine 风格）=====
  // 双击层级树行的骨/插槽/附件/动画/约束节点 → 弹窗，输入新名字后回写 store。
  // 用一个对象统一驱动弹窗内容，避免每个 kind 都各搞一个 useState。
  const [pendingRename, setPendingRename] = useState<{
    title: string;
    message: string;
    initialValue: string;
    onConfirm: (value: string) => void;
  } | null>(null);
  const closeRename = () => setPendingRename(null);

  // ★ 监听「编辑路径」浮动面板的「新建」按钮 → 弹统一的命名对话框，新建一条路径
  //   （浮动面板在 CanvasOverlay，这里通过自定义事件联动）
  useEffect(() => {
    const onNewPath = () => {
      const st = usePixiBonesStore.getState();
      // 目标骨骼：当前选中的骨，否则根骨
      const boneId = st.selectedBoneId
        ?? (st.bones.find((b) => b.parentId === null)?.id ?? null);
      if (!boneId) return;
      setPendingRename({
        title: '新建路径',
        message: '为新路径输入一个名称:',
        initialValue: `路径 ${Object.keys(st.attachmentPaths).length + 1}`,
        onConfirm: (v) => { createPathSlotForBone(boneId, v); closeRename(); },
      });
    };
    window.addEventListener('spine:new-path', onNewPath);
    return () => window.removeEventListener('spine:new-path', onNewPath);
  }, [createPathSlotForBone, setPendingRename]);

  /**
   * 构造每一行的双击重命名回调。
   * - 未支持的 kind（section / project / …）→ 返回 undefined → TreeRow 不响应双击。
   * - 各 kind 命名风格对齐 Spine：
   *     重命名骨骼   "重命名骨骼"            "为此骨骼输入一个新名称:"
   *     重命名插槽   "重命名插槽"            "为此插槽输入一个新名称:"
   *     重命名图片   "重命名图片"            "为此图片输入一个新名称:"
   *     重命名动画   "重命名动画"            "为此动画输入一个新名称:"
   *     重命名约束   "重命名约束"            "为此约束输入一个新名称:"
   * 注：约束本身已有内联 onRename 路径，此处仍挂双击以便用户从「约束」分区直接触发弹窗（对齐 Spine）。
   */
  const buildRenameHandler = (r: TreeRow): (() => void) | undefined => {
    if (r.kind === 'bone' && r.node) {
      const id = r.node.id;
      return () => {
        // 重新读 store，拿到当前最新名字（防止期间被外部改名）
        const cur = usePixiBonesStore.getState().bones.find((x) => x.id === id);
        if (!cur) return;
        setPendingRename({
          title: '重命名骨骼',
          message: '为此骨骼输入一个新名称:',
          initialValue: cur.name,
          onConfirm: (v) => { renameBone(id, v); closeRename(); },
        });
      };
    }
    if (r.kind === 'slot' && r.slot) {
      const id = r.slot.id;
      return () => {
        const cur = usePixiBonesStore.getState().slots.find((x) => x.id === id);
        if (!cur) return;
        setPendingRename({
          title: '重命名插槽',
          message: '为此插槽输入一个新名称:',
          initialValue: cur.name,
          onConfirm: (v) => { renameSlot(id, v); closeRename(); },
        });
      };
    }
    if (r.kind === 'asset' && r.asset) {
      const id = r.asset.id;
      return () => {
        const cur = usePixiBonesStore.getState().images.find((x) => x.id === id);
        if (!cur) return;
        setPendingRename({
          title: '重命名图片',
          message: '为此图片输入一个新名称:',
          initialValue: cur.name,
          onConfirm: (v) => { renameAttachment(id, v); closeRename(); },
        });
      };
    }
    if (r.kind === 'animation') {
      // 双击动画节点 → 重命名当前动画
      const aid = activeAnimationId;
      return () => {
        if (!aid) return;
        const cur = usePixiBonesStore.getState().animations.find((x) => x.id === aid);
        if (!cur) return;
        setPendingRename({
          title: '重命名动画',
          message: '为此动画输入一个新名称:',
          initialValue: cur.name,
          onConfirm: (v) => { renameAnimation(aid, v); closeRename(); },
        });
      };
    }
    if (r.kind === 'constraint' && r.constraint) {
      // 双击约束行 → 重命名约束
      const id = r.constraint.id;
      return () => {
        const cur = usePixiBonesStore.getState().constraints.find((x) => x.id === id);
        if (!cur) return;
        setPendingRename({
          title: '重命名约束',
          message: '为此约束输入一个新名称:',
          initialValue: cur.name,
          onConfirm: (v) => { renameConstraint(id, v); closeRename(); },
        });
      };
    }
    if (r.kind === 'path-constraint' && r.pathConstraint) {
      // 双击路径约束行 → 重命名路径约束
      const id = r.pathConstraint.id;
      return () => {
        const cur = usePixiBonesStore.getState().pathConstraints.find((x) => x.id === id);
        if (!cur) return;
        setPendingRename({
          title: '重命名路径约束',
          message: '为此路径约束输入一个新名称:',
          initialValue: cur.name,
          onConfirm: (v) => { renamePathConstraint(id, v); closeRename(); },
        });
      };
    }
    return undefined;
  };

  // 约束行的双击 handler（在 ConstraintsSectionPropsBlock 内单独挂；保持职责分离）
  const openConstraintRename = (id: string) => {
    const cur = usePixiBonesStore.getState().constraints.find((x) => x.id === id);
    if (!cur) return;
    setPendingRename({
      title: '重命名约束',
      message: '为此约束输入一个新名称:',
      initialValue: cur.name,
      onConfirm: (v) => { renameConstraint(id, v); closeRename(); },
    });
  };
  // 路径约束标题栏「✎」→ 弹窗重命名（仿 openConstraintRename）
  const openPathConstraintRename = (id: string) => {
    const cur = usePixiBonesStore.getState().pathConstraints.find((x) => x.id === id);
    if (!cur) return;
    setPendingRename({
      title: '重命名路径约束',
      message: '为此路径约束输入一个新名称:',
      initialValue: cur.name,
      onConfirm: (v) => { renamePathConstraint(id, v); closeRename(); },
    });
  };
  // ===== 大预览（hover 附件图标 2s 后弹出该素材的大图） =====
  const [preview, setPreview] = useState<{ url: string; layerId: string; x: number; y: number } | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  /** 是否已弹出过一次预览（Spine：弹过一次后，再悬停其他节点立即显示，不再等延迟） */
  const previewShownOnceRef = useRef(false);
  /** 离开附件行后、短时间内没进入新附件行才重置"已弹过"记录的定时器 */
  const resetShownTimerRef = useRef<number | null>(null);
  /** 清除预览定时器与预览态（hover 中断时）。不重置"已弹过"记录。 */
  const clearPreview = () => {
    if (previewTimerRef.current !== null) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    setPreview(null);
  };
  /** 取消待执行的"重置已弹过" */
  const cancelResetShown = () => {
    if (resetShownTimerRef.current !== null) {
      clearTimeout(resetShownTimerRef.current);
      resetShownTimerRef.current = null;
    }
  };
  /** 鼠标离开附件行：延迟重置"已弹过"。行间快速切换会在 enter 时取消，保持立即显示；
      真正离开（短时间内未进入新附件行）才删除记录，下次悬停重新等 2s。 */
  const scheduleResetShown = () => {
    cancelResetShown();
    resetShownTimerRef.current = window.setTimeout(() => {
      previewShownOnceRef.current = false;
      resetShownTimerRef.current = null;
    }, 500);
  };
  useEffect(() => () => {
    if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
    cancelResetShown();
  }, []);
  /** 鼠标进入附件行：延迟后弹出大图。layer 是被 hover 的素材（attachment）。 */
  const onAssetHoverEnter = (layer: PixiBonesLayer, clientX: number, clientY: number) => {
    // 刚离开上一行：取消重置，保证行间快速切换仍"立即显示"
    cancelResetShown();
    if (previewTimerRef.current !== null) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    // 首次需要等 2s；弹过一次后立即显示（仿 Spine）
    const delay = previewShownOnceRef.current ? 0 : HOVER_PREVIEW_DELAY;
    previewTimerRef.current = window.setTimeout(() => {
      const url = attachmentThumb(layer);
      if (url) setPreview({ url, layerId: layer.id, x: clientX, y: clientY });
      previewShownOnceRef.current = true;
      previewTimerRef.current = null;
    }, delay);
  };
  /** 鼠标在附件行内移动：刷新弹出位置（仍保留当前预览）。 */
  const onAssetHoverMove = (clientX: number, clientY: number) => {
    setPreview((p) => (p ? { ...p, x: clientX, y: clientY } : p));
  };
  /** 鼠标离开附件行：清掉预览 + 延迟重置"已弹过"记录。 */
  const onAssetHoverLeave = () => {
    clearPreview();
    scheduleResetShown();
  };

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
  // 真正最小化：见下面"出场动画"块的 useCallback 版本（拦截后先播动画再卸载）
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
  /** 当前选中的附件对象（层级树点附件行时非 null）→ 底部显示「附件属性」面板 */
  const selectedAttachment = selectedAttachmentId
    ? attachmentById.get(selectedAttachmentId) ?? null
    : null;
  /** 当前选中的路径附件数据（选中路径附件行时非 null）→ 底部显示「路径属性」面板 */
  const selectedPathData = selectedAttachmentId
    ? attachmentPaths[selectedAttachmentId] ?? null
    : null;
  /** 选中路径附件的引用插槽（面板标题名 / 重命名目标；优先当前选中插槽，否则取第一个引用它的） */
  const selectedPathSlot = selectedPathData
    ? (selectedSlotId
        ? (slots.find((s) => s.id === selectedSlotId) ?? null)
        : slots.find((s) => s.attachmentIds.includes(selectedAttachmentId!)) ?? null)
    : null;
  /** 当前选中插槽绑定的骨骼名（底部面板显示「父级」用） */
  const selectedBindingBoneName = selectedSlotId && slotBindings[selectedSlotId]
    ? new Map(bones.map((b) => [b.id, b.name])).get(slotBindings[selectedSlotId].boneId) ?? null
    : null;

  /** 插槽按绘制顺序排列（层级树 & 「绘制顺序」拖拽排序共用） */
  const orderedSlots = useMemo<PixiBonesSlot[]>(
    () => orderLayers(slots, slotOrder),
    [slots, slotOrder],
  );

  // ===== 拖拽状态 =====
  //   - 「绘制顺序」里的插槽行 → 排序（kind = 'slot-order'）
  //   - 「图片」分区里的附件行 → 拖到插槽行 = 添加附件；拖到插槽下方的附件行 = 替换
  const [dragSrc, setDragSrc] = useState<
    { kind: 'slot-order'; slotId: string } | { kind: 'attachment'; attachmentId: string } | null
  >(null);
  /** 当前落点行的 key（用于高亮） */
  const [dropKey, setDropKey] = useState<string | null>(null);

  /** 清空拖拽态（拖动结束 / 落下后） */
  const clearDrag = () => {
    setDragSrc(null);
    setDropKey(null);
  };

  /** 把「绘制顺序」里的插槽行拖到 targetSlotId 的位置（目标为末行时移到末尾） */
  const dropSlotOrderAt = (targetSlotId: string) => {
    const src = dragSrc;
    clearDrag();
    if (!src || src.kind !== 'slot-order' || src.slotId === targetSlotId) return;
    const from = src.slotId;
    const ids = orderedSlots.map((s) => s.id);
    if (!ids.includes(from)) return;
    const rest = ids.filter((id) => id !== from);
    const lastId = ids[ids.length - 1];
    const at = targetSlotId === lastId ? rest.length : Math.max(0, rest.indexOf(targetSlotId));
    rest.splice(at, 0, from);
    setSlotOrder(rest);
  };

  /**
   * 把「图片」里的附件放到插槽上：
   *   - 只给 slotId → 添加附件（addAttachmentToSlot 已会从原插槽移走并设为当前显示）
   *   - 再给 replaceAttachmentId → 替换：加完后再把被替换的附件移出（变成独立插槽）
   */
  const dropAttachmentOn = (slotId: string, replaceAttachmentId?: string) => {
    const src = dragSrc;
    clearDrag();
    if (!src || src.kind !== 'attachment') return;
    if (replaceAttachmentId && replaceAttachmentId === src.attachmentId) return;
    addAttachmentToSlot(slotId, src.attachmentId);
    if (replaceAttachmentId) detachAttachment(slotId, replaceAttachmentId);
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

    // ★ 当前动画名（显示在树底部的「动画」分区节点下，仿 Spine）
    const currentAnimName =
      animations.find((a) => a.id === activeAnimationId)?.name
      ?? animations[0]?.name
      ?? '无动画';

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
        // 空插槽没有子行 → 不显示折叠按钮（插槽本身仍保留在树里）
        collapsible: slot.attachmentIds.length > 0,
      });
      if (isCollapsed) return;
      slot.attachmentIds.forEach((aid, j) => {
        const l = attachmentById.get(aid);
        const p = attachmentPaths[aid];
        if (!l && !p) return;
        const isLast = j === slot.attachmentIds.length - 1;
        if (l) {
          out.push({
            key: 'slotatt:' + slot.id + ':' + aid,
            kind: 'asset',
            depth: depth + 1,
            isLast,
            asset: l,
            slotId: slot.id,
            attachmentActive: aid === slot.activeAttachmentId,
            isMesh: !!attachmentMeshes[l.id],
            icon: '🖼',
            label: l.name,
            collapsible: false,
          });
        } else {
          // 路径附件行（没有素材图层，只有 PathData；名字按 id 序号显示 `路径 ${n}`）
          out.push({
            key: 'slotatt:' + slot.id + ':' + aid,
            kind: 'asset',
            depth: depth + 1,
            isLast,
            slotId: slot.id,
            attachmentActive: aid === slot.activeAttachmentId,
            isPath: true,
            pathAttachmentId: aid,
            icon: '✒️',
            label: `路径 ${parseInt(aid.slice(5), 10)}`,
            collapsible: false,
          });
        }
      });
    };

    const emit = (list: Desc[], depth: number) => {
      list.forEach((d, i) => {
        const isLast = i === list.length - 1;
        if (d.kind === 'section') {
          const isImagesNode = d.section.key === 'images';
          const isDrawOrderNode = d.section.key === 'drawOrder';
          // ★ 「动画」分区下挂当前动画节点（仿 Spine：动画列在分区里）
          const isAnimNode = d.section.key === 'animations';
          // ★ 「约束」分区下挂每条约束（仿 Spine：小图标行）
          const isConstraintsNode = d.section.key === 'constraints';
          const sectionKey = 'section:' + d.section.key;
          const isCollapsed = collapsed.has(sectionKey);
          const kids = (isImagesNode || isDrawOrderNode)
            ? orderedSlots
            : isAnimNode && animations.length > 0
              ? [ANIM_KEY]
              : isConstraintsNode
                ? [
                    ...constraints.map((c) => 'constraint:' + c.id),
                    ...pathConstraints.map((c) => 'pathconstraint:' + c.id),
                  ]
                : [];
          out.push({
            key: sectionKey,
            kind: 'section',
            depth,
            isLast,
            icon: d.section.icon,
            label: d.section.label,
            collapsible: kids.length > 0,
          });
          // ★ 「动画」分区：其下挂当前动画节点（点击 = 高亮并清空其它选中）
          if (isAnimNode && !isCollapsed && animations.length > 0) {
            out.push({
              key: ANIM_KEY,
              kind: 'animation',
              depth: depth + 1,
              isLast: true,
              icon: '🎬',
              label: currentAnimName,
              collapsible: false,
            });
          }
          // 「约束」分区：列出全部 IK 约束 + 路径约束（小图标行，仿 Spine；IK 在前，Path 在后）
          if (isConstraintsNode && !isCollapsed) {
            constraints.forEach((c, j) => {
              out.push({
                key: 'constraint:' + c.id,
                kind: 'constraint',
                depth: depth + 1,
                isLast: j === constraints.length - 1 && pathConstraints.length === 0,
                constraint: c,
                listIndex: j,
                listLength: constraints.length,
                icon: '🪢',
                label: c.name,
                collapsible: false,
              });
            });
            // ★ 路径约束行：label = 名称，subLabel = 小字「槽名 → 骨1,骨2」
            pathConstraints.forEach((c, j) => {
              const slotName = slots.find((x) => x.id === c.targetSlotId)?.name ?? '(无槽)';
              const boneNames = c.boneIds
                .map((bid) => bones.find((b) => b.id === bid)?.name ?? '(已删)')
                .join(',');
              out.push({
                key: 'pathconstraint:' + c.id,
                kind: 'path-constraint',
                depth: depth + 1,
                isLast: j === pathConstraints.length - 1,
                pathConstraint: c,
                listIndex: j,
                listLength: pathConstraints.length,
                subLabel: `${slotName} → ${boneNames}`,
                icon: '📐',
                label: c.name,
                collapsible: false,
              });
            });
          }
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
                isMesh: !!attachmentMeshes[l.id],
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
  }, [projectName, collapsed, childMap, filteredRoots, orderedSlots, attachments, attachmentById, bones, slotBindings, animations, activeAnimationId, attachmentMeshes]);

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

  // ===== 最小化 / 恢复动画 =====
  //   点击 ☰ 右键 / 弹层"最小化" → 面板缩成 0×0，移动到 header 图标位置，渐隐 → 卸载
  //   点击 header 图标 → 面板从图标位置展开到正常大小
  const asideRef = useRef<HTMLElement | null>(null);
  // 入场动画：`hierarchyRestorePending` 为 true 时挂载即播从图标位置展开
  const restorePending = usePixiBonesStore((s) => s.hierarchyRestorePending);
  const setRestorePending = usePixiBonesStore((s) => s.setHierarchyRestorePending);
  // 当前动画状态（仅在动画进行中非 idle）
  const [animStyle, setAnimStyle] = useState<React.CSSProperties | null>(null);
  const [animating, setAnimating] = useState(false);

  // 入场：从图标位置展开（被最小化按钮 toggle 打开时触发）
  useEffect(() => {
    if (!restorePending) return;
    const el = asideRef.current;
    if (!el) return;
    // 量图标位置（按钮 data-attr="hierarchy-min-icon" 由 Editor.tsx header 提供）
    const iconEl = document.querySelector<HTMLElement>('[data-hierarchy-min-icon]');
    const startRect = iconEl ? iconEl.getBoundingClientRect() : null;
    const endRect = el.getBoundingClientRect();
    // ★ 起始位置 = 图标中心；缩到 0 宽，移到图标位置，透明度 0
    //   终止位置 = 当前面板；正常宽，opacity 1
    const fromX = startRect ? (startRect.left + startRect.width / 2 - endRect.left - endRect.width / 2) : 0;
    const fromY = startRect ? (startRect.top + startRect.height / 2 - endRect.top - endRect.height / 2) : 0;
    const targetW = endRect.width;
    const targetH = endRect.height;
    const dur = 240;
    const t0 = performance.now();
    setAnimating(true);
    setAnimStyle({
      width: 0,
      height: targetH,
      transform: `translate(${fromX}px, ${fromY}px) scale(0.02)`,
      transformOrigin: 'center center',
      opacity: 0,
      transition: 'none',
      overflow: 'hidden',
    });
    let raf = 0;
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      // ease-out cubic
      const e = 1 - Math.pow(1 - t, 3);
      const w = targetW * e;
      setAnimStyle({
        width: w,
        height: targetH,
        transform: `translate(${fromX * (1 - e)}px, ${fromY * (1 - e)}px) scale(${0.02 + 0.98 * e})`,
        transformOrigin: 'center center',
        opacity: e,
        transition: 'none',
        overflow: 'hidden',
      });
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        setAnimStyle(null);
        setAnimating(false);
        setRestorePending(false);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [restorePending, setRestorePending]);

  // 出场：拦截"最小化"，先播动画再卸载
  const fullyMinimize = useCallback(() => {
    const el = asideRef.current;
    if (!el) {
      // 找不到 ref（极端情况）就直接卸载
      setShowTree(false);
      usePixiBonesStore.getState().toggleRightPanel();
      setPopoverOpen(false);
      return;
    }
    const startRect = el.getBoundingClientRect();
    const iconEl = document.querySelector<HTMLElement>('[data-hierarchy-min-icon]');
    const endRect = iconEl ? iconEl.getBoundingClientRect() : startRect;
    const fromX = 0;
    const fromY = 0;
    // 目标位置：图标中心 - 面板中心
    const toX = (endRect.left + endRect.width / 2) - (startRect.left + startRect.width / 2);
    const toY = (endRect.top + endRect.height / 2) - (startRect.top + startRect.height / 2);
    const fromW = startRect.width;
    const targetH = endRect.height;
    const dur = 220;
    const t0 = performance.now();
    setPopoverOpen(false);
    setAnimating(true);
    setAnimStyle({
      width: fromW,
      height: targetH,
      transform: 'translate(0,0) scale(1)',
      transformOrigin: 'center center',
      opacity: 1,
      transition: 'none',
      overflow: 'hidden',
    });
    let raf = 0;
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      // ease-in cubic（开始慢后加速）
      const e = Math.pow(t, 2);
      const w = fromW * (1 - e);
      setAnimStyle({
        width: w,
        height: targetH,
        transform: `translate(${toX * e}px, ${toY * e}px) scale(${1 - 0.98 * e})`,
        transformOrigin: 'center center',
        opacity: 1 - e,
        transition: 'none',
        overflow: 'hidden',
      });
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        setAnimStyle(null);
        setAnimating(false);
        setShowTree(false);
        usePixiBonesStore.getState().toggleRightPanel();
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [setShowTree, setPopoverOpen]);


  return (
    <aside
      ref={asideRef}
      className="flex flex-col overflow-hidden text-[16px] hierarchy-pop-enter shrink-0"
      style={{
        width: panelWidth,
        background: C.panel, color: C.text,
        borderLeft: '1px solid ' + C.border,
        transformOrigin: 'top right',
        transition: animStyle ? undefined : 'width 0.18s ease',
        // ★ 作为「右侧停靠区」的一个面板参与横向排列（停靠区自身浮在画布右侧，
        //   所以不会挤压画布宽度）。
        position: 'relative',
        ...(animStyle ?? {}),
      }}
    >
      {/* ============ 顶部：标题（Spine 风格：图标 + 「层级树」 + 骨数）============ */}
      <div
        className="flex items-center px-2"
        style={{ height: 28, borderBottom: '1px solid ' + C.border, background: C.toolbar }}
      >
        <button
          className="flex items-center gap-1.5 text-[14px] font-semibold h-full"
          style={{ color: C.text, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={(e) => (e.currentTarget.style.color = C.text)}
          onClick={() => setShowTree((v) => !v)}
          title={showTree ? '折叠层级树' : '展开层级树'}
        >
          {/* Spine 树状图标：两根线汇合到一个点 + 顶横线 */}
          <svg width="14" height="12" viewBox="0 0 14 12" fill="none" style={{ flexShrink: 0 }}>
            <path d="M1 1 H4 V6 H8 V11" stroke={C.warning} strokeWidth="1.4" strokeLinecap="square" fill="none"/>
            <circle cx="8" cy="11" r="1.5" fill={C.warning}/>
            <path d="M6 1 H13" stroke={C.warning} strokeWidth="1.4" strokeLinecap="square" fill="none"/>
          </svg>
          <span>层级树</span>
          <span style={{ color: C.dim, fontSize: 12 }}>{bones.length} 骨</span>
        </button>
        <div className="ml-auto flex items-center gap-2" style={{ color: C.dim, position: 'relative' }} ref={popoverWrapRef}>
          {/* × 全部展开：SVG X 图标 */}
          <button
            className="h-full flex items-center justify-center"
            style={{ color: C.dim, background: 'transparent', border: 'none', padding: '0 2px', cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
            onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)}
            title="全部展开"
            onClick={() => setShowTree(true)}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"/>
            </svg>
          </button>
          {/* ☰ 选项：SVG 三横线（右键=最小化，双击=关闭） */}
          <button
            className="h-full flex items-center justify-center"
            style={{ color: popoverOpen ? '#fff' : C.dim, background: 'transparent', border: 'none', padding: '0 2px', cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
            onMouseLeave={(e) => { if (!popoverOpen) e.currentTarget.style.color = C.dim; }}
            title="面板选项"
            onClick={() => setPopoverOpen((v) => !v)}
            onContextMenu={(e) => {
              e.preventDefault();
              // ★ 右键三横杠 → 真正最小化（面板缩成图标，对齐 Spine）
              fullyMinimize();
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // ★ 双击三横杠 → 关闭层级树面板
              closePanel();
            }}
          >
            <svg width="12" height="9" viewBox="0 0 14 10" fill="none">
              <path d="M1 1 H13 M1 5 H13 M1 9 H13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"/>
            </svg>
          </button>
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
              <button
                className="w-full flex items-center justify-between"
                style={{ height: 22, padding: '0 10px', background: 'transparent', border: 'none', color: C.text, fontSize: 14, cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => { fullyMinimize(); }}
              >
                <span style={{ color: C.accent, fontWeight: 600 }}>最小化</span>
                <span style={{ color: C.dim, fontSize: 13 }}>右键单击</span>
              </button>
              <button
                className="w-full flex items-center justify-between"
                style={{ height: 22, padding: '0 10px', background: 'transparent', border: 'none', color: C.text, fontSize: 12, cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={closePanel}
              >
                <span>关闭</span>
                <span style={{ color: C.dim, fontSize: 13 }}>双击</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ============ 工具条（Spine 单行：搜索框 + ← → + 8 个工具按钮）============ */}
      {showTree && (
        <>
          <div
            className="flex items-center px-1"
            style={{ height: 34, gap: 3, borderBottom: '1px solid ' + C.border, background: C.panel }}
          >
            {/* 搜索框 + 放大镜图标（Spine 风格：固定 120px 宽） */}
            <div className="flex items-center h-6 rounded shrink-0" style={{ width: 140, background: C.panelDk, border: '1px solid ' + C.border }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ margin: '0 3px 0 6px', flexShrink: 0 }}>
                <circle cx="5" cy="5" r="3.4" stroke={C.dim} strokeWidth="1.2" fill="none"/>
                <path d="M7.5 7.5 L10.5 10.5" stroke={C.dim} strokeWidth="1.2" strokeLinecap="square"/>
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder=""
                className="min-w-0 text-[14px] focus:outline-none bg-transparent"
                style={{ color: C.text, padding: '0 6px 0 0', width: '100%' }}
                onFocus={(e) => (e.currentTarget.parentElement!.style.borderColor = C.accent)}
                onBlur={(e) => (e.currentTarget.parentElement!.style.borderColor = C.border)}
              />
            </div>
            {/* ← / → 上下匹配按钮（Spine 风格） */}
            <ToolIcon title="上一个匹配" C={C}><path d="M5 1 L2 4 L8 4 Z" fill="currentColor"/></ToolIcon>
            <ToolIcon title="下一个匹配" C={C}><path d="M5 7 L2 4 L8 4 Z" fill="currentColor"/></ToolIcon>
            {/* 8 个工具按钮（Spine 单行：编辑/可见/连接/选中/移动/复制/复制设置/粘贴） */}
            <ToolIcon title="编辑骨骼" C={C}><path d="M1 11 L4 11 L11 4 L8 1 L1 8 Z" stroke="currentColor" strokeWidth="1" fill="none"/></ToolIcon>
            <ToolIcon title="可见性" C={C}><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1" fill="none"/></ToolIcon>
            <ToolIcon title="链接" C={C}>
              <rect x="1.5" y="3.5" width="4" height="5" rx="1" stroke="currentColor" strokeWidth="1" fill="none"/>
              <rect x="6.5" y="3.5" width="4" height="5" rx="1" stroke="currentColor" strokeWidth="1" fill="none"/>
            </ToolIcon>
            <ToolIcon title="选中" active C={C}>
              <path d="M2 2 H10 V10 H2 Z M5 5 H7 V7 H5 Z" stroke="#fff" strokeWidth="1" fill="none"/>
            </ToolIcon>
            <ToolIcon title="缩放" C={C}>
              <circle cx="5" cy="5" r="3" stroke="currentColor" strokeWidth="1" fill="none"/>
              <path d="M7 7 L10.5 10.5" stroke="currentColor" strokeWidth="1" strokeLinecap="square"/>
            </ToolIcon>
            <ToolIcon title="复制" C={C}>
              <rect x="2" y="2" width="6" height="7" stroke="currentColor" strokeWidth="1" fill="none"/>
              <rect x="4" y="4" width="6" height="7" stroke="currentColor" strokeWidth="1" fill="none"/>
            </ToolIcon>
            <ToolIcon title="复制设置" C={C}>
              <rect x="1.5" y="2" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none"/>
              <path d="M4 5 H8 M4 7 H8 M4 9 H7" stroke="currentColor" strokeWidth="1"/>
            </ToolIcon>
            <ToolIcon title="粘贴" C={C}>
              <rect x="2" y="3" width="8" height="8" stroke="currentColor" strokeWidth="1" fill="none"/>
              <rect x="4" y="1.5" width="4" height="2" stroke="currentColor" strokeWidth="1" fill="none"/>
            </ToolIcon>
          </div>

          {/* 列头（Spine 风格：3 个图标 = 可见性 / 关键帧 / 节点树） */}
          <div
            className="flex items-center shrink-0"
            style={{ height: 24, borderBottom: '1px solid ' + C.border, background: C.panelDk }}
          >
            {/* 可见性列 */}
            <div
              className="flex items-center justify-center shrink-0"
              style={{ width: 32, color: C.dim }}
              title="可见性：点击切换显隐"
            >
              {/* 眼睛 SVG */}
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M1 7 C 3 3, 11 3, 13 7 C 11 11, 3 11, 1 7 Z" stroke="currentColor" strokeWidth="1" fill="none"/>
                <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1" fill="none"/>
              </svg>
            </div>
            {/* 关键帧列 */}
            <div
              className="flex items-center justify-center shrink-0"
              style={{ width: 32, color: C.dim, borderRight: '1px solid ' + C.border }}
              title="关键帧：有动画属性时显示钥匙"
            >
              {/* 钥匙 SVG（圆形头 + 杆 + 齿） */}
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                <circle cx="4" cy="7" r="2.6" stroke="currentColor" strokeWidth="1" fill="none"/>
                <path d="M6.6 7 L12.6 7 M11 7 L11 9.5 M9.4 7 L9.4 8.6" stroke="currentColor" strokeWidth="1" strokeLinecap="square"/>
              </svg>
            </div>
            {/* 节点树列（占满剩余空间） */}
            <div
              className="flex items-center px-1 gap-1 flex-1 min-w-0 text-[12px]"
              style={{ color: C.dim }}
              title="节点树"
            >
              {/* 层级 / 缩进图标 */}
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                <path d="M2 2 H12 M2 2 V5 M2 8 H12 M2 8 V11 M2 14 H12 M2 14 V17" stroke="currentColor" strokeWidth="1" strokeLinecap="square" fill="none"/>
                <rect x="6" y="4.5" width="3" height="3" stroke="currentColor" strokeWidth="1" fill="none"/>
                <rect x="6" y="10.5" width="3" height="3" stroke="currentColor" strokeWidth="1" fill="none"/>
              </svg>
            </div>
          </div>

          {/* 树主体：左列（显隐小圆点）+ 中列（关键帧图标）+ 右列（树） —— 三列由同一个 rows 数组驱动，保证行对齐 */}
          <div className="flex flex-1 min-h-0 overflow-y-auto">
            {/* 左列：统一用小圆点。显示/当前 = 浅灰，隐藏/非当前 = 深灰；插槽与附件行可点击切换 */}
            <div
              className="w-8 flex flex-col shrink-0"
              style={{ background: C.panelDk, borderRight: '1px solid ' + C.border }}
            >
              {rows.map((r) => {
                const dotStyle = (on: boolean, clickable: boolean, tip: string, act: () => void) => (
                  <button
                    key={r.key}
                    className="h-[28px] flex items-center justify-center shrink-0"
                    title={tip}
                    style={{
                      background: 'transparent', border: 'none',
                      cursor: clickable ? 'pointer' : 'default',
                      padding: 0,
                    }}
                    onClick={(e) => { e.stopPropagation(); if (clickable) act(); }}
                  >
                    <span
                      style={{
                        display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                        background: on ? '#9a9a9a' : '#4a4a4a',
                      }}
                    />
                  </button>
                );
                // 插槽行：圆点 = 显隐（可点击切换）
                if (r.kind === 'slot' && r.slot) {
                  const vis = slotVisibility[r.slot.id] ?? true;
                  return dotStyle(vis, true, vis ? '隐藏插槽' : '显示插槽', () => toggleSlotVisibility(r.slot!.id));
                }
                // 附件行：圆点 = 是否当前显示（可点击切换）
                if (r.kind === 'asset' && r.asset && r.slotId) {
                  const isCur = !!r.attachmentActive;
                  const sid = r.slotId;
                  const aid = r.asset.id;
                  return dotStyle(isCur, !isCur, isCur ? '当前显示' : '点击切换为当前显示', () => setActiveAttachment(sid, aid));
                }
                // 骨骼 / 分区 / 动画节点：中性深灰圆点（无显隐）
                return (
                  <div
                    key={r.key}
                    className="h-[28px] flex items-center justify-center shrink-0"
                    title={r.label}
                  >
                    <span
                      style={{
                        display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                        background: r.kind === 'bone' && r.node && r.node.id === selectedBoneId ? '#9a9a9a' : '#4a4a4a',
                      }}
                    />
                  </div>
                );
              })}
            </div>

            {/* 中列：关键帧（钥匙）—— 骨骼有动画属性时显示；其它行空白 */}
            <div
              className="w-8 flex flex-col shrink-0"
              style={{ background: C.panelDk, borderRight: '1px solid ' + C.border }}
              title="关键帧：有动画属性时显示"
            >
              {(() => {
                // 当前激活动画里哪些骨骼有非空轨道（订阅动画/活动 id 变化）
                const curAnims = usePixiBonesStore((s) => s.animations);
                const curActive = usePixiBonesStore((s) => s.activeAnimationId);
                const anim = curAnims.find((a) => a.id === curActive);
                const withKey = new Set<string>();
                if (anim) {
                  for (const tr of anim.tracks) {
                    if (tr.keys && tr.keys.length > 0) withKey.add(tr.boneId);
                  }
                }
                return rows.map((r) => {
                  const hasKey = r.kind === 'bone' && r.node && withKey.has(r.node.id);
                  return (
                    <div
                      key={r.key}
                      className="h-[28px] flex items-center justify-center shrink-0"
                      title={hasKey ? `${r.label}（有关键帧）` : r.label}
                      style={{ color: hasKey ? C.accent : 'transparent' }}
                    >
                      {hasKey ? (
                        <svg width="9" height="9" viewBox="0 0 14 14" fill="none">
                          <circle cx="4" cy="7" r="2.4" stroke="currentColor" strokeWidth="1" fill="none"/>
                          <path d="M6.4 7 L12.4 7 M10.8 7 L10.8 9.4 M9.2 7 L9.2 8.6" stroke="currentColor" strokeWidth="1" strokeLinecap="square"/>
                        </svg>
                      ) : null}
                    </div>
                  );
                });
              })()}
            </div>

            {/* 右列：树 */}
            <div className="flex-1" style={{ background: C.panelDk }}>
              {rows.length === 0 ? (
                <div className="text-[14px] text-center py-6" style={{ color: C.dim }}>
                  {search ? '没有匹配的骨' : '还没有骨骼'}
                </div>
              ) : (
                <div className="py-1">
                  {rows.map((r) => {
                    const drawId = r.key.startsWith('drawslot:') ? r.key.slice('drawslot:'.length) : null;
                    const assetSrcId = r.key.startsWith('asset:') ? r.key.slice('asset:'.length) : null;
                    // ---- 拖动源 ----
                    //   「绘制顺序」里的插槽行 → 排序；「图片」里的附件行 → 拖去插槽（添加/替换）
                    let drag: RowDrag | undefined;
                    if (drawId) {
                      drag = {
                        dragging: dragSrc?.kind === 'slot-order' && dragSrc.slotId === drawId,
                        title: '拖拽调整绘制顺序',
                        onDragStart: () => setDragSrc({ kind: 'slot-order', slotId: drawId }),
                        onDragEnd: clearDrag,
                      };
                    } else if (assetSrcId && r.asset) {
                      drag = {
                        dragging: dragSrc?.kind === 'attachment' && dragSrc.attachmentId === assetSrcId,
                        title: '拖到插槽 = 添加附件；拖到插槽下的附件 = 替换',
                        onDragStart: () => setDragSrc({ kind: 'attachment', attachmentId: assetSrcId }),
                        onDragEnd: clearDrag,
                      };
                    }
                    // ---- 落点 ----
                    let drop: RowDrop | undefined;
                    const onDragOverRow = (e: React.DragEvent) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (dropKey !== r.key) setDropKey(r.key);
                    };
                    const onDragLeaveRow = () => { if (dropKey === r.key) setDropKey(null); };
                    if (dragSrc?.kind === 'slot-order' && drawId) {
                      // 绘制顺序内部：排序
                      drop = {
                        kind: 'order',
                        active: dropKey === r.key,
                        onDragOver: onDragOverRow, onDragLeave: onDragLeaveRow,
                        onDrop: () => dropSlotOrderAt(drawId),
                      };
                    } else if (dragSrc?.kind === 'attachment' && r.kind === 'slot' && r.slot && !drawId) {
                      // 主树插槽行：添加附件
                      const sid = r.slot.id;
                      drop = {
                        kind: 'slot',
                        active: dropKey === r.key,
                        onDragOver: onDragOverRow, onDragLeave: onDragLeaveRow,
                        onDrop: () => dropAttachmentOn(sid),
                      };
                    } else if (
                      dragSrc?.kind === 'attachment'
                      && r.kind === 'asset' && r.asset && r.slotId
                      && r.key.startsWith('slotatt:')
                    ) {
                      // 插槽下方的附件行：替换该附件
                      const sid = r.slotId;
                      const aid = r.asset.id;
                      drop = {
                        kind: 'attachment',
                        active: dropKey === r.key,
                        onDragOver: onDragOverRow, onDragLeave: onDragLeaveRow,
                        onDrop: () => dropAttachmentOn(sid, aid),
                      };
                    }
                    return (
                    <TreeRowView
                      key={r.key}
                      drag={drag}
                      drop={drop}
                      row={r}
                      selectedBoneId={selectedBoneId}
                      onSelect={(id) => {
                        // ★ 拾取 IK 目标模式：点骨行 = 选为目标骨
                        const st = usePixiBonesStore.getState();
                        if (st.ikPickBoneId) { st.setIkPickTarget(id); return; }
                        selectBone(id);
                      }}
                      onAddChild={(id) => addBone(id)}
                      collapsed={collapsed}
                      onToggleCollapse={toggleCollapsed}
                      search={search}
                      C={C}
                      selectedRowKey={selectedRowKey}
                      onSelectSlot={selectSlot}
                      onSelectAttachment={selectAttachment}
                      onActivateAttachment={setActiveAttachment}
                      selectedSectionKey={selectedSectionKey}
                      onSelectSection={selectSection}
                      selectedConstraintId={selectedConstraintId}
                      onSelectConstraint={selectConstraint}
                      onRemovePathConstraint={removePathConstraint}
                      onMovePathConstraint={movePathConstraint}
                      onSelectAnimation={selectAnimationNode}
                      slotBindings={slotBindings}
                      attachmentById={attachmentById}
                      boneNameById={new Map(bones.map((b) => [b.id, b.name]))}
                      onImport={r.kind === 'section' && r.key === 'section:images'
                        ? () => importInputRef.current?.click()
                        : undefined}
                      onAssetHoverEnter={onAssetHoverEnter}
                      onAssetHoverMove={onAssetHoverMove}
                      onAssetHoverLeave={onAssetHoverLeave}
                      onRequestRename={buildRenameHandler(r)}
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
          onCreateIk={() => {
            // 「新建 → 约束 → IK 约束」：进入拾取模式，等用户点目标骨（对齐 Spine）
            // ★ 支持双骨 IK：用户多选了两根骨（selectedBoneIds）时，
            //   第一根 = 受约束骨（boneId），第二根 = 子骨（childBoneId）
            const st = usePixiBonesStore.getState();
            const ids = st.selectedBoneIds.length >= 2 ? st.selectedBoneIds : [selectedBone.id];
            st.startIkPick(ids[0], ids[1] ?? null);
          }}
          onCreatePath={() => {
            // 「新建 → 路径」：先弹统一命名对话框（PromptDialog），确认后创建绑定到当前骨骼的新路径
            setPendingRename({
              title: '新建路径',
              message: '为新路径输入一个名称:',
              initialValue: `路径 ${Object.keys(attachmentPaths).length + 1}`,
              onConfirm: (v) => { createPathSlotForBone(selectedBone.id, v); closeRename(); },
            });
          }}
          onCreatePathConstraint={() => {
            // 「新建 → 约束 → 路径约束」：进入拾取模式（先选目标路径，再选受约束骨骼）
            startPathConstraintPick();
          }}
          onDelete={() => {
            if (confirm(`删除 "${selectedBone.name}" 及其子骨？`)) removeBone(selectedBone.id);
          }}
          onRename={() => {
            const cur = usePixiBonesStore.getState().bones.find((x) => x.id === selectedBone.id);
            if (!cur) return;
            setPendingRename({
              title: '重命名骨骼',
              message: '为此骨骼输入一个新名称:',
              initialValue: cur.name,
              onConfirm: (v) => { renameBone(selectedBone.id, v); closeRename(); },
            });
          }}
          onCopy={() => duplicateBone(selectedBone.id)}
          onToggleIsolate={() => setHideNonSelected((v) => !v)}
          isolated={hideNonSelected}
          C={C}
        />
      ) : selectedAttachmentId && selectedPathData ? (
        <PathAttachmentPropsBlock
          name={selectedPathSlot?.name ?? `路径 ${parseInt(selectedAttachmentId.slice(5), 10)}`}
          path={selectedPathData}
          editing={pathEditAttachmentId === selectedAttachmentId}
          onEdit={() => setPathEdit(pathEditAttachmentId === selectedAttachmentId ? null : selectedAttachmentId)}
          onClosed={(v) => setPathClosed(selectedAttachmentId, v)}
          onConstantSpeed={(v) => setPathConstantSpeed(selectedAttachmentId, v)}
          onColor={(c) => setPathColor(selectedAttachmentId, c)}
          onOption={(opt, v) => setPathOption(selectedAttachmentId, opt, v)}
          onReset={() => resetPath(selectedAttachmentId)}
          onFreeze={() => freezePath(selectedAttachmentId)}
          onReverse={() => reversePath(selectedAttachmentId)}
          onCopy={() => duplicateAttachment(selectedAttachmentId, selectedSlotId)}
          onRename={selectedPathSlot
            ? () => {
                setPendingRename({
                  title: '重命名路径',
                  message: '为此路径输入一个新名称:',
                  initialValue: selectedPathSlot.name,
                  onConfirm: (v) => { renameSlot(selectedPathSlot.id, v); closeRename(); },
                });
              }
            : undefined}
          onDelete={() => {
            const label = selectedPathSlot?.name ?? `路径 ${parseInt(selectedAttachmentId.slice(5), 10)}`;
            if (confirm(`删除路径附件 "${label}"？\n它会被从所有插槽中移除。`)) {
              removePathAttachment(selectedAttachmentId);
            }
          }}
          C={C}
        />
      ) : selectedAttachment ? (
        <AttachmentPropsBlock
          attachment={selectedAttachment}
          color={attachmentStyle[selectedAttachment.id]?.color ?? ''}
          onColor={(c) => setAttachmentStyle(selectedAttachment.id, { color: c })}
          candidates={attachments.filter((l) => !selectedSlot?.attachmentIds.includes(l.id))}
          onAddAttachment={selectedSlotId ? (aid) => addAttachmentToSlot(selectedSlotId, aid) : undefined}
          onDetach={selectedSlotId ? () => detachAttachment(selectedSlotId, selectedAttachment.id) : undefined}
          onRename={() => {
            const cur = usePixiBonesStore.getState().images.find((x) => x.id === selectedAttachment.id);
            if (!cur) return;
            setPendingRename({
              title: '重命名图片',
              message: '为此图片输入一个新名称:',
              initialValue: cur.name,
              onConfirm: (v) => { renameAttachment(selectedAttachment.id, v); closeRename(); },
            });
          }}
          onCopy={() => duplicateAttachment(selectedAttachment.id, selectedSlotId)}
          bindingBoneName={selectedBindingBoneName}
          onUnbind={selectedSlotId ? () => unbindSlot(selectedSlotId) : undefined}
          onParent={selectedSlotId ? () => startAttach(selectedSlotId) : undefined}
          slotId={selectedSlotId}
          isMesh={!!attachmentMeshes[selectedAttachment.id]}
          onToggleMesh={(v) => {
            pushHistory();
            if (v) createMesh(selectedAttachment.id, 2, 2);
            else {
              removeMesh(selectedAttachment.id);
              // 取消网格后退出编辑模式（该附件不再可编辑）
              setMeshEditSlot(null);
            }
          }}
          wireframe={!!meshWireframe[selectedAttachment.id]}
          onToggleWireframe={(v) => setMeshWireframe(selectedAttachment.id, v)}
          editingMesh={!!selectedSlotId && meshEditSlotId === selectedSlotId}
          onEditMesh={() => {
            if (!selectedSlotId) return;
            setMeshEditSlot(meshEditSlotId === selectedSlotId ? null : selectedSlotId);
          }}
          onResetMesh={selectedSlotId ? () => resetMesh(selectedAttachment.id) : undefined}
          onFreeze={selectedSlotId ? () => { pushHistory(); freezeMesh(selectedSlotId, selectedAttachment.id); } : undefined}
          vertexCount={attachmentMeshes[selectedAttachment.id]
            ? Math.floor(attachmentMeshes[selectedAttachment.id].vertices.length / 2)
            : undefined}
          C={C}
        />
      ) : selectedSlotId ? (
        <SlotPropsBlock
          slot={selectedSlot}
          candidates={attachments.filter((l) => !selectedSlot?.attachmentIds.includes(l.id))}
          onAddAttachment={(aid) => addAttachmentToSlot(selectedSlotId, aid)}
          onCreatePath={() => createPathAttachment(selectedSlotId)}
          color={slotStyle[selectedSlotId]?.color ?? ''}
          onColor={(c) => setSlotStyle(selectedSlotId, { color: c })}
          blend={slotStyle[selectedSlotId]?.blend ?? 'normal'}
          onBlend={(b) => setSlotStyle(selectedSlotId, { blend: b })}
          bindingBoneName={selectedBindingBoneName}
          onParent={() => startAttach(selectedSlotId)}
          onUnbind={() => unbindSlot(selectedSlotId)}
          onDelete={selectedSlot
            ? () => {
                const n = selectedSlot.attachmentIds.length;
                if (n > 0) {
                  if (!confirm(`删除插槽 "${selectedSlot.name}"？\n它包含 ${n} 个附件（素材保留在「图片」区）。`)) return;
                } else {
                  if (!confirm(`删除插槽 "${selectedSlot.name}"？`)) return;
                }
                removeSlot(selectedSlotId);
              }
            : undefined}
          onRename={selectedSlot ? () => {
            const cur = usePixiBonesStore.getState().slots.find((x) => x.id === selectedSlot.id);
            if (!cur) return;
            setPendingRename({
              title: '重命名插槽',
              message: '为此插槽输入一个新名称:',
              initialValue: cur.name,
              onConfirm: (v) => { renameSlot(selectedSlot.id, v); closeRename(); },
            });
          } : undefined}
          onCopy={selectedSlot ? () => duplicateSlot(selectedSlot.id) : undefined}
          C={C}
        />
      ) : selectedSectionKey === 'images' ? (
        <ImagesSectionPropsBlock
          onAddPsd={() => importInputRef.current?.click()}
          onRefresh={() => { thumbCache.clear(); setRefreshTick((t) => t + 1); }}
          C={C}
        />
      ) : selectedSectionKey === 'constraints' ? (
        // ★ 按选中约束的 id 前缀分派：pc_ = 路径约束面板；否则 = IK 面板
        (selectedConstraintId && selectedConstraintId.startsWith('pc_')) ? (
          <PathConstraintsSectionPropsBlock
            pathConstraints={pathConstraints}
            bones={bones}
            slots={slots}
            attachmentPaths={attachmentPaths}
            onAdd={(targetSlotId, boneIds) => addPathConstraint(targetSlotId, boneIds)}
            onRemove={(id) => removePathConstraint(id)}
            onRename={(id, name) => renamePathConstraint(id, name)}
            onRenamePopup={(id) => openPathConstraintRename(id)}
            onCopy={(id) => duplicatePathConstraint(id)}
            onTarget={(id, slotId) => setPathConstraintTarget(id, slotId)}
            onSetBones={(id, boneIds) => setPathConstraintBones(id, boneIds)}
            onBoneOrder={(id, fromIndex, toIndex) => setPathConstraintBoneOrder(id, fromIndex, toIndex)}
            onPositionMode={(id, m) => setPathConstraintPositionMode(id, m)}
            onPosition={(id, v) => setPathConstraintPosition(id, v)}
            onSpacingMode={(id, m) => setPathConstraintSpacingMode(id, m)}
            onSpacing={(id, v) => setPathConstraintSpacing(id, v)}
            onRotateMode={(id, m) => setPathConstraintRotateMode(id, m)}
            onRotateMix={(id, v) => setPathConstraintRotateMix(id, v)}
            onTranslateMix={(id, v) => setPathConstraintTranslateMix(id, v)}
            onRotationOffset={(id, deg) => setPathConstraintRotationOffset(id, deg)}
            onMove={(id, toIndex) => movePathConstraint(id, toIndex)}
            pushHistory={pushHistory}
            C={C}
          />
        ) : (
          <ConstraintsSectionPropsBlock
            constraints={constraints}
            bones={bones}
            onAdd={(boneId, targetBoneId, childBoneId) => addIkConstraint(boneId, targetBoneId, childBoneId)}
            onRemove={(id) => removeConstraint(id)}
            onRename={(id, name) => renameConstraint(id, name)}
            onRenamePopup={(id) => openConstraintRename(id)}
            onTarget={(id, targetId) => setConstraintTarget(id, targetId)}
            onMix={(id, mix) => setConstraintMix(id, mix)}
            onBend={(id, dir) => setConstraintBendDirection(id, dir)}
            onMove={(id, toIndex) => moveConstraint(id, toIndex)}
            C={C}
          />
        )
      ) : null}

      {/* ===== 大预览浮层：hover 附件图标 2s 后弹出（仿 Spine） =====
            用 createPortal 渲染到 body，避开 <aside> 的 overflow/transform 影响。 */}
      {preview && createPortal(
        <div
          style={{
            position: 'fixed',
            left: Math.min(preview.x + 18, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 360),
            top: Math.min(preview.y + 18, (typeof window !== 'undefined' ? window.innerHeight : 720) - 320),
            zIndex: 9999,
            pointerEvents: 'none',
            padding: 8,
            background: '#2D2D30',
            border: '1px solid #3F3F46',
            borderRadius: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          <img
            src={preview.url}
            alt=""
            draggable={false}
            style={{
              maxWidth: 320,
              maxHeight: 320,
              display: 'block',
              backgroundImage:
                'linear-gradient(45deg, #3A3A3D 25%, transparent 25%),' +
                'linear-gradient(-45deg, #3A3A3D 25%, transparent 25%),' +
                'linear-gradient(45deg, transparent 75%, #3A3A3D 75%),' +
                'linear-gradient(-45deg, transparent 75%, #3A3A3D 75%)',
              backgroundSize: '16px 16px',
              backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
              backgroundColor: '#2A2A2D',
            }}
          />
        </div>,
        document.body,
      )}

      {/* ===== 重命名弹窗（Spine 风格，蓝色斜切标题 + 自动选中输入） =====
          Portal 到 body，避开 <aside> 内的 stacking context / overflow 影响。 */}
      {pendingRename && createPortal(
        <PromptDialog
          open
          title={pendingRename.title}
          message={pendingRename.message}
          initialValue={pendingRename.initialValue}
          onConfirm={pendingRename.onConfirm}
          onCancel={closeRename}
        />,
        document.body,
      )}
    </aside>
  );
}

// =================================================================================
//  顶部工具按钮（SVG 图标，Spine 单行风格）
//    children：SVG path / rect / circle 等节点
// =================================================================================
function ToolIcon({ title, active, children, C }: { title: string; active?: boolean; children: React.ReactNode; C: any }) {
  return (
    <button
      className="h-6 w-6 flex items-center justify-center rounded shrink-0"
      style={{
        background: active ? C.accentDk : 'transparent',
        color: active ? '#fff' : C.dim,
        border: 'none',
        cursor: 'pointer',
        padding: 0,
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
      title={title}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">{children}</svg>
    </button>
  );
}

// =================================================================================
//  树的一行（工程节点 / 骨 / 分区）+ Spine 风格折线连线
// =================================================================================
/** 行高（像素）——左列 / 右列 / 连线都按它对齐 */
const ROW_H = 28;
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

/** 一行的「拖动源」信息 */
interface RowDrag {
  /** 拖拽中（半透明显示） */
  dragging: boolean;
  /** 悬浮提示 */
  title?: string;
  onDragStart: () => void;
  onDragEnd: () => void;
}

/** 一行的「落点」信息 */
interface RowDrop {
  /** order = 绘制顺序插入位置；slot = 加到该插槽；attachment = 替换该附件 */
  kind: 'order' | 'slot' | 'attachment';
  /** 当前是否是落点（高亮） */
  active: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: () => void;
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
  /** 当前选中的树行 key —— 只给「被点击的那一行」上高亮，不联动其它视图 */
  selectedRowKey: string | null;
  /** 选中一个插槽（key = slotId） */
  onSelectSlot: (slotId: string, rowKey?: string) => void;
  /** 选中一个素材附件（点附件行）。slotId = 上下文插槽（「图片」里可能没被引用 → null）；
   *  additive=true = Shift 加选/反选（多选路径附件） */
  onSelectAttachment: (slotId: string | null, attachmentId: string, rowKey: string, additive?: boolean) => void;
  /** 切换插槽当前显示的附件 */
  onActivateAttachment: (slotId: string, attachmentId: string) => void;
  /** 分区节点（约束 / 图片 / …）相关 */
  selectedSectionKey: string | null;
  onSelectSection: (key: string) => void;
  /** 当前选中的 IK 约束 id（约束行高亮） */
  selectedConstraintId: string | null;
  onSelectConstraint: (id: string) => void;
  /** 路径约束行：行内删除 / 调整应用顺序 */
  onRemovePathConstraint?: (id: string) => void;
  onMovePathConstraint?: (id: string, toIndex: number) => void;
  /** 层级树顶部的「动画」节点被点击 */
  onSelectAnimation: () => void;
  slotBindings: Record<string, SlotBinding>;
  /** 附件 id → layer 映射（插槽行悬停预览取激活附件用） */
  attachmentById: Map<string, PixiBonesLayer>;
  boneNameById: Map<string, string>;
  /** 「图片」节点上的 ＋ 导入按钮 */
  onImport?: () => void;
  /** 该行可被拖动（绘制顺序里排序 / 「图片」里的附件拖去插槽） */
  drag?: RowDrag;
  /** 该行可作为落点 */
  drop?: RowDrop;
  /** 附件图标 hover 大预览（仿 Spine：停留 2s 弹出大图） */
  onAssetHoverEnter?: (layer: PixiBonesLayer, clientX: number, clientY: number) => void;
  onAssetHoverMove?: (clientX: number, clientY: number) => void;
  onAssetHoverLeave?: () => void;
  /** 双击该行触发重命名弹窗（Spine 行为）。不传 = 该行不支持重命名。 */
  onRequestRename?: () => void;
}

function TreeRowView(props: TreeRowViewProps) {
  const {
    row, selectedBoneId, onSelect, onAddChild, collapsed, onToggleCollapse, search, C,
    selectedRowKey, onSelectSlot, onSelectAttachment,
    onActivateAttachment, selectedSectionKey, onSelectSection, selectedConstraintId, onSelectConstraint, onSelectAnimation,
    onRemovePathConstraint, onMovePathConstraint,
    slotBindings, boneNameById, onImport, drag, drop,
    onAssetHoverEnter, onAssetHoverMove, onAssetHoverLeave,
    onRequestRename,
    attachmentById,
  } = props;
  // ★ 路径约束创建拾取：TreeRowView 是独立组件，直接读 store（避免层层传 prop）
  const pcPickMode = usePixiBonesStore((s) => s.pcPickMode);
  const pickPathConstraintPath = usePixiBonesStore((s) => s.pickPathConstraintPath);
  const isBone = row.kind === 'bone';
  /** 附件行（🖼） */
  const isAsset = row.kind === 'asset';
  const isSection = row.kind === 'section';
  /** 插槽行（◉） */
  const isSlot = row.kind === 'slot';
  /** 顶部「动画」节点（🎬 当前动画名） */
  const isAnim = row.kind === 'animation';
  /** IK 约束行（🪢，挂在「约束」分区下） */
  const isConstraint = row.kind === 'constraint';
  /** 路径约束行（📐，挂在「约束」分区下、IK 之后） */
  const isPathConstraint = row.kind === 'path-constraint';
  /** 分区原始 key（'section:images' → 'images'） */
  const sectionKey = isSection && row.key.startsWith('section:') ? row.key.slice('section:'.length) : null;
  const node = row.node;
  const asset = row.asset;
  const slot = row.slot;
  /** 悬停预览对象：附件行 = 该附件；插槽行 = 插槽当前激活的附件（对齐 Spine） */
  const previewLayer = isAsset
    ? (asset ?? null)
    : (isSlot && slot && slot.activeAttachmentId
        ? (attachmentById.get(slot.activeAttachmentId) ?? null)
        : null);
  /** 附件行归属的插槽 id */
  const assetSlotId = row.slotId ?? null;
  // ★ 高亮精确到「被点击的那一行」：slot / asset 行只看 selectedRowKey，
  //   避免同一插槽在 主树 / 绘制顺序 / 图片分区 多处同时高亮。
  const isSelected =
    (isBone && !!node && selectedBoneId === node.id) ||
    ((isSlot || isAsset || isAnim) && row.key === selectedRowKey) ||
    (isSection && sectionKey !== null && selectedSectionKey === sectionKey) ||
    (isConstraint && !!row.constraint && selectedConstraintId === row.constraint.id) ||
    (isPathConstraint && !!row.pathConstraint && selectedConstraintId === row.pathConstraint.id);

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
  const clickable = isBone || isAsset || isSection || isSlot || isAnim || isConstraint || isPathConstraint;

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
      className="group flex items-center pl-2 pr-1 rounded select-none"
      draggable={!!drag}
      onDragStart={drag ? (e) => {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', row.label); } catch { /* 某些浏览器对自定义 MIME 有限制 */ }
        drag.onDragStart();
      } : undefined}
      onDragEnd={drag ? () => drag.onDragEnd() : undefined}
      onDragOver={drop ? (e) => drop.onDragOver(e) : undefined}
      onDragLeave={drop ? () => drop.onDragLeave() : undefined}
      onDrop={drop ? (e) => { e.preventDefault(); drop.onDrop(); } : undefined}
      style={{
        height: ROW_H,
        cursor: drag ? 'grab' : (clickable ? 'pointer' : 'default'),
        background: isSelected ? C.accentDk : 'transparent',
        color: isSelected ? '#fff' : C.text,
        fontWeight: isSelected ? 600 : 400,
        opacity: drag?.dragging ? 0.45 : 1,
        boxShadow: drop?.active
          // 排序落点：顶部一条插入线；附件落点（加插槽 / 替换）：整行描边
          ? (drop.kind === 'order' ? `inset 0 2px 0 ${C.accent}` : `inset 0 0 0 1px ${C.accent}`)
          : undefined,
      }}
      title={drag?.title}
      onMouseEnter={(e) => {
        if (!isSelected && clickable) e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
        if (previewLayer && onAssetHoverEnter) onAssetHoverEnter(previewLayer, e.clientX, e.clientY);
      }}
      onMouseMove={(e) => {
        if (previewLayer && onAssetHoverMove) onAssetHoverMove(e.clientX, e.clientY);
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.background = 'transparent';
        if (previewLayer && onAssetHoverLeave) onAssetHoverLeave();
      }}
      onClick={(e) => {
        if (isBone && node) onSelect(node.id);
        else if (isAnim) onSelectAnimation();
        else if (isSection && sectionKey !== null) onSelectSection(sectionKey);
        else if (isSlot && slot) {
          // ★ 路径约束创建/重选：拾取目标路径阶段点「插槽」行 = 拾取为约束目标（pickPathConstraintPath 内部会校验插槽是否激活路径）
          if (pcPickMode === 'path' && slot.id && pickPathConstraintPath) {
            pickPathConstraintPath(slot.id);
            return;
          }
          onSelectSlot(slot.id, row.key);
        }
        else if (isAsset && (asset || row.isPath)) {
          // 附件行（图片 / 路径）：有引用它的插槽则顺便切为「当前显示」，然后选中该附件
          // ★ Shift = 加选/反选（路径多选；图片附件仍单选）
          const aid = asset ? asset.id : (row.pathAttachmentId ?? '');
          if (!aid) return;
          if (assetSlotId) onActivateAttachment(assetSlotId, aid);
          // ★ 路径约束创建：拾取目标路径阶段点路径行 = 拾取为约束目标
          if (row.isPath && pcPickMode === 'path' && assetSlotId) {
            pickPathConstraintPath(assetSlotId);
            return;
          }
          onSelectAttachment(assetSlotId, aid, row.key, row.isPath ? e.shiftKey : undefined);
        }
        else if (isConstraint && row.constraint) onSelectConstraint(row.constraint.id);
        else if (isPathConstraint && row.pathConstraint) onSelectConstraint(row.pathConstraint.id);
      }}
      onDoubleClick={(e) => {
        // ★ 双击 = 触发重命名（Spine 行为）
        // 阻止默认文本选择（按住拖动选中状态下双击会引发文本选中）
        e.preventDefault();
        onRequestRename?.();
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
        className="w-3 h-3 mr-0.5 shrink-0 flex items-center justify-center rounded-full text-[11px]"
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
          className="w-4 h-4 flex items-center justify-center text-[13px] shrink-0 mr-1"
          style={{ color: isSelected ? '#fff' : C.dim }}
        >
          {row.icon}
        </span>
      )}

      {/* 名称（空插槽额外标注，便于区分「插槽还在但没附件」） */}
      <span className="truncate flex-1 text-[14px]">
        {nameEl}
        {/* 路径约束行：小字「槽名 → 骨1,骨2」 */}
        {isPathConstraint && row.subLabel && (
          <span className="ml-1 text-[11px]" style={{ color: C.dim }}>{row.subLabel}</span>
        )}
        {isSlot && slot && slot.attachmentIds.length === 0 && (
          <span className="ml-1 text-[11px]" style={{ color: C.dim }}>（空）</span>
        )}
        {isAsset && row.isMesh && (
          <span className="ml-1 text-[11px]" style={{ color: C.accent }} title="网格附件（曲面）">▦ 曲面</span>
        )}
        {isAsset && row.isPath && (
          <span className="ml-1 text-[11px]" style={{ color: '#8ec9ff' }} title="路径附件（复合贝塞尔）">✒ 路径</span>
        )}
      </span>

      {/* 插槽行 / 附件行：绑定状态已并入树形结构（插槽挂到绑定骨骼下），
          不再显示 🔗绑定名 标签（对齐 Spine）；未绑定时保留 hover 的 🔗 绑定入口 */}
      {((isSlot && slot) || (isAsset && assetSlotId)) && !boundBoneName ? (
        <button
          className="shrink-0 w-4 h-4 flex items-center justify-center text-[12px] opacity-0 group-hover:opacity-100"
          style={{ background: 'transparent', border: 'none', cursor: selectedBoneId ? 'pointer' : 'not-allowed', color: selectedBoneId ? C.text : C.dim }}
          title={selectedBoneId ? '绑定到选中骨骼' : '先在画布/树里选中一根骨骼'}
          onClick={(e) => { e.stopPropagation(); if (selectedBoneId) doBindToggle(); }}
        >
          🔗
        </button>
      ) : null}

      {/* 「图片」节点上的 ＋ 导入素材 */}
      {onImport && (
        <button
          className="w-4 h-4 flex items-center justify-center text-[14px] shrink-0 opacity-0 group-hover:opacity-100"
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
          className="w-4 h-4 flex items-center justify-center text-[14px] shrink-0 opacity-0 group-hover:opacity-100"
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

      {/* 路径约束行右侧：上移 / 下移 / 删除（调整应用顺序；hover 才显示） */}
      {isPathConstraint && row.pathConstraint && (
        <div className="flex items-center shrink-0 opacity-0 group-hover:opacity-100">
          <button
            className="w-4 h-4 flex items-center justify-center rounded text-[12px]"
            style={{ background: 'transparent', border: 'none', color: C.dim, cursor: (row.listIndex ?? 0) === 0 ? 'default' : 'pointer' }}
            disabled={(row.listIndex ?? 0) === 0}
            title="上移（更先应用）"
            onClick={(e) => { e.stopPropagation(); onMovePathConstraint?.(row.pathConstraint!.id, (row.listIndex ?? 0) - 1); }}
          >▲</button>
          <button
            className="w-4 h-4 flex items-center justify-center rounded text-[12px]"
            style={{ background: 'transparent', border: 'none', color: C.dim, cursor: (row.listIndex ?? 0) >= (row.listLength ?? 1) - 1 ? 'default' : 'pointer' }}
            disabled={(row.listIndex ?? 0) >= (row.listLength ?? 1) - 1}
            title="下移（更后应用）"
            onClick={(e) => { e.stopPropagation(); onMovePathConstraint?.(row.pathConstraint!.id, (row.listIndex ?? 0) + 1); }}
          >▼</button>
          <button
            className="w-4 h-4 flex items-center justify-center rounded text-[12px]"
            style={{ background: 'transparent', border: 'none', color: C.warning, cursor: 'pointer' }}
            title="删除路径约束"
            onClick={(e) => {
              e.stopPropagation();
              onRemovePathConstraint?.(row.pathConstraint!.id);
              if (selectedConstraintId === row.pathConstraint!.id) usePixiBonesStore.getState().selectSection('constraints');
            }}
          >✕</button>
        </div>
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
//  Spine 风格「新建」下拉菜单（骨骼属性面板底部按钮触发）
//   - 深灰菜单 + 图标 + 悬停高亮（参考 Spine New 菜单）
//   - 带子菜单的项（如 约束）hover 展开二级菜单
//   - 未实现的功能用「(未实现)」占位文字显示，点击无操作
// =================================================================================
interface NewMenuEntry {
  icon: string;
  label: string;
  /** 已实现 → 点击执行；缺省 = 未实现占位 */
  action?: () => void;
  /** 子菜单项（hover 展开） */
  children?: NewMenuEntry[];
}

function SpineNewMenu({
  x, y, items, onClose, C,
}: {
  /** 菜单左上角固定定位（viewport 坐标） */
  x: number;
  y: number;
  items: NewMenuEntry[];
  onClose: () => void;
  C: any;
}) {
  const [child, setChild] = useState<{ parent: NewMenuEntry; left: number; top: number } | null>(null);
  const ITEM_H = 24;
  const W = 170;

  // Esc = 关闭
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      {createPortal(
        <div
          className="fixed z-[9998] shadow-2xl"
          style={{ left: x, top: y, minWidth: W, background: C.panel, border: '1px solid ' + C.border, borderRadius: 4, padding: '4px 0', fontSize: 14 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {items.map((it, idx) => {
            const enabled = !!it.action || !!it.children?.length;
            return (
              <button
                key={it.label}
                type="button"
                className="w-full flex items-center gap-2 text-left"
                style={{
                  height: ITEM_H,
                  padding: '0 10px',
                  background: 'transparent',
                  border: 'none',
                  color: enabled ? C.text : C.dim,
                  cursor: enabled ? 'pointer' : 'default',
                  fontSize: 14,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                  if (it.children?.length) {
                    // 子菜单向左侧弹出（菜单通常在右侧面板，往左避免溢出屏幕）
                    setChild({ parent: it, left: x - W - 6, top: y + 4 + idx * ITEM_H });
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  // 若已展开子菜单则保留（hover 进入子菜单不关闭）
                  if (child?.parent !== it) setChild(null);
                }}
                onClick={() => {
                  if (it.children?.length) return; // 子菜单通过 hover 展开
                  if (!it.action) return;
                  onClose();
                  it.action();
                }}
              >
                <span className="w-4 shrink-0 text-center" style={{ color: enabled ? C.accent : C.dim }}>{it.icon}</span>
                <span className="flex-1 truncate">{it.label}</span>
                {!enabled && <span className="text-[12px] shrink-0" style={{ color: C.dim }}>(未实现)</span>}
                {!!it.children?.length && <span className="text-[12px]" style={{ color: C.dim }}>▶</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
      {/* 二级菜单（约束 → IK/路径/变换） */}
      {child && createPortal(
        <div
          className="fixed z-[9999] shadow-2xl"
          style={{ left: child.left, top: child.top, minWidth: W, background: C.panel, border: '1px solid ' + C.border, borderRadius: 4, padding: '4px 0', fontSize: 12 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {child.parent.children!.map((sub) => {
            const enabled = !!sub.action;
            return (
              <button
                key={sub.label}
                type="button"
                className="w-full flex items-center gap-2 text-left"
                style={{
                  height: ITEM_H,
                  padding: '0 10px',
                  background: 'transparent',
                  border: 'none',
                  color: enabled ? C.text : C.dim,
                  cursor: enabled ? 'pointer' : 'default',
                  fontSize: 12,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                onClick={() => {
                  if (!sub.action) return;
                  onClose();
                  sub.action();
                }}
              >
                <span className="w-4 shrink-0 text-center" style={{ color: enabled ? C.accent : C.dim }}>{sub.icon}</span>
                <span className="flex-1 truncate">{sub.label}</span>
                {!enabled && <span className="text-[12px] shrink-0" style={{ color: C.dim }}>(未实现)</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
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
  /** 「新建」菜单：创建 IK 约束（目标骨由父级决定） */
  onCreateIk?: () => void;
  /** 「新建 → 路径」：先弹命名对话框，确认后创建绑定到当前骨骼的新路径 */
  onCreatePath?: () => void;
  /** 「新建 → 约束 → 路径约束」：进入拾取模式（先选目标路径，再选受约束骨骼） */
  onCreatePathConstraint?: () => void;
  onDelete: () => void;
  /** 重命名骨骼 */
  onRename?: () => void;
  /** 复制骨骼（插入到该骨骼下方、平级） */
  onCopy?: () => void;
  onToggleIsolate: () => void;
  isolated: boolean;
  C: any;
}

function BonePropsBlock(props: BonePropsBlockProps) {
  const { node, parentOptions, onMove, onRotate, onLength, onParent, onAddChild, onCreateIk, onCreatePath, onCreatePathConstraint, onDelete, onRename, onCopy, onToggleIsolate, isolated, C } = props;
  const rotDeg = (node.rotation * 180) / Math.PI;
  // 输入框统一样式
  const inputStyle: React.CSSProperties = {
    background: C.panelDk,
    border: '1px solid ' + C.border,
    color: C.text,
    borderRadius: 3,
    padding: '2px 6px',
    fontSize: 13,
  };
  // ===== 「新建」下拉菜单（Spine 风格）=====
  const newBtnRef = useRef<HTMLButtonElement | null>(null);
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);
  // 打开菜单：按钮在面板底部 → 优先向上展开
  const openNewMenu = () => {
    const el = newBtnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const MENU_H = 8 * 24 + 8; // 估算：8 项 × 24px + 上下 padding
    const up = r.top > MENU_H + 40;
    setNewMenu({ x: r.left, y: up ? r.top - MENU_H : r.bottom });
  };
  // 点击外部 / 切换选中骨 → 关闭菜单
  useEffect(() => {
    if (!newMenu) return;
    const onDocDown = (e: MouseEvent) => {
      if (newBtnRef.current && !newBtnRef.current.contains(e.target as Node)) setNewMenu(null);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [newMenu]);
  // 新建菜单项：骨骼 / 插槽 / 皮肤 / 网格 / 路径 / 约束(子菜单) / 事件 / 音频
  const newMenuItems: NewMenuEntry[] = [
    { icon: '🦴', label: '骨骼', action: onAddChild },
    { icon: '◉', label: '插槽' }, // 未实现
    { icon: '🧴', label: '皮肤' }, // 未实现
    { icon: '▦', label: '网格' }, // 未实现
    // 「新建 → 路径」：先弹命名对话框（统一 PromptDialog UI），确认后创建绑定到当前骨骼的新路径
    { icon: '✒️', label: '路径', action: onCreatePath ? () => onCreatePath() : undefined },
    {
      icon: '🪢', label: '约束',
      children: [
        { icon: '🪝', label: 'IK 约束', action: onCreateIk },
        { icon: '⤳', label: '路径约束', action: onCreatePathConstraint ? () => onCreatePathConstraint() : undefined },
        { icon: '⇄', label: '变换约束' }, // 未实现
      ],
    },
    { icon: '🎬', label: '事件' }, // 未实现
    { icon: '🔊', label: '音频' }, // 未实现
  ];
  return (
    <div style={{ borderTop: '1px solid ' + C.border, background: C.panelDk }}>
      {/* 第一行：骨名 + 图标按钮 */}
      <div className="flex items-center px-2 py-1.5" style={{ background: C.toolbar, borderBottom: '1px solid ' + C.border }}>
        <span className="text-[14px] font-semibold flex-1 truncate" style={{ color: C.selected }} title={node.name}>
          🦴 {node.name}
        </span>
        <button className="w-6 h-6 flex items-center justify-center" style={{ color: C.dim, background: 'transparent', border: 'none', cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')} onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)} title="定位到画布" onClick={onToggleIsolate}>
          {isolated ? '🟢' : '📍'}
        </button>
        {node.parentId !== null && (
          <button
            className="w-6 h-6 flex items-center justify-center"
            style={{ color: C.dim, background: 'transparent', border: 'none', cursor: onCopy ? 'pointer' : 'not-allowed', opacity: onCopy ? 1 : 0.5 }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
            onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)}
            title={onCopy ? '复制（创建副本，插入到下方）' : '复制'}
            onClick={onCopy}
          >⧉</button>
        )}
        <button
          className="w-6 h-6 flex items-center justify-center"
          style={{ color: C.dim, background: 'transparent', border: 'none', cursor: onRename ? 'pointer' : 'not-allowed', opacity: onRename ? 1 : 0.5 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)}
          title="重命名"
          onClick={onRename}
        >✎</button>
        {node.parentId !== null && (
          <button className="w-6 h-6 flex items-center justify-center" style={{ color: C.dim, background: 'transparent', border: 'none', cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.color = '#e88')} onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)} title="删除" onClick={onDelete}>✕</button>
        )}
      </div>

      {/* 第二行：继承 / 旋转 / 缩放 / 反射 checkbox */}
      <div className="px-2 py-1 grid grid-cols-4 gap-1 text-[12px]">
        <CheckChip label="继承" defaultChecked C={C} />
        <CheckChip label="旋转" defaultChecked C={C} />
        <CheckChip label="缩放" defaultChecked C={C} />
        <CheckChip label="反射" defaultChecked C={C} />
      </div>

      {/* 第三行：长度 / 选择 / 名称 */}
      <div className="px-2 pb-1.5 flex items-center gap-2 text-[14px]">
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
      <div className="px-2 pb-1.5 flex items-center gap-2 text-[14px]">
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
      <div className="px-2 pb-1.5 flex items-center gap-2 text-[14px]">
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

      {/* 第六行：底部操作按钮（新建 ▾ / 父级 / 拆分 / 皮肤） */}
      <div className="px-2 pb-2 grid grid-cols-4 gap-1 text-[12px]">
        <button ref={newBtnRef} onClick={openNewMenu} className="rounded px-1 py-1 flex items-center justify-center gap-0.5" style={{ background: newMenu ? C.toolbar : C.panel, color: C.text, border: '1px solid ' + C.border, cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)} onMouseLeave={(e) => { if (!newMenu) e.currentTarget.style.background = C.panel; }} title="新建骨骼 / 插槽 / 约束 …">
          <span style={{ color: C.accent }}>+</span> 新建 <span style={{ color: C.dim, fontSize: 11 }}>▾</span>
        </button>
        <button className="rounded px-1 py-1 flex items-center justify-center gap-0.5" style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border, cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)} onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}>
          <span>↗</span> 父级
        </button>
        <button className="rounded px-1 py-1 flex items-center justify-center gap-0.5" style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border, cursor: 'pointer' }} onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)} onMouseLeave={(e) => (e.currentTarget.style.background = C.panel)}>
          <span>✂</span> 拆分
        </button>
        <button className="rounded px-1 py-1 flex items-center justify-center gap-0.5 relative" style={{ background: 'rgba(230,30,30,0.15)', color: '#e88', border: '1px solid rgba(230,30,30,0.3)', cursor: 'pointer' }}>
          <span>🧴</span> 皮肤
          <span className="absolute -top-1 -right-1 text-[10px] px-0.5 font-bold" style={{ background: C.warning, color: '#000', borderRadius: 2 }}>PRO</span>
        </button>
      </div>

      {/* 「新建」下拉菜单（Spine 风格，portal 到 body） */}
      {newMenu && (
        <SpineNewMenu
          x={newMenu.x}
          y={newMenu.y}
          items={newMenuItems}
          onClose={() => setNewMenu(null)}
          C={C}
        />
      )}
    </div>
  );
}

function CheckChip({ label, checked, onChange, defaultChecked, C }: { label: string; checked?: boolean; onChange?: (v: boolean) => void; defaultChecked?: boolean; C: any }) {
  return (
    <label className="flex items-center gap-1 cursor-pointer select-none" style={{ color: C.text }}>
      <input
        type="checkbox"
        checked={checked}
        defaultChecked={checked === undefined ? defaultChecked : undefined}
        onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
        className="w-3 h-3"
      />
      <span>{label}</span>
    </label>
  );
}

// =================================================================================
//  属性面板共用零件（插槽面板 / 附件面板共用；仿 Spine 面板布局）
// =================================================================================

/** PIXI v8 混合模式下拉选项 */
const BLEND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'normal',   label: '正常' },
  { value: 'add',      label: '相加' },
  { value: 'multiply', label: '相乘' },
  { value: 'screen',   label: '滤色' },
  { value: 'overlay',  label: '叠加' },
  { value: 'darken',   label: '变暗' },
  { value: 'lighten',  label: '变亮' },
];

/**
 * 属性面板标题栏：`◉ 插槽: 名字` / `▭ 区域: 名字` + 右侧 4 个图标按钮
 * （从右往左：删除 / 重命名 / 复制 / 设置占位）。
 */
function PanelTitleBar({
  icon, kindLabel, name, badge, C, onDelete, deleteTitle, onRename, onCopy,
}: {
  icon: string; kindLabel: string; name: string; badge?: string; C: any;
  /** 提供则「✕」可点，否则为占位 */
  onDelete?: () => void;
  deleteTitle?: string;
  /** 提供则「✎」可点（重命名），否则为占位 */
  onRename?: () => void;
  /** 提供则「⧉」可点（复制），否则为占位 */
  onCopy?: () => void;
}) {
  const iconBtn: React.CSSProperties = {
    background: C.panel,
    border: '1px solid ' + C.border,
    color: C.dim,
    cursor: 'not-allowed',
    width: 20, height: 18, lineHeight: '16px',
    fontSize: 12, borderRadius: 3, padding: 0, opacity: 0.55,
  };
  const activeBtn = (color?: string): React.CSSProperties => ({
    ...iconBtn,
    cursor: 'pointer',
    opacity: 1,
    ...(color ? { color } : {}),
  });
  return (
    <div
      className="flex items-center px-2 py-1.5 gap-1"
      style={{ background: C.toolbar, borderBottom: '1px solid ' + C.border }}
    >
      <span className="text-[14px] shrink-0" style={{ color: C.dim }}>{icon}</span>
      <span className="text-[14px] shrink-0" style={{ color: C.dim }}>{kindLabel}:</span>
      <span className="text-[14px] font-semibold truncate" style={{ color: C.selected }} title={name}>{name}</span>
      {badge ? <span className="text-[12px] shrink-0" style={{ color: C.dim }}>{badge}</span> : null}
      <span className="ml-auto flex items-center gap-1 shrink-0">
        <button style={iconBtn} title="设置（待实现）">⚙</button>
        <button
          style={onCopy ? activeBtn() : iconBtn}
          title={onCopy ? '复制（创建副本，插入到下方）' : '复制（待实现）'}
          onClick={onCopy}
        >⧉</button>
        <button
          style={onRename ? activeBtn() : iconBtn}
          title={onRename ? '重命名' : '重命名（待实现）'}
          onClick={onRename}
        >✎</button>
        <button
          style={onDelete ? activeBtn('#e06c75') : { ...iconBtn, color: '#e06c75' }}
          title={onDelete ? (deleteTitle ?? '删除') : '删除（待实现）'}
          onClick={onDelete}
        >✕</button>
      </span>
    </div>
  );
}

/** 属性面板的一行：左「图标 + 标签」+ 右侧控件 */
function PanelRow({
  icon, label, C, children,
}: { icon: string; label: string; C: any; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 px-2 py-1" style={{ borderBottom: '1px solid ' + C.border }}>
      <span className="w-4 text-[13px] shrink-0 text-center" style={{ color: C.dim }}>{icon}</span>
      <span className="text-[13px] shrink-0" style={{ color: C.text, width: 40 }}>{label}</span>
      <span className="flex items-center gap-1 flex-1 min-w-0">{children}</span>
    </div>
  );
}

/** 属性面板底部按钮（＋ 新建… / 父级 …） */
function PanelFooterBtn({
  C, onClick, icon, label, title, disabled = false, active = false, pro = false,
}: {
  C: any; onClick: () => void; icon: string; label: string; title?: string;
  /** 不可用（如没有上下文插槽）时置灰、不可点 */
  disabled?: boolean;
  /** 激活态（如「编辑网格」正在编辑中） */
  active?: boolean;
  /** 带 PRO 角标 */
  pro?: boolean;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className="rounded px-1 py-1 flex items-center justify-center gap-0.5 relative"
      style={{
        background: active ? C.accentDk : C.panel,
        color: active ? '#fff' : C.text,
        border: '1px solid ' + (active ? C.accent : C.border),
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 12,
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = C.toolbar; }}
      onMouseLeave={(e) => (e.currentTarget.style.background = active ? C.accentDk : C.panel)}
      title={title}
    >
      {pro && (
        <span style={{ color: '#e5c07b', fontSize: 9, fontWeight: 700, lineHeight: 1 }}>PRO</span>
      )}
      <span style={{ color: active ? '#fff' : C.accent }}>{icon}</span> {label}
    </button>
  );
}

// =================================================================================
//  选中路径附件的属性块（仿 Spine 路径附件面板）
//    「✒ 路径: 名字」标题栏 + 长度 / 选项 / 封闭·定速 / 颜色
//    + 底部按钮：编辑路径 / 重置 / 冻结 / 反转
// =================================================================================
interface PathAttachmentPropsBlockProps {
  name: string;
  /** 路径附件数据（顶点 / 封闭 / 定速 / 颜色 / 选项） */
  path: PathData;
  /** 当前是否处于路径编辑态（画布上显示结 / 柄 gizmo） */
  editing: boolean;
  onEdit: () => void;
  /** 切换「封闭」 */
  onClosed: (v: boolean) => void;
  /** 切换「定速」 */
  onConstantSpeed: (v: boolean) => void;
  /** 设置显示颜色（0xRRGGBB） */
  onColor: (c: number) => void;
  /** 设置选项开关（选择 / 导出 / 名称） */
  onOption: (opt: 'selectable' | 'exportable' | 'nameable', v: boolean) => void;
  /** 重置：旋转归 0、缩放归 1（仿 Spine「重置」） */
  onReset: () => void;
  /** 冻结：把旋转 / 缩放烘焙进顶点再归 0 / 1 */
  onFreeze: () => void;
  /** 反转顶点顺序 */
  onReverse: () => void;
  /** 复制路径附件（副本插入到插槽下方） */
  onCopy: () => void;
  /** 重命名路径（= 重命名引用它的插槽） */
  onRename?: () => void;
  /** 删除路径附件 */
  onDelete: () => void;
  C: any;
}

function PathAttachmentPropsBlock(props: PathAttachmentPropsBlockProps) {
  const { name, path, editing, onEdit, onClosed, onConstantSpeed, onColor, onOption, onReset, onFreeze, onReverse, onCopy, onRename, onDelete, C } = props;
  const colorHex = '#' + (path.color ?? DEFAULT_PATH_COLOR).toString(16).padStart(6, '0');
  return (
    <div style={{ borderTop: '1px solid ' + C.border, background: C.panelDk }}>
      {/* 标题栏：✒️ 路径: 名字 + 右上角 复制 / 重命名 / 删除 */}
      <PanelTitleBar
        icon="✒️"
        kindLabel="路径"
        name={name}
        C={C}
        onCopy={onCopy}
        onRename={onRename}
        onDelete={onDelete}
        deleteTitle="删除该路径附件（同时从所有插槽移除）"
      />

      {/* 长度（只读）：累计段长（贝塞尔采样求弧长） */}
      <PanelRow icon="📏" label="长度" C={C}>
        <span className="text-[13px] tabular-nums" style={{ color: C.text }}>
          {pathLength(path).toFixed(1)}
        </span>
      </PanelRow>

      {/* 选项：选择 / 导出 / 名称（仿 Spine 附件 Options） */}
      <PanelRow icon="☰" label="选项" C={C}>
        <span className="flex items-center gap-3">
          <CheckChip label="选择" checked={path.selectable !== false} onChange={(v) => onOption('selectable', v)} C={C} />
          <CheckChip label="导出" checked={path.exportable !== false} onChange={(v) => onOption('exportable', v)} C={C} />
          <CheckChip label="名称" checked={path.nameable !== false} onChange={(v) => onOption('nameable', v)} C={C} />
        </span>
      </PanelRow>

      {/* 封闭 / 定速（PRO） */}
      <PanelRow icon="✒️" label="路径" C={C}>
        <span className="flex items-center gap-3">
          <CheckChip label="封闭" checked={path.closed} onChange={onClosed} C={C} />
          <CheckChip label="定速" checked={path.constantSpeed} onChange={onConstantSpeed} C={C} />
          <span className="text-[10px] font-bold" style={{ color: '#e5c07b' }}>PRO</span>
        </span>
      </PanelRow>

      {/* 颜色：拾色器（控制画布上路径曲线的显示色） */}
      <PanelRow icon="🎨" label="颜色" C={C}>
        <input
          type="color"
          value={colorHex}
          onChange={(e) => onColor(parseInt(e.target.value.slice(1), 16))}
          style={{ width: 30, height: 20, padding: 0, border: '1px solid ' + C.border, background: 'transparent', cursor: 'pointer', borderRadius: 3 }}
        />
        <span className="text-[12px] tabular-nums" style={{ color: C.dim }}>{colorHex.toUpperCase()}</span>
      </PanelRow>

      {/* 底部按钮：编辑路径 / 重置 / 冻结 / 反转（PRO） */}
      <div className="px-2 pb-2 pt-1 grid grid-cols-4 gap-1 text-[12px]">
        <PanelFooterBtn
          C={C}
          onClick={onEdit}
          icon="✒"
          label={editing ? '退出编辑' : '编辑路径'}
          title={editing
            ? '退出路径编辑'
            : '进入路径编辑：单击加结、右键结束（开放路径）、点回起点闭合（圆）、拖结、拖柄、双击删结'}
          active={editing}
          pro
        />
        <PanelFooterBtn
          C={C}
          onClick={onReset}
          icon="↺"
          label="重置"
          title="把路径的旋转归 0、缩放归 1"
          pro
        />
        <PanelFooterBtn
          C={C}
          onClick={onFreeze}
          icon="❄"
          label="冻结"
          title="把旋转 / 缩放烘焙进顶点，再归 0 / 1"
          pro
        />
        <PanelFooterBtn
          C={C}
          onClick={onReverse}
          icon="⇄"
          label="反转"
          title="反转顶点顺序（交换入 / 出柄，保持曲线形状）"
          pro
        />
      </div>
    </div>
  );
}

/** 路径累计长度（近似弧长：直线段取距离，贝塞尔段 8 段采样求和；封闭时含末段 → 首段）。 */
function pathLength(p: PathData): number {
  const v = p.vertices;
  if (v.length < 2) return 0;
  const segs = p.closed ? v.length : v.length - 1;
  let total = 0;
  const S = 8;
  for (let i = 0; i < segs; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    const hasCtl = a.handleOutX !== 0 || a.handleOutY !== 0 || b.handleInX !== 0 || b.handleInY !== 0;
    if (!hasCtl) {
      total += Math.hypot(b.x - a.x, b.y - a.y);
      continue;
    }
    const p1x = a.x + a.handleOutX, p1y = a.y + a.handleOutY;
    const p2x = b.x + b.handleInX, p2y = b.y + b.handleInY;
    let px = a.x, py = a.y;
    for (let s = 1; s <= S; s++) {
      const t = s / S;
      const mt = 1 - t;
      const x = mt * mt * mt * a.x + 3 * mt * mt * t * p1x + 3 * mt * t * t * p2x + t * t * t * b.x;
      const y = mt * mt * mt * a.y + 3 * mt * mt * t * p1y + 3 * mt * t * t * p2y + t * t * t * b.y;
      total += Math.hypot(x - px, y - py);
      px = x; py = y;
    }
  }
  return total;
}

// =================================================================================
//  选中插槽的属性块（仿 Spine 插槽面板）
//    预览 + 「◉ 插槽: 名字」标题栏 + 颜色 + 混合 + ＋新建…/↖父级
// =================================================================================
interface SlotPropsBlockProps {
  slot: PixiBonesSlot | null;
  /** 「＋ 新建…」挑选器：可加入该插槽的候选素材 */
  candidates: PixiBonesLayer[];
  onAddAttachment: (attachmentId: string) => void;
  /** 「＋ 新建…」里的「新建路径附件」（无插槽上下文时不可用） */
  onCreatePath?: () => void;
  /** 插槽颜色（hex，'' = 不覆盖） */
  color: string;
  onColor: (color: string) => void;
  /** 插槽混合模式（PIXI v8 blend 字符串） */
  blend: string;
  onBlend: (blend: string) => void;
  /** 已绑定的父级骨骼名（null = 未绑定） */
  bindingBoneName: string | null;
  onParent: () => void;
  onUnbind: () => void;
  /** 删除插槽（仅空插槽时由父组件传入；undefined = 有附件，按占位显示） */
  onDelete?: () => void;
  /** 重命名插槽（弹出重命名弹窗） */
  onRename?: () => void;
  /** 复制插槽（插入到该插槽下方、平级） */
  onCopy?: () => void;
  C: any;
}

function SlotPropsBlock(props: SlotPropsBlockProps) {
  const {
    slot, candidates, onAddAttachment, onCreatePath,
    color, onColor, blend, onBlend, bindingBoneName, onParent, onUnbind, onDelete, onRename, onCopy, C,
  } = props;
  // 「＋ 新建…」选择器：把已有素材加入该插槽
  const [picking, setPicking] = useState(false);
  const name = slot?.name ?? '（未知插槽）';
  return (
    <div style={{ borderTop: '1px solid ' + C.border, background: C.panelDk }}>
      {/* 标题栏：◉ 插槽: 名字 + 右侧图标按钮 */}
      <PanelTitleBar
        icon="◉"
        kindLabel="插槽"
        name={name}
        badge={slot ? `${slot.attachmentIds.length} 附件` : ''}
        C={C}
        onDelete={onDelete}
        deleteTitle="删除该插槽"
        onRename={onRename}
        onCopy={onCopy}
      />

      {/* 已绑定的父级骨骼 */}
      {bindingBoneName && (
        <div className="px-2 py-1 flex items-center gap-1 text-[12px]" style={{ color: '#7dd3a0' }}>
          <span>🔗 父级: {bindingBoneName}</span>
          <button
            style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', marginLeft: 'auto' }}
            title="解除绑定"
            onClick={onUnbind}
          >✕</button>
        </div>
      )}

      {/* 颜色行：插槽颜色（与附件颜色相乘后作用于画布） */}
      <PanelRow icon="🎨" label="颜色" C={C}>
        <input
          type="color"
          value={color || '#ffffff'}
          onChange={(e) => onColor(e.target.value)}
          style={{ width: 30, height: 18, padding: 0, border: '1px solid ' + C.border, background: 'transparent', cursor: 'pointer' }}
          title="插槽颜色（与附件颜色相乘后作用于画布）"
        />
        <button
          className="rounded px-1 text-[12px]"
          style={{ background: C.panel, border: '1px solid ' + C.border, color: C.text, cursor: 'pointer' }}
          onClick={() => onColor('')}
          title="恢复默认（不覆盖颜色）"
        >默认</button>
      </PanelRow>

      {/* 混合行 */}
      <PanelRow icon="🖼" label="混合" C={C}>
        <select
          value={blend}
          onChange={(e) => onBlend(e.target.value)}
          className="rounded px-1 text-[12px] w-full"
          style={{ background: C.panel, border: '1px solid ' + C.border, color: C.text, cursor: 'pointer' }}
        >
          {BLEND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </PanelRow>

      {/* ＋ 新建…：挑选已有素材加入该插槽 / 新建路径附件 */}
      {picking && (
        <div className="mx-2 my-1 rounded" style={{ background: C.panel, border: '1px solid ' + C.border, maxHeight: 132, overflowY: 'auto' }}>
          <button
            className="w-full flex items-center gap-1 px-2 py-1 text-[12px] text-left"
            style={{ background: 'transparent', border: 'none', color: C.text, cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={() => { onCreatePath?.(); setPicking(false); }}
            title="新建一个空路径附件并进入编辑（单击加结、右键轮转工具）"
          >
            <span>✒️</span>
            <span className="truncate">新建路径附件</span>
          </button>
          <div className="mx-1 border-t" style={{ borderColor: C.border }} />
          {candidates.length === 0 ? (
            <div className="px-2 py-1 text-[12px]" style={{ color: C.dim }}>没有可添加的素材</div>
          ) : candidates.map((l) => (
            <button
              key={l.id}
              className="w-full flex items-center gap-1 px-2 py-1 text-[12px] text-left"
              style={{ background: 'transparent', border: 'none', color: C.text, cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => { onAddAttachment?.(l.id); setPicking(false); }}
              title="加入该插槽并设为当前显示"
            >
              <span>🖼</span>
              <span className="truncate">{l.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* 操作按钮：＋ 新建… / ↖ 父级 */}
      <div className="px-2 pb-2 pt-1 grid grid-cols-2 gap-1 text-[12px]">
        <PanelFooterBtn
          C={C}
          onClick={() => setPicking((v) => !v)}
          icon="＋"
          label="新建…"
          title="把已有素材加入该插槽"
        />
        <PanelFooterBtn
          C={C}
          onClick={onParent}
          icon="↖"
          label="父级"
          title="设置父级（拾取骨骼）"
        />
      </div>
    </div>
  );
}

// =================================================================================
//  选中附件的属性块（仿 Spine 区域附件面板）
//    预览 + 「▭ 区域: 名字」标题栏 + 图片路径 + 选项 + 网格/序列 + 颜色 + ＋新建…/↖父级
// =================================================================================
interface AttachmentPropsBlockProps {
  attachment: PixiBonesLayer;
  /** 附件颜色（hex，'' = 不覆盖） */
  color: string;
  onColor: (color: string) => void;
  /** 「＋ 新建…」挑选器：可加入所属插槽的候选素材 */
  candidates: PixiBonesLayer[];
  /** 把已有素材加入所属插槽（无上下文插槽时不可用） */
  onAddAttachment?: (attachmentId: string) => void;
  /** 从当前插槽解除引用（无上下文插槽时不可用） */
  onDetach?: () => void;
  /** 已绑定的父级骨骼名（null = 未绑定） */
  bindingBoneName: string | null;
  /** 解除插槽与骨骼的绑定 */
  onUnbind?: () => void;
  /** 设置父级（拾取骨骼） */
  onParent?: () => void;
  /** 上下文插槽 id（null = 该素材没被任何插槽引用） */
  slotId: string | null;
  /** 重命名图片（弹出重命名弹窗） */
  onRename?: () => void;
  /** 复制图片（深拷贝素材；若有上下文插槽则引用进该插槽、设为当前显示） */
  onCopy?: () => void;
  // ---- 网格（仿 Spine）----
  /** 该附件是否已经是网格附件 */
  isMesh: boolean;
  /** 勾选/取消「网格」：创建 / 移除网格数据 */
  onToggleMesh: (v: boolean) => void;
  /** 线框开关：未选中也画出顶点和边 */
  wireframe: boolean;
  onToggleWireframe: (v: boolean) => void;
  /** 是否正在编辑这个网格 */
  editingMesh: boolean;
  /** 进入 / 退出网格编辑模式 */
  onEditMesh: () => void;
  /** 重置网格（顶点回到 UV 位置，消除变形）；非网格时 undefined */
  onResetMesh?: () => void;
  /** 冻结（把网格顶点的旋转归 0、缩放归 1）；非网格时 undefined */
  onFreeze?: () => void;
  /** 网格顶点数（显示在按钮旁） */
  vertexCount?: number;
  C: any;
}

/** 附件打包选项的一个复选框（选择 / 导出 / 名称） */
function FlagCheck({
  label, checked, onChange, C,
}: { label: string; checked: boolean; onChange: (v: boolean) => void; C: any }) {
  return (
    <label className="flex items-center gap-1 shrink-0 cursor-pointer text-[12px]" style={{ color: C.text }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: C.accent }}
      />
      {label}
    </label>
  );
}

function AttachmentPropsBlock(props: AttachmentPropsBlockProps) {
  const {
    attachment, color, onColor, candidates, onAddAttachment,
    onDetach, bindingBoneName, onUnbind, onParent, C,
    onRename, onCopy,
    isMesh, onToggleMesh, wireframe, onToggleWireframe, editingMesh, onEditMesh,
    onResetMesh, onFreeze, vertexCount,
  } = props;
  // 「＋ 新建…」：把已有素材加入所属插槽
  const [picking, setPicking] = useState(false);
  // 打包选项（选择 / 导出 / 名称）—— 骨架阶段先本地保存，待接入纹理打包流程
  const [flags, setFlags] = useState<Record<string, { selected: boolean; exported: boolean; named: boolean }>>({});
  const flag = flags[attachment.id] ?? { selected: true, exported: true, named: false };
  const patchFlag = (k: 'selected' | 'exported' | 'named', v: boolean) =>
    setFlags((m) => ({ ...m, [attachment.id]: { ...flag, [k]: v } }));

  const miniBtn: React.CSSProperties = {
    background: C.panel,
    border: '1px solid ' + C.border,
    color: C.dim,
    cursor: 'not-allowed',
    width: 20, height: 18, lineHeight: '16px', fontSize: 12,
    borderRadius: 3, padding: 0, flex: 'none',
  };

  return (
    <div style={{ borderTop: '1px solid ' + C.border, background: C.panelDk }}>
      {/* 标题栏：勾了网格显示「网格:」，否则「区域:」（✕ = 从插槽移出） */}
      <PanelTitleBar
        icon={isMesh ? '▦' : '▭'}
        kindLabel={isMesh ? '网格' : '区域'}
        name={attachment.name}
        badge={isMesh && vertexCount ? `${vertexCount} 顶点` : undefined}
        C={C}
        onDelete={onDetach}
        deleteTitle="从插槽移出（变成独立插槽）"
        onRename={onRename}
        onCopy={onCopy}
      />

      {/* 已绑定的父级骨骼 */}
      {bindingBoneName && (
        <div className="px-2 py-1 flex items-center gap-1 text-[12px]" style={{ color: '#7dd3a0' }}>
          <span>🔗 父级: {bindingBoneName}</span>
          <button
            style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', marginLeft: 'auto' }}
            title="解除绑定"
            onClick={onUnbind}
          >✕</button>
        </div>
      )}

      {/* 图片路径（当前 = 素材名；查找/重指定为占位） */}
      <PanelRow icon="📁" label="图片路径" C={C}>
        <span
          className="truncate rounded px-1 text-[12px] flex-1"
          style={{ background: C.panel, border: '1px solid ' + C.border, color: C.text, lineHeight: '16px' }}
          title={attachment.name}
        >&lt;{attachment.name}&gt;</span>
        <button style={miniBtn} title="查找图片（待实现）">🔍</button>
        <button style={{ ...miniBtn, color: '#7dd3a0' }} title="重新指定图片（待实现）">📂</button>
      </PanelRow>

      {/* 选项：选择 / 导出 / 名称 + 网格 / 线框 / 序列（仿 Spine） */}
      <PanelRow icon="📋" label="选项" C={C}>
        <div className="flex flex-col gap-1 w-full">
          <div className="flex items-center gap-2 flex-wrap">
            <FlagCheck label="选择" checked={flag.selected} onChange={(v) => patchFlag('selected', v)} C={C} />
            <FlagCheck label="导出" checked={flag.exported} onChange={(v) => patchFlag('exported', v)} C={C} />
            <FlagCheck label="名称" checked={flag.named} onChange={(v) => patchFlag('named', v)} C={C} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <FlagCheck label="网格" checked={isMesh} onChange={onToggleMesh} C={C} />
            <FlagCheck label="线框" checked={wireframe} onChange={onToggleWireframe} C={C} />
            <span
              className="flex items-center gap-1 text-[12px] shrink-0"
              style={{ color: C.dim, cursor: 'not-allowed' }}
              title="序列帧（待实现）"
            >
              <input type="checkbox" disabled className="w-3 h-3" style={{ accentColor: C.accent }} />
              序列
            </span>
          </div>
        </div>
      </PanelRow>

      {/* 颜色行 */}
      <PanelRow icon="🎨" label="颜色" C={C}>
        <input
          type="color"
          value={color || '#ffffff'}
          onChange={(e) => onColor(e.target.value)}
          style={{ width: 30, height: 18, padding: 0, border: '1px solid ' + C.border, background: 'transparent', cursor: 'pointer' }}
          title="附件颜色（与插槽颜色相乘后作用于画布）"
        />
        <button
          className="rounded px-1 text-[12px]"
          style={{ background: C.panel, border: '1px solid ' + C.border, color: C.text, cursor: 'pointer' }}
          onClick={() => onColor('')}
          title="恢复默认（不覆盖颜色）"
        >默认</button>
      </PanelRow>

      {/* ＋ 新建…：挑选已有素材加入所属插槽 */}
      {picking && (
        <div className="mx-2 my-1 rounded" style={{ background: C.panel, border: '1px solid ' + C.border, maxHeight: 132, overflowY: 'auto' }}>
          {candidates.length === 0 ? (
            <div className="px-2 py-1 text-[12px]" style={{ color: C.dim }}>没有可添加的素材</div>
          ) : candidates.map((l) => (
            <button
              key={l.id}
              className="w-full flex items-center gap-1 px-2 py-1 text-[12px] text-left"
              style={{ background: 'transparent', border: 'none', color: C.text, cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.toolbar)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => { onAddAttachment?.(l.id); setPicking(false); }}
              title="加入该插槽并设为当前显示"
            >
              <span>🖼</span>
              <span className="truncate">{l.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* 操作按钮：＋新建… / 父级 [/ 编辑网格 / 描绘 / 重置 / 冻结（勾网格后出现）] */}
      <div className="px-2 pb-2 pt-1 flex flex-col gap-1 text-[12px]">
        <div className="grid grid-cols-4 gap-1">
          <PanelFooterBtn
            C={C}
            onClick={() => setPicking((v) => !v)}
            icon="＋"
            label="新建…"
            title={onAddAttachment ? '把已有素材加入所属插槽' : '请先在层级树里选中一个插槽下的附件'}
            disabled={!onAddAttachment}
          />
          <PanelFooterBtn
            C={C}
            onClick={onParent ?? (() => { /* 无上下文插槽：按钮已置灰 */ })}
            icon="↖"
            label="父级"
            title={onParent ? '设置父级（拾取骨骼）' : '请先在层级树里选中一个插槽下的附件'}
            disabled={!onParent}
          />
          {isMesh && (
            <>
              <PanelFooterBtn
                C={C}
                onClick={onEditMesh}
                icon="▦"
                label="编辑网格"
                title={editingMesh ? '退出网格编辑' : '进入网格编辑：拖动顶点、增删顶点、细分边'}
                active={editingMesh}
                pro
              />
              <PanelFooterBtn
                C={C}
                onClick={() => { /* 描绘：自动提取轮廓，待实现 */ }}
                icon="✎"
                label="描绘"
                title="自动描绘轮廓生成网格（待实现）"
                disabled
                pro
              />
            </>
          )}
        </div>
        {isMesh && (
          <div className="grid grid-cols-4 gap-1">
            <PanelFooterBtn
              C={C}
              onClick={onResetMesh ?? (() => {})}
              icon="↺"
              label="重置"
              title="重置为初始矩形（4 个顶点 + 1 条对角线）；已绑定骨骼时会弹出面板询问如何处理权重"
              disabled={!onResetMesh}
              pro
            />
            <PanelFooterBtn
              C={C}
              onClick={onFreeze ?? (() => {})}
              icon="❄"
              label="冻结"
              title="把网格顶点的旋转归 0、缩放归 1"
              disabled={!onFreeze}
              pro
            />
            <span />
            <span />
          </div>
        )}
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
        <span className="text-[14px] font-semibold" style={{ color: C.selected }}>图片文件</span>
      </div>

      {/* 选项：限制扫描（checkbox） */}
      <div className="px-2 py-1 flex items-center gap-2 text-[13px]" style={{ color: C.text }}>
        <span style={{ color: C.dim }}>▶ 选项</span>
        <label className="flex items-center gap-1 cursor-pointer select-none ml-auto">
          <input type="checkbox" defaultChecked className="w-3 h-3" />
          <span>限制扫描</span>
        </label>
      </div>

      {/* 路径 ./images/ */}
      <div className="px-2 py-1 flex items-center gap-1 text-[13px]" style={{ color: C.text }}>
        <span className="shrink-0" style={{ color: C.dim }}>路径</span>
        <span className="flex-1 truncate" style={{ color: C.dim }}>./images/</span>
        <span style={{ color: C.warning }} title="设为图片目录">★</span>
        <span style={{ color: C.dim }} title="截图">📷</span>
        <span style={{ color: C.dim }} title="选择文件夹">📁</span>
      </div>

      {/* PSD <无> */}
      <div className="px-2 py-1 flex items-center gap-2 text-[13px]" style={{ color: C.text }}>
        <span className="shrink-0" style={{ color: C.dim }}>PSD</span>
        <span className="flex-1 truncate" style={{ color: C.dim }}>&lt;无&gt;</span>
      </div>

      {/* 底部按钮：添加PSD / 刷新 */}
      <div className="px-2 pb-2 pt-1 grid grid-cols-2 gap-1 text-[12px]">
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

// =================================================================================
//  IK 约束管理面板（仿 Spine 的「约束」节点：列表 + 新建 + 属性编辑）
// =================================================================================
interface ConstraintsSectionPropsBlockProps {
  constraints: IkConstraintDef[];
  bones: BoneNode[];
  onAdd: (boneId: string, targetBoneId: string, childBoneId: string | null) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** 双击行触发弹窗重命名（Spine 行为；与 onRename 同时存在不冲突） */
  onRenamePopup?: (id: string) => void;
  onTarget: (id: string, targetBoneId: string) => void;
  onMix: (id: string, mix: number) => void;
  onBend: (id: string, dir: 1 | -1) => void;
  onMove: (id: string, toIndex: number) => void;
  C: any;
}

function ConstraintsSectionPropsBlock(props: ConstraintsSectionPropsBlockProps) {
  const { constraints, bones, onAdd, onRemove, onRename, onRenamePopup, onTarget, onMix, onBend, onMove, C } = props;
  // ★ 选中态收敛到 store：树里的约束行点击 → selectConstraint → 这里同步高亮
  const selectedId = usePixiBonesStore((s) => s.selectedConstraintId);
  const selectConstraint = usePixiBonesStore((s) => s.selectConstraint);
  const [newBone, setNewBone] = useState(bones[0]?.id ?? '');
  const [newChild, setNewChild] = useState('');
  const [newTarget, setNewTarget] = useState(bones[0]?.id ?? '');
  const selected = constraints.find((c) => c.id === selectedId) ?? null;

  // bones 变化时兜底修正下拉默认值（避免指向已删除的骨）
  const boneIds = bones.map((b) => b.id);
  if (boneIds.length > 0 && (!boneIds.includes(newBone) || newBone === '')) setNewBone(boneIds[0]);
  if (boneIds.length > 0 && (!boneIds.includes(newTarget) || newTarget === '')) setNewTarget(boneIds[0]);

  const boneName = (id: string) => bones.find((b) => b.id === id)?.name ?? '(已删除)';
  const canAdd = newBone && newTarget && newBone !== newTarget;

  return (
    <div style={{ borderTop: '1px solid ' + C.border, background: C.panelDk, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 标题行 */}
      <div className="flex items-center px-2 py-1.5 gap-1 shrink-0" style={{ background: C.toolbar, borderBottom: '1px solid ' + C.border }}>
        <span className="text-[14px] font-semibold" style={{ color: C.selected }}>IK 约束</span>
        <span className="text-[12px]" style={{ color: C.dim }}>{constraints.length} 条</span>
      </div>

      {/* 约束列表（顺序 = 应用顺序） */}
      <div className="px-2 py-1 flex flex-col gap-0.5 overflow-y-auto shrink-0" style={{ maxHeight: 160 }}>
        {constraints.length === 0 && (
          <div className="text-[13px]" style={{ color: C.dim }}>尚未创建约束。用下方「新建」添加 IK。</div>
        )}
        {constraints.map((c, i) => (
          <div
            key={c.id}
            onClick={() => selectConstraint(c.id)}
            // ★ 双击 = 弹窗重命名（Spine 行为），与「name」输入框 onBlur 互不干扰（点击触发 onBlur 但 name 未变 → noop）
            onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); onRenamePopup?.(c.id); }}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[13px] cursor-pointer select-none"
            style={{
              background: selectedId === c.id ? C.accentDk : 'transparent',
              color: selectedId === c.id ? '#fff' : C.text,
            }}
          >
            <span className="flex-1 truncate">
              {i + 1}. {c.name}
              <span style={{ color: C.dim }}> · {boneName(c.boneId)}{c.childBoneId ? `→${boneName(c.childBoneId)}` : ''}→{boneName(c.targetBoneId)}</span>
            </span>
            {/* 上移 / 下移（调整应用顺序） */}
            <button
              className="w-4 h-4 flex items-center justify-center rounded text-[12px]"
              style={{ background: 'transparent', border: 'none', color: C.dim, cursor: i === 0 ? 'default' : 'pointer' }}
              disabled={i === 0}
              title="上移（更先应用）"
              onClick={(e) => { e.stopPropagation(); onMove(c.id, i - 1); }}
            >▲</button>
            <button
              className="w-4 h-4 flex items-center justify-center rounded text-[12px]"
              style={{ background: 'transparent', border: 'none', color: C.dim, cursor: i === constraints.length - 1 ? 'default' : 'pointer' }}
              disabled={i === constraints.length - 1}
              title="下移（更后应用）"
              onClick={(e) => { e.stopPropagation(); onMove(c.id, i + 1); }}
            >▼</button>
            <button
              className="w-4 h-4 flex items-center justify-center rounded text-[12px]"
              style={{ background: 'transparent', border: 'none', color: C.warning, cursor: 'pointer' }}
              title="删除约束"
              onClick={(e) => { e.stopPropagation(); onRemove(c.id); if (selectedId === c.id) usePixiBonesStore.getState().selectSection('constraints'); }}
            >✕</button>
          </div>
        ))}
      </div>

      {/* 新建约束 */}
      <div className="px-2 py-1.5 border-t flex flex-col gap-1 text-[13px]" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-1">
          <span className="shrink-0" style={{ color: C.dim }}>受约束</span>
          <select
            className="flex-1 min-w-0 rounded px-1 py-0.5 outline-none text-[13px]"
            style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
            value={newBone}
            onChange={(e) => setNewBone(e.target.value)}
          >
            {bones.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="shrink-0" style={{ color: C.dim }}>子骨(选)</span>
          <select
            className="flex-1 min-w-0 rounded px-1 py-0.5 outline-none text-[13px]"
            style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
            value={newChild}
            onChange={(e) => setNewChild(e.target.value)}
          >
            <option value="">— 单骨 IK —</option>
            {bones.filter((b) => b.id !== newBone).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="shrink-0" style={{ color: C.dim }}>目标</span>
          <select
            className="flex-1 min-w-0 rounded px-1 py-0.5 outline-none text-[13px]"
            style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
            value={newTarget}
            onChange={(e) => setNewTarget(e.target.value)}
          >
            {bones.filter((b) => b.id !== newBone).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <button
          className="rounded px-1 py-1 flex items-center justify-center gap-0.5"
          style={{
            background: canAdd ? C.accentDk : C.panel,
            color: canAdd ? '#fff' : C.dim,
            border: '1px solid ' + C.border,
            cursor: canAdd ? 'pointer' : 'default',
          }}
          disabled={!canAdd}
          onClick={() => {
            if (!canAdd) return;
            onAdd(newBone, newTarget, newChild || null);
          }}
        >
          <span style={{ color: C.accent }}>+</span> 新建 IK 约束
        </button>
      </div>

      {/* 选中约束的属性编辑 */}
      {selected && (
        <div className="px-2 py-1.5 border-t flex flex-col gap-1.5 text-[13px]" style={{ borderColor: C.border }}>
          <div className="flex items-center gap-1">
            <span className="shrink-0" style={{ color: C.dim }}>名称</span>
            <input
              className="flex-1 min-w-0 rounded px-1 py-0.5 outline-none text-[13px]"
              style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
              defaultValue={selected.name}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== selected.name) onRename(selected.id, v); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="shrink-0" style={{ color: C.dim }}>目标骨</span>
            <select
              className="flex-1 min-w-0 rounded px-1 py-0.5 outline-none text-[13px]"
              style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
              value={selected.targetBoneId}
              onChange={(e) => onTarget(selected.id, e.target.value)}
            >
              {bones.filter((b) => b.id !== selected.boneId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {selected.childBoneId && (
            <div className="flex items-center gap-1">
              <span className="shrink-0" style={{ color: C.dim }}>弯曲方向</span>
              <select
                className="flex-1 min-w-0 rounded px-1 py-0.5 outline-none text-[13px]"
                style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
                value={selected.bendDirection}
                onChange={(e) => onBend(selected.id, Number(e.target.value) as 1 | -1)}
              >
                <option value={1}>正方向（逆时针）</option>
                <option value={-1}>反方向（顺时针）</option>
              </select>
            </div>
          )}
          <div className="flex items-center gap-1">
            <span className="shrink-0" style={{ color: C.dim }}>混合</span>
            <input
              type="range"
              className="flex-1"
              min={0}
              max={1}
              step={0.01}
              value={selected.mix}
              onChange={(e) => onMix(selected.id, Number(e.target.value))}
            />
            <span className="shrink-0 w-8 text-right" style={{ color: C.dim }}>{Math.round(selected.mix * 100)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

// =================================================================================
//  路径约束管理面板（仿 Spine 的 Path Constraint：列表 + 新建 + 属性编辑）
//  - 与 IK 共用 selectedConstraintId（id 前缀 pc_），树里点 📐 行 → selectConstraint → 这里同步高亮
// =================================================================================
interface PathConstraintsSectionPropsBlockProps {
  pathConstraints: PathConstraintDef[];
  bones: BoneNode[];
  slots: PixiBonesSlot[];
  attachmentPaths: Record<string, PathData>;
  onAdd: (targetSlotId: string, boneIds: string[]) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** 标题栏「✎」→ 弹窗重命名 */
  onRenamePopup?: (id: string) => void;
  /** 标题栏「⧉」→ 复制 */
  onCopy?: (id: string) => void;
  onTarget: (id: string, slotId: string) => void;
  onSetBones: (id: string, boneIds: string[]) => void;
  onBoneOrder: (id: string, fromIndex: number, toIndex: number) => void;
  onPositionMode: (id: string, m: 'fixed' | 'percent') => void;
  onPosition: (id: string, v: number) => void;
  onSpacingMode: (id: string, m: PathSpacingMode) => void;
  onSpacing: (id: string, v: number) => void;
  onRotateMode: (id: string, m: PathRotateMode) => void;
  onRotateMix: (id: string, v: number) => void;
  onTranslateMix: (id: string, v: number) => void;
  onRotationOffset: (id: string, deg: number) => void;
  onMove: (id: string, toIndex: number) => void;
  /** 数字输入 onBlur 前推历史（setPathConstraintPosition 等不推历史，由输入框包一层） */
  pushHistory: () => void;
  C: any;
}

function PathConstraintsSectionPropsBlock(props: PathConstraintsSectionPropsBlockProps) {
  const {
    pathConstraints, slots, attachmentPaths,
    onRemove, onRename, onRenamePopup, onCopy,
    onPositionMode, onPosition, onSpacingMode, onSpacing, onRotateMode,
    onRotateMix, onTranslateMix, onRotationOffset, pushHistory, C,
  } = props;
  // ★ 选中态收敛到 store：树里的路径约束行点击 → selectConstraint → 这里同步高亮
  const selectedId = usePixiBonesStore((s) => s.selectedConstraintId);
  const selected = pathConstraints.find((c) => c.id === selectedId) ?? null;

  const slotName = (id: string) => slots.find((x) => x.id === id)?.name ?? '(已删)';

  // ★ Spine 风格面板：折叠区 / 链接滑块 UI 状态
  const [offsetOpen, setOffsetOpen] = useState(true);
  const [mixOpen, setMixOpen] = useState(true);
  const [linkSliders, setLinkSliders] = useState(true);

  // 目标插槽激活的路径附件（约束解算实际读取的路径）
  const targetSlotObj = slots.find((s) => s.id === selected?.targetSlotId);
  const targetPathAid = targetSlotObj?.activeAttachmentId ?? null;
  const targetPathName = targetPathAid && attachmentPaths[targetPathAid] ? targetPathAid : null;

  const startPathConstraintRetarget = usePixiBonesStore((s) => s.startPathConstraintRetarget);

  // 混合滑块联动（Spine「链接滑块」：勾选时旋转/移动滑块同步）
  const applyRotateMix = (v: number) => {
    if (!selected) return;
    onRotateMix(selected.id, v);
    if (linkSliders) onTranslateMix(selected.id, v);
  };
  const applyTranslateMix = (v: number) => {
    if (!selected) return;
    onTranslateMix(selected.id, v);
    if (linkSliders) onRotateMix(selected.id, v);
  };

  return (
    <div style={{ borderTop: '1px solid ' + C.border, background: C.panelDk, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 标题栏：📐 路径约束: <name> + 右上角 复制 / 重命名 / 删除（参考其它属性面板） */}
      <PanelTitleBar
        icon="📐"
        kindLabel="路径约束"
        name={selected?.name ?? '（未选中）'}
        C={C}
        onDelete={selected ? () => {
          onRemove(selected.id);
          usePixiBonesStore.getState().selectSection('constraints');
        } : undefined}
        deleteTitle="删除该路径约束"
        onRename={selected ? (onRenamePopup ? () => onRenamePopup!(selected.id) : () => onRename(selected.id, selected.name)) : undefined}
        onCopy={selected ? (onCopy ? () => onCopy!(selected.id) : undefined) : undefined}
      />

      {/* 目标插槽未显示路径附件时提示（约束不生效） */}
      {selected && (() => {
        const hasPath = targetPathAid !== null && !!attachmentPaths[targetPathAid];
        return hasPath ? null : (
          <div className="px-2 py-1 text-[12px] shrink-0" style={{ background: C.warning + '22', color: C.warning, borderTop: '1px solid ' + C.border }}>
            ⚠ 目标插槽未显示路径附件，约束暂不生效。请先在画布中激活该插槽的路径附件。
          </div>
        );
      })()}

      {/* 选中约束的属性编辑（Spine 布局） */}
      {selected && (
        <div className="px-2 py-1.5 border-t flex flex-col gap-1.5 text-[13px] overflow-y-auto" style={{ borderColor: C.border }}>
          {/* 路径：插槽名 + 附件名 + 编辑（重选路径 = 画布拾取 / 层级树点插槽） */}
          <div className="flex items-center gap-1">
            <span className="shrink-0 w-10" style={{ color: C.accent }}>路径</span>
            <span className="flex-1 min-w-0 truncate" style={{ color: C.text }}>
              {targetSlotObj ? (
                <>
                  <span style={{ color: C.text }}>{slotName(selected.targetSlotId)}</span>
                  <span style={{ color: C.dim }}> / {targetPathName ?? '（无附件）'}</span>
                </>
              ) : (
                <span style={{ color: C.dim }}>（未绑定插槽）</span>
              )}
            </span>
            <button
              className="w-4 h-4 flex items-center justify-center rounded text-[12px] shrink-0"
              style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer' }}
              title="重新选择路径（画布拾取或在层级树点击插槽）"
              onClick={() => startPathConstraintRetarget(selected.id)}
            >✎</button>
          </div>

          {/* 目标：插槽名 + 附件名 + 编辑 + 删除（删除约束，骨骼退回原位） */}
          <div className="flex items-center gap-1">
            <span className="shrink-0 w-10" style={{ color: C.accent }}>目标</span>
            <span className="flex-1 min-w-0 truncate" style={{ color: C.text }}>
              {targetSlotObj ? (
                <>
                  <span style={{ color: C.text }}>{slotName(selected.targetSlotId)}</span>
                  <span style={{ color: C.dim }}> / {targetPathName ?? '（无附件）'}</span>
                </>
              ) : (
                <span style={{ color: C.dim }}>（未绑定插槽）</span>
              )}
            </span>
            <button
              className="w-4 h-4 flex items-center justify-center rounded text-[12px] shrink-0"
              style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer' }}
              title="重新选择目标插槽（画布拾取或在层级树点击插槽）"
              onClick={() => startPathConstraintRetarget(selected.id)}
            >✎</button>
            <button
              className="w-4 h-4 flex items-center justify-center rounded text-[12px] shrink-0"
              style={{ background: 'transparent', border: 'none', color: C.warning, cursor: 'pointer' }}
              title="删除该约束（骨骼退回原位）"
              onClick={() => {
                onRemove(selected.id);
                usePixiBonesStore.getState().selectSection('constraints');
              }}
            >✕</button>
          </div>

          {/* 间距 */}
          <div className="flex items-center gap-1">
            <span className="shrink-0 w-10" style={{ color: C.accent }}>间距</span>
            <input
              type="number"
              className="w-14 shrink-0 rounded px-1 py-0.5 outline-none text-[13px]"
              style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
              defaultValue={selected.spacing}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (!isNaN(v) && v !== selected.spacing) { pushHistory(); onSpacing(selected.id, v); }
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
            <input
              type="range"
              className="flex-1"
              min={-200}
              max={200}
              step={1}
              value={selected.spacing}
              onChange={(e) => onSpacing(selected.id, Number(e.target.value))}
            />
            <select
              className="w-24 shrink-0 rounded px-1 py-0.5 outline-none text-[13px]"
              style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
              value={selected.spacingMode}
              onChange={(e) => onSpacingMode(selected.id, e.target.value as PathSpacingMode)}
            >
              <option value="length">长度</option>
              <option value="fixed">固定</option>
              <option value="percent">百分比</option>
              <option value="proportional">按长度比例</option>
            </select>
          </div>

          {/* 位置 */}
          <div className="flex items-center gap-1">
            <span className="shrink-0 w-10" style={{ color: C.accent }}>位置</span>
            {selected.positionMode === 'percent' ? (
              <>
                <input
                  type="number"
                  className="w-14 shrink-0 rounded px-1 py-0.5 outline-none text-[13px]"
                  style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
                  defaultValue={selected.position}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!isNaN(v) && v !== selected.position) { pushHistory(); onPosition(selected.id, v); }
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
                <input
                  type="range"
                  className="flex-1"
                  min={0}
                  max={100}
                  step={0.1}
                  value={selected.position}
                  onChange={(e) => onPosition(selected.id, Number(e.target.value))}
                />
              </>
            ) : (
              <input
                type="number"
                className="w-14 shrink-0 rounded px-1 py-0.5 outline-none text-[13px]"
                style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
                defaultValue={selected.position}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (!isNaN(v) && v !== selected.position) { pushHistory(); onPosition(selected.id, v); }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
            )}
            <select
              className="w-24 shrink-0 rounded px-1 py-0.5 outline-none text-[13px]"
              style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
              value={selected.positionMode}
              onChange={(e) => onPositionMode(selected.id, e.target.value as 'fixed' | 'percent')}
            >
              <option value="percent">百分比</option>
              <option value="fixed">像素</option>
            </select>
          </div>

          {/* 偏移（折叠） */}
          <div className="border-t pt-1.5 flex flex-col gap-1" style={{ borderColor: C.border }}>
            <div className="flex items-center gap-1 cursor-pointer select-none" onClick={() => setOffsetOpen(!offsetOpen)}>
              <span className="text-[11px]" style={{ color: C.dim }}>{offsetOpen ? '▾' : '▸'}</span>
              <span style={{ color: C.accent }}>偏移</span>
            </div>
            {offsetOpen && (
              <div className="flex items-center gap-1 pl-3">
                <span className="shrink-0 w-10" style={{ color: C.accent }}>旋转</span>
                <input
                  type="number"
                  className="w-16 shrink-0 rounded px-1 py-0.5 outline-none text-[13px]"
                  style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
                  defaultValue={selected.rotationOffset}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!isNaN(v) && v !== selected.rotationOffset) { pushHistory(); onRotationOffset(selected.id, v); }
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
                <span className="shrink-0" style={{ color: C.dim }}>°</span>
              </div>
            )}
          </div>

          {/* 混合（折叠） */}
          <div className="border-t pt-1.5 flex flex-col gap-1" style={{ borderColor: C.border }}>
            <div className="flex items-center gap-1 select-none">
              <span className="text-[11px] cursor-pointer" style={{ color: C.dim }} onClick={() => setMixOpen(!mixOpen)}>{mixOpen ? '▾' : '▸'}</span>
              <span style={{ color: C.accent }}>混合</span>
              <label className="flex items-center gap-0.5 ml-1 text-[12px] cursor-pointer" style={{ color: C.dim }}>
                <input
                  type="checkbox"
                  checked={linkSliders}
                  onChange={(e) => setLinkSliders(e.target.checked)}
                />
                链接滑块
              </label>
            </div>
            {mixOpen && (
              <>
                {/* 旋转混合 + 旋转模式 */}
                <div className="flex items-center gap-1 pl-3">
                  <span className="shrink-0 w-10" style={{ color: C.accent }}>旋转</span>
                  <input
                    type="range"
                    className="flex-1"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selected.rotateMix}
                    onChange={(e) => applyRotateMix(Number(e.target.value))}
                  />
                  <span className="shrink-0 w-8 text-right" style={{ color: C.dim }}>{Math.round(selected.rotateMix * 100)}</span>
                  <select
                    className="w-24 shrink-0 rounded px-1 py-0.5 outline-none text-[13px]"
                    style={{ background: C.panel, color: C.text, border: '1px solid ' + C.border }}
                    value={selected.rotateMode}
                    onChange={(e) => onRotateMode(selected.id, e.target.value as PathRotateMode)}
                  >
                    <option value="tangent">切线</option>
                    <option value="chain">链条</option>
                    <option value="chainScale">链条缩放</option>
                  </select>
                </div>
                {/* 移动混合（X/Y 同值联动） */}
                <div className="flex items-center gap-1 pl-3">
                  <span className="shrink-0 w-10" style={{ color: C.accent }}>移动</span>
                  <span className="text-[11px] shrink-0" style={{ color: C.dim }}>X</span>
                  <input
                    type="range"
                    className="flex-1"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selected.translateMix}
                    onChange={(e) => applyTranslateMix(Number(e.target.value))}
                  />
                  <span className="text-[11px] shrink-0" style={{ color: C.dim }}>Y</span>
                  <input
                    type="range"
                    className="flex-1"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selected.translateMix}
                    onChange={(e) => applyTranslateMix(Number(e.target.value))}
                  />
                  <span className="shrink-0 w-8 text-right" style={{ color: C.dim }}>{Math.round(selected.translateMix * 100)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
