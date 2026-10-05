import { create } from 'zustand';
import type { Skeleton } from '@engine/Skeleton';
import type { Animation } from '@engine/Animation';
import type { PixiBonesPsd, PixiBonesLayer } from '@psd/types';

export type ViewMode = 'editor' | 'demo';

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

export interface PixiBonesState {
  // ---- Day 1 残留字段（Demo 用自己的 skeleton，这里保留兼容）----
  skeleton: Skeleton | null;
  animations: Animation[];
  currentTime: number;
  playing: boolean;
  selectedBoneName: string | null;

  // ---- Day 2 ----
  psd: PixiBonesPsd | null;
  layerVisibility: Record<string, boolean>;
  selectedLayerId: string | null;
  viewMode: ViewMode;

  // ---- Day 3 ----
  bones: BoneNode[];
  selectedBoneId: string | null;

  // ---- UI state ----
  showLeftPanel: boolean;
  showRightPanel: boolean;
  editorMode: 'pose' | 'weights' | 'create';
  transformSpace: 'local' | 'world';
  viewport: { panX: number; panY: number; zoom: number };
  /** BoneEditor 的实际渲染原点/缩放，用于标尺换算（世界 0,0 在屏幕的哪里） */
  render: { x: number; y: number; scale: number };

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
  setEditorMode: (m: 'pose' | 'weights' | 'create') => void;
  setTransformSpace: (s: 'local' | 'world') => void;
  setViewport: (v: { panX: number; panY: number; zoom: number }) => void;
  setRender: (r: { x: number; y: number; scale: number }) => void;

  addBone: (parentId: string | null, partial?: Partial<BoneNode>) => void;
  removeBone: (id: string) => void;
  moveBone: (id: string, x: number, y: number) => void;
  setBoneRotation: (id: string, rotation: number) => void;
  setBoneLength: (id: string, length: number) => void;
  setBoneParent: (id: string, parentId: string | null) => void;
  selectBone: (id: string | null) => void;
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

export const usePixiBonesStore = create<PixiBonesState>((set) => ({
  skeleton: null,
  animations: [],
  currentTime: 0,
  playing: true,
  selectedBoneName: null,

  psd: null,
  layerVisibility: {},
  selectedLayerId: null,
  viewMode: 'editor',

  bones: [],
  selectedBoneId: null,

  showLeftPanel: false,
  showRightPanel: false,
  editorMode: 'pose',
  transformSpace: 'local',
  viewport: { panX: 0, panY: 0, zoom: 1 },
  render: { x: 0, y: 0, scale: 1 },

  // Day 1 setters
  setSkeleton: (s) => set({ skeleton: s }),
  addAnimation: (a) => set((state) => ({ animations: [...state.animations, a] })),
  setCurrentTime: (t) => set({ currentTime: t }),
  setPlaying: (p) => set({ playing: p }),
  setSelectedBoneName: (n) => set({ selectedBoneName: n }),

  // Day 2 setters
  setPsd: (p) =>
    set({
      psd: p,
      layerVisibility: {},
      selectedLayerId: null,
      bones: [],          // 切 PSD 时骨全清
      selectedBoneId: null,
    }),
  toggleLayerVisibility: (id) =>
    set((state) => {
      const cur = state.layerVisibility[id];
      const psdLayer = findLayer(state.psd, id);
      const effective = cur ?? psdLayer?.visible ?? true;
      return { layerVisibility: { ...state.layerVisibility, [id]: !effective } };
    }),
  selectLayer: (id) => set({ selectedLayerId: id, selectedBoneId: null }),
  setViewMode: (m) => set({ viewMode: m }),

  toggleLeftPanel: () => set((s) => ({ showLeftPanel: !s.showLeftPanel })),
  toggleRightPanel: () => set((s) => ({ showRightPanel: !s.showRightPanel })),
  setEditorMode: (m) => set({ editorMode: m }),
  setTransformSpace: (s) => set({ transformSpace: s }),
  setViewport: (v) => set({ viewport: v }),
  setRender: (r) => set({ render: r }),

  // Day 3 setters
  addBone: (parentId, partial = {}) =>
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
      };
    }),

  removeBone: (id) =>
    set((state) => {
      const toRemove = collectDescendants(state.bones, id);
      return {
        bones: state.bones.filter((n) => !toRemove.has(n.id)),
        selectedBoneId: toRemove.has(state.selectedBoneId ?? '') ? null : state.selectedBoneId,
      };
    }),

  moveBone: (id, x, y) =>
    set((state) => ({
      bones: state.bones.map((n) => (n.id === id ? { ...n, x, y } : n)),
    })),

  setBoneRotation: (id, rotation) =>
    set((state) => ({
      bones: state.bones.map((n) => (n.id === id ? { ...n, rotation } : n)),
    })),

  setBoneLength: (id, length) =>
    set((state) => ({
      bones: state.bones.map((n) => (n.id === id ? { ...n, length: Math.max(1, length) } : n)),
    })),

  setBoneParent: (id, parentId) =>
    set((state) => {
      if (!isValidParent(state.bones, id, parentId)) return state;
      return {
        bones: state.bones.map((n) => (n.id === id ? { ...n, parentId } : n)),
      };
    }),

  selectBone: (id) => set({ selectedBoneId: id, selectedLayerId: null }),
}));

// 兼容：导出供 store 外的消费者复用
export { findBone, collectDescendants };
