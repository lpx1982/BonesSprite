/**
 * 「导出数据」：ProjectData → Spine v3.8 JSON 字符串。
 * 与 importSpineData.ts 互为逆操作，可往返：
 *   - 骨骼 → bones（name / parent / x / y / rotation / scaleX / scaleY / length / shear）
 *   - 插槽 → slots（bone = 绑定骨骼名；attachment = 附件名）+ skins.default（图片附件中心点，Y 翻转）
 *   - 路径附件 → paths（相对柄 → Spine 绝对柄 inX/inY/outX/outY）
 *   - 路径约束 → pathConstraints（target = 路径名；本地 rotationOffset → Spine 侧 offsetRotation）
 *   - 动画 → animations（骨骼 x/y → translate、scaleX/scaleY → scale、rotation → rotate；
 *     pc_ 轨道 → pathConstraints[约束名][position/spacing/rotateMix/translateMix/rotateOffset]；
 *     IK mix 轨道 → ik[约束名]）
 *
 * 命名约定（与导入端一致）：
 *   - 路径名 = 引用它的插槽名（slot.name）
 *   - 图片附件名 = layer.name（导入时层名 = slots[].attachment）
 */
import type { ProjectData, AnimProperty, AnimKeyframe } from '../editor/store';
import { usePixiBonesStore, PC_ANIM_PROP, isPathConstraintAnimProperty } from '../editor/store';
import type { PathVertex } from '@psd/types';

// =================================================================================
//  小工具
// =================================================================================

/** 单个数值关键帧（Spine 3.8 形状）：{ time, <field>: value }，stepped 显式标记。 */
function numFrame(field: string, k: AnimKeyframe): Record<string, unknown> {
  const f: Record<string, unknown> = { time: k.time, [field]: k.value };
  if (k.curve === 'stepped') f.curve = 'stepped';
  return f;
}

/**
 * 把两条同轴轨道（如 x/y、scaleX/scaleY）合并成 Spine 复合轨道（translate / scale）。
 * 合并规则：时间戳取并集；某轴缺帧时沿用「上一个 ≤ t 的值」（轨道缺省 def）。
 * 两轴都无轨道 → 返回 null。
 */
function mergeAxis(
  a: AnimKeyframe[] | undefined,
  b: AnimKeyframe[] | undefined,
  def: number,
): Array<{ time: number; a: number; b: number }> | null {
  if ((!a || a.length === 0) && (!b || b.length === 0)) return null;
  const times = new Set<number>();
  a?.forEach((k) => times.add(k.time));
  b?.forEach((k) => times.add(k.time));
  const sorted = [...times].sort((p, q) => p - q);
  const sample = (keys: AnimKeyframe[] | undefined, t: number): number => {
    let v = def;
    for (const k of keys ?? []) {
      if (k.time <= t + 1e-9) v = k.value;
      else break;
    }
    return v;
  };
  return sorted.map((t) => ({ time: t, a: sample(a, t), b: sample(b, t) }));
}

// =================================================================================
//  主入口
// =================================================================================

