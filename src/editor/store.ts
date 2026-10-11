import { create } from 'zustand';
import type { Skeleton } from '@engine/Skeleton';
import type { PixiBonesPsd, PixiBonesLayer, PixiBonesSlot, MeshData } from '@psd/types';
import { flattenLayers } from '@psd/index';
import type { Locale } from './i18n';

export type ViewMode = 'editor' | 'demo';
export type EditorTab = 'setup' | 'animate';

/** 7 个可切换的工具：姿势 / 权重 / 创建 / 旋转 / 移动 / 缩放 / 倾斜（对齐 Spine） */
export type EditorTool = 'pose' | 'weights' | 'create' | 'rotate' | 'move' | 'scale' | 'shear';

// =================================================================================
//  动画数据模型（可序列化，随工程保存 / 载入）
//    Spine 语义：每根骨骼按「属性」分轨道，每条轨道一串关键帧。
//    动画 tab 下 bones 的姿态 = 采样结果；未覆盖的属性回退到 setupPose（设置姿态）。
// =================================================================================
export type AnimProperty = 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY' | 'mix';
/** 骨骼全部可动画属性（录制 / 采样共用）。'mix' 不在这里 —— 它是约束 mix 专用属性。 */
export const ANIM_PROPERTIES: AnimProperty[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];
/** 单个关键帧：time 为秒。 */
export interface AnimKeyframe {
  time: number;
  value: number;
}
/** 一根骨骼一个属性的一条轨道（keys 恒按 time 升序）。
 *  constraintMix = true 时是「约束 mix」轨道：boneId 存约束 id，property 固定 'mix'。 */
export interface AnimTrack {
  boneId: string;
  property: AnimProperty;
  keys: AnimKeyframe[];
  /** 约束 mix 轨道标记（骨骼轨道不需要设置） */
  constraintMix?: boolean;
}
/** 一段动画：一组轨道 + 时长（秒）。 */
export interface EditorAnimation {
  id: string;
  name: string;
  /** 时长（秒）。播放时 currentTime 超出按 loop 决定回绕或停在末尾。 */
  duration: number;
  tracks: AnimTrack[];
}
/** 骨骼设置姿态（进入动画 tab 时从 bones 快照；动画未覆盖属性的缺省值）。 */
export interface BonePose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/** 描绘弹窗打开前的网格快照（用于「取消」时还原） */
export interface TraceSnapshot {
  layerId: string;
  mesh: MeshData | null;
}

// =================================================================================
//  右侧停靠区尺寸常量
//    DOCK_PANEL_DEFAULT_WIDTH：各面板的默认宽度（新增面板记得在这里加默认值）
//    DOCK_PANEL_MIN_WIDTH：拖动缩放时的最小宽度
//    DOCK_RESIZER_WIDTH：面板左边缘那根可拖动分隔条的宽度（占布局宽度）
// =================================================================================
export const DOCK_PANEL_DEFAULT_WIDTH: Record<string, number> = {
  hierarchy: 418,
  grid_tool: 300,
  weights: 300,
};
export const DOCK_PANEL_MIN_WIDTH = 180;
export const DOCK_RESIZER_WIDTH = 6;

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
  /** 骨骼颜色（0xRRGGBB，Spine 面板 Color 行；未设置用默认灰 0x9ca3af）。 */
  color?: number;
  /** 本地剪切角（弧度，对应 Spine shearX）。 */
  shearX?: number;
  /** 本地剪切角（弧度，对应 Spine shearY）。 */
  shearY?: number;
  /** 是否继承父骨骼旋转（Spine Inherit Rotation）。缺省 true。 */
  inheritRotation?: boolean;
  /** 是否继承父骨骼缩放（Spine Inherit Scale）。缺省 true。 */
  inheritScale?: boolean;
  /** 是否继承父骨骼反射（Spine Inherit Reflection）。缺省 true。 */
  inheritReflection?: boolean;
  /** 视口中总是渲染名字（Spine Name checkbox）。 */
  showName?: boolean;
  /** 是否可在视口中被点选（Spine Select checkbox）。 */
  selectable?: boolean;
}

/** 骨骼新字段的缺省值补全（旧存档 / 新建骨骼共用）。 */
export function normalizeBone(b: BoneNode): BoneNode {
  return {
    ...b,
    shearX: b.shearX ?? 0,
    shearY: b.shearY ?? 0,
    inheritRotation: b.inheritRotation ?? true,
    inheritScale: b.inheritScale ?? true,
    inheritReflection: b.inheritReflection ?? true,
    showName: b.showName ?? false,
    selectable: b.selectable ?? true,
  };
}

/**
 * 「图层 → 骨骼」绑定。
 *
 * ref = 绑定参考矩阵（列主序 6 元组 [a, b, c, d, tx, ty]，等价 PIXI Matrix）。
 * 渲染时用增量变换 delta = 当前骨骼世界矩阵 × ref⁻¹ 去驱动图层。
 * - 首次绑定：ref = 该骨骼绑定时的世界矩阵 → 绑定瞬间 delta = I，图层不动。
 * - 重新父级到另一根骨骼：ref 会反解为「旧父级驱动 × 新骨骼世界矩阵⁻¹」，
 *   使绑定瞬间仍然 delta = 旧父级驱动，位置和朝向都不跳。
 */
export interface SlotBinding {
  boneId: string;
  ref: number[];
}

/**
 * IK 约束定义（仿 Spine 3.8 IkConstraint）。
 * 单骨 IK：boneId 旋转指向 targetBoneId。
 * 双骨 IK：boneId（父）→ childBoneId（子），子骨末梢落在 targetBoneId 上。
 * 数组顺序即应用顺序（层级树「约束」节点里可拖拽调整）。
 */
export interface IkConstraintDef {
  id: string;
  name: string;
  /** 受约束的第一根骨骼（单骨 IK 即这根） */
  boneId: string;
  /** 双骨 IK 的第二根骨骼（单骨 IK 为 null） */
  childBoneId: string | null;
  /** 目标骨骼（不能用受约束骨骼的后代） */
  targetBoneId: string;
  /** 弯曲方向：1 = 逆时针 / 正方向，-1 = 顺时针（仅双骨 IK 有效） */
  bendDirection: 1 | -1;
  /** 混合程度 0..1：0 = 完全不受约束 */
  mix: number;
}

/** 撤销 / 重做快照的内容（骨树 + 插槽变换 + 网格顶点 + 选中骨 + 动画 + 约束）。 */
export type HistorySnapshot = {
  bones: BoneNode[];
  slotTransforms: Record<string, { tx: number; ty: number; rotation: number; scaleX: number; scaleY: number; skewX: number; skewY: number }>;
  /** 网格数据也纳入快照，这样拖顶点 / 增删顶点都能 Cmd+Z 撤销 */
  attachmentMeshes: Record<string, MeshData>;
  selectedBoneId: string | null;
  /** 动画数据也纳入快照：关键帧增删/拖动、动画增删重命名都能 Cmd+Z 撤销 */
  animations: EditorAnimation[];
  /** IK 约束也纳入快照（增删/改 mix/调顺序都能 Cmd+Z 撤销） */
  constraints: IkConstraintDef[];
  // ===== 素材 / 插槽相关（让插槽/附件的删除、重命名、复制也能 Cmd+Z / Cmd+Shift+Z）=====
  slots: PixiBonesSlot[];
  /** 素材库：canvas 保留同一引用（canvas 内容创建后不变），数组结构可还原 */
  images: PixiBonesLayer[];
  slotVisibility: Record<string, boolean>;
  slotStyle: Record<string, { color: string; blend: string }>;
  attachmentStyle: Record<string, { color: string; blend: string }>;
  slotOrder: string[];
  slotBindings: Record<string, SlotBinding>;
  selectedSlotId: string | null;
  selectedSlotIds: string[];
  selectedAttachmentId: string | null;
  selectedRowKey: string | null;
};

/** 深拷贝素材图层（canvas 保留同一引用 —— 内容创建后不变，只还原数组结构）。 */
function cloneLayerTree(layer: PixiBonesLayer): PixiBonesLayer {
  return {
    ...layer,
    children: layer.children.map(cloneLayerTree),
  };
}

/** 从当前 store 状态生成一份完整历史快照。 */
function makeSnapshot(s: PixiBonesState): HistorySnapshot {
  return {
    bones: JSON.parse(JSON.stringify(s.bones)),
    slotTransforms: JSON.parse(JSON.stringify(s.slotTransforms)),
    attachmentMeshes: JSON.parse(JSON.stringify(
      Object.fromEntries(Object.entries(s.attachmentMeshes).map(([k, m]) => [k, fillMeshDefaults(m)])),
    )),
    selectedBoneId: s.selectedBoneId,
    animations: JSON.parse(JSON.stringify(s.animations)),
    constraints: JSON.parse(JSON.stringify(s.constraints)),
    slots: JSON.parse(JSON.stringify(s.slots)),
    images: s.images.map(cloneLayerTree),
    slotVisibility: JSON.parse(JSON.stringify(s.slotVisibility)),
    slotStyle: JSON.parse(JSON.stringify(s.slotStyle)),
    attachmentStyle: JSON.parse(JSON.stringify(s.attachmentStyle)),
    slotOrder: JSON.parse(JSON.stringify(s.slotOrder)),
    slotBindings: JSON.parse(JSON.stringify(s.slotBindings)),
    selectedSlotId: s.selectedSlotId,
    selectedSlotIds: [...s.selectedSlotIds],
    selectedAttachmentId: s.selectedAttachmentId,
    selectedRowKey: s.selectedRowKey,
  };
}

/** 把快照还原成可 set 的状态子集（供 undo / redo 使用）。 */
function snapshotToState(snap: HistorySnapshot) {
  return {
    bones: snap.bones,
    slotTransforms: snap.slotTransforms,
    attachmentMeshes: snap.attachmentMeshes,
    selectedBoneId: snap.selectedBoneId,
    animations: snap.animations,
    constraints: snap.constraints,
    slots: snap.slots,
    images: snap.images,
    slotVisibility: snap.slotVisibility,
    slotStyle: snap.slotStyle,
    attachmentStyle: snap.attachmentStyle,
    slotOrder: snap.slotOrder,
    slotBindings: snap.slotBindings,
    selectedSlotId: snap.selectedSlotId,
    selectedSlotIds: snap.selectedSlotIds,
    selectedAttachmentId: snap.selectedAttachmentId,
    selectedRowKey: snap.selectedRowKey,
  };
}

/**
 * 一个已保存工程的完整数据（projectIO 反序列化后交给 applyProjectData 落盘）。
 * 注意：psd / images 里的 PixiBonesLayer.canvas 此时必须是**已还原好的 canvas**。
 */
export interface ProjectData {
  psd: PixiBonesPsd | null;
  images: PixiBonesLayer[];
  slots: PixiBonesSlot[];
  slotVisibility: Record<string, boolean>;
  slotTransforms: Record<string, { tx: number; ty: number; rotation: number; scaleX: number; scaleY: number; skewX: number; skewY: number }>;
  slotStyle: Record<string, { color: string; blend: string }>;
  attachmentStyle: Record<string, { color: string; blend: string }>;
  attachmentMeshes: Record<string, MeshData>;
  slotOrder: string[];
  slotBindings: Record<string, SlotBinding>;
  bones: BoneNode[];
  selectedBoneId: string | null;
  selectedBoneIds: string[];
  projectName: string;
  /** 动画数据（可序列化模型；旧存档缺省为 []） */
  animations: EditorAnimation[];
  activeAnimationId: string | null;
  setupPose: Record<string, BonePose>;
  /** IK 约束列表（顺序即应用顺序；旧存档缺省为 []） */
  constraints: IkConstraintDef[];
  editorTab?: EditorTab;
  viewport?: { panX: number; panY: number; zoom: number };
}

export interface PixiBonesState {
  // ---- Day 1 残留字段（Demo 用自己的 skeleton，这里保留兼容）----
  skeleton: Skeleton | null;
  selectedBoneName: string | null;

  // ---- 动画（仿 Spine 动画 tab）----
  animations: EditorAnimation[];
  /** 当前激活（正在编辑/播放）的动画 id */
  activeAnimationId: string | null;
  /** 当前时间（秒） */
  currentTime: number;
  playing: boolean;
  /** 循环播放：时间到达 duration 后回绕到 0 */
  loop: boolean;
  /** 时间轴标尺 / 帧步进的帧率（fps） */
  fps: number;
  /** 进入动画 tab 时捕获的「设置姿态」（动画未覆盖属性的缺省值） */
  setupPose: Record<string, BonePose>;
  /** 关键帧锁（动画 tab 钥匙按钮）：true = 变换骨骼时自动在 currentTime 写关键帧 */
  keyframeLock: boolean;
  setActiveAnimation: (id: string | null) => void;
  addAnimation: (name?: string) => string;
  duplicateAnimation: (id: string) => string;
  renameAnimation: (id: string, name: string) => void;
  removeAnimation: (id: string) => void;
  setAnimationDuration: (id: string, duration: number) => void;
  /** 设置当前时间并（动画 tab 下）采样应用到骨骼（不入历史） */
  seekTo: (t: number) => void;
  /** 前进 / 后退一帧（1/fps） */
  stepFrame: (dir: 1 | -1) => void;
  togglePlay: () => void;
  setLoop: (v: boolean) => void;
  toggleKeyframeLock: () => void;
  /** 写 / 更新某骨骼某属性在 time 处的关键帧（入历史；随后采样应用） */
  setKeyframe: (boneId: string, property: AnimProperty, time: number, value: number) => void;
  /** 删除某骨骼某属性在 time 处的关键帧（入历史；随后采样应用） */
  removeKeyframe: (boneId: string, property: AnimProperty, time: number) => void;
  /** 把 fromTime 处的关键帧移到 toTime（入历史；随后采样应用） */
  moveKeyframe: (boneId: string, property: AnimProperty, fromTime: number, toTime: number) => void;
  /** 动画 tab + 关键帧锁开启时：把骨骼当前值的若干属性在 currentTime 写关键帧（一次拖动合并为一步历史） */
  recordBoneEdits: (boneId: string, props: Array<Exclude<AnimProperty, 'mix'>>) => void;
  /** 用当前激活动画在 currentTime 的采样覆盖 bones（不入历史；仅动画 tab 有效） */
  applyActiveAnimation: () => void;
  /** 写 / 更新某约束在 time 处的 mix 关键帧（入历史；随后采样应用） */
  setConstraintMixKeyframe: (constraintId: string, time: number, value: number) => void;
  /** 删除某约束在 time 处的 mix 关键帧（入历史；随后采样应用） */
  removeConstraintMixKeyframe: (constraintId: string, time: number) => void;
  /** 动画 tab 下约束 mix 的运行时值（key = 约束 id，由 applyActiveAnimation 采样写入，
   *  离开动画 tab 时清空）。渲染 IK 时用它覆盖 constraints[].mix。 */
  constraintRuntimeMix: Record<string, number>;

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
  /** 给目标插槽**追加引用**某附件并设为当前显示。
   *  ★ 附件是全局素材，可被多个插槽同时引用（如一把枪同时给左手/右手），
   *    因此不会从其它插槽移除它。 */
  addAttachmentToSlot: (slotId: string, attachmentId: string) => void;
  /** 解除「该插槽 → 该附件」的引用（附件本身留在素材库，插槽空了也保留） */
  detachAttachment: (slotId: string, attachmentId: string) => void;
  /** 复制一个素材附件：深拷贝素材加入 images；若提供 slotId，把副本引用进该插槽
   *  （插入原附件之后、设为当前显示），选中副本。 */
  duplicateAttachment: (attachmentId: string, slotId?: string | null) => void;
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

