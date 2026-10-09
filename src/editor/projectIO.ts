/**
 * 工程「保存 / 读取」。
 *
 * 存储介质：IndexedDB（见 idb.ts）—— 快照里含图片素材（PNG dataURL），体积大，
 * localStorage 的 5MB 配额不够用。
 *
 * 序列化难点：PixiBonesLayer.canvas 是 HTMLCanvasElement，不能直接 JSON 化，
 * 存的时候转成 PNG dataURL，读的时候再画回 canvas。
 * dataURL 按图层 id 缓存（图层的 canvas 导入后不再变化），避免每次自动保存都重编码。
 */
import { useEffect, useRef } from 'react';
import { usePixiBonesStore, type ProjectData, type BoneNode, type SlotBinding } from './store';
import type { PixiBonesLayer, PixiBonesPsd, PixiBonesSlot, MeshData } from '@psd/types';
import { idbPut, idbGet } from './idb';

const PROJECT_VERSION = 1;
const projectKey = (id: string) => `project:${id}`;

// =================================================================================
//  序列化结构
// =================================================================================

/** 序列化后的图层：canvas → PNG dataURL（null = 该图层无画布）。 */
interface SerializedLayer {
  id: string;
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  blendMode: string;
  canvas: string | null;
  children: SerializedLayer[];
}

interface SerializedProject {
  version: number;
  savedAt: number;
  name: string;
  // PSD（拆成三个字段，便于判断是否存在）
  psdWidth: number;
  psdHeight: number;
  psdLayers: SerializedLayer[];
  hasPsd: boolean;
  images: SerializedLayer[];
  slots: PixiBonesSlot[];
  slotVisibility: Record<string, boolean>;
  slotTransforms: ProjectData['slotTransforms'];
  slotStyle: ProjectData['slotStyle'];
  attachmentStyle: ProjectData['attachmentStyle'];
  attachmentMeshes: Record<string, MeshData>;
  slotOrder: string[];
  slotBindings: Record<string, SlotBinding>;
  bones: BoneNode[];
  selectedBoneId: string | null;
  selectedBoneIds: string[];
  projectName: string;
  editorTab: 'setup' | 'animate';
  viewport: { panX: number; panY: number; zoom: number };
}

// =================================================================================
//  canvas ↔ dataURL
// =================================================================================

/** 图层 id → dataURL 缓存（图层画布内容在导入后不再变化，可安全缓存）。 */
const dataUrlCache = new Map<string, string>();

function canvasToDataUrl(id: string, canvas: HTMLCanvasElement): string {
  const cached = dataUrlCache.get(id);
  if (cached) return cached;
  const url = canvas.toDataURL('image/png');
  dataUrlCache.set(id, url);
  return url;
}

function dataUrlToCanvas(url: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      const ctx = c.getContext('2d');
      if (!ctx) { reject(new Error('无法创建 2D 上下文')); return; }
      ctx.drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = url;
  });
}

function serializeLayer(l: PixiBonesLayer): SerializedLayer {
  return {
    id: l.id,
    name: l.name,
    left: l.left,
    top: l.top,
    width: l.width,
    height: l.height,
    opacity: l.opacity,
    visible: l.visible,
    blendMode: l.blendMode,
    canvas: l.canvas ? canvasToDataUrl(l.id, l.canvas) : null,
    children: l.children.map(serializeLayer),
  };
}

async function deserializeLayer(s: SerializedLayer): Promise<PixiBonesLayer> {
  const canvas = s.canvas ? await dataUrlToCanvas(s.canvas) : undefined;
  const children = await Promise.all(s.children.map(deserializeLayer));
  return {
    id: s.id,
    name: s.name,
    left: s.left,
    top: s.top,
    width: s.width,
    height: s.height,
    opacity: s.opacity,
    visible: s.visible,
    blendMode: s.blendMode,
    canvas,
    children,
  };
}

/** MeshData 的可选字段兜底为数组（和 store 里的 fillMeshDefaults 同义），避免 undefined 丢失。 */
function normalizeMesh(m: MeshData): MeshData {
  return {
    ...m,
    bones: m.bones ?? [],
    weights: m.weights ?? [],
    bindPose: m.bindPose ?? [],
    boneBindWorld: m.boneBindWorld ?? [],
  };
}

// =================================================================================
//  保存 / 读取
// =================================================================================

let _saving = false;

/**
 * 已「另存为」出来、且内存里就是最新数据的工程 id。
 * 切过去时不需要再从 IndexedDB 回读（回读会把选中态等临时状态清掉）。
 */
const skipLoadOnce = new Set<string>();

/** 用当前 store 状态构建一份完整快照。 */
function buildSnapshot(): SerializedProject {
  const s = usePixiBonesStore.getState();
  const psd: PixiBonesPsd | null = s.psd;
  const meshes: Record<string, MeshData> = {};
  for (const [k, m] of Object.entries(s.attachmentMeshes)) meshes[k] = normalizeMesh(m);
  return {
    version: PROJECT_VERSION,
    savedAt: Date.now(),
    name: s.projectName,
    hasPsd: !!psd,
    psdWidth: psd?.width ?? 0,
    psdHeight: psd?.height ?? 0,
    psdLayers: psd ? psd.layers.map(serializeLayer) : [],
    images: s.images.map(serializeLayer),
    slots: s.slots,
    slotVisibility: s.slotVisibility,
    slotTransforms: s.slotTransforms,
    slotStyle: s.slotStyle,
    attachmentStyle: s.attachmentStyle,
    attachmentMeshes: meshes,
    slotOrder: s.slotOrder,
    slotBindings: s.slotBindings,
    bones: s.bones,
    selectedBoneId: s.selectedBoneId,
    selectedBoneIds: s.selectedBoneIds,
    projectName: s.projectName,
    editorTab: s.editorTab,
    viewport: s.viewport,
  };
}