/** ProjectData → Spine 3.8 JSON 对象（顶层形状：skeleton / bones / slots / skins / paths / pathConstraints / animations）。 */
export function buildSpineObject(data: ProjectData): Record<string, unknown> {
  const warnings: string[] = [];

  const boneNameById = new Map(data.bones.map((b) => [b.id, b.name]));
  const rootBoneId = data.bones.find((b) => b.parentId === null)?.id ?? data.bones[0]?.id ?? null;
  const rootBoneName = rootBoneId ? (boneNameById.get(rootBoneId) ?? 'root') : 'root';
  const constraintNameById = new Map(data.constraints.map((c) => [c.id, c.name]));

  // 1) bones ------------------------------------------------------------
  // 只写非默认字段（贴近 Spine 官方导出风格）；shearX/Y 本地是弧度 → Spine 用度。
  const bonesOut: Record<string, unknown>[] = [];
  for (const b of data.bones) {
    const bone: Record<string, unknown> = { name: b.name };
    if (b.parentId) {
      const pname = boneNameById.get(b.parentId);
      if (pname) bone.parent = pname;
    }
    if (b.x !== 0) bone.x = b.x;
    if (b.y !== 0) bone.y = b.y;
    if (b.rotation !== 0) bone.rotation = b.rotation;
    if (b.scaleX !== 1) bone.scaleX = b.scaleX;
    if (b.scaleY !== 1) bone.scaleY = b.scaleY;
    if (b.length !== 0) bone.length = b.length;
    if (b.shearX) bone.shearX = (b.shearX * 180) / Math.PI;
    if (b.shearY) bone.shearY = (b.shearY * 180) / Math.PI;
    bonesOut.push(bone);
  }
  if (bonesOut.length === 0) bonesOut.push({ name: rootBoneName });

  // 2) 路径命名：路径附件 id → Spine 路径名（= 第一个引用它的插槽名）-------
  const pathNameByAid = new Map<string, string>();
  for (const [aid, p] of Object.entries(data.attachmentPaths)) {
    if (p.vertices.length < 2) {
      warnings.push(`路径附件 ${aid} 顶点不足 2 个，导出时已跳过`);
      continue;
    }
    const slot = data.slots.find((s) => s.attachmentIds.includes(aid)) ?? null;
    if (!slot) {
      warnings.push(`路径附件 ${aid} 没有被任何插槽引用，导出时已跳过`);
      continue;
    }
    pathNameByAid.set(aid, slot.name);
  }

  // 3) slots + skins -----------------------------------------------------
  // 顺序 = slotOrder（先出现 = 底，对齐 Spine 插槽数组顺序）
  const orderedSlots = [...data.slots].sort((a, b) => {
    const ia = data.slotOrder.indexOf(a.id);
    const ib = data.slotOrder.indexOf(b.id);
    return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib);
  });
  const slotsOut: Record<string, unknown>[] = [];
  const skinSlotEntries: Record<string, Record<string, unknown>> = {};
  for (const slot of orderedSlots) {
    const slotOut: Record<string, unknown> = { name: slot.name };
    const binding = data.slotBindings[slot.id];
    slotOut.bone = binding ? (boneNameById.get(binding.boneId) ?? rootBoneName) : rootBoneName;
    const aid = slot.activeAttachmentId;
    if (aid) {
      const layer = data.images.find((l) => l.id === aid) ?? null;
      const path = data.attachmentPaths[aid] ?? null;
      if (layer) {
        // 图片附件：进 skins（中心坐标，Y 朝上翻转）
        const attName = layer.name || slot.name;
        slotOut.attachment = attName;
        const cx = layer.left + layer.width / 2;
        const cySpine = -(layer.top + layer.height / 2);
        skinSlotEntries[slot.name] = {
          [attName]: { x: cx, y: cySpine, width: layer.width, height: layer.height },
        };
      } else if (path) {
        // 路径附件：不进 skins，attachment = 路径名
        const pname = pathNameByAid.get(aid);
        if (pname) slotOut.attachment = pname;
      }
      // 其它附件（无 layer 无 path）→ 不写 attachment
    }
    slotsOut.push(slotOut);
  }
  const skinsOut: Record<string, unknown> = { default: skinSlotEntries };

  // 4) paths ------------------------------------------------------------
  // 相对柄 → Spine 绝对柄：[x, y, x+inX, y+inY, x+outX, y+outY]
  const pathsOut: Record<string, unknown>[] = [];
  for (const [aid, p] of Object.entries(data.attachmentPaths)) {
    const name = pathNameByAid.get(aid);
    if (!name) continue;
    const vertices: number[] = [];
    for (const v of p.vertices as PathVertex[]) {
      vertices.push(v.x, v.y, v.x + v.handleInX, v.y + v.handleInY, v.x + v.handleOutX, v.y + v.handleOutY);
    }
    pathsOut.push({ name, closed: p.closed, constantSpeed: p.constantSpeed, vertices });
  }

  // 5) pathConstraints ---------------------------------------------------
  // target = 目标插槽激活的路径名；本地 rotationOffset → Spine 侧 offsetRotation
  const pcOut: Record<string, unknown>[] = [];
  for (const c of data.pathConstraints) {
    const targetSlot = data.slots.find((s) => s.id === c.targetSlotId);
    const targetName = targetSlot && targetSlot.activeAttachmentId
      ? pathNameByAid.get(targetSlot.activeAttachmentId)
      : undefined;
    if (!targetName) {
      warnings.push(`路径约束 "${c.name}" 的目标插槽没有激活路径附件，导出时已跳过`);
      continue;
    }
    const bones = c.boneIds
      .map((id) => boneNameById.get(id))
      .filter((x): x is string => !!x);
    if (bones.length === 0) {
      warnings.push(`路径约束 "${c.name}" 没有可用的受约束骨骼，导出时已跳过`);
      continue;
    }
    pcOut.push({
      name: c.name,
      target: targetName,
      bones,
      positionMode: c.positionMode,
      spacingMode: c.spacingMode,
      rotateMode: c.rotateMode,
      position: c.position,
      spacing: c.spacing,
      rotateMix: c.rotateMix,
      translateMix: c.translateMix,
      offsetRotation: c.rotationOffset,
    });
  }

  // 5.5) transformConstraints ----------------------------------------------
  // Spine 3.8 形状：target = 源骨骼（提供变换），bones = 受约束骨骼列表。
  const tcOut: Record<string, unknown>[] = [];
  for (const c of data.transformConstraints) {
    const sourceName = boneNameById.get(c.sourceBoneId);
    const boneName = boneNameById.get(c.boneId);
    if (!sourceName || !boneName) {
      warnings.push(`变换约束 "${c.name}" 引用了不存在的骨骼，导出时已跳过`);
      continue;
    }
    tcOut.push({
      name: c.name,
      target: sourceName,
      bones: [boneName],
      local: c.local,
      relative: c.additive,
      rotation: c.offsetRotation,
      x: c.offsetX,
      y: c.offsetY,
      scaleX: c.offsetScaleX,
      scaleY: c.offsetScaleY,
      shearY: c.offsetShearY,
      rotateMix: c.rotateMix,
      // Spine 3.8 只有单个 translateMix / scaleMix：取 X（若 X、Y 不同会有精度损失）
      translateMix: c.translateMixX,
      scaleMix: c.scaleMixX,
      shearMix: c.shearMix,
    });
  }

  // 6) animations --------------------------------------------------------
  const animationsOut: Record<string, unknown> = {};
  for (const anim of data.animations) {
    // 按目标分组：骨骼（boneName → 轴/旋转）、路径约束（约束 id）、IK（约束 id）
    const boneGroups = new Map<string, { axes: Partial<Record<'x' | 'y' | 'scaleX' | 'scaleY', AnimKeyframe[]>>; rotate?: AnimKeyframe[] }>();
    // key = `${约束id}|${Spine属性名}`：同一约束的不同属性分开成组
    const pcTracksByKey = new Map<string, AnimKeyframe[]>();
    const ikTracksByIkId = new Map<string, AnimKeyframe[]>();

    for (const tr of anim.tracks) {
      const p: AnimProperty = tr.property;
      if (isPathConstraintAnimProperty(p)) {
        const local = PC_ANIM_PROP[p];
        if (!local) continue;
        const spineProp = local === 'rotationOffset' ? 'rotateOffset' : local;
        const key = `${tr.boneId}|${spineProp}`;
        if (!pcTracksByKey.has(key)) pcTracksByKey.set(key, []);
        pcTracksByKey.get(key)!.push(...tr.keys);
        continue;
      }
      if (tr.constraintMix && p === 'mix') {
        if (!ikTracksByIkId.has(tr.boneId)) ikTracksByIkId.set(tr.boneId, []);
        ikTracksByIkId.get(tr.boneId)!.push(...tr.keys);
        continue;
      }
      const boneName = boneNameById.get(tr.boneId);
      if (!boneName) continue;
      let g = boneGroups.get(boneName);
      if (!g) {
        g = { axes: {} };
        boneGroups.set(boneName, g);
      }
      switch (p) {
        case 'x': g.axes.x = tr.keys; break;
        case 'y': g.axes.y = tr.keys; break;
        case 'scaleX': g.axes.scaleX = tr.keys; break;
        case 'scaleY': g.axes.scaleY = tr.keys; break;
        case 'rotation': g.rotate = tr.keys; break;
        default: break; // 其它属性（理论上不会到这）
      }
    }

    const boneTracks: Record<string, unknown> = {};
    for (const [boneName, g] of boneGroups) {
      const props: Record<string, unknown> = {};
      const tr = mergeAxis(g.axes.x, g.axes.y, 0);
      if (tr) props.translate = tr.map((f) => ({ time: f.time, x: f.a, y: f.b }));
      const sc = mergeAxis(g.axes.scaleX, g.axes.scaleY, 1);
      if (sc) props.scale = sc.map((f) => ({ time: f.time, x: f.a, y: f.b }));
      if (g.rotate && g.rotate.length > 0) {
        props.rotate = g.rotate.map((k) => numFrame('rotation', k));
      }
      if (Object.keys(props).length > 0) boneTracks[boneName] = props;
    }

    const pathConstraintTracks: Record<string, Record<string, unknown>> = {};
    for (const [key, keys] of pcTracksByKey) {
      const sep = key.indexOf('|');
      const pcId = key.slice(0, sep);
      const spineProp = key.slice(sep + 1);
      const pcName = data.pathConstraints.find((c) => c.id === pcId)?.name;
      if (!pcName || keys.length === 0) continue;
      // Spine 官方特例：动画块属性键 = rotateOffset，帧字段 = offsetRotation
      const frameField = spineProp === 'rotateOffset' ? 'offsetRotation' : spineProp;
      if (!pathConstraintTracks[pcName]) pathConstraintTracks[pcName] = {};
      pathConstraintTracks[pcName][spineProp] = keys
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((k) => numFrame(frameField, k));
    }

    const ikTracks: Record<string, unknown> = {};
    for (const [constraintId, keys] of ikTracksByIkId) {
      const name = constraintNameById.get(constraintId);
      if (!name || keys.length === 0) continue;
      ikTracks[name] = keys
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((k) => numFrame('mix', k));
    }

    const animOut: Record<string, unknown> = {};
    if (Object.keys(boneTracks).length > 0) animOut.bones = boneTracks;
    if (Object.keys(pathConstraintTracks).length > 0) animOut.pathConstraints = pathConstraintTracks;
    if (Object.keys(ikTracks).length > 0) animOut.ik = ikTracks;
    if (Object.keys(animOut).length > 0) animationsOut[anim.name] = animOut;
  }

  // 7) 顶层组装 -----------------------------------------------------------
  const root: Record<string, unknown> = {
    skeleton: { spine: '3.8.99' },
    bones: bonesOut,
    slots: slotsOut,
    skins: skinsOut,
  };
  if (pathsOut.length > 0) root.paths = pathsOut;
  if (pcOut.length > 0) root.pathConstraints = pcOut;
  if (tcOut.length > 0) root.transformConstraints = tcOut;
  if (Object.keys(animationsOut).length > 0) root.animations = animationsOut;

  return root;
}

