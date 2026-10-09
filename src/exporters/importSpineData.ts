/**
 * 「导入数据」：把 psd2spine 风格的简化 Spine JSON + 散落 PNG 一并吃进来，
 * 重建出 store 里的 bones / slots / images / slotBindings。
 *
 * ─── 约定的输入 JSON 格式（与 psd2spine 输出兼容）───
 * {
 *   "skeleton":  { "images": "/Users/xxx/Downloads/images/" },   // 仅供参考：图片目录路径
 *   "PhotoshopToSpine": { "scale": 1, "padding": 1, "trim": true },
 *   "bones":   [ { "name": "root" }, ... ],
 *   "slots":   [ { "name": "下半身", "bone": "root", "attachment": "下半身" }, ... ],
 *   "skins":   {
 *     "default": {
 *       "<slotName>": {
 *         "<attachmentName>": { "x": 81.5, "y": 647, "width": 1241, "height": 1296 }
 *       }
 *     }
 *   },
 *   "animations": { "animation": { ... } }
 * }
 *
 * 约定：
 *   - JSON 里的 attachment key === PNG 文件名（不含扩展名）
 *   - slot.attachment = slot.attachmentName = slotName 通常三同一
 *   - bones 只有 name（无 parent / x / y / length），按出现顺序构造一棵树
 *     （没有引用父级时 → 第一个作为根，剩余作为同一层子骨）
 *   - 所有 slot 初始绑定到 root
 */
import type { PixiBonesLayer, PixiBonesSlot } from '@psd/types';
import type { BoneNode, SlotBinding, EditorAnimation, AnimProperty, AnimTrack, AnimKeyframe, ProjectData } from '../editor/store';
import { parseImageFile } from '@psd/parseImage';

// =================================================================================
//  JSON 结构（只声明我们关心的字段）
// =================================================================================

/** 单附件的位置 + 尺寸（atlas 风格），坐标以 PNG 左下角为原点。 */
export interface SpineAttachment {
  x: number;
  y: number;
  width: number;
  height: number;
  /** psd2spine 可能输出 type/rotate 等扩展字段，先放着不解析。 */
  [k: string]: unknown;
}

/** psd2spine 风格的顶层 JSON 形状（只声明用到的字段，其余宽容忽略）。 */
export interface SpineJson {
  skeleton?: { images?: string; [k: string]: unknown };
  bones?: Array<{ name: string; parent?: string; x?: number; y?: number; length?: number; rotation?: number }>;
  slots?: Array<{ name: string; bone: string; attachment: string }>;
  skins?: Record<string, Record<string, Record<string, SpineAttachment>>>;
  animations?: Record<string, SpineAnimationTrack>;
}

export type SpineAnimationTrack = {
  /** 各骨轨道（键 = 骨名）。 */
  bones?: Record<string, Record<string, SpineKeyframe[]>>;
  /** 各插槽轨道（暂不解析）。 */
  slots?: Record<string, unknown>;
  /** 各附件轨道（暂不解析）。 */
  attachments?: Record<string, unknown>;
  /** 事件 / drawOrder / ik 等其它字段（暂不解析）。 */
  [k: string]: unknown;
};

/** 单关键帧：Spine 用 time（秒）/ value，curve 可选（贝塞尔，暂不解析）。 */
export interface SpineKeyframe {
  time: number;
  value: number | string;
  curve?: unknown;
}

// =================================================================================
//  解析入口
// =================================================================================

/**
 * 把 PNG 文件按「文件 basename（去扩展名）」建立索引，方便按 attachment key 查找。
 * 不区分大小写。
 */
function buildPngIndex(files: File[]): Map<string, File> {
  const idx = new Map<string, File>();
  for (const f of files) {
    const m = f.name.match(/^(.+?)\.[^.]+$/);
    if (!m) continue;
    const key = m[1].trim();
    if (!idx.has(key)) idx.set(key, f);  // 重复名 → 留先到的
    idx.set(key.toLowerCase(), f);       // 小写副本作 fallback
  }
  return idx;
}

/**
 * 主入口：JSON 文本 + 散落 PNG → 还原成可直接 applyProjectData 的 ProjectData 形状。
 *
 * 匹配策略：
 *   - bones：按 name 复用（缺省全部新建）
 *   - slots：按 name 复用
 *   - attachments：按 PNG basename === attachment key 匹配；找不到的会收集到 missing 里
 */