  // ---- 网格附件（仿 Spine Mesh Attachment）----
  /** 附件的网格数据（key = attachmentId）。
   *  有记录 = 网格附件（渲染走 PIXI Mesh）；没有 = 区域附件（4 角 Sprite）。 */
  attachmentMeshes: Record<string, MeshData>;
  /** 把一个附件转成网格附件。cols/rows = 初始细分（默认 2×2 → 4 顶点，仿 Spine）。 */
  createMesh: (attachmentId: string, cols?: number, rows?: number) => void;
  /** 把网格附件转回区域附件（删除网格数据） */
  removeMesh: (attachmentId: string) => void;
  /**
   * 重置网格（编辑网格工具栏 / 层级面板「重置」按钮）。
   *  - 无权重：直接重置为初始矩形（2×2 网格：4 顶点 + 1 条对角线）。
   *  - 有权重：不直接重置，写入 resetMeshRequestAttachmentId → 弹面板让用户选择。
   */
  resetMesh: (attachmentId: string) => void;
  /** 重置弹窗：当前请求重置的网格 id（非 null = 弹窗打开） */
  resetMeshRequestAttachmentId: string | null;
  /** 确认重置：mode = 'keepWeights' 保留骨骼绑定并重算 4 顶点权重 / 'clearWeights' 清除全部绑定 */
  confirmMeshReset: (attachmentId: string, mode: 'keepWeights' | 'clearWeights') => void;
  /** 取消重置弹窗 */
  cancelMeshReset: () => void;
  /**
   * 生成（仿 Spine）：在「最有利于变形」的位置——当前最长边的中点——自动添加顶点，
   * 已有顶点不动，多次点击网格越来越密。会移除所有权重（Spine 行为）。
   */
  generateMesh: (attachmentId: string) => void;
  /** 冻结：把该插槽当前的旋转 / 缩放（slotTransforms）烘焙进网格顶点，
   *  再把 rotation 归 0、scale 归 1 —— 视觉不变但变换值清零（仿 Spine 的「冻结」）。 */
  freezeMesh: (slotId: string, attachmentId: string) => void;
  /** 写入顶点位置（拖动顶点时高频调用，不做历史快照） */
  setMeshVertices: (attachmentId: string, vertices: number[]) => void;
  /** 整体写入网格数据（增删顶点 / 细分边等改变拓扑时用） */
  setMeshData: (attachmentId: string, mesh: MeshData) => void;
  // ---- 权重绑定（线性混合蒙皮，仿 Spine Mesh Attachment.weights）----
  /** 把若干骨骼绑定到网格，并按「就近主控 + 距离衰减」自动算权重。
   *  - attachmentId：目标网格附件
   *  - boneIds：要绑上去的骨骼 id（去重；顺序决定 bones[] 写入顺序）
   *  - bindPoseVertices：可选，传入则用它作为 bindPose；不传则用当前 vertices 的副本
   *  - boneWorlds：可选，每根骨骼在**绑定时**的 world 坐标 (x,y,...)，长度 = boneIds.length*2。
   *    必须与 boneIds 去重后的顺序一致。不传则退化用 bones[].x/y（local，仅根骨骼/单层时准确）。
   *  - boneMatrices：可选，每根骨骼在**绑定时**的完整世界矩阵（6 元/骨 [a,b,c,d,tx,ty]），
   *    长度 = boneIds.length*6。存在时蒙皮用完整 LBS（旋转/缩放/平移都正确，对齐 Spine）。
   *  调用后写：mesh.bones / mesh.weights / mesh.bindPose / mesh.boneBindWorld / mesh.boneBindMatrices，并推一次历史。 */
  bindBonesToMesh: (attachmentId: string, boneIds: string[], bindPoseVertices?: number[], boneWorlds?: number[], boneMatrices?: number[]) => void;
  /** 给指定网格解绑一根骨骼（若该骨不再被任何顶点引用，同时从 mesh.bones 中移除） */
  unbindBoneFromMesh: (attachmentId: string, boneId: string) => void;
  /** 「绑定模式」：true 时 BoneEditor 把「点骨骼」解释成「绑到当前网格」，
   *  并显示 cursor / 高亮提示；Esc / 空格 / 再点「绑定」按钮 退出。 */
  weightBindMode: boolean;
  /** 进入 / 退出绑定模式。绑定模式开启时再点一次 = 退出 */
  toggleWeightBindMode: () => void;
  /** 权重「自动」按钮：按当前 mesh 的骨骼表重算一遍权重（用于重新绑定时刷新） */
  recomputeMeshWeights: (attachmentId: string) => void;
  /** 手动调权重（直接模式）：把若干选中顶点对某根骨骼的权重设为 value，
   *  其它骨骼按比例缩放到 (1-value)，保证每个顶点权重总和 = 1。
   *  ★ 不推历史：滑块拖动时由调用方在拖动开始推一次（避免每个 onChange 都产生一步 undo）。 */
  setVertexWeights: (attachmentId: string, boneId: string, vertexIndices: number[], value: number) => void;
  // ---- 权重工具（视图菜单「权重」）UI 状态 ----
  /** 影响（0..1）：权重工具的施加强度 */
  weightInfluence: number; setWeightInfluence: (v: number) => void;
  /** 模式：直接（精确设值）/ 画笔 */
  weightMode: 'direct' | 'brush'; setWeightMode: (m: 'direct' | 'brush') => void;
  /** 权重（0..1）：直接模式下设置精确权重值 */
  weightValue: number; setWeightValue: (v: number) => void;
  /** 饼图：为每个顶点画权重饼图 */
  weightPie: boolean; setWeightPie: (v: boolean) => void;
  /** 叠加：用骨骼颜色填充网格来显示权重 */
  weightOverlay: boolean; setWeightOverlay: (v: boolean) => void;
  /** 已选：只画选中顶点 / 选中骨骼的饼图（叠加时未选骨骼用黑色） */
  weightSelectedOnly: boolean; setWeightSelectedOnly: (v: boolean) => void;
  /**
   * 权重视图「当前作用的网格附件 id」（key = attachmentId）。
   * ★ 关键：它**不随选中骨骼而清空** —— 在权重面板的骨骼列表里点某根骨骼时，
   *   插槽/附件选中会被清掉，但 weightMeshId 保留，面板才能继续列出该网格绑定的骨骼。
   * 选中插槽 / 附件 / 绑定骨骼时会自动更新。
   */
  weightMeshId: string | null;
  setWeightMesh: (attachmentId: string | null) => void;
  /** 正在编辑网格的插槽 id（null = 未进入网格编辑模式） */
  meshEditSlotId: string | null;
  setMeshEditSlot: (slotId: string | null) => void;
  /** 网格编辑工具：modify=拖顶点（双击删除）/ create=点击加顶点、拖拽加边 / delete=点顶点删除 */
  meshTool: 'modify' | 'create' | 'delete';
  setMeshTool: (t: 'modify' | 'create' | 'delete') => void;
  /** 编辑模式下选中的顶点索引（支持多选） */
  meshSelectedVertices: number[];
  setMeshSelectedVertices: (idx: number[]) => void;
  /** 是否在画布上画出三角剖分（虚线） */
  meshShowTriangles: boolean;
  setMeshShowTriangles: (v: boolean) => void;
  /** 变形（仿 Spine 编辑网格里的 Deformed）：勾选 = 编辑时也套用网格（预览裁切/变形）；
   *  未勾选 = 编辑时显示**完整原图**、只编辑顶点，不把网格效果施加到图片上。 */
  meshDeformed: boolean;
  setMeshDeformed: (v: boolean) => void;
  /** 网格编辑：变暗（占位，暂无渲染效果） */
  meshDim: boolean;
  setMeshDim: (v: boolean) => void;
  /** 网格编辑：隔离（勾选后画布只显示正在编辑的那个插槽的图） */
  meshIsolate: boolean;
  setMeshIsolate: (v: boolean) => void;
  /** 网格工具·软选择：勾选后拖动顶点时，附近的顶点按距离衰减一起动（仿 Spine「网格工具」视图） */
  meshSoftSelect: boolean;
  setMeshSoftSelect: (v: boolean) => void;
  /** 软选择「大小」：影响半径（附件局部单位 = 图片像素） */
  meshSoftSize: number;
  setMeshSoftSize: (v: number) => void;
  /** 软选择「羽化」：0..1，半径内「完全选中」的比例；之外线性衰减到 0 */
  meshSoftFeather: number;
  setMeshSoftFeather: (v: number) => void;
  /** 软选择「外壳顶点」：勾选 = 外壳（边界）顶点也受软选择影响 */
  meshSoftHull: boolean;
  setMeshSoftHull: (v: boolean) => void;
  /** 网格「新建」描绘中：已点出的轮廓点（附件局部坐标）。
   *  null = 不在描绘；空数组 = 刚激活、还没点第一个点。
   *  点回起点即闭合 → 用该多边形重建网格（图片裁到轮廓内）。 */
  meshNewPolygon: Array<{ x: number; y: number }> | null;
  setMeshNewPolygon: (pts: Array<{ x: number; y: number }> | null) => void;
  /** 线框：勾选后即使未选中该网格，也画出它的顶点和边（key = attachmentId） */
  meshWireframe: Record<string, boolean>;
  setMeshWireframe: (attachmentId: string, v: boolean) => void;
  /** 「描绘」请求：面板点一次自增一次，BoneEditor 订阅到变化后按图片 alpha 自动提取轮廓。
   *  （和 fitRequestId 同一套路：面板不直接改网格数据，只发请求） */
  traceRequestId: number;
  requestTrace: () => void;

  // ---- 描绘对话框（仿 Spine 的 Trace 弹窗） ----
  traceDialogOpen: boolean;
  /** 弹窗内参数（默认值参考 Spine 的 Trace Settings 截图） */
  traceDetail: number;          // 细节 1..100，越大越精细
  traceConcavity: number;       // 凹度 1..100，越大越愿意把顶点塞进凹处
  traceRefinement: number;      // 精致度（控制迭代/再拟合次数）
  traceMerge: number;           // 统一 0..1，相邻顶点距离小于该比例时合并
  traceAlphaThreshold: number;  // Alpha 阈值 0..255
  tracePadding: number;         // 填充 0..32
  /** 对话框里「实时」追踪的顶点数（不加历史） */
  traceVertexCount: number;
  setTraceDialogOpen: (v: boolean) => void;
  setTraceDetail: (v: number) => void;
  setTraceConcavity: (v: number) => void;
  setTraceRefinement: (v: number) => void;
  setTraceMerge: (v: number) => void;
  setTraceAlphaThreshold: (v: number) => void;
  setTracePadding: (v: number) => void;
  setTraceVertexCount: (v: number) => void;
  /** 描绘弹窗「实时预览」开关 */
  traceLivePreview: boolean;
  /** 打开弹窗前的网格快照（仅 mesh 字段，null = 该图层原无网格） */
  traceSnapshot: { layerId: string; mesh: MeshData | null } | null;
  /** 打开弹窗：标记预览模式 + 存快照 + 设对话框 open */
  openTraceDialog: (layerId: string, currentMesh: MeshData | null) => void;
  /** 「确定」：最后一次结果入历史 + 关闭预览 + 关弹窗 */
  applyTraceWithDialogSettings: () => void;
  /** 「取消」：从快照恢复网格 + 关闭预览 + 关弹窗 */
  cancelTraceWithDialogSettings: () => void;
  /** 取消恢复请求：BoneEditor 订阅到变化后用 traceSnapshot 把网格还原 */
  traceRestoreRequestId: number;
  /** 订阅者完成 snapshot 恢复后清掉快照 */
  clearTraceSnapshot: () => void;
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
  /** 选中一个素材附件。slotId = 上下文插槽（「图片」里的素材可能没被任何插槽引用 → null）。 */
  selectAttachment: (slotId: string | null, attachmentId: string, rowKey?: string) => void;
  /** 删除插槽。★ 只允许删**空插槽**（有附件时请先把附件移出，避免素材丢失）——
   *  插槽的生命周期由用户显式控制，不会被附件移走自动删除。 */
  removeSlot: (slotId: string) => void;
  /** 复制一个插槽：新插槽插入到原插槽**下方**（slots 数组顺序 = 层级树顺序），
   *  引用同一批附件，名字加「 Copy」后缀（对齐 Spine）。 */
  duplicateSlot: (slotId: string) => void;
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
  /** 当前选中的 IK 约束 id（「约束」分区里高亮；也用于树行高亮）。 */
  selectedConstraintId: string | null;
  /** 选中一个 IK 约束（并切到「约束」分区）。 */
  selectConstraint: (id: string) => void;
  /** 选中层级树顶部的「动画」节点（当前动画名），清空骨骼/素材/分区选中 */
  selectAnimationNode: () => void;
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
  /** 层级树面板"恢复"时需要播"从图标展开"的入场动画（被最小化图标点击后置 true） */
  hierarchyRestorePending: boolean;
  /** 网格工具面板"恢复"时需要播入场动画 */
  gridRestorePending: boolean;
  /** 权重视图面板"恢复"时需要播入场动画 */
  weightsRestorePending: boolean;
  /** 把层级树面板的入场动画置为 true（由 header 恢复按钮调用） */
  setHierarchyRestorePending: (v: boolean) => void;
  setGridRestorePending: (v: boolean) => void;
  setWeightsRestorePending: (v: boolean) => void;

  // ---- IK 约束（仿 Spine 3.8，顺序 = 应用顺序）----
  /** IK 约束列表。数组顺序即应用顺序（层级树「约束」节点里可拖拽调整）。 */
  constraints: IkConstraintDef[];
  /** 新建一条 IK 约束：boneId = 受约束骨，targetBoneId = 目标骨，childBoneId 可选（双骨 IK）。name 可自定义（默认 "IK N"）。 */
  addIkConstraint: (boneId: string, targetBoneId: string, childBoneId?: string | null, name?: string) => string;
  /** 删除约束（id 不存在则忽略） */
  removeConstraint: (id: string) => void;
  /** 重命名约束 */
  renameConstraint: (id: string, name: string) => void;
  /** 重命名骨骼（层级树行上双击触发） */
  renameBone: (id: string, name: string) => void;
  /** 重命名插槽 */
  renameSlot: (id: string, name: string) => void;
  /** 重命名素材附件（PixiBonesLayer） */
  renameAttachment: (id: string, name: string) => void;
  /** 改目标骨 */
  setConstraintTarget: (id: string, targetBoneId: string) => void;
  /** 改混合程度 0..1 */
  setConstraintMix: (id: string, mix: number) => void;
  /** 改弯曲方向（双骨 IK） */
  setConstraintBendDirection: (id: string, dir: 1 | -1) => void;
  /** 调整顺序：把 id 对应约束移到新索引（数组索引，0 = 最先应用） */
  moveConstraint: (id: string, toIndex: number) => void;

  // ---- IK 约束创建流程（仿 Spine：选骨 → 新建 → IK → 拾取目标 → 弹窗命名）----
  /** 正在等待拾取 IK 目标骨（非 null = 「新建 ik 约束：选择目标」拾取模式）。 */
  ikPickBoneId: string | null;
  /** 双骨 IK 的第二根受约束骨（用户多选时；单骨为 null）。 */
  ikPickChildBoneId: string | null;
  /** 已拾取的目标骨 id（触发命名弹窗；确认后创建约束并清空）。 */
  ikPickTargetBoneId: string | null;
  /** 进入拾取模式：boneId = 第一根受约束骨，childBoneId = 第二根（双骨 IK，可空）。 */
  startIkPick: (boneId: string, childBoneId?: string | null) => void;
  /** 取消拾取模式 */
  cancelIkPick: () => void;
  /** 拾取到目标骨：记录目标，触发命名弹窗 */
  setIkPickTarget: (targetBoneId: string) => void;
  /** 点空白画布：创建一根新的目标骨「target n」（父级 = root，长度 0 = 可拖手柄）并设为目标。 */
  createIkTargetBone: (worldX: number, worldY: number) => string;