/** ProjectData → 缩进 2 空格的美化 JSON 字符串。 */
export function buildSpineJson(data: ProjectData): string {
  return JSON.stringify(buildSpineObject(data), null, 2);
}

/** 把当前工程导出为 Spine v3.8 JSON 文件并触发浏览器下载。 */
export function exportSpineJsonFile(): void {
  const s = usePixiBonesStore.getState();
  const data: ProjectData = {
    psd: s.psd,
    images: s.images,
    slots: s.slots,
    slotVisibility: s.slotVisibility,
    slotTransforms: s.slotTransforms,
    slotStyle: s.slotStyle,
    attachmentStyle: s.attachmentStyle,
    attachmentMeshes: s.attachmentMeshes,
    attachmentPaths: s.attachmentPaths,
    slotOrder: s.slotOrder,
    slotBindings: s.slotBindings,
    bones: s.bones,
    selectedBoneId: s.selectedBoneId,
    selectedBoneIds: s.selectedBoneIds,
    projectName: s.projectName,
    animations: s.animations,
    activeAnimationId: s.activeAnimationId,
    setupPose: s.setupPose,
    constraints: s.constraints,
    pathConstraints: s.pathConstraints,
    physicsConstraints: s.physicsConstraints,
    transformConstraints: s.transformConstraints,
  };
  const json = buildSpineJson(data);
  const safeName = (s.projectName || 'skeleton').replace(/[\\/:*?"<>|]/g, '_') || 'skeleton';
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