async function writeSnapshot(id: string, snap: SerializedProject): Promise<boolean> {
  try {
    await idbPut(projectKey(id), snap);
    return true;
  } catch (err) {
    console.error('[projectIO] 保存失败', err);
    return false;
  }
}

/** 把当前工程快照写入 IndexedDB（覆盖当前工程 id）。返回是否成功。 */
export async function saveCurrentProject(): Promise<boolean> {
  const id = usePixiBonesStore.getState().currentProjectId;
  if (!id) return false;
  if (_saving) return false;
  _saving = true;
  try {
    return await writeSnapshot(id, buildSnapshot());
  } finally {
    _saving = false;
  }
}

/**
 * 另存为：把当前工程另存到一个**新的工程 id + 新名字**，并切换过去。
 * 原工程保留不动（不会被覆盖）。
 */
export async function saveProjectAs(name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const id = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const snap = buildSnapshot();
  snap.name = trimmed;
  snap.projectName = trimmed;
  const ok = await writeSnapshot(id, snap);
  if (!ok) return false;
  // 新 id 的数据就是内存里这份 → 切换时跳过回读，避免清掉当前选中/编辑态
  skipLoadOnce.add(id);
  const st = usePixiBonesStore.getState();
  usePixiBonesStore.setState({ currentProjectId: id, projectName: trimmed });
  st.pushRecentProject(id, trimmed);
  return true;
}

/** 弹窗让用户输入新工程名，然后另存为。用户取消返回 false。 */
export async function saveProjectAsPrompt(): Promise<boolean> {
  const st = usePixiBonesStore.getState();
  const input = window.prompt('另存为（输入新的工程名）', `${st.projectName} 副本`);
  if (input == null) return false;
  return saveProjectAs(input);
}

/** 读取指定工程的快照并应用到 store。返回是否读到了数据。 */
export async function loadProject(id: string): Promise<boolean> {
  let snap: SerializedProject | null = null;
  try {
    snap = await idbGet<SerializedProject>(projectKey(id));
  } catch (err) {
    console.error('[projectIO] 读取失败', err);
    return false;
  }
  if (!snap) return false;
  if (snap.version !== PROJECT_VERSION) return false;

  try {
    const psd: PixiBonesPsd | null = snap.hasPsd
      ? {
          width: snap.psdWidth,
          height: snap.psdHeight,
          layers: await Promise.all(snap.psdLayers.map(deserializeLayer)),
        }
      : null;
    const images = await Promise.all(snap.images.map(deserializeLayer));
    const meshes: Record<string, MeshData> = {};
    for (const [k, m] of Object.entries(snap.attachmentMeshes)) meshes[k] = normalizeMesh(m);

    const data: ProjectData = {
      psd,
      images,
      slots: snap.slots,
      slotVisibility: snap.slotVisibility,
      slotTransforms: snap.slotTransforms,
      slotStyle: snap.slotStyle,
      attachmentStyle: snap.attachmentStyle,
      attachmentMeshes: meshes,
      slotOrder: snap.slotOrder,
      slotBindings: snap.slotBindings,
      bones: snap.bones,
      selectedBoneId: snap.selectedBoneId,
      selectedBoneIds: snap.selectedBoneIds,
      projectName: snap.projectName,
      editorTab: snap.editorTab,
      viewport: snap.viewport,
    };
    usePixiBonesStore.getState().applyProjectData(data);
    return true;
  } catch (err) {
    console.error('[projectIO] 反序列化失败', err);
    return false;
  }
}

/** 某工程是否已有存档。 */
export async function hasSavedProject(id: string): Promise<boolean> {
  return (await idbGet<unknown>(projectKey(id))) != null;
}

// =================================================================================
//  持久化 Hook：打开工程时自动载入 + 变更防抖自动保存 + 关闭/隐藏前保存
// =================================================================================

const AUTOSAVE_DELAY = 1200;

/**
 * 在编辑器挂载时调用一次：
 *  1. currentProjectId 确定后，尝试从 IndexedDB 载入该工程的存档（没有则保持新建状态）
 *  2. 载入完成后，订阅 store 变化，防抖 1.2s 自动保存
 *  3. beforeunload / 页面隐藏时立即保存（尽力而为）
 */
export function useProjectPersistence(): void {
  const projectId = usePixiBonesStore((s) => s.currentProjectId);
  /** 该工程是否已完成「载入」阶段 —— 载入完成前不做自动保存，避免把空/半载入状态覆盖存档。 */
  const readyRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  // 1) 载入
  useEffect(() => {
    if (!projectId) return;
    // 「另存为」刚写入的新工程：内存里就是最新数据，跳过回读
    if (skipLoadOnce.has(projectId)) {
      skipLoadOnce.delete(projectId);
      readyRef.current = true;
      return;
    }
    let cancelled = false;
    readyRef.current = false;
    (async () => {
      await loadProject(projectId);
      if (!cancelled) readyRef.current = true;
    })();
    return () => { cancelled = true; readyRef.current = false; };
  }, [projectId]);

  // 2) 自动保存
  useEffect(() => {
    if (!projectId) return;
    const schedule = () => {
      if (!readyRef.current) return;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void saveCurrentProject();
      }, AUTOSAVE_DELAY);
    };
    const unsub = usePixiBonesStore.subscribe(schedule);
    const flush = () => {
      if (timerRef.current != null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      void saveCurrentProject();
    };
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      unsub();
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onHidden);
      if (timerRef.current != null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, [projectId]);
}