export async function buildProjectFromSpineJson(
  jsonText: string,
  pngFiles: File[],
  opts: { projectName?: string; reuseExisting?: { bones: BoneNode[]; slots: PixiBonesSlot[] } } = {},
): Promise<{
  data: ProjectData;
  missing: Array<{ slotName: string; attachmentName: string }>;
  warnings: string[];
}> {
  const json = JSON.parse(jsonText) as SpineJson;
  const warnings: string[] = [];
  const missing: Array<{ slotName: string; attachmentName: string }> = [];
  const pngIndex = buildPngIndex(pngFiles);

  // 1) 骨树 ----------------------------------------------------------------
  const boneSrc = json.bones ?? [];
  if (boneSrc.length === 0) {
    warnings.push('JSON 里没有 bones 字段，已自动创建一个 root 骨');
  }
  const existingBones = opts.reuseExisting?.bones ?? [];
  const existingByName = new Map(existingBones.map((b) => [b.name, b]));

  // 按出现顺序建立：第一个作为根（如果显式有 parent=root 引用其它，那条作为子）。
  // 没有 parent 字段时，保留 psd2spine 的「同一层」语义：除第一个外都挂到第一个上。
  const bonesOut: BoneNode[] = [];
  const idByName = new Map<string, string>();  // 重新生成一份「稳定 id」（按 name 派生）
  const rootName = boneSrc[0]?.name ?? 'root';

  let boneCounter = 0;
  const genNewBoneId = () => `bone_imported_${++boneCounter}`;

  for (const b of boneSrc) {
    const existing = existingByName.get(b.name);
    if (existing) {
      // 复用已有骨：id 保持原样，name 维持（用户可能改过）；transform 用 JSON 里的值覆盖
      idByName.set(b.name, existing.id);
      bonesOut.push({
        ...existing,
        x: b.x ?? existing.x,
        y: b.y ?? existing.y,
        rotation: b.rotation ?? existing.rotation,
        length: b.length ?? existing.length,
      });
    } else {
      const newId = genNewBoneId();
      idByName.set(b.name, newId);
      // 父级：JSON 没写 parent 时，第一个为根；其余挂到 rootName
      const parentName = b.parent ?? (b.name === rootName ? null : rootName);
      const parentId = parentName ? idByName.get(parentName) ?? null : null;
      bonesOut.push({
        id: newId,
        name: b.name,
        parentId,
        x: b.x ?? 0,
        y: b.y ?? 0,
        rotation: b.rotation ?? 0,
        scaleX: 1,
        scaleY: 1,
        length: b.length ?? 0,
        slotId: null,
      });
    }
  }
  // JSON 一个骨都没有 → 给个 root
  if (bonesOut.length === 0) {
    const newId = genNewBoneId();
    bonesOut.push({
      id: newId, name: 'root', parentId: null,
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0, slotId: null,
    });
  }

  // 2) 附件 + 插槽 ----------------------------------------------------------
  // 收集 skins.default 里所有 attachment（保留顺序，便于画布绘制顺序：先出现 = 底层）
  const slotSrc = json.slots ?? [];
  const skinDef = json.skins?.default ?? {};

  // 记录已经处理过的 attachment 名称 → 它在 store.images 里的 id
  // （同一 PNG 可能被多个 slot 引用：第一次真正加载，后续复用）
  const attachmentIdByName = new Map<string, string>();
  const imagesOut: PixiBonesLayer[] = [];

  // 把 PNG 文件读成 canvas 的辅助
  const loadPng = async (attName: string): Promise<PixiBonesLayer | null> => {
    if (attachmentIdByName.has(attName)) {
      return imagesOut.find((l) => l.id === attachmentIdByName.get(attName)) ?? null;
    }
    const f = pngIndex.get(attName) ?? pngIndex.get(attName.toLowerCase());
    if (!f) return null;
    const layer = await parseImageFile(f, { x: 0, y: 0 });
    attachmentIdByName.set(attName, layer.id);
    imagesOut.push(layer);
    return layer;
  };

  const slotsOut: PixiBonesSlot[] = [];
  const slotBindings: Record<string, SlotBinding> = {};
  const slotVisibility: Record<string, boolean> = {};

  // 插槽绘制顺序 = slots 数组出现顺序（Spine 行为：先出现 = 底）
  const rootBoneId = bonesOut.find((b) => b.parentId === null)?.id ?? bonesOut[0].id;

  let slotCounter = 0;
  const genNewSlotId = () => `slot_imported_${++slotCounter}`;

  const existingSlots = opts.reuseExisting?.slots ?? [];
  const existingSlotByName = new Map(existingSlots.map((s) => [s.name, s]));

  for (const sl of slotSrc) {
    const attInfo = skinDef[sl.name]?.[sl.attachment];
    if (!attInfo) {
      // skins 里没有这个 slot 的 attachment 描述（极少见）→ 跳过
      warnings.push(`插槽 "${sl.name}" 在 skins.default 中没有对应的 attachment，已跳过`);
      continue;
    }

    // 1. 加载 PNG → attachment（图层）
    const layer = await loadPng(sl.attachment);
    if (!layer) {
      missing.push({ slotName: sl.name, attachmentName: sl.attachment });
      continue;
    }

    // 2. 位置暂存：JSON 里的 x/y 是图片中心，Y 朝上。
    //    我们不直接写到 layer.left/top —— 留到所有 slot 处理完后做：
    //      a) 翻转 Y 轴（JSON Y↑ → PixiJS Y↓）
    //      b) 按整体 bbox 中心平移，使整组居中在画布 (0, 0)
    //    这里只把 JSON 中心点存到 layer.__importedCenter（私有字段，下游清理）。
    const cx = attInfo.x;
    const cy = attInfo.y;
    const w = attInfo.width;
    const h = attInfo.height;
    layer.width = w;
    layer.height = h;
    layer.name = sl.attachment;
    (layer as PixiBonesLayer & { __spineCenter?: { x: number; y: number; w: number; h: number } }).__spineCenter = { x: cx, y: cy, w, h };
    // 重新画 canvas 到新尺寸（如果 JSON 里的 width/height 跟 PNG 实际尺寸不同）
    // —— 仍用 PNG 原图，width/height 只是逻辑尺寸
    // 但 layer.canvas 此时仍是 PNG 原大小，渲染时按 left/top + width/height 截。
    // 这里不重画，保持 canvas 完整。

    // 3. 插槽：复用 or 新建
    const existSlot = existingSlotByName.get(sl.name);
    const slotId = existSlot?.id ?? genNewSlotId();
    if (!existSlot) {
      slotsOut.push({
        id: slotId,
        name: sl.name,
        attachmentIds: [layer.id],
        activeAttachmentId: layer.id,
      });
    } else {
      // 复用：仅当尚未引用这个 attachment 时追加（保持「多插槽可共享同一素材」的语义）
      const already = existSlot.attachmentIds.includes(layer.id);
      slotsOut.push({
        ...existSlot,
        attachmentIds: already ? existSlot.attachmentIds : [...existSlot.attachmentIds, layer.id],
        activeAttachmentId: layer.id,
      });
    }

    // 4. 插槽绑定到 bone（默认 root）
    const boneName = sl.bone;
    const boneId = idByName.get(boneName) ?? rootBoneId;
    // 仿 Spine：ref = 单位矩阵（绑定时 delta = I，图层不动）
    slotBindings[slotId] = { boneId, ref: [1, 0, 0, 1, 0, 0] };
    slotVisibility[slotId] = true;
  }

  // 2.5) 坐标系变换：JSON 中心点 → PixiJS 图层 left/top
  //   与 Spine 行为完全一致 —— 仿 PS 标尺原点 = 世界 (0, 0)：
  //     - JSON 的 (cx, cy) 是图片**中心**在世界里的位置
  //     - PS 标尺原点 (0, 0) 直接对应世界原点，不做"按 bbox 居中"（那是 Spine 行为）
  //     - Y 轴翻转：JSON Y↑ → PixiJS Y↓
  //     - 中心 → 左上角
  //   调整完后从 layer 上删掉 __spineCenter 私有字段
  for (const l of imagesOut) {
    const c = (l as PixiBonesLayer & { __spineCenter?: { x: number; y: number; w: number; h: number } }).__spineCenter;
    if (!c) continue;
    // Y 翻转：JSON Y 朝上 → PixiJS Y 朝下
    const pixiCx = c.x;
    const pixiCy = -c.y;
    // 中心 → 左上角
    l.left = Math.round(pixiCx - c.w / 2);
    l.top = Math.round(pixiCy - c.h / 2);
    delete (l as PixiBonesLayer & { __spineCenter?: unknown }).__spineCenter;
  }

  // 3) 动画 ----------------------------------------------------------------
  // Spine 动画轨道 property 字符串 → 我们的 AnimProperty
  const SPINE_PROP_MAP: Record<string, AnimProperty> = {
    translate: 'x',       // Spine 的 translate 同时带 x/y 两条轨道
    x: 'x',
    y: 'y',
    rotate: 'rotation',   // Spine 用「度」，我们用「度」（store 里 rotation 已经是度）
    rotation: 'rotation',
    scalex: 'scaleX',
    scaley: 'scaleY',
    scale: 'scaleX',      // 'scale' 标量：同时落到 x/y，循环里会处理
  };

  const animationsOut: EditorAnimation[] = [];
  const animSrc = json.animations ?? {};
  let animCounter = 0;
  for (const [animName, anim] of Object.entries(animSrc)) {
    const tracks: AnimTrack[] = [];
    const duration = computeAnimationDuration(anim);

    const boneTracks = anim.bones ?? {};
    for (const [boneName, props] of Object.entries(boneTracks)) {
      const boneId = idByName.get(boneName);
      if (!boneId) {
        warnings.push(`动画 "${animName}" 引用了不存在的骨 "${boneName}"，已忽略`);
        continue;
      }
      for (const [prop, keys] of Object.entries(props)) {
        if (!Array.isArray(keys) || keys.length === 0) continue;
        const lower = prop.toLowerCase();
        if (lower === 'translate') {
          // 期望形如 { "x": [...], "y": [...] }，但 psd2spine 的 translate 通常是单条数组
          // 这里兼容：若 key[0].value 是 number → 当作 y，x 留空
          const k0 = keys[0] as SpineKeyframe;
          if (typeof k0.value === 'number') {
            tracks.push({
              boneId, property: 'y',
              keys: keys.filter((k) => typeof k.value === 'number').map((k) => ({ time: k.time, value: k.value as number })),
            });
          } else if (k0.value && typeof k0.value === 'object') {
            // 可能是 {x: 1, y: 2} 形式（罕见）
            warnings.push(`动画 "${animName}" 的 translate 用了对象形式，未实现`);
          }
          continue;
        }
        if (lower === 'scale') {
          // 'scale' = 标量；同时落到 scaleX 和 scaleY
          const safeKeys = keys
            .filter((k) => typeof k.value === 'number')
            .map((k) => ({ time: k.time, value: k.value as number }));
          tracks.push({ boneId, property: 'scaleX', keys: safeKeys });
          tracks.push({ boneId, property: 'scaleY', keys: safeKeys });
          continue;
        }
        const ap = SPINE_PROP_MAP[lower];
        if (!ap) {
          warnings.push(`动画 "${animName}" 的属性 "${prop}" 未识别，已忽略`);
          continue;
        }
        const safeKeys: AnimKeyframe[] = keys
          .filter((k) => typeof k.value === 'number')
          .map((k) => ({ time: k.time, value: k.value as number }));
        if (safeKeys.length > 0) {
          tracks.push({ boneId, property: ap, keys: safeKeys });
        }
      }
    }

    animationsOut.push({
      id: `anim_imported_${++animCounter}`,
      name: animName,
      duration: Math.max(0.01, duration),
      tracks,
    });
  }

  // 4) 合成 ProjectData ----------------------------------------------------
  const data: ProjectData = {
    psd: null,
    images: imagesOut,
    slots: slotsOut,
    slotVisibility,
    slotTransforms: {},
    slotStyle: {},
    attachmentStyle: {},
    attachmentMeshes: {},
    slotOrder: slotsOut.map((s) => s.id),  // 按出现顺序：先到 = 底
    slotBindings,
    bones: bonesOut,
    selectedBoneId: rootBoneId,
    selectedBoneIds: [rootBoneId],
    projectName: opts.projectName ?? (json.skeleton?.images
      ? json.skeleton.images.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'imported'
      : 'imported'),
    animations: animationsOut,
    activeAnimationId: animationsOut[0]?.id ?? null,
    setupPose: {},
    constraints: [],
    editorTab: animationsOut.length > 0 ? 'animate' : 'setup',
    viewport: { panX: 0, panY: 0, zoom: 1 },
  };

  return { data, missing, warnings };
}

/** 算出动画时长：取所有关键帧 max(time)；无关键帧时默认 1s。 */
function computeAnimationDuration(anim: SpineAnimationTrack): number {
  let max = 0;
  const boneTracks = anim.bones ?? {};
  for (const props of Object.values(boneTracks)) {
    for (const keys of Object.values(props ?? {})) {
      if (!Array.isArray(keys)) continue;
      for (const k of keys) {
        if (typeof k.time === 'number' && k.time > max) max = k.time;
      }
    }
  }
  return max > 0 ? max : 1;
}