  // ---- UI state ----
  showLeftPanel: boolean;
  showRightPanel: boolean;
  showRulers: boolean;
  // ---- 视图菜单 11 个开关（Spine 视图风格，全部默认关闭）----
  viewWeights:        boolean; toggleViewWeights:        () => void;
  viewSkin:           boolean; toggleViewSkin:           () => void;
  viewGridTool:       boolean; toggleViewGridTool:       () => void; setViewGridTool: (v: boolean) => void;
  /** grid_tool 面板"已最小化"标记（true = view 标记仍为 true 但不渲染面板） */
  viewGridToolMinimized: boolean; setViewGridToolMinimized: (v: boolean) => void;
  viewColor:          boolean; toggleViewColor:          () => void;
  viewAnimation:      boolean; toggleViewAnimation:      () => void;
  viewHierarchy:      boolean; toggleViewHierarchy:      () => void;
  setViewWeights:     (v: boolean) => void;
  /** weights 面板"已最小化"标记 */
  viewWeightsMinimized: boolean; setViewWeightsMinimized: (v: boolean) => void;
  viewIndicators:     boolean; toggleViewIndicators:     () => void;
  viewOutline:        boolean; toggleViewOutline:        () => void;
  viewIssues:         boolean; toggleViewIssues:         () => void;
  viewPreview:        boolean; toggleViewPreview:        () => void;
  viewAllHidden:      boolean; setViewAllHidden:         (v: boolean) => void;
  /** "隐藏所有视图"前一刻已经开启的面板（viewDockOrder 的子集）—— 用于再次点击按钮时全部恢复 */
  lastOpenedDockOrder: string[];
  /**
   * 右侧停靠区里「视图面板」的**首次出现顺序**（仿 Spine 停靠规则）：
   * 越早出现的越靠右，后出现的依次往左排。
   * key 与视图菜单一致：'hierarchy'（层级树）/ 'grid_tool'（网格工具）。
   * 关闭面板不会把它从数组里移除 → 重新打开时回到原来的位置。
   */
  viewDockOrder: string[];
  /** 右侧停靠区各面板的宽度（key 同 viewDockOrder）；拖动面板左边缘的把手改这个值 */
  dockPanelWidths: Record<string, number>;
  setDockPanelWidth: (key: string, w: number) => void;
  editorMode: 'idle' | 'pose' | 'weights' | 'create';
  transformSpace: 'local' | 'world';
  /** 工具栏上「旋转 / 移动 / 缩放 / 倾斜」四张卡片的当前激活工具 */
  activeTool: 'rotate' | 'move' | 'scale' | 'shear' | null;
  /** 上一个被激活的 transform 工具（用于右键空白处回退）。
   *  由 setActiveTool setter 自动维护：每次切到新工具时把上一个记下来。 */
  prevActiveTool: 'rotate' | 'move' | 'scale' | 'shear' | null;
  /** 7 个工具的统一定义（姿势/权重/创建/旋转/移动/缩放/倾斜）。
   *  用于右键空白处在"最近两个工具"之间来回切换（对齐 Spine）。 */
  setTool: (t: EditorTool) => void;
  /** 上一次 setTool 切走的工具（右键空白处回退用）。 */
  prevTool: EditorTool | null;
  /** 当前激活的工具（由 editorMode + activeTool 推导，快捷读取）。 */
  currentTool: EditorTool;
  /** 当前项目名（默认 raptor-pro，可被 setProjectName 覆盖，如导入 PSD 后用文件名） */
  projectName: string;
  setProjectName: (name: string) => void;
  /** 当前打开的工程 id。null = 在欢迎页（未进入编辑器） */
  currentProjectId: string | null;
  openProject:    (id: string, name: string) => void;
  /** 新建项目：清空当前工程全部数据，重置为「只有一个 root 骨 + 一个默认动画」的全新工程。 */
  newProject: (name: string) => void;
  /** 载入一份已保存的工程数据（一次性覆盖全部工程态 + 清撤销栈），供 projectIO 调用 */
  applyProjectData: (d: ProjectData) => void;
  closeProject:   () => void;
  /** 最近工程列表（按打开时间倒序，最多 8 个，localStorage 持久化） */
  recentProjects: Array<{ id: string; name: string; openedAt: number }>;
  pushRecentProject: (id: string, name: string) => void;
  // ===== Undo/Redo 撤销重做（记录 bones + slotTransforms 的快照） =====
  /** 历史快照栈（最多 50 步），每项是 bones + slotTransforms + selectedBoneId 的快照 */
  historyPast:  HistorySnapshot[];
  historyFuture: HistorySnapshot[];
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
  /** 复制一根骨骼：新骨骼插入到原骨骼**下方**（平级），名字加「 Copy」后缀。 */
  duplicateBone: (id: string) => void;
  moveBone: (id: string, x: number, y: number) => void;
  setBoneRotation: (id: string, rotation: number) => void;
  setBoneLength: (id: string, length: number) => void;
  /** 设置骨骼颜色（0xRRGGBB；Spine 面板 Color 行） */
  setBoneColor: (id: string, color: number) => void;
  /** 设置本地剪切角（弧度；对应 Spine shearX / shearY） */
  setBoneShear: (id: string, shearX: number, shearY: number) => void;
  /** 设置是否继承父骨骼的 旋转 / 缩放 / 反射（Spine Inherit checkboxes） */
  setBoneInherit: (id: string, prop: 'rotation' | 'scale' | 'reflection', on: boolean) => void;
  /** 视口总是渲染名字（Spine Name checkbox） */
  setBoneShowName: (id: string, on: boolean) => void;
  /** 视口可否点选（Spine Select checkbox） */
  setBoneSelectable: (id: string, on: boolean) => void;
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

/** 由 editorMode + activeTool 推导出"当前 7 个工具之一"（setTool / setActiveTool / setEditorMode 共用） */
function currentToolOf(
  editorMode: 'idle' | 'pose' | 'weights' | 'create',
  activeTool: 'rotate' | 'move' | 'scale' | 'shear' | null,
): EditorTool {
  if (activeTool) return activeTool;
  if (editorMode === 'idle') return 'pose'; // idle 且无 activeTool 视为 pose
  return editorMode as EditorTool;
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

/**
 * 把 MeshData 的可选字段从 undefined 兜底为 []，保证 JSON.stringify / 解析后字段不丢。
 *   bones     → []
 *   weights   → []
 *   bindPose  → []
 * 否则 JSON.stringify 会丢 undefined，undo/redo 后 mesh.bones 变 undefined，
 * applySkinning 误判"无权重" → 网格被覆盖成 0 → 画面消失。
 */
function fillMeshDefaults(m: MeshData): MeshData {
  return {
    ...m,
    bones: m.bones ?? [],
    weights: m.weights ?? [],
    bindPose: m.bindPose ?? [],
    boneBindWorld: m.boneBindWorld ?? [],
    boneBindMatrices: m.boneBindMatrices ?? [],
  };
}

// =================================================================================
//  动画采样（纯函数，供 applyActiveAnimation 等调用）
// =================================================================================

/** 单属性关键帧插值（线性）。keys 必须按 time 升序、非空。
 *  - t < 第一个关键帧：从 t=0 的 setupValue 线性插到第一个关键帧（Spine 语义）
 *  - 关键帧之间：线性插值
 *  - t > 最后一个关键帧：钳在最后一个关键帧的值
 */
function sampleTrackValue(keys: AnimKeyframe[], t: number, setupValue: number): number {
  const first = keys[0];
  if (t <= first.time) {
    if (first.time <= 1e-6) return first.value;
    const u = t / first.time;
    return setupValue + (first.value - setupValue) * u;
  }
  const last = keys[keys.length - 1];
  if (t >= last.time) return last.value;
  let i = 1;
  while (i < keys.length - 1 && keys[i].time < t) i++;
  const a = keys[i - 1];
  const b = keys[i];
  const span = b.time - a.time;
  const u = span > 1e-9 ? (t - a.time) / span : 0;
  return a.value + (b.value - a.value) * u;
}

/** 采样约束 mix 轨道（constraintMix = true 的轨道），返回 约束 id → mix 值。
 *  t 处无轨道 → 不包含该约束（调用方用 setupPose 缺省）。 */
function sampleConstraintMixes(anim: EditorAnimation, t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tr of anim.tracks) {
    if (!tr.constraintMix || tr.keys.length === 0) continue;
    out[tr.boneId] = sampleTrackValue(tr.keys, t, 1);
  }
  return out;
}

/**
 * ★ 动画 tab 下，用「已更新轨道的动画」在 currentTime 采样骨骼姿态 + 约束 mix，
 * 返回可直接展开进 set() 的补丁（一次 set 完成，避免 applyActiveAnimation 的二次 set
 * 触发二次 subscribe → 播放 / 编辑时少一半全量重画）。
 */
function buildAnimPatch(s: PixiBonesState, anim: EditorAnimation): Partial<PixiBonesState> {
  if (s.editorTab !== 'animate') return {};
  const patch: Partial<PixiBonesState> = {};
  const next = sampleAnimationPose(anim, s.setupPose, s.bones, s.currentTime);
  if (next) patch.bones = next;
  const mixes = sampleConstraintMixes(anim, s.currentTime);
  if (Object.keys(mixes).length > 0) patch.constraintRuntimeMix = mixes;
  return patch;
}

/**
 * 采样一段动画在 t 时刻的骨骼姿态。
 * 每根骨骼、每个属性独立：有轨道 → 按关键帧插值；无轨道 → 用 setupPose 缺省值。
 * 返回 null = 无有效动画（调用方保持 bones 不动）。
 */
function sampleAnimationPose(
  anim: EditorAnimation,
  setupPose: Record<string, BonePose>,
  bones: BoneNode[],
  t: number,
): BoneNode[] | null {
  if (anim.duration <= 0) return null;
  // 轨道按 骨骼 → 属性 → keys 索引
  const trackMap = new Map<string, Map<AnimProperty, AnimKeyframe[]>>();
  for (const tr of anim.tracks) {
    if (!tr.keys || tr.keys.length === 0) continue;
    let byProp = trackMap.get(tr.boneId);
    if (!byProp) { byProp = new Map(); trackMap.set(tr.boneId, byProp); }
    byProp.set(tr.property, tr.keys);
  }
  const clampT = Math.min(anim.duration, Math.max(0, t));
  return bones.map((n) => {
    const sp = setupPose[n.id] ?? { x: n.x, y: n.y, rotation: n.rotation, scaleX: n.scaleX, scaleY: n.scaleY };
    const byProp = trackMap.get(n.id);
    const val = (p: keyof BonePose): number => {
      const keys = byProp?.get(p as AnimProperty);
      return keys ? sampleTrackValue(keys, clampT, sp[p]) : sp[p];
    };
    return {
      ...n,
      x: val('x'),
      y: val('y'),
      rotation: val('rotation'),
      scaleX: val('scaleX'),
      scaleY: val('scaleY'),
    };
  });
}

/** 在 tracks 里 upsert 一条关键帧（同位置已有关键帧则覆盖），返回新 tracks（保持 time 升序）。 */
function upsertTrackKey(
  tracks: AnimTrack[],
  boneId: string,
  property: AnimProperty,
  time: number,
  value: number,
): AnimTrack[] {
  const key: AnimKeyframe = { time, value };
  const idx = tracks.findIndex((tr) => tr.boneId === boneId && tr.property === property);
  if (idx >= 0) {
    const keys = tracks[idx].keys.filter((k) => Math.abs(k.time - time) >= 1e-6);
    keys.push(key);
    keys.sort((a, b) => a.time - b.time);
    return tracks.map((tr, i) => (i === idx ? { ...tr, keys } : tr));
  }
  return [...tracks, { boneId, property, keys: [key] }];
}

/** 读某轨道在精确 time 处的关键帧值（无则 0；moveKeyframe 用）。 */
function keyValueAt(anim: EditorAnimation, boneId: string, property: AnimProperty, time: number): number {
  const tr = anim.tracks.find((x) => x.boneId === boneId && x.property === property);
  const k = tr?.keys.find((kk) => Math.abs(kk.time - time) < 1e-6);
  return k?.value ?? 0;
}

// =================================================================================
//  插槽（slot）工具
// =================================================================================

/** 插槽 id 自增（一次会话内稳定）。 */
let _slotIdCounter = 0;
function genSlotId(): string {
  _slotIdCounter++;
  return `slot_${_slotIdCounter}`;
}

/** 素材附件（PixiBonesLayer）id 自增 —— 复制附件时需要生成新 id。 */
let _layerIdCounter = 0;
function genLayerId(): string {
  _layerIdCounter++;
  return `layer_${_layerIdCounter}`;
}

/** 深拷贝一个素材图层（含 canvas 与子图层），复制时生成独立 id。 */
function cloneLayerDeep(layer: PixiBonesLayer): PixiBonesLayer {
  let canvas: HTMLCanvasElement | undefined;
  if (layer.canvas) {
    canvas = document.createElement('canvas');
    canvas.width = layer.canvas.width;
    canvas.height = layer.canvas.height;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.drawImage(layer.canvas, 0, 0);
  }
  return {
    ...layer,
    id: genLayerId(),
    canvas,
    children: layer.children.map(cloneLayerDeep),
  };
}

/** 动画 id 自增（一次会话内稳定）。 */
let _animIdCounter = 0;
function genAnimId(): string {
  _animIdCounter++;
  return `anim_${_animIdCounter}`;
}

/** IK 约束 id 自增（一次会话内稳定）。 */
let _constraintIdCounter = 0;
function genConstraintId(): string {
  _constraintIdCounter++;
  return `ik_${_constraintIdCounter}`;
}

/**
 * 把骨骼 / 插槽 / 动画的 id 自增计数器推到已载入 id 的最大序号之后。
 * 载入工程后必须调用，否则新建的 bone_1 / slot_1 / anim_1 会和已载入的 id 撞号。
 */
function syncIdCounters(boneIds: string[], slotIds: string[], animIds: string[]): void {
  const maxSuffix = (ids: string[], prefix: string): number => {
    let m = 0;
    for (const id of ids) {
      if (typeof id !== 'string' || !id.startsWith(prefix)) continue;
      const n = parseInt(id.slice(prefix.length), 10);
      if (Number.isFinite(n)) m = Math.max(m, n);
    }
    return m;
  };
  _boneIdCounter = Math.max(_boneIdCounter, maxSuffix(boneIds, 'bone_'));
  _slotIdCounter = Math.max(_slotIdCounter, maxSuffix(slotIds, 'slot_'));
  _animIdCounter = Math.max(_animIdCounter, maxSuffix(animIds, 'anim_'));
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
 * 自动权重（就近主控 + 距离反比衰减，供绑定与重置「保留权重」共用）：
 * 每顶点找最近骨做主控（0.7），剩余 0.3 按距离反比分给其它骨。
 * 返回 weights 数组，长度 = vertices.length / 2 * boneWorlds.length。
 */
function computeAutoWeights(boneWorlds: Array<{ x: number; y: number }>, vertices: number[]): number[] {
  const vertCount = vertices.length / 2;
  const nb = boneWorlds.length;
  const weights = new Array(vertCount * nb).fill(0);
  for (let v = 0; v < vertCount; v++) {
    const vx = vertices[v * 2];
    const vy = vertices[v * 2 + 1];
    let nearest = 0;
    let nearestD = Infinity;
    const dists = new Array(nb);
    for (let i = 0; i < nb; i++) {
      const dx = vx - boneWorlds[i].x;
      const dy = vy - boneWorlds[i].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      dists[i] = d;
      if (d < nearestD) { nearestD = d; nearest = i; }
    }
    // 只有一骨时直接 100%
    if (nb === 1) { weights[v * nb + 0] = 1; continue; }
    // 距离反比：距离差越大权重越低（最近差 = 1）
    let sum = 0;
    const inv: number[] = new Array(nb).fill(0);
    for (let i = 0; i < nb; i++) {
      if (i === nearest) continue;
      const inv_i = 1 / ((dists[i] - nearestD) + 1);
      inv[i] = inv_i;
      sum += inv_i;
    }
    weights[v * nb + nearest] = 0.7;
    if (sum > 0) {
      const rem = 0.3 / sum;
      for (let i = 0; i < nb; i++) {
        if (i === nearest) continue;
        weights[v * nb + i] = inv[i] * rem;
      }
    } else {
      // 其它骨距离都一样 → 均分 0.3
      const rem = 0.3 / (nb - 1);
      for (let i = 0; i < nb; i++) {
        if (i === nearest) continue;
        weights[v * nb + i] = rem;
      }
    }
  }
  return weights;
}

/**
 * 把网格重置为初始矩形（2×2 网格：4 顶点 + 1 条对角线，与 createMesh(2,2) 一致）。
 *  - 'clearWeights'：同时删除骨骼绑定与权重（不留任何绑定字段）
 *  - 'keepWeights'：保留 bones / boneBindWorld，对新的 4 顶点自动重算权重
 * 推一次历史；同时清空选中顶点（索引可能越界）。
 */
function applyMeshReset(getState: () => PixiBonesState, attachmentId: string, mode: 'keepWeights' | 'clearWeights') {
  const st = getState();
  const mesh = st.attachmentMeshes[attachmentId];
  if (!mesh) return;
  const layer = attachmentLayers(st.psd, st.images).find((l) => l.id === attachmentId);
  if (!layer) return;
  const w = layer.width;
  const h = layer.height;
  // 初始矩形：顶点按「左→右、上→下」（0,0)(w,0)(0,h)(w,h)；对角线切成 2 个三角形
  const vertices = [0, 0, w, 0, 0, h, w, h];
  const uvs = [0, 0, 1, 0, 0, 1, 1, 1];
  const indices = [0, 1, 2, 1, 3, 2];
  st.pushHistory();
  if (mode === 'keepWeights' && mesh.bones && mesh.bones.length > 0) {
    const bones = mesh.bones.slice();
    const nb = bones.length;
    const boneWorlds: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < nb; i++) {
      const b = st.bones.find((x) => x.id === bones[i]);
      boneWorlds.push({
        x: mesh.boneBindWorld?.[i * 2] ?? b?.x ?? 0,
        y: mesh.boneBindWorld?.[i * 2 + 1] ?? b?.y ?? 0,
      });
    }
    const weights = computeAutoWeights(boneWorlds, vertices);
    usePixiBonesStore.setState((s) => ({
      attachmentMeshes: {
        ...s.attachmentMeshes,
        [attachmentId]: {
          vertices, uvs, indices,
          bones, weights,
          bindPose: vertices.slice(),
          boneBindWorld: mesh.boneBindWorld?.slice(),
          boneBindMatrices: mesh.boneBindMatrices?.slice(),
        },
      },
      meshSelectedVertices: [],
    }));
  } else {
    // 清除权重：不保留任何绑定字段
    usePixiBonesStore.setState((s) => ({
      attachmentMeshes: {
        ...s.attachmentMeshes,
        [attachmentId]: { vertices, uvs, indices },
      },
      meshSelectedVertices: [],
    }));
  }
}

/**
 * 「生成」：反复在当前**最长边**的中点插入新顶点（边中点细分，接近 Delaunay 加密）。
 *  - 已存在的顶点不动（新顶点正好落在边上）
 *  - 矩形外壳时结果逐步逼近「行 / 列」网格（对齐 Spine 文档）
 *  - 返回新的 vertices / uvs / indices（不含权重字段，生成会移除所有权重）
 */
function generateMeshData(mesh: MeshData): { vertices: number[]; uvs: number[]; indices: number[] } {
  const vertices = mesh.vertices.slice();
  const uvs = mesh.uvs.slice();
  // 三角形列表（每 3 个索引一个三角形）
  const tris: Array<[number, number, number]> = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    tris.push([mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]]);
  }
  // 每次生成新增约 1/3 三角形数量的顶点（多次点击持续加密）
  const addCount = Math.max(2, Math.round(tris.length / 3));
  for (let k = 0; k < addCount && tris.length > 0; k++) {
    // 找当前最长边
    let best: [number, number] | null = null;
    let bestLen = -1;
    for (const [a, b, c] of tris) {
      for (const [p, q] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
        const dx = vertices[p * 2] - vertices[q * 2];
        const dy = vertices[p * 2 + 1] - vertices[q * 2 + 1];
        const len = dx * dx + dy * dy;
        if (len > bestLen) { bestLen = len; best = [p, q]; }
      }
    }
    if (!best) break;
    const [va, vb] = best;
    // 收集所有包含该边的三角形并从列表移除
    const shared: Array<[number, number, number]> = [];
    for (let i = tris.length - 1; i >= 0; i--) {
      const t3 = tris[i];
      const hasEdge = [0, 1, 2].some((k2) => {
        const p = t3[k2];
        const q = t3[(k2 + 1) % 3];
        return (p === va && q === vb) || (p === vb && q === va);
      });
      if (hasEdge) { shared.push(t3); tris.splice(i, 1); }
    }
    // 新顶点 = 边中点（位置与 UV 都取平均，纹理不畸变、不移动已有顶点）
    const nv = vertices.length / 2;
    vertices.push(
      (vertices[va * 2] + vertices[vb * 2]) / 2,
      (vertices[va * 2 + 1] + vertices[vb * 2 + 1]) / 2,
    );
    uvs.push(
      (uvs[va * 2] + uvs[vb * 2]) / 2,
      (uvs[va * 2 + 1] + uvs[vb * 2 + 1]) / 2,
    );
    // 每个共享三角形拆成两个，保持原绕序（新三角形顶点都在原三角形内部/边上）
    for (const t3 of shared) {
      const other = t3[0] !== va && t3[0] !== vb ? t3[0]
        : t3[1] !== va && t3[1] !== vb ? t3[1]
        : t3[2];
      // 判断边方向：绕序中 va 的下一个（环转）是否是 vb
      const idxA = t3.indexOf(va);
      const next = t3[(idxA + 1) % 3];
      if (next === vb) {
        tris.push([va, nv, other], [nv, vb, other]);
      } else {
        tris.push([vb, nv, other], [nv, va, other]);
      }
    }
  }
  const indices: number[] = [];
  for (const [a, b, c] of tris) indices.push(a, b, c);
  return { vertices, uvs, indices };
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
  hierarchyRestorePending: false,
  gridRestorePending: false,
  weightsRestorePending: false,
  viewGridToolMinimized: false,
  viewWeightsMinimized: false,
  animations: [],
  activeAnimationId: null,
  currentTime: 0,
  playing: false,
  loop: true,
  fps: 30,
  setupPose: {},
  keyframeLock: true,
  constraintRuntimeMix: {},
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
  // 把附件加入目标插槽并设为当前显示。
  //   ★ 附件是**全局素材**，可被多个插槽同时引用（例如一把枪同时给左手 / 右手
  //     两个插槽用），因此这里**不从其它插槽移除**它，只往目标插槽追加引用。
  addAttachmentToSlot: (slotId, attachmentId) => set((state) => {
    if (!state.slots.some((s) => s.id === slotId)) return state;
    const slots = state.slots.map((s) => s.id === slotId
      ? {
          ...s,
          // 已经引用过就不重复追加，只切为当前显示
          attachmentIds: s.attachmentIds.includes(attachmentId)
            ? s.attachmentIds
            : [...s.attachmentIds, attachmentId],
          activeAttachmentId: attachmentId,
        }
      : s);
    return { slots };
  }),
  // 解除「该插槽 → 该附件」的引用（★ 只解引用：附件仍在素材库里，
  //   也可能仍被其它插槽引用；插槽空了也照样保留）
  detachAttachment: (slotId, attachmentId) => {
    get().pushHistory();
    set((state) => {
      const src = state.slots.find((s) => s.id === slotId);
      if (!src || !src.attachmentIds.includes(attachmentId)) return state;
      const slots = state.slots.map((s) => {
        if (s.id !== slotId) return s;
        const attachmentIds = s.attachmentIds.filter((id) => id !== attachmentId);
        const activeAttachmentId = s.activeAttachmentId && attachmentIds.includes(s.activeAttachmentId)
          ? s.activeAttachmentId
          : (attachmentIds[0] ?? null);
        return { ...s, attachmentIds, activeAttachmentId };
      });
      return { slots };
    });
  },
  slotIdOfAttachment: (attachmentId) => slotIdOf(get().slots, attachmentId),
  duplicateAttachment: (attachmentId, slotId = null) => {
    get().pushHistory();
    set((state) => {
      const src = state.images.find((l) => l.id === attachmentId);
      if (!src) return state;
      const copy = cloneLayerDeep(src);
      copy.name = src.name + ' Copy';
      // 若提供 slotId：把副本引用进该插槽（插在原附件**之后**、设为当前显示）
      const slots = slotId
        ? state.slots.map((s) => {
            if (s.id !== slotId) return s;
            const attachmentIds = [...s.attachmentIds];
            const at = attachmentIds.indexOf(attachmentId);
            if (at >= 0) attachmentIds.splice(at + 1, 0, copy.id);
            else attachmentIds.push(copy.id);
            return { ...s, attachmentIds, activeAttachmentId: copy.id };
          })
        : state.slots;
      return {
        images: [...state.images, copy],
        slots,
        selectedSlotId: slotId ?? state.selectedSlotId,
        selectedSlotIds: slotId ? [slotId] : state.selectedSlotIds,
        selectedAttachmentId: copy.id,
        selectedRowKey: 'asset:' + copy.id,
        selectedBoneId: null,
        selectedSectionKey: null,
      };
    });
  },
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
  // ===== 网格附件 =====
  attachmentMeshes: {},
  createMesh: (attachmentId, cols = 2, rows = 2) => set((state) => {
    const layer = attachmentLayers(state.psd, state.images).find((l) => l.id === attachmentId);
    if (!layer) return state;
    const w = layer.width;
    const h = layer.height;
    const cx = Math.max(2, Math.round(cols));
    const cy = Math.max(2, Math.round(rows));
    const vertices: number[] = [];
    const uvs: number[] = [];
    // 顶点按「从左到右、从上到下」排；UV 与位置同比例（此时网格无变形）
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const u = i / (cx - 1);
        const v = j / (cy - 1);
        vertices.push(u * w, v * h);
        uvs.push(u, v);
      }
    }
    // 每个格子切成 2 个三角形
    const indices: number[] = [];
    for (let j = 0; j < cy - 1; j++) {
      for (let i = 0; i < cx - 1; i++) {
        const a = j * cx + i;      // 左上
        const b = a + 1;           // 右上
        const c = a + cx;          // 左下
        const d = c + 1;           // 右下
        indices.push(a, b, c, b, d, c);
      }
    }
    return {
      attachmentMeshes: {
        ...state.attachmentMeshes,
        [attachmentId]: { vertices, uvs, indices },
      },
    };
  }),
  removeMesh: (attachmentId) => set((state) => {
    const next = { ...state.attachmentMeshes };
    delete next[attachmentId];
    return {
      attachmentMeshes: next,
      // 该网格被移除 → 权重视图当前网格一并清空
      ...(state.weightMeshId === attachmentId ? { weightMeshId: null } : {}),
    };
  }),
  // 重置网格：无权重 → 直接重置为初始矩形；有权重 → 弹面板让用户选择（由 confirmMeshReset 执行）
  resetMesh: (attachmentId) => {
    const mesh = get().attachmentMeshes[attachmentId];
    if (!mesh) return;
    const hasWeights = !!(mesh.bones && mesh.bones.length > 0);
    if (hasWeights) {
      set({ resetMeshRequestAttachmentId: attachmentId });
      return;
    }
    applyMeshReset(get, attachmentId, 'clearWeights');
  },
  confirmMeshReset: (attachmentId, mode) => {
    applyMeshReset(get, attachmentId, mode);
    // 关闭弹窗（若期间网格已被删除/切换，不再误关其它请求）
    if (get().resetMeshRequestAttachmentId === attachmentId) {
      set({ resetMeshRequestAttachmentId: null });
    }
  },
  cancelMeshReset: () => set({ resetMeshRequestAttachmentId: null }),
  resetMeshRequestAttachmentId: null,
  // 生成：在最长边中点自动加点（多次点击越来越密）；移除所有权重（Spine 行为）
  generateMesh: (attachmentId) => {
    const mesh = get().attachmentMeshes[attachmentId];
    if (!mesh || mesh.indices.length < 3) return;
    const next = generateMeshData(mesh);
    get().pushHistory();
    set((s) => ({
      attachmentMeshes: {
        ...s.attachmentMeshes,
        [attachmentId]: { vertices: next.vertices, uvs: next.uvs, indices: next.indices },
      },
      meshSelectedVertices: [],
    }));
  },
  setMeshVertices: (attachmentId, vertices) => set((state) => {
    const mesh = state.attachmentMeshes[attachmentId];
    if (!mesh) return state;
    return {
      attachmentMeshes: { ...state.attachmentMeshes, [attachmentId]: { ...mesh, vertices } },
    };
  }),
  setMeshData: (attachmentId, mesh) => set((state) => ({
    attachmentMeshes: { ...state.attachmentMeshes, [attachmentId]: mesh },
  })),
  // ===== 权重绑定（线性混合蒙皮） =====
  /**
   * 自动权重算法：每个顶点取最近的骨为「主控」（100%），
   *   其它骨按 1 / (d + ε)² 加权后再归一化到 1 - w_main。
   *
   * bones 输入会被去重 + 过滤掉不存在的；返回 { bones, weights }。
   * - bones 长度 = nb
   * - weights 长度 = vertices.length / 2 * nb
   *   每个顶点占 nb 段，依次为对 bones[0..nb-1] 的权重。
   */
  bindBonesToMesh: (attachmentId, boneIds, bindPoseVertices, boneWorlds, boneMatrices) => {
    const st = get();
    const mesh = st.attachmentMeshes[attachmentId];
    if (!mesh) return;
    // 去重 + 过滤存在的骨；同时按 boneIds 原始顺序提取对应的 world 坐标（若有传）
    const seen = new Set<string>();
    const bones: string[] = [];
    const world: Array<{ x: number; y: number }> = [];
    const mats: number[] = [];   // 完整绑定矩阵（6 元/骨），与 bones 去重后顺序一致
    for (let k = 0; k < boneIds.length; k++) {
      const id = boneIds[k];
      if (!id || seen.has(id)) continue;
      if (!st.bones.some((b) => b.id === id)) continue;
      seen.add(id);
      bones.push(id);
      if (boneWorlds && k * 2 + 1 < boneWorlds.length) {
        world.push({ x: boneWorlds[k * 2], y: boneWorlds[k * 2 + 1] });
      } else {
        const b = st.bones.find((x) => x.id === id)!;
        world.push({ x: b.x, y: b.y });   // fallback：local x/y
      }
      if (boneMatrices && k * 6 + 5 < boneMatrices.length) {
        for (let m2 = 0; m2 < 6; m2++) mats.push(boneMatrices[k * 6 + m2]);
      }
    }
    if (bones.length === 0) {
      // 没有任何有效骨 → 解绑
      st.pushHistory();
      set((s) => {
        const m = s.attachmentMeshes[attachmentId];
        if (!m) return s;
        const { bones: _, weights: __, bindPose: ___, boneBindWorld: ____, boneBindMatrices: _____, ...rest } = m;
        return { attachmentMeshes: { ...s.attachmentMeshes, [attachmentId]: rest } };
      });
      return;
    }
    // 就近主控 + 距离反比衰减（与「重置→保留权重」共用同一算法）
    const weights = computeAutoWeights(world, mesh.vertices);
    const bindPose = bindPoseVertices ? bindPoseVertices.slice() : mesh.vertices.slice();
    // ★ 记下绑定时每个骨骼的 world 坐标位置（去重后顺序）。
    //   world 数组在去重时已按 bones 顺序填好（优先用调用方传入的 boneWorlds，否则 local fallback）。
    const boneBindWorld: number[] = new Array(bones.length * 2);
    for (let i = 0; i < bones.length; i++) {
      boneBindWorld[i * 2] = world[i].x;
      boneBindWorld[i * 2 + 1] = world[i].y;
    }
    // ★ 完整绑定矩阵：传入则存（供 LBS 蒙皮）；缺省时用单位矩阵 + 平移作为近似
    const boneBindMatrices: number[] = mats.length === bones.length * 6
      ? mats
      : (() => {
          const out: number[] = [];
          for (let i = 0; i < bones.length; i++) {
            out.push(1, 0, 0, 1, world[i].x, world[i].y);
          }
          return out;
        })();
    st.pushHistory();
    set((s) => {
      const m = s.attachmentMeshes[attachmentId];
      if (!m) return s;
      return {
        attachmentMeshes: {
          ...s.attachmentMeshes,
          [attachmentId]: { ...m, bones, weights, bindPose, boneBindWorld, boneBindMatrices },
        },
        // ★ 绑定后把权重视图的「当前网格」切到这里，面板立即列出刚绑的骨骼
        weightMeshId: attachmentId,
      };
    });
  },
  unbindBoneFromMesh: (attachmentId, boneId) => {
    const st = get();
    const mesh = st.attachmentMeshes[attachmentId];
    if (!mesh || !mesh.bones) return;
    const idx = mesh.bones.indexOf(boneId);
    if (idx < 0) return;
    st.pushHistory();
    set((s) => {
      const m = s.attachmentMeshes[attachmentId];
      if (!m || !m.bones || !m.weights || !m.bindPose) return s;
      const nb = m.bones.length;
      const vertCount = m.vertices.length / 2;
      const newBones = m.bones.filter((_, i) => i !== idx);
      if (newBones.length === 0) {
        // 全部解绑 → 回到无权重状态
        const { bones: _b, weights: _w, bindPose: _bp, boneBindWorld: _bbw, boneBindMatrices: _bbm, ...rest } = m;
        return { attachmentMeshes: { ...s.attachmentMeshes, [attachmentId]: rest } };
      }
      const newWeights = new Array(vertCount * newBones.length).fill(0);
      const newBoneBindWorld: number[] = [];
      const newBoneBindMatrices: number[] = [];
      for (let i = 0; i < nb; i++) {
        if (i === idx) continue;
        newBoneBindWorld.push(m.boneBindWorld?.[i * 2] ?? 0);
        newBoneBindWorld.push(m.boneBindWorld?.[i * 2 + 1] ?? 0);
        for (let k = 0; k < 6; k++) {
          newBoneBindMatrices.push(m.boneBindMatrices?.[i * 6 + k] ?? (k === 0 || k === 3 ? 1 : 0));
        }
      }
      for (let v = 0; v < vertCount; v++) {
        const oldRow = v * nb;
        const newRow = v * newBones.length;
        let ni = 0;
        for (let i = 0; i < nb; i++) {
          if (i === idx) continue;
          newWeights[newRow + ni] = m.weights[oldRow + i];
          ni++;
        }
        // 归一化：剩余骨权重和应为 1；若被解绑的是主控则重新归一
        let sum = 0;
        for (let i = 0; i < newBones.length; i++) sum += newWeights[newRow + i];
        if (sum > 0 && Math.abs(sum - 1) > 0.001) {
          for (let i = 0; i < newBones.length; i++) newWeights[newRow + i] /= sum;
        } else if (sum === 0) {
          newWeights[newRow + 0] = 1;
        }
      }
      return {
        attachmentMeshes: {
          ...s.attachmentMeshes,
          [attachmentId]: { ...m, bones: newBones, weights: newWeights, boneBindWorld: newBoneBindWorld, boneBindMatrices: newBoneBindMatrices },
        },
      };
    });
  },
  weightBindMode: false,
  toggleWeightBindMode: () => set((s) => ({ weightBindMode: !s.weightBindMode })),
  /** 「自动」按钮：按 mesh.bones 表里已有的骨，重算一次权重（vertices 不变）。
   *  用于：绑定后调过顶点、想重新分配权重时。 */
  recomputeMeshWeights: (attachmentId) => {
    const st = get();
    const mesh = st.attachmentMeshes[attachmentId];
    if (!mesh || !mesh.bones || mesh.bones.length === 0) return;
    // 用 bindPose 算最近（顶点 = bindPose 才是绑定时的姿态距离）
    const bindSource: number[] = mesh.bindPose ?? mesh.vertices;
    // 复用 bindBonesToMesh 的算法：把 vertices 临时换成 bindSource 算完再换回
    const prevVerts = mesh.vertices.slice();
    set((s) => {
      const m = s.attachmentMeshes[attachmentId];
      if (!m) return s;
      return { attachmentMeshes: { ...s.attachmentMeshes, [attachmentId]: { ...m, vertices: bindSource } } };
    });
    st.bindBonesToMesh(attachmentId, mesh.bones, mesh.bindPose, mesh.boneBindWorld, mesh.boneBindMatrices);
    // 还原 vertices 到原值（bindBones 之后 mesh.vertices 是 bindSource 的副本）
    set((s) => {
      const m = s.attachmentMeshes[attachmentId];
      if (!m) return s;
      return { attachmentMeshes: { ...s.attachmentMeshes, [attachmentId]: { ...m, vertices: prevVerts } } };
    });
  },
  setVertexWeights: (attachmentId, boneId, vertexIndices, value) => {
    const st = get();
    const mesh = st.attachmentMeshes[attachmentId];
    if (!mesh || !mesh.bones || !mesh.weights || mesh.bones.length === 0) return;
    const idx = mesh.bones.indexOf(boneId);
    if (idx < 0) return;
    const nb = mesh.bones.length;
    const vertCount = mesh.vertices.length / 2;
    const v = Math.min(1, Math.max(0, value));
    const weights = mesh.weights.slice();
    let changed = false;
    for (const vi of vertexIndices) {
      if (vi < 0 || vi >= vertCount) continue;
      const row = vi * nb;
      if (nb === 1) { weights[row] = 1; changed = true; continue; }
      // 其它骨骼当前总和；>0 → 按比例缩放到 (1-v)，否则（全是 0）剩余均分
      let otherSum = 0;
      for (let i = 0; i < nb; i++) if (i !== idx) otherSum += weights[row + i];
      if (otherSum > 0) {
        const scale = (1 - v) / otherSum;
        for (let i = 0; i < nb; i++) weights[row + i] = i === idx ? v : weights[row + i] * scale;
      } else {
        const rem = (1 - v) / (nb - 1);
        for (let i = 0; i < nb; i++) weights[row + i] = i === idx ? v : rem;
      }
      changed = true;
    }
    if (!changed) return;
    set((s) => {
      const m = s.attachmentMeshes[attachmentId];
      if (!m) return s;
      return { attachmentMeshes: { ...s.attachmentMeshes, [attachmentId]: { ...m, weights } } };
    });
  },
  freezeMesh: (slotId, attachmentId) => set((state) => {
    const mesh = state.attachmentMeshes[attachmentId];
    if (!mesh) return state;
    const lt = state.slotTransforms[slotId];
    const n = Math.floor(mesh.vertices.length / 2);
    if (!lt || n === 0) return state;
    // 顶点质心作为旋转/缩放中心
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      cx += mesh.vertices[i * 2];
      cy += mesh.vertices[i * 2 + 1];
    }
    cx /= n;
    cy /= n;
    const cos = Math.cos(lt.rotation);
    const sin = Math.sin(lt.rotation);
    const vertices = mesh.vertices.slice();
    for (let i = 0; i < n; i++) {
      const dx = (mesh.vertices[i * 2] - cx) * lt.scaleX;
      const dy = (mesh.vertices[i * 2 + 1] - cy) * lt.scaleY;
      vertices[i * 2] = cx + cos * dx - sin * dy;
      vertices[i * 2 + 1] = cy + sin * dx + cos * dy;
    }
    return {
      attachmentMeshes: { ...state.attachmentMeshes, [attachmentId]: { ...mesh, vertices } },
      slotTransforms: {
        ...state.slotTransforms,
        [slotId]: { ...lt, rotation: 0, scaleX: 1, scaleY: 1 },
      },
    };
  }),
  // 网格编辑态 / 工具 / 显示开关
  meshEditSlotId: null,
  setMeshEditSlot: (slotId) => set({ meshEditSlotId: slotId, meshSelectedVertices: [] }),
  meshTool: 'modify',
  setMeshTool: (t) => set({ meshTool: t }),
  meshSelectedVertices: [],
  setMeshSelectedVertices: (idx) => set({ meshSelectedVertices: idx }),
  meshShowTriangles: true,
  setMeshShowTriangles: (v) => set({ meshShowTriangles: v }),
  meshDeformed: true,   // 默认勾选（对齐 Spine）：编辑时也套用网格（裁切预览）；取消勾选 = 显示完整原图
  setMeshDeformed: (v) => set({ meshDeformed: v }),
  meshDim: false,
  setMeshDim: (v) => set({ meshDim: v }),
  meshIsolate: false,
  setMeshIsolate: (v) => set({ meshIsolate: v }),
  meshSoftSelect: false,
  setMeshSoftSelect: (v) => set({ meshSoftSelect: v }),
  meshSoftSize: 40,
  setMeshSoftSize: (v) => set({ meshSoftSize: v }),
  meshSoftFeather: 0.5,
  setMeshSoftFeather: (v) => set({ meshSoftFeather: v }),
  meshSoftHull: true,
  setMeshSoftHull: (v) => set({ meshSoftHull: v }),
  // 权重工具 UI 状态（默认值对齐 Spine 面板初始态：饼图开、叠加/已选关）
  weightInfluence: 0.5,
  setWeightInfluence: (v) => set({ weightInfluence: v }),
  weightMode: 'direct',
  setWeightMode: (m) => set({ weightMode: m }),
  weightValue: 1,
  setWeightValue: (v) => set({ weightValue: v }),
  weightPie: true,
  setWeightPie: (v) => set({ weightPie: v }),
  weightOverlay: false,
  setWeightOverlay: (v) => set({ weightOverlay: v }),
  weightSelectedOnly: false,
  setWeightSelectedOnly: (v) => set({ weightSelectedOnly: v }),
  // 权重视图当前作用的网格（选中骨骼时不清空，见接口注释）
  weightMeshId: null,
  setWeightMesh: (attachmentId) => set({ weightMeshId: attachmentId }),
  meshNewPolygon: null,
  setMeshNewPolygon: (pts) => set({ meshNewPolygon: pts }),
  meshWireframe: {},
  setMeshWireframe: (attachmentId, v) => set((state) => ({
    meshWireframe: { ...state.meshWireframe, [attachmentId]: v },
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

  constraints: [],
  selectedConstraintId: null,
  ikPickBoneId: null,
  ikPickChildBoneId: null,
  ikPickTargetBoneId: null,
  addIkConstraint: (boneId, targetBoneId, childBoneId = null, name) => {
    const s = get();
    if (!s.bones.some((b) => b.id === boneId)) return '';
    if (!s.bones.some((b) => b.id === targetBoneId)) return '';
    if (childBoneId && !s.bones.some((b) => b.id === childBoneId)) childBoneId = null;
    const id = genConstraintId();
    s.pushHistory();
    const def: IkConstraintDef = {
      id,
      name: name?.trim() || `IK ${s.constraints.length + 1}`,
      boneId,
      childBoneId: childBoneId ?? null,
      targetBoneId,
      bendDirection: 1,
      mix: 1,
    };
    set((st) => ({ constraints: [...st.constraints, def] }));
    return id;
  },
  startIkPick: (boneId, childBoneId = null) => {
    // 只允许选中的骨骼作为受约束骨；进入拾取模式等待点目标骨
    const s = get();
    if (!s.bones.some((b) => b.id === boneId)) return;
    // ★ Spine 双骨 IK：第二根骨必须是第一根骨的直接子骨。
    //   用户多选顺序可能不对（先点子后点父），自动纠正。
    if (childBoneId) {
      const child = s.bones.find((b) => b.id === childBoneId);
      if (!child) {
        childBoneId = null;
      } else if (child.parentId !== boneId) {
        // 交换：childBoneId 其实是父骨 → 把它当 boneId，原 boneId 当子骨
        const parent = s.bones.find((b) => b.id === boneId);
        if (parent && parent.parentId === childBoneId) {
          [boneId, childBoneId] = [childBoneId, boneId];
        } else {
          childBoneId = null; // 两骨不是父子关系 → 回退单骨 IK
        }
      }
    }
    set({ ikPickBoneId: boneId, ikPickChildBoneId: childBoneId, ikPickTargetBoneId: null });
  },
  cancelIkPick: () => set({ ikPickBoneId: null, ikPickChildBoneId: null, ikPickTargetBoneId: null }),
  setIkPickTarget: (targetBoneId) => {
    const s = get();
    if (!s.ikPickBoneId) return; // 不在拾取模式
    if (!s.bones.some((b) => b.id === targetBoneId)) return;
    if (targetBoneId === s.ikPickBoneId || targetBoneId === s.ikPickChildBoneId) return; // 目标骨不能是受约束骨自己
    set({ ikPickTargetBoneId: targetBoneId });
  },
  // 仿 Spine：点空白画布 → 新建一根「target n」骨（挂在 root 骨下 / 长度 0 = 可拖手柄），设为目标
  createIkTargetBone: (worldX, worldY) => {
    const s = get();
    // target 序号：统计已有以 "target" 开头的骨名 → target 1 / target 2 …
    const n = s.bones.filter((b) => /^target\b/i.test(b.name)).length + 1;
    const id = genBoneId();
    // ★ 引擎骨架只支持一个根骨（parentId === null），多根骨不会被绘制。
    //   目标骨必须挂在现有根骨下（对齐 Spine：层级树里 target 出现在 root 之下）。
    const rootBone = s.bones.find((b) => b.parentId === null);
    const parentId = rootBone ? rootBone.id : null;
    // 把世界坐标 (worldX, worldY) 换算成相对父骨（根骨）的 local 坐标：
    //   local = S⁻¹ · R⁻¹ · (world - rootOrigin)
    let lx = worldX, ly = worldY;
    if (rootBone) {
      const dx = worldX - rootBone.x;
      const dy = worldY - rootBone.y;
      const rot = rootBone.rotation;
      const cosR = Math.cos(-rot), sinR = Math.sin(-rot);
      const rx = dx * cosR - dy * sinR;
      const ry = dx * sinR + dy * cosR;
      lx = rootBone.scaleX !== 0 ? rx / rootBone.scaleX : rx;
      ly = rootBone.scaleY !== 0 ? ry / rootBone.scaleY : ry;
    }
    s.pushHistory();
    set((st) => ({
      bones: [
        ...st.bones,
        {
          id,
          name: `target ${n}`,
          parentId,
          x: lx, y: ly,
          rotation: 0, scaleX: 1, scaleY: 1,
          length: 0,               // 长度 0 → 画布上只是一个可拖动的小手柄
          slotId: null,
        },
      ],
      // 选中新目标骨，便于画布拖动 / 层级树高亮
      selectedBoneId: id,
      selectedBoneIds: [id],
      ikPickTargetBoneId: id,
    }));
    return id;
  },
  removeConstraint: (id) => {
    const s = get();
    if (!s.constraints.some((c) => c.id === id)) return;
    s.pushHistory();
    set((st) => ({ constraints: st.constraints.filter((c) => c.id !== id) }));
  },
  renameConstraint: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    get().pushHistory();
    set((st) => ({
      constraints: st.constraints.map((c) => (c.id === id ? { ...c, name: trimmed } : c)),
    }));
  },
  /**
   * 重命名一根骨骼。空字符串忽略；与现有同名也忽略。
   * 推入撤销栈（pushHistory），便于 Cmd+Z。
   */
  renameBone: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const s = get();
    const b = s.bones.find((x) => x.id === id);
    if (!b || b.name === trimmed) return;
    s.pushHistory();
    set((st) => ({
      bones: st.bones.map((x) => (x.id === id ? { ...x, name: trimmed } : x)),
    }));
  },
  /**
   * 重命名一个插槽。空字符串忽略；同名忽略。
   * 已入撤销栈（HistorySnapshot 已含 slots）。
   */
  renameSlot: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const s = get();
    const sl = s.slots.find((x) => x.id === id);
    if (!sl || sl.name === trimmed) return;
    s.pushHistory();
    set((st) => ({
      slots: st.slots.map((x) => (x.id === id ? { ...x, name: trimmed } : x)),
    }));
  },
  /**
   * 重命名一个素材附件（PixiBonesLayer）。空字符串忽略；同名忽略。
   * 已入撤销栈（HistorySnapshot 已含 images）。
   */
  renameAttachment: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const s = get();
    const a = s.images.find((x) => x.id === id);
    if (!a || a.name === trimmed) return;
    s.pushHistory();
    set((st) => ({
      images: st.images.map((x) => (x.id === id ? { ...x, name: trimmed } : x)),
    }));
  },
  setConstraintTarget: (id, targetBoneId) => {
    const s = get();
    const c = s.constraints.find((x) => x.id === id);
    if (!c || c.targetBoneId === targetBoneId) return;
    if (!s.bones.some((b) => b.id === targetBoneId)) return;
    s.pushHistory();
    set((st) => ({
      constraints: st.constraints.map((x) => (x.id === id ? { ...x, targetBoneId } : x)),
    }));
  },
  setConstraintMix: (id, mix) => {
    const m = Math.max(0, Math.min(1, mix));
    get().pushHistory();
    set((st) => ({
      constraints: st.constraints.map((x) => (x.id === id ? { ...x, mix: m } : x)),
    }));
  },
  setConstraintBendDirection: (id, dir) => {
    get().pushHistory();
    set((st) => ({
      constraints: st.constraints.map((x) => (x.id === id ? { ...x, bendDirection: dir } : x)),
    }));
  },
  moveConstraint: (id, toIndex) => {
    const s = get();
    const from = s.constraints.findIndex((c) => c.id === id);
    if (from < 0) return;
    const list = s.constraints.slice();
    const [item] = list.splice(from, 1);
    const idx = Math.max(0, Math.min(list.length, toIndex));
    list.splice(idx, 0, item);
    s.pushHistory();
    set({ constraints: list });
  },

  showLeftPanel: false,
  showRightPanel: false,  // 默认隐藏层级树，用户从 View 菜单手动开启
  showRulers: true,

  // 视图菜单 11 项默认值（false=关闭）
  viewWeights:     false, toggleViewWeights:     () => set((s) => {
    const on = !s.viewWeights;
    return { viewWeights: on, ...(on && !s.viewDockOrder.includes('weights') ? { viewDockOrder: [...s.viewDockOrder, 'weights'] } : {}) };
  }),
  viewSkin:        false, toggleViewSkin:        () => set((s) => ({ viewSkin:       !s.viewSkin })),
  viewGridTool:    false, toggleViewGridTool:    () => set((s) => {
    const on = !s.viewGridTool;
    // 首次打开时登记停靠顺序（越早出现的越靠右）
    return { viewGridTool: on, ...(on && !s.viewDockOrder.includes('grid_tool') ? { viewDockOrder: [...s.viewDockOrder, 'grid_tool'] } : {}) };
  }),
  setViewGridTool: (v) => set((s) => (s.viewGridTool === v ? s : {
    viewGridTool: v,
    viewDockOrder: v && !s.viewDockOrder.includes('grid_tool') ? [...s.viewDockOrder, 'grid_tool'] : s.viewDockOrder,
  })),
  setViewWeights: (v: boolean) => set((s) => (s.viewWeights === v ? s : {
    viewWeights: v,
    viewDockOrder: v && !s.viewDockOrder.includes('weights') ? [...s.viewDockOrder, 'weights'] : s.viewDockOrder,
  })),
  viewColor:       false, toggleViewColor:       () => set((s) => ({ viewColor:      !s.viewColor })),
  viewAnimation:   false, toggleViewAnimation:   () => set((s) => ({ viewAnimation:  !s.viewAnimation })),
  viewHierarchy:   false, toggleViewHierarchy:   () => set((s) => {
    const on = !s.viewHierarchy;
    return { viewHierarchy: on, ...(on && !s.viewDockOrder.includes('hierarchy') ? { viewDockOrder: [...s.viewDockOrder, 'hierarchy'] } : {}) };
  }),
  viewIndicators:  false, toggleViewIndicators:  () => set((s) => ({ viewIndicators: !s.viewIndicators })),
  viewOutline:     false, toggleViewOutline:     () => set((s) => ({ viewOutline:    !s.viewOutline })),
  viewIssues:      false, toggleViewIssues:      () => set((s) => ({ viewIssues:     !s.viewIssues })),
  viewPreview:     false, toggleViewPreview:     () => set((s) => ({ viewPreview:    !s.viewPreview })),
  viewAllHidden:   false, setViewAllHidden:      (v) => set({ viewAllHidden: v }),
  lastOpenedDockOrder: [],
  viewDockOrder: [],
  dockPanelWidths: { ...DOCK_PANEL_DEFAULT_WIDTH },
  setDockPanelWidth: (key, w) => set((s) => ({ dockPanelWidths: { ...s.dockPanelWidths, [key]: w } })),
  fitRequestId: 0,
  traceRequestId: 0,
  requestTrace: () => set((s) => ({ traceRequestId: s.traceRequestId + 1 })),
  // 描绘对话框（默认参数对齐 Spine Trace 截图：细节 20 / 凹度 50 / 精致度 50 /
  //   统一 0.3 / Alpha 阈值 8 / 填充 0）
  traceDialogOpen: false,
  traceDetail: 20,
  traceConcavity: 50,
  traceRefinement: 50,
  traceMerge: 0.3,
  traceAlphaThreshold: 8,
  tracePadding: 0,
  traceVertexCount: 0,
  traceRestoreRequestId: 0,
  setTraceDialogOpen: (v) => set({ traceDialogOpen: v }),
  setTraceDetail: (v) => set({ traceDetail: v }),
  setTraceConcavity: (v) => set({ traceConcavity: v }),
  setTraceRefinement: (v) => set({ traceRefinement: v }),
  setTraceMerge: (v) => set({ traceMerge: v }),
  setTraceAlphaThreshold: (v) => set({ traceAlphaThreshold: v }),
  setTracePadding: (v) => set({ tracePadding: v }),
  setTraceVertexCount: (v) => set({ traceVertexCount: v }),
  // 描绘弹窗「实时预览」：on 时每次 trace* 变化都自动把描绘结果写进网格；
  //   点「确定」时最后一次结果入历史；点「取消」时从快照恢复并关预览。
  traceLivePreview: false,
  traceSnapshot: null,
  openTraceDialog: (layerId, currentMesh) => set((s) => ({
    traceDialogOpen: true,
    traceLivePreview: true,
    traceSnapshot: { layerId, mesh: currentMesh },
  })),
  /** 「确定」：用最近一次参数再跑一次（这次入历史） + 关闭预览 + 关弹窗 */
  applyTraceWithDialogSettings: () => set((s) => ({
    traceDialogOpen: false,
    traceLivePreview: false,
    traceSnapshot: null,
    traceRequestId: s.traceRequestId + 1,
  })),
  /** 「取消」：触发 snapshot 恢复（BoneEditor 订阅 traceRestoreRequestId 后用 traceSnapshot 把网格还原）。
   *  注意：traceSnapshot 留给订阅者读，订阅者恢复完自己清；这里只关弹窗 + 关预览 + 推恢复请求。 */
  cancelTraceWithDialogSettings: () => set((s) => ({
    traceDialogOpen: false,
    traceLivePreview: false,
    traceRestoreRequestId: s.traceRestoreRequestId + 1,
  })),
  /** 订阅者完成 snapshot 恢复后调用，清掉快照（避免后续误用） */
  clearTraceSnapshot: () => set({ traceSnapshot: null }),
  editorMode: 'idle',
    transformSpace: 'local',
    activeTool: 'rotate',
    prevActiveTool: null,
    currentTool: 'rotate',
    prevTool: null,
  viewport: { panX: 0, panY: 0, zoom: 1 },
  render: { x: 0, y: 0, scale: 1 },
  /** 图层 → 骨骼 的绑定表：key = slotId。语义见 SlotBinding 注释。 */
  slotBindings: {},

  locale: 'zh',
  setLocale: (l) => set({ locale: l }),

  editorTab: 'setup',
  // 进入 / 离开动画 tab：
  //   - 进入：捕获当前 bones 为「设置姿态」（动画未覆盖属性的缺省值），确保存在动画，随后采样应用
  //   - 离开：恢复设置姿态（骨骼回到进入动画 tab 前的样子，动画数据保留）
  setEditorTab: (t) => {
    const s = get();
    if (t === s.editorTab) return set({ editorTab: t });
    if (t === 'animate') {
      const setup: Record<string, BonePose> = {};
      for (const b of s.bones) {
        setup[b.id] = { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY };
      }
      let animations = s.animations;
      if (animations.length === 0) {
        animations = [{ id: genAnimId(), name: 'Animation', duration: 1, tracks: [] }];
      } else {
        // ★ 兜底：老工程 idb 里可能存了 duration<=0 的动画，修正为 1s 让时间轴有内容
        animations = animations.map((a) => a.duration > 0 ? a : { ...a, duration: 1 });
      }
      const activeAnimationId = s.activeAnimationId && animations.some((a) => a.id === s.activeAnimationId)
        ? s.activeAnimationId
        : animations[0].id;
      set({
        editorTab: 'animate',
        setupPose: setup,
        animations,
        activeAnimationId,
        playing: false,
      });
      get().applyActiveAnimation();
    } else {
      const st = get();
      const setup = st.setupPose;
      const bones = st.bones.map((n) => {
        const sp = setup[n.id];
        return sp ? { ...n, x: sp.x, y: sp.y, rotation: sp.rotation, scaleX: sp.scaleX, scaleY: sp.scaleY } : n;
      });
      // 离开动画 tab：清空约束 mix 运行时值（IK 回到设置姿态的 mix）
      set({ editorTab: 'setup', bones, playing: false, constraintRuntimeMix: {} });
    }
  },

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
        // ★ 新工程自动建一个默认动画（duration=1s），保证时间轴有内容可见
        animations: [{ id: genAnimId(), name: 'Animation', duration: 1, tracks: [] }],
        activeAnimationId: null,  // setEditorTab 切到 animate 时会选中
      }));
    }
  },
  /**
   * 新建项目：清空当前工程**全部**数据，重置为一个全新工程（只有一个 root 骨 + 一个默认动画）。
   * 与 openProject 的区别：openProject 只在 bones 为空时建 root（从欢迎页进入用），
   * 而 newProject 无条件清空当前工程（编辑器里「主菜单 → 新建项目」用）。
   */
  newProject: (name) => {
    const trimmed = name.trim() || 'untitled';
    const id = `proj-${Date.now().toString(36)}`;
    const rootId = genBoneId();
    // 重置所有工程数据 + 清掉各种编辑中/拾取中的临时态
    set({
      currentProjectId: id,
      projectName: trimmed,
      // —— 素材 / 插槽 / 绑定 ——
      psd: null,
      images: [],
      slots: [],
      slotVisibility: {},
      slotTransforms: {},
      slotStyle: {},
      attachmentStyle: {},
      attachmentMeshes: {},
      slotOrder: [],
      slotBindings: {},
      // —— 骨骼 ——
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
      // —— 动画 ——
      animations: [{ id: genAnimId(), name: 'Animation', duration: 1, tracks: [] }],
      activeAnimationId: null,
      setupPose: {},
      constraintRuntimeMix: {},
      currentTime: 0,
      playing: false,
      // —— IK 约束 ——
      constraints: [],
      selectedConstraintId: null,
      // —— 各种选中态清零 ——
      selectedSlotId: null,
      selectedSlotIds: [],
      selectedAttachmentId: null,
      selectedRowKey: null,
      selectedSectionKey: null,
      // —— 编辑中 / 拾取中的临时态一律清零 ——
      meshEditSlotId: null,
      meshSelectedVertices: [],
      meshNewPolygon: null,
      meshWireframe: {},
      attachingSlotId: null,
      ikPickBoneId: null,
      ikPickChildBoneId: null,
      ikPickTargetBoneId: null,
      weightBindMode: false,
      weightMeshId: null,
      traceDialogOpen: false,
      traceLivePreview: false,
      traceSnapshot: null,
      // —— 撤销栈清空（新项目是新起点，不允许撤销回旧工程）——
      historyPast: [],
      historyFuture: [],
      // —— 最小化标记清空（每次加载项目时面板全部还原）——
      hierarchyRestorePending: false,
      gridRestorePending: false,
      weightsRestorePending: false,
      viewGridToolMinimized: false,
      viewWeightsMinimized: false,
      lastOpenedDockOrder: [],
      viewAllHidden: false,
      prevActiveTool: null,
    });
    // id 计数器对齐（新项目只有 1 根骨 / 1 个动画，无插槽）
    syncIdCounters(
      [rootId],
      [],
      [get().animations[0]?.id].filter((x): x is string => !!x),
    );
    _constraintIdCounter = 0;
    get().pushRecentProject(id, trimmed);
  },
  closeProject:     () => set({ currentProjectId: null, selectedBoneId: null, selectedBoneIds: [] }),
  /**
   * 载入一份已保存的工程：一次性覆盖全部工程态，并清掉撤销栈与各种"编辑中"临时状态。
   * 同时把 id 自增计数器推到已载入 id 之后，避免之后新建骨骼/插槽与旧 id 撞号。
   */
  applyProjectData: (d) => {
    set({
      psd: d.psd,
      images: d.images,
      slots: d.slots,
      slotVisibility: d.slotVisibility,
      slotTransforms: d.slotTransforms,
      slotStyle: d.slotStyle,
      attachmentStyle: d.attachmentStyle,
      attachmentMeshes: d.attachmentMeshes,
      slotOrder: d.slotOrder,
      slotBindings: d.slotBindings,
      bones: d.bones.map(normalizeBone),
      selectedBoneId: d.selectedBoneId,
      selectedBoneIds: d.selectedBoneIds,
      projectName: d.projectName,
      ...(d.editorTab ? { editorTab: d.editorTab } : {}),
      // 动画数据（旧存档缺省为空）
      animations: d.animations ?? [],
      activeAnimationId: d.activeAnimationId ?? null,
      setupPose: d.setupPose ?? {},
      // IK 约束（旧存档缺省为空）
      constraints: d.constraints ?? [],
      constraintRuntimeMix: {},
      currentTime: 0,
      playing: false,
      loop: true,
      fps: 30,
      keyframeLock: true,
      // 临时态一律清零（编辑网格 / 描绘 / 拾取 / 权重绑定 / 各种选中）
      meshEditSlotId: null,
      meshSelectedVertices: [],
      meshNewPolygon: null,
      attachingSlotId: null,
      ikPickBoneId: null,
      ikPickChildBoneId: null,
      ikPickTargetBoneId: null,
      weightBindMode: false,
      weightMeshId: null,
      traceDialogOpen: false,
      traceLivePreview: false,
      traceSnapshot: null,
      selectedSlotId: null,
      selectedSlotIds: [],
      selectedAttachmentId: null,
      selectedRowKey: null,
      selectedSectionKey: null,
      // 撤销栈清空（载入是新起点，不允许撤回到"另一个工程"的状态）
      historyPast: [],
      historyFuture: [],
    });
    // id 计数器对齐（bone_ / slot_ / anim_ 前缀）
    syncIdCounters(
      d.bones.map((b) => b.id),
      d.slots.map((s) => s.id),
      (d.animations ?? []).map((a) => a.id),
    );
    // 约束 id 计数器对齐（ik_ 前缀）
    _constraintIdCounter = Math.max(
      _constraintIdCounter,
      Math.max(0, ...(d.constraints ?? []).map((c) => {
        if (!c.id.startsWith('ik_')) return 0;
        const n = parseInt(c.id.slice(3), 10);
        return Number.isFinite(n) ? n : 0;
      })),
    );
    // 载入时若停在动画 tab，按当前时间（0）采样一次，画面与动画一致
    if (get().editorTab === 'animate' && get().animations.length > 0) {
      get().applyActiveAnimation();
    }
    // 视口延后一拍恢复：BoneEditor 在 psd 变化时会用微任务把视口重置为默认，
    // 我们的微任务排在它后面（同一同步块里更晚入队）→ 不会被覆盖。
    if (d.viewport) {
      const vp = d.viewport;
      queueMicrotask(() => set({ viewport: vp }));
    }
  },
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

  // ===== Undo / Redo（快照 bones + slotTransforms + selectedBoneId + 素材/插槽）=====
  historyPast:  [],
  historyFuture: [],
  pushHistory: () => {
    const s = get();
    // 深拷贝当前快照（素材 canvas 保留同一引用 —— 内容创建后不变，只还原数组结构）
    const snap = makeSnapshot(s);
    const past = [...s.historyPast, snap].slice(-50);  // 最多 50 步
    set({ historyPast: past, historyFuture: [] });
  },
  undo: () => {
    const s = get();
    if (s.historyPast.length === 0) return;
    const past = [...s.historyPast];
    const prev = past.pop()!;
    // 当前状态推到 future
    const currentSnap = makeSnapshot(s);
    const future = [currentSnap, ...s.historyFuture];
    set({
      historyPast: past,
      historyFuture: future,
      ...snapshotToState(prev),
    });
    // 撤销后若在动画 tab，按当前时间重新采样骨骼（保证画面与动画一致）
    if (get().editorTab === 'animate') get().applyActiveAnimation();
  },
  redo: () => {
    const s = get();
    if (s.historyFuture.length === 0) return;
    const [next, ...rest] = s.historyFuture;
    // 当前状态推到 past
    const currentSnap = makeSnapshot(s);
    const past = [...s.historyPast, currentSnap];
    set({
      historyPast: past,
      historyFuture: rest,
      ...snapshotToState(next),
    });
    if (get().editorTab === 'animate') get().applyActiveAnimation();
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
  setCurrentTime: (t) => set({ currentTime: t }),
  setPlaying: (p) => set({ playing: p }),
  setSelectedBoneName: (n) => set({ selectedBoneName: n }),

  // ===== 动画（仿 Spine 动画 tab） =====
  setActiveAnimation: (id) => set(() => ({ activeAnimationId: id, playing: false })),
  addAnimation: (name) => {
    const s = get();
    const id = genAnimId();
    s.pushHistory();
    const anim: EditorAnimation = {
      id,
      name: name?.trim() || `Animation ${s.animations.length + 1}`,
      duration: 1,
      tracks: [],
    };
    set((st) => ({ animations: [...st.animations, anim], activeAnimationId: id, playing: false }));
    return id;
  },
  duplicateAnimation: (id) => {
    const s = get();
    const src = s.animations.find((a) => a.id === id);
    if (!src) return id;
    const newId = genAnimId();
    s.pushHistory();
    set((st) => {
      const copy: EditorAnimation = {
        ...src,
        id: newId,
        name: `${src.name} copy`,
        tracks: src.tracks.map((tr) => ({ ...tr, keys: tr.keys.map((k) => ({ ...k })) })),
      };
      return { animations: [...st.animations, copy], activeAnimationId: newId, playing: false };
    });
    return newId;
  },
  renameAnimation: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    get().pushHistory();
    set((st) => ({
      animations: st.animations.map((a) => (a.id === id ? { ...a, name: trimmed } : a)),
    }));
  },
  removeAnimation: (id) => {
    const s = get();
    if (s.animations.length <= 1) return;   // 至少保留一个动画
    s.pushHistory();
    set((st) => {
      const animations = st.animations.filter((a) => a.id !== id);
      const activeAnimationId = st.activeAnimationId === id ? (animations[0]?.id ?? null) : st.activeAnimationId;
      return { animations, activeAnimationId, playing: false };
    });
  },
  setAnimationDuration: (id, duration) => {
    const d = Math.max(0.01, duration);
    get().pushHistory();
    set((st) => ({
      animations: st.animations.map((a) => (a.id === id ? { ...a, duration: d } : a)),
    }));
  },
  seekTo: (t) => {
    const s = get();
    const anim = s.animations.find((a) => a.id === s.activeAnimationId);
    const dur = anim?.duration ?? 0;
    const ct = dur > 0 ? Math.min(dur, Math.max(0, t)) : Math.max(0, t);
    if (s.editorTab === 'animate' && anim && dur > 0) {
      // ★ 合并为一次 set：currentTime + bones + constraintRuntimeMix 一起写。
      //   原来 set(currentTime) + applyActiveAnimation→set(bones) 触发**两次** subscribe
      //   （播放时每帧 2 次全量重画）。现在只触发一次。
      const next = sampleAnimationPose(anim, s.setupPose, s.bones, ct);
      const mixes = sampleConstraintMixes(anim, ct);
      set({
        currentTime: ct,
        ...(next ? { bones: next } : {}),
        ...(Object.keys(mixes).length > 0 ? { constraintRuntimeMix: mixes } : {}),
      });
    } else {
      set({ currentTime: ct });
    }
  },
  stepFrame: (dir) => {
    const s = get();
    const anim = s.animations.find((a) => a.id === s.activeAnimationId);
    const dur = anim?.duration ?? 0;
    const dt = 1 / (s.fps || 30);
    let t = s.currentTime + dir * dt;
    if (dur > 0) t = Math.min(dur, Math.max(0, t));
    s.seekTo(t);
  },
  togglePlay: () => {
    const s = get();
    const anim = s.animations.find((a) => a.id === s.activeAnimationId);
    if (!anim || anim.duration <= 0) return;
    if (!s.playing && s.currentTime >= anim.duration - 1e-6) s.seekTo(0);
    set({ playing: !s.playing });
  },
  setLoop: (v) => set({ loop: v }),
  toggleKeyframeLock: () => set((s) => ({ keyframeLock: !s.keyframeLock })),
  setKeyframe: (boneId, property, time, value) => {
    const s = get();
    const anim = s.animations.find((a) => a.id === s.activeAnimationId);
    if (!anim) return;
    s.pushHistory();
    const t = Math.max(0, time);
    const tracks = upsertTrackKey(anim.tracks, boneId, property, t, value);
    // ★ 合并采样进同一次 set（避免 applyActiveAnimation 二次 set → 二次 subscribe）
    const withAnim = { ...anim, tracks };
    set((st) => ({
      animations: st.animations.map((a) => (a.id === anim.id ? withAnim : a)),
      ...buildAnimPatch(s, withAnim),
    }));
  },
  removeKeyframe: (boneId, property, time) => {
    const s = get();
    const anim = s.animations.find((a) => a.id === s.activeAnimationId);
    if (!anim) return;
    const tr = anim.tracks.find((x) => x.boneId === boneId && x.property === property);
    if (!tr || !tr.keys.some((k) => Math.abs(k.time - time) < 1e-6)) return;
    s.pushHistory();
    const tracks = anim.tracks
      .map((x) => {
        if (x.boneId !== boneId || x.property !== property) return x;
        const keys = x.keys.filter((k) => Math.abs(k.time - time) >= 1e-6);
        return { ...x, keys };
      })
      .filter((x) => x.keys.length > 0);
    const withAnim = { ...anim, tracks };
    set((st) => ({
      animations: st.animations.map((a) => (a.id === anim.id ? withAnim : a)),
      ...buildAnimPatch(s, withAnim),
    }));
  },
  moveKeyframe: (boneId, property, fromTime, toTime) => {
    const s = get();
    const anim = s.animations.find((a) => a.id === s.activeAnimationId);
    if (!anim) return;
    s.pushHistory();
    const t = Math.max(0, toTime);
    const value = keyValueAt(anim, boneId, property, fromTime);
    // 判断是否为约束 mix 轨道（移动后要保留 constraintMix 标记）
    const isConstraintTrack = anim.tracks.some((x) => x.boneId === boneId && x.property === property && x.constraintMix);
    // 先从原处移除
    let tracks = anim.tracks
      .map((x) => {
        if (x.boneId !== boneId || x.property !== property) return x;
        const keys = x.keys.filter((k) => Math.abs(k.time - fromTime) >= 1e-6);
        return { ...x, keys };
      })
      .filter((x) => x.keys.length > 0);
    tracks = upsertTrackKey(tracks, boneId, property, t, value);
    if (isConstraintTrack) {
      tracks = tracks.map((tr) => (tr.boneId === boneId && tr.property === property ? { ...tr, constraintMix: true } : tr));
    }
    const withAnim = { ...anim, tracks };
    set((st) => ({
      animations: st.animations.map((a) => (a.id === anim.id ? withAnim : a)),
      ...buildAnimPatch(s, withAnim),
    }));
  },
  recordBoneEdits: (boneId, props) => {
    const s = get();
    if (s.editorTab !== 'animate' || !s.keyframeLock) return;
    const bone = s.bones.find((b) => b.id === boneId);
    const anim = s.animations.find((a) => a.id === s.activeAnimationId);
    if (!bone || !anim) return;
    const t = s.currentTime;
    s.pushHistory();
    let tracks = anim.tracks.map((tr) => ({ ...tr, keys: tr.keys.map((k) => ({ ...k })) }));
    for (const p of props) {
      tracks = upsertTrackKey(tracks, boneId, p, t, bone[p]);
    }
    const withAnim = { ...anim, tracks };
    set((st) => ({
      animations: st.animations.map((a) => (a.id === anim.id ? withAnim : a)),
      ...buildAnimPatch(s, withAnim),
    }));
  },
  applyActiveAnimation: () => {
    const s = get();
    if (s.editorTab !== 'animate') return;
    const anim = s.animations.find((a) => a.id === s.activeAnimationId);
    if (!anim) return;
    // ★ 合并 bones + constraintRuntimeMix 进同一次 set（避免二次 subscribe）
    const patch = buildAnimPatch(s, anim);
    if (Object.keys(patch).length > 0) set(patch);
  },
  setConstraintMixKeyframe: (constraintId, time, value) => {
    const s = get();
    const anim = s.animations.find((a) => a.id === s.activeAnimationId);
    if (!anim) return;
    s.pushHistory();
    const t = Math.max(0, time);
    // 复用 upsertTrackKey：constraintMix 轨道 boneId = 约束 id，property = 'mix'
    const tracks = upsertTrackKey(anim.tracks, constraintId, 'mix' as AnimProperty, t, value)
      .map((tr) => (tr.boneId === constraintId && tr.property === 'mix' ? { ...tr, constraintMix: true } : tr));
    const withAnim = { ...anim, tracks };
    set((st) => ({
      animations: st.animations.map((a) => (a.id === anim.id ? withAnim : a)),
      ...buildAnimPatch(s, withAnim),
    }));
  },
  removeConstraintMixKeyframe: (constraintId, time) => {
    const s = get();
    const anim = s.animations.find((a) => a.id === s.activeAnimationId);
    if (!anim) return;
    s.pushHistory();
    const tracks = anim.tracks
      .map((x) => {
        if (x.boneId !== constraintId || x.property !== 'mix' || !x.constraintMix) return x;
        const keys = x.keys.filter((k) => Math.abs(k.time - time) >= 1e-6);
        return { ...x, keys };
      })
      .filter((x) => x.keys.length > 0);
    const withAnim = { ...anim, tracks };
    set((st) => ({
      animations: st.animations.map((a) => (a.id === anim.id ? withAnim : a)),
      ...buildAnimPatch(s, withAnim),
    }));
  },

  // Day 2 setters
  setPsd: (p) => {
    // 切 / 导入 PSD 时骨全清，但必须重建一根根骨骼：
    //   - 没有根骨时「创建模式」找不到父骨骼，会导致新建子骨骼直接失败
    const rootId = p ? genBoneId() : null;
    // ★ 为每个可渲染图层建一个同名插槽（1 图层 = 1 插槽）
    const slots = p ? slotsFromAttachments(flattenLayers(p)) : [];
    // ★ 仿 Spine：导入的每个插槽自动绑定到根骨（root 是层级最高的，
    //   拖动 root 时整幅图跟着走；之后可再绑定到具体骨骼覆盖）。
    //   ref = 绑定时 root 的世界矩阵（此刻 root 在 (0,0) → 单位矩阵）
    const slotBindings: Record<string, SlotBinding> = {};
    if (p && rootId) {
      for (const sl of slots) {
        slotBindings[sl.id] = { boneId: rootId, ref: [1, 0, 0, 1, 0, 0] };
      }
    }
    set({
      psd: p,
      slots,
      slotVisibility: {},
      slotTransforms: {},
      slotStyle: {},
      attachmentStyle: {},
      attachmentMeshes: {},
      weightMeshId: null,   // 新 PSD：权重视图的当前网格清空
      meshEditSlotId: null,
      meshSelectedVertices: [],
      meshWireframe: {},
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
      slotBindings,
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
  // 删除插槽（有附件也允许删除：附件素材是全局共享的，删插槽只移除容器与引用，素材保留）
  removeSlot: (slotId) => {
    get().pushHistory();
    set((state) => {
      const slot = state.slots.find((s) => s.id === slotId);
      if (!slot) return state;
      // 若选中的附件属于该插槽，一并清掉选中（素材本身保留）
      const attSelected = state.selectedAttachmentId !== null
        && slot.attachmentIds.includes(state.selectedAttachmentId);
      const omit = <T,>(rec: Record<string, T>) => {
        const next = { ...rec };
        delete next[slotId];
        return next;
      };
      return {
        slots: state.slots.filter((s) => s.id !== slotId),
        selectedSlotId: state.selectedSlotId === slotId ? null : state.selectedSlotId,
        selectedSlotIds: state.selectedSlotIds.filter((id) => id !== slotId),
        selectedAttachmentId: attSelected ? null : state.selectedAttachmentId,
        selectedRowKey: state.selectedRowKey === 'slot:' + slotId ? null : state.selectedRowKey,
        slotVisibility: omit(state.slotVisibility),
        slotStyle: omit(state.slotStyle),
        slotBindings: omit(state.slotBindings),
        slotTransforms: omit(state.slotTransforms),
        slotOrder: state.slotOrder.filter((id) => id !== slotId),
      };
    });
  },
  duplicateSlot: (slotId) => {
    get().pushHistory();
    set((state) => {
      const slot = state.slots.find((s) => s.id === slotId);
      if (!slot) return state;
      const id = genSlotId();
      const copy: PixiBonesSlot = {
        id,
        name: slot.name + ' Copy',
        attachmentIds: [...slot.attachmentIds],
        activeAttachmentId: slot.activeAttachmentId,
      };
      // 插入到原插槽下方（平级）—— slots 数组顺序即层级树顺序
      const idx = state.slots.findIndex((s) => s.id === slotId);
      const slots = [...state.slots];
      slots.splice(idx + 1, 0, copy);
      // 复制关联的可见性 / 样式 / 绑定 / 变换 / 绘制顺序
      const cp = <T,>(rec: Record<string, T>): Record<string, T> =>
        slotId in rec ? { ...rec, [id]: rec[slotId] } : rec;
      const slotOrder = [...state.slotOrder];
      const orderIdx = slotOrder.indexOf(slotId);
      if (orderIdx >= 0) slotOrder.splice(orderIdx + 1, 0, id);
      return {
        slots,
        slotVisibility: cp(state.slotVisibility),
        slotStyle: cp(state.slotStyle),
        slotBindings: cp(state.slotBindings),
        slotTransforms: cp(state.slotTransforms),
        slotOrder,
        // 选中新插槽
        selectedSlotId: id,
        selectedSlotIds: [id],
        selectedAttachmentId: null,
        selectedRowKey: 'slot:' + id,
        selectedBoneId: null,
        selectedSectionKey: null,
        attachingSlotId: null,
      };
    });
  },
  // 单独导入的图片素材（PNG/JPG）：追加到 images，并建一个同名插槽
  addImage: (layer) =>
    set((state) => {
      const slot: PixiBonesSlot = {
        id: genSlotId(),
        name: layer.name,
        attachmentIds: [layer.id],
        activeAttachmentId: layer.id,
      };
      // ★ 仿 Spine：新插槽自动绑定到根骨（root 是层级最高的，拖动 root 时新图跟着走）。
      //   ref 用恒等矩阵 → 绑定即「吸附」到 root 当前位置（图像 = root 世界 × 图像局部），
      //   否则 root 已在非原点时 ref 会含 root 位移，导致图像不跟 root（留在原地）。
      const rootBone = state.bones.find((b) => b.parentId === null) ?? null;
      const newBinding = rootBone
        ? { [slot.id]: { boneId: rootBone.id, ref: [1, 0, 0, 1, 0, 0] } as SlotBinding }
        : {};
      return {
        images: [...state.images, layer],
        slots: [...state.slots, slot],
        slotVisibility: { ...state.slotVisibility, [slot.id]: true },
        slotBindings: { ...state.slotBindings, ...newBinding },
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
      // ★ 删除素材：从**所有**引用它的插槽里解除引用（插槽本身保留，不删）。
      //   附件是全局素材，删除它只影响引用关系。
      const slots = state.slots.map((s) => {
        if (!s.attachmentIds.includes(id)) return s;
        const attachmentIds = s.attachmentIds.filter((a) => a !== id);
        const activeAttachmentId = s.activeAttachmentId && attachmentIds.includes(s.activeAttachmentId)
          ? s.activeAttachmentId
          : (attachmentIds[0] ?? null);
        return { ...s, attachmentIds, activeAttachmentId };
      });
      const attSelected = state.selectedAttachmentId === id;
      // 附件级样式 / 网格：删掉该附件的记录
      const nextAttachmentStyle = { ...state.attachmentStyle };
      delete nextAttachmentStyle[id];
      const nextMeshes = { ...state.attachmentMeshes };
      delete nextMeshes[id];
      const nextWire = { ...state.meshWireframe };
      delete nextWire[id];
      return {
        images: state.images.filter((l) => l.id !== id),
        slots,
        selectedAttachmentId: attSelected ? null : state.selectedAttachmentId,
        selectedRowKey: attSelected ? null : state.selectedRowKey,
        attachmentStyle: nextAttachmentStyle,
        attachmentMeshes: nextMeshes,
        meshWireframe: nextWire,
        ...(state.weightMeshId === id ? { weightMeshId: null } : {}),
        meshEditSlotId: state.meshEditSlotId && state.meshEditSlotId === state.selectedSlotId && attSelected
          ? null
          : state.meshEditSlotId,
      };
    }),
  // 插槽显隐（key = slotId）
  toggleSlotVisibility: (slotId) =>
    set((state) => ({
      slotVisibility: { ...state.slotVisibility, [slotId]: !(state.slotVisibility[slotId] ?? true) },
    })),
  selectSlot: (id, rowKey) => set((s) => {
    const slot = id ? s.slots.find((x) => x.id === id) ?? null : null;
    const attId = slot?.activeAttachmentId ?? null;
    return {
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
    // ★ 权重视图：把「当前网格」切到这个插槽的激活附件（选骨骼时不会被清）
    ...(attId ? { weightMeshId: attId } : {}),
    // ★ 仿 Spine：姿势模式下在层级树选中插槽/图片 → 自动切到「旋转」工具。
    //   变换工具与 mode 卡互斥，因此同时退出 pose（editorMode = 'idle'）。
    ...(id && s.editorMode === 'pose'
      ? { activeTool: 'rotate' as const, editorMode: 'idle' as const }
      : {}),
    };
  }),
  // 选中一个附件（层级树附件行 / 点小圆点切当前）：同时选中它所属插槽
  selectAttachment: (slotId, attachmentId, rowKey) => set((s) => ({
    selectedSlotId: slotId,
    selectedSlotIds: slotId ? [slotId] : [],
    selectedAttachmentId: attachmentId,
    selectedRowKey: rowKey
      ?? (slotId ? 'slotatt:' + slotId + ':' + attachmentId : 'asset:' + attachmentId),
    selectedBoneId: null,
    selectedBoneIds: [],
    selectedSectionKey: null,
    attachingSlotId: null,
    // ★ 权重视图：当前网格 = 刚选中的附件
    weightMeshId: attachmentId,
    // 与 selectSlot 一致：pose 模式下切到旋转工具
    ...(s.editorMode === 'pose'
      ? { activeTool: 'rotate' as const, editorMode: 'idle' as const }
      : {}),
  })),
  // 多选素材：additive=true 增量追加，false 替换
  selectSlots: (ids, additive = false) => set((s) => {
    const next = additive ? Array.from(new Set([...s.selectedSlotIds, ...ids])) : ids;
    // 单选时把权重当前网格同步过去
    const onlySlot = next.length === 1 ? s.slots.find((x) => x.id === next[0]) ?? null : null;
    const onlyAtt = onlySlot?.activeAttachmentId ?? null;
    return {
      selectedSlotIds: next,
      selectedSlotId: next[0] ?? null,
      selectedAttachmentId: null,
      selectedRowKey: next[0] ? 'slot:' + next[0] : null,
      selectedBoneId: null,
      selectedBoneIds: [],
      selectedSectionKey: null,
      attachingSlotId: null,
      ...(onlyAtt ? { weightMeshId: onlyAtt } : {}),
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
    selectedConstraintId: null,
    attachingSlotId: null,
  }),
  selectConstraint: (id) => {
    const s = get();
    if (!s.constraints.some((c) => c.id === id)) return;
    set({
      selectedConstraintId: id,
      selectedSectionKey: 'constraints',
      selectedBoneId: null,
      selectedBoneIds: [],
      selectedSlotId: null,
      selectedSlotIds: [],
      selectedAttachmentId: null,
      selectedRowKey: null,
      attachingSlotId: null,
    });
  },
  // ★ 层级树顶部「动画」节点（当前动画名）被选中：高亮该行，同时清空骨骼/素材/分区选中
  selectAnimationNode: () => set({
    selectedRowKey: 'animation',
    selectedBoneId: null,
    selectedBoneIds: [],
    selectedSlotId: null,
    selectedSlotIds: [],
    selectedAttachmentId: null,
    selectedSectionKey: null,
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
setTool: (t) => set((s) => {
  // ★ 7 个工具的统一切换（对齐 Spine：右键在最近两个工具之间来回切换）
  //   - 切到不同的工具：把当前工具记为 prevTool
  //   - 切到相同工具：no-op，不更新 prevTool（保持"上一工具"稳定）
  const cur = currentToolOf(s.editorMode, s.activeTool);
  const prev = t === cur ? s.prevTool : cur;
  // 按工具类型分别设置 editorMode / activeTool
  const isMode = t === 'pose' || t === 'weights' || t === 'create';
  return {
    currentTool: t,
    prevTool: prev,
    editorMode: (isMode ? t : 'idle') as 'pose' | 'weights' | 'create' | 'idle',
    activeTool: (isMode ? null : t) as 'rotate' | 'move' | 'scale' | 'shear' | null,
    // ★ 进入 pose 或激活变换工具时：清空图层选中（避免高亮残留）
    ...((t === 'pose' || !isMode)
      ? { selectedSlotId: null, selectedSlotIds: [], selectedAttachmentId: null, selectedRowKey: null }
      : {}),
  };
}),
setEditorMode: (m) => set((s) => {
  const cur = currentToolOf(s.editorMode, s.activeTool);
  const prev = m === cur ? s.prevTool : cur;
  return {
    editorMode: m,
    activeTool: null,
    currentTool: m as EditorTool,
    prevTool: prev,
    // ★ 姿势模式下画布上的图层不可选：进入 pose 时清空图层选中（避免高亮残留）
    ...(m === 'pose'
      ? { selectedSlotId: null, selectedSlotIds: [], selectedAttachmentId: null, selectedRowKey: null }
      : {}),
  };
}),
setActiveTool: (t) => set((s) => {
  // ★ 维护"上一个工具"：仅当切换到不同的 transform tool 时记录，
  //   这样右键空白处可以回退到前一个。
  //   - 从 A 切到 B（A≠null）：把 A 记为 prev
  //   - 从 B 切到 null：保留 prev 不变（再按右键还能回到 B）
  //   - 切到相同的工具：no-op，不更新 prev
  let prev = s.prevActiveTool;
  if (t !== null && t !== s.activeTool && s.activeTool !== null) {
    prev = s.activeTool;
  }
  const cur = currentToolOf(s.editorMode, s.activeTool);
  const nextTool: EditorTool = t ?? 'pose';
  return {
    activeTool: t,
    prevActiveTool: prev,
    currentTool: nextTool,
    prevTool: t === cur ? s.prevTool : cur,
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
  };
}),
  setTransformSpace: (s) => set({ transformSpace: s }),
  setViewport: (v) => set({ viewport: v }),
  setRender: (r) => set({ render: r }),

  // Day 3 setters
  addBone: (parentId, partial = {}) => {
    get().pushHistory();
    set((state) => {
      const newBone: BoneNode = normalizeBone({
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
        color: partial.color,
        shearX: partial.shearX ?? 0,
        shearY: partial.shearY ?? 0,
        inheritRotation: partial.inheritRotation ?? true,
        inheritScale: partial.inheritScale ?? true,
        inheritReflection: partial.inheritReflection ?? true,
        showName: partial.showName ?? false,
        selectable: partial.selectable ?? true,
      });
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
      // 一并删除：整棵子树骨骼 + 绑定在这些骨骼上的插槽
      const toRemove = collectDescendants(state.bones, id);
      const removedSlots = new Set<string>();
      for (const [slotId, b] of Object.entries(state.slotBindings)) {
        if (toRemove.has(b.boneId)) removedSlots.add(slotId);
      }
      const removedSel = state.selectedBoneId && toRemove.has(state.selectedBoneId);
      const slotRemovedSel = state.selectedSlotId !== null && removedSlots.has(state.selectedSlotId);
      const omit = <T,>(rec: Record<string, T>) => {
        const next = { ...rec };
        for (const sid of removedSlots) delete next[sid];
        return next;
      };
      return {
        bones: state.bones.filter((n) => !toRemove.has(n.id)),
        selectedBoneId: removedSel ? null : state.selectedBoneId,
        selectedBoneIds: removedSel ? [] : state.selectedBoneIds.filter((bid) => !toRemove.has(bid)),
        slots: state.slots.filter((s) => !removedSlots.has(s.id)),
        selectedSlotId: slotRemovedSel ? null : state.selectedSlotId,
        selectedSlotIds: slotRemovedSel ? [] : state.selectedSlotIds.filter((sid) => !removedSlots.has(sid)),
        selectedAttachmentId: slotRemovedSel ? null : state.selectedAttachmentId,
        selectedRowKey: slotRemovedSel ? null : state.selectedRowKey,
        slotBindings: omit(state.slotBindings),
        slotVisibility: omit(state.slotVisibility),
        slotStyle: omit(state.slotStyle),
        slotTransforms: omit(state.slotTransforms),
        slotOrder: state.slotOrder.filter((sid) => !removedSlots.has(sid)),
      };
    });
  },

  duplicateBone: (id) => {
    get().pushHistory();
    set((state) => {
      const src = state.bones.find((n) => n.id === id);
      if (!src) return state;
      // ★ 复制整棵子树（含所有子骨骼），绑定在这些骨骼上的插槽也一并复制
      const subTree = [...collectDescendants(state.bones, id)];
      // 按 bones 数组顺序排序（插入位置要保持原相对顺序）
      const orderIdx = new Map(state.bones.map((n, i) => [n.id, i]));
      subTree.sort((a, b) => (orderIdx.get(a) ?? 0) - (orderIdx.get(b) ?? 0));
      const idMap = new Map<string, string>();
      for (const oid of subTree) idMap.set(oid, genBoneId());

      const copies: BoneNode[] = subTree.map((oid) => {
        const n = state.bones.find((x) => x.id === oid)!;
        return normalizeBone({
          id: idMap.get(oid)!,
          name: oid === id ? n.name + ' Copy' : n.name,
          parentId: n.parentId ? (idMap.get(n.parentId) ?? n.parentId) : null,
          x: n.x, y: n.y,
          rotation: n.rotation,
          scaleX: n.scaleX, scaleY: n.scaleY,
          length: n.length,
          slotId: n.slotId,
          color: n.color,
          shearX: n.shearX, shearY: n.shearY,
          inheritRotation: n.inheritRotation,
          inheritScale: n.inheritScale,
          inheritReflection: n.inheritReflection,
          showName: n.showName,
          selectable: n.selectable,
        });
      });

      // 插入到原骨骼**下方**（平级）—— bones 数组顺序 = 层级树同级顺序
      const idx = state.bones.findIndex((n) => n.id === id);
      const bones = [...state.bones];
      bones.splice(idx + 1, 0, ...copies);

      // 复制绑定在这些骨骼上的插槽（引用同一批附件，绑定到对应新骨骼）
      const slots = [...state.slots];
      const slotOrder = [...state.slotOrder];
      const slotVisibility = { ...state.slotVisibility };
      const slotStyle = { ...state.slotStyle };
      const slotTransforms = { ...state.slotTransforms };
      const slotBindings = { ...state.slotBindings };
      for (const [slotId, b] of Object.entries(state.slotBindings)) {
        const newBoneId = idMap.get(b.boneId);
        if (!newBoneId) continue; // 不是子树里的骨骼
        const s = state.slots.find((x) => x.id === slotId);
        if (!s) continue;
        const nid = genSlotId();
        slots.splice(slots.findIndex((x) => x.id === slotId) + 1, 0, {
          ...s,
          id: nid,
          name: s.name + ' Copy',
          attachmentIds: [...s.attachmentIds],
        });
        slotBindings[nid] = { boneId: newBoneId, ref: [...b.ref] };
        if (slotVisibility[slotId] !== undefined) slotVisibility[nid] = slotVisibility[slotId];
        if (slotStyle[slotId]) slotStyle[nid] = { ...slotStyle[slotId] };
        if (slotTransforms[slotId]) slotTransforms[nid] = { ...slotTransforms[slotId] };
        const oi = slotOrder.indexOf(slotId);
        if (oi >= 0) slotOrder.splice(oi + 1, 0, nid);
      }

      return {
        bones,
        slots,
        slotBindings,
        slotVisibility,
        slotStyle,
        slotTransforms,
        slotOrder,
        selectedBoneId: idMap.get(id)!,
        selectedBoneIds: [idMap.get(id)!],
        selectedSlotId: null,
        selectedSlotIds: [],
        selectedAttachmentId: null,
        selectedRowKey: null,
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

  setBoneColor: (id, color) => {
    get().pushHistory();
    set((state) => ({
      bones: state.bones.map((n) => (n.id === id ? { ...n, color } : n)),
    }));
  },

  setBoneShear: (id, shearX, shearY) => {
    get().pushHistory();
    set((state) => ({
      bones: state.bones.map((n) => (n.id === id ? { ...n, shearX, shearY } : n)),
    }));
  },

  setBoneInherit: (id, prop, on) => {
    get().pushHistory();
    set((state) => ({
      bones: state.bones.map((n) => {
        if (n.id !== id) return n;
        if (prop === 'rotation') return { ...n, inheritRotation: on };
        if (prop === 'scale') return { ...n, inheritScale: on };
        return { ...n, inheritReflection: on };
      }),
    }));
  },

  setBoneShowName: (id, on) => {
    get().pushHistory();
    set((state) => ({
      bones: state.bones.map((n) => (n.id === id ? { ...n, showName: on } : n)),
    }));
  },

  setBoneSelectable: (id, on) => {
    get().pushHistory();
    set((state) => ({
      bones: state.bones.map((n) => (n.id === id ? { ...n, selectable: on } : n)),
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

  setHierarchyRestorePending: (v) => set({ hierarchyRestorePending: v }),
  setGridRestorePending: (v) => set({ gridRestorePending: v }),
  setWeightsRestorePending: (v) => set({ weightsRestorePending: v }),
  setViewGridToolMinimized: (v) => set({ viewGridToolMinimized: v }),
  setViewWeightsMinimized: (v) => set({ viewWeightsMinimized: v }),
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
