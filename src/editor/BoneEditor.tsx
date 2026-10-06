import { useEffect, useRef } from 'react';
import {
  Application,
  Container,
  Graphics as Gfx,
  Sprite,
  Texture,
  FederatedPointerEvent,
  FederatedWheelEvent,
} from 'pixi.js';
import { usePixiBonesStore, findBone, type BoneNode } from './store';
import { Bone as EngineBone } from '@engine/Bone';
import { Skeleton } from '@engine/Skeleton';
import { flattenLayers, parsePsd, type PixiBonesLayer, type PixiBonesPsd } from '@psd/index';
import { CanvasOverlay } from './CanvasOverlay';

/**
 * Day 3.5 · 主编辑器画布（Spine 风格）
 *
 * 视觉：
 *   - 棋盘格底色（CSS 给 host）
 *   - 网格线（每 32px，颜色 #454548）
 *   - 十字光标（world (0,0) 处黑线）
 *   - PSD 资源 + 骨骼 + 选中高亮
 *
 * 交互：
 *   - **左键** 点图层/骨 → 选中
 *   - **右键拖** → 平移画布（panX, panY）
 *   - **滚轮** → 缩放（每次以鼠标位置为中心）
 */
export function BoneEditor() {
  const hostRef = useRef<HTMLDivElement>(null);

  // Hooks 必须在组件顶部（useEffect 内部调 Zustand hook 在某些版本会触发 Invalid hook call）
  const viewport = usePixiBonesStore((s) => s.viewport);
  const setViewport = usePixiBonesStore((s) => s.setViewport);
  const setRender = usePixiBonesStore((s) => s.setRender);
  const editorMode = usePixiBonesStore((s) => s.editorMode);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let destroyed = false;
    let app: Application | null = null;
    let resizeObs: ResizeObserver | null = null;
    const cleanups: Array<() => void> = [];
    type DragState =
      | { kind: 'tip'; boneId: string; startLocal: { x: number; y: number }; startScreen: { x: number; y: number } }
      | { kind: 'tip-resize'; boneId: string; startLength: number; startRotation: number; parentWorld: { x: number; y: number }; parentRotDeg: number; startScreen: { x: number; y: number }; startScreenParent: { x: number; y: number } }
      | { kind: 'rotate'; boneId: string; startRot: number; startScreen: { x: number; y: number } }
      | { kind: 'pan'; startScreen: { x: number; y: number }; startPan: { x: number; y: number } }
      | { kind: 'create-from'; parentId: string; startWorld: { x: number; y: number }; startScreen: { x: number; y: number }; preview: Gfx }
      | null;
    let dragState: DragState = null;

    const cleanup = () => {
      if (destroyed) return;
      destroyed = true;
      cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
      cleanups.length = 0;
      if (resizeObs) { try { resizeObs.disconnect(); } catch {} resizeObs = null; }
      if (app) {
        try {
          if (app.canvas && app.canvas.parentNode === host) {
            host.removeChild(app.canvas);
          }
          app.destroy(true, { children: true, texture: true });
        } catch { /* ignore */ }
      }
    };

    (async () => {
      const a = new Application();
      app = a;
      try {
        await a.init({
          backgroundAlpha: 0,
          resizeTo: host,
          antialias: true,
        });
      } catch (err) {
        if (!destroyed) console.error('[BoneEditor] init 失败:', err);
        return;
      }

      if (destroyed || !host) {
        cleanup();
        return;
      }

      host.appendChild(a.canvas);
      a.canvas.style.display = 'block';

      const gridLayer = new Gfx();
      a.stage.addChild(gridLayer);

      // 十字光标插在 grid 之后、PSD 之前（被 PSD sprites 盖住）
      const crosshairLayer = new Gfx();
      crosshairLayer.eventMode = 'none';   // 纯视觉装饰，不响应事件
      a.stage.addChild(crosshairLayer);
// 紧贴 grid 上方（z-index 在 PSD 之下）

      const root = new Container();
      a.stage.addChild(root);

      const bonesLayer = new Gfx();
      bonesLayer.eventMode = 'none';      // 纯视觉装饰（绘制骨骼线/十字）
      a.stage.addChild(bonesLayer);

      const handlesLayer = new Container();
      handlesLayer.eventMode = 'static';
      a.stage.addChild(handlesLayer);

      const highlight = new Gfx();
      a.stage.addChild(highlight);

      const spriteByLayerId = new Map<string, Container>();
      const canvasRefs = new Set<HTMLCanvasElement>();

      a.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      // ---- PSD 拖拽进画布 ----
      let dragCounter = 0;
      const showDropHint = (show: boolean) => {
        let hint = document.getElementById('pixibones-drop-hint');
        if (show && !hint) {
          hint = document.createElement('div');
          hint.id = 'pixibones-drop-hint';
          hint.textContent = '📁 放开导入 .psd';
          hint.style.cssText = [
            'position: absolute',
            'inset: 0',
            'display: flex',
            'align-items: center',
            'justify-content: center',
            'background: rgba(26, 99, 149, 0.3)',
            'border: 3px dashed var(--spine-accent)',
            'color: white',
            'font-size: 18px',
            'font-weight: 600',
            'pointer-events: none',
            'z-index: 100',
          ].join(';');
          host.style.position = 'relative';
          host.appendChild(hint);
        } else if (!show && hint) {
          hint.remove();
        }
      };

      const onHostDragEnter = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        dragCounter++;
        showDropHint(true);
      };
      const onHostDragOver = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
      };
      const onHostDragLeave = (e: DragEvent) => {
        e.preventDefault();
        dragCounter = Math.max(0, dragCounter - 1);
        if (dragCounter === 0) showDropHint(false);
      };
      const onHostDrop = async (e: DragEvent) => {
        e.preventDefault();
        dragCounter = 0;
        showDropHint(false);
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.psd')) {
          console.warn('[BoneEditor] 不是 .psd 文件:', file.name);
          return;
        }
        try {
          const result = await parsePsd(file);
          if (result.layers.length > 0) {
            usePixiBonesStore.getState().setPsd(result);
          }
        } catch (err) {
          console.error('[BoneEditor] PSD 解析失败:', err);
        }
      };

      host.addEventListener('dragenter', onHostDragEnter);
      host.addEventListener('dragover', onHostDragOver);
      host.addEventListener('dragleave', onHostDragLeave);
      host.addEventListener('drop', onHostDrop);

      cleanups.push(() => {
        showDropHint(false);
        host.removeEventListener('dragenter', onHostDragEnter);
        host.removeEventListener('dragover', onHostDragOver);
        host.removeEventListener('dragleave', onHostDragLeave);
        host.removeEventListener('drop', onHostDrop);
      });

      const rebuildPsd = (psd: PixiBonesPsd | null) => {
        while (root.children.length > 0) {
          const c = root.children[0];
          root.removeChild(c);
          c.destroy({ children: true, texture: true });
        }
        spriteByLayerId.clear();
        canvasRefs.clear();

        if (!psd) return;

        for (const layer of flattenLayers(psd)) {
          if (!layer.canvas) continue;
          if (layer.canvas.width === 0 || layer.canvas.height === 0) continue;

          const tex = Texture.from(layer.canvas);
          tex.source.resize();

          const sprite = new Sprite(tex);
          sprite.x = layer.left;
          sprite.y = layer.top;
          sprite.alpha = layer.opacity;
          sprite.visible = layer.visible;
          (sprite as unknown as { blendMode: string }).blendMode = layer.blendMode;
          sprite.eventMode = 'static';
          sprite.cursor = 'pointer';

          sprite.on('pointerdown', (e: FederatedPointerEvent) => {
            // 只对左键 stopPropagation，右键放行让 stage 收到去做 pan
            if (e.button === 0) {
              e.stopPropagation();
              usePixiBonesStore.getState().selectLayer(layer.id);
            }
          });

          const wrap = new Container();
          wrap.label = layer.name;
          wrap.addChild(sprite);
          root.addChild(wrap);

          spriteByLayerId.set(layer.id, wrap);
          canvasRefs.add(layer.canvas);
        }
      };

      const applyVisibility = (
        psd: PixiBonesPsd | null,
        overrides: Record<string, boolean>,
      ) => {
        if (!psd) return;
        for (const layer of flattenLayers(psd)) {
          const wrap = spriteByLayerId.get(layer.id);
          if (!wrap) continue;
          const o = overrides[layer.id];
          wrap.visible = o === undefined ? layer.visible : o;
        }
      };

      const drawHighlight = (
        psd: PixiBonesPsd | null,
        selectedLayerId: string | null,
      ) => {
        highlight.clear();
        if (!psd || !selectedLayerId) return;
        const layer = findLayerInPsd(psd, selectedLayerId);
        if (!layer || layer.width === 0 || layer.height === 0) return;

        const stageX = root.x + layer.left * root.scale.x;
        const stageY = root.y + layer.top * root.scale.y;
        const stageW = layer.width * root.scale.x;
        const stageH = layer.height * root.scale.y;

        highlight
          .rect(stageX - 2, stageY - 2, stageW + 4, stageH + 4)
          .stroke({ width: 2, color: 0x60a5fa, alpha: 0.9 });
      };

      const center = (psd: PixiBonesPsd | null) => {
        // 实时从 store 读 viewport（避免 closure 缓存导致 zoom/pan 改不动）
        const vp = usePixiBonesStore.getState().viewport;
        // render guard：只有真变了才推 store（否则死循环：setRender → subscribe → center → setRender...）
        const curRender = usePixiBonesStore.getState().render;
        const pushRender = (x: number, y: number, scale: number) => {
          if (curRender.x !== x || curRender.y !== y || curRender.scale !== scale) {
            usePixiBonesStore.getState().setRender({ x, y, scale });
          }
        };
        if (!psd || psd.width === 0 || psd.height === 0) {
          // 没 PSD：root 居中画布（用 CSS 像素，不是 backing store）
          const cssW = host.clientWidth;
          const cssH = host.clientHeight;
          root.scale.set(vp.zoom, vp.zoom);
          root.x = cssW / 2 + vp.panX;
          root.y = cssH / 2 + vp.panY;
          pushRender(root.x, root.y, root.scale.x);
          return;
        }
        const margin = 40;
        const rw = host.clientWidth;
        const rh = host.clientHeight;
        const sw = Math.max(1, rw - margin * 2);
        const sh = Math.max(1, rh - margin * 2);
        const baseFit = Math.min(sw / psd.width, sh / psd.height);
        const scale = Math.max(0.01, Math.min(baseFit * vp.zoom, 8));
        root.scale.set(scale, scale);
        root.x = (rw - psd.width * scale) / 2 + vp.panX;
        root.y = rh / 2 - psd.height * scale + vp.panY;
        // 十字应该对齐 image bottom-center（不是左上角的 root.x/y）
        const renderX = root.x + (psd.width / 2) * scale;
        const renderY = root.y + psd.height * scale;
        pushRender(renderX, renderY, scale);
      };

      const GRID_STEP = 32;
      const drawGrid = (psd: PixiBonesPsd | null) => {
        gridLayer.clear();
        if (!psd) return;

        const sx = root.scale.x;
        const sy = root.scale.y;
        if (sx <= 0 || sy <= 0) return;

        const minWX = (-root.x) / sx;
        const maxWX = (a.renderer.width - root.x) / sx;
        const minWY = (-root.y) / sy;
        const maxWY = (a.renderer.height - root.y) / sy;

        const left = Math.max(0, Math.floor(minWX / GRID_STEP) * GRID_STEP);
        const right = Math.min(psd.width, Math.ceil(maxWX / GRID_STEP) * GRID_STEP);
        const top = Math.max(0, Math.floor(minWY / GRID_STEP) * GRID_STEP);
        const bottom = Math.min(psd.height, Math.ceil(maxWY / GRID_STEP) * GRID_STEP);

        for (let x = left; x <= right; x += GRID_STEP) {
          const sx0 = root.x + x * sx;
          gridLayer
            .moveTo(sx0, root.y + top * sy)
            .lineTo(sx0, root.y + bottom * sy)
            .stroke({ width: 1, color: 0x454548, alpha: 0.4 });
        }
        for (let y = top; y <= bottom; y += GRID_STEP) {
          const sy0 = root.y + y * sy;
          gridLayer
            .moveTo(root.x + left * sx, sy0)
            .lineTo(root.x + right * sx, sy0)
            .stroke({ width: 1, color: 0x454548, alpha: 0.4 });
        }
      };


      // 十字光标（PixiJS 层，在 grid 后、PSD 前；PSD 自动盖住）
      const drawCrosshair = (psd: PixiBonesPsd | null) => {
        crosshairLayer.clear();
        const r = usePixiBonesStore.getState().render;
        // CSS 坐标 → PixiJS stage 坐标（CanvasOverlay 的 left:0 是 canvas-host 边缘 = stage 0）
        const cx = r.x;
        const cy = r.y;
        // 横线
        crosshairLayer
          .moveTo(0, cy)
          .lineTo(a.renderer.width, cy)
          .stroke({ width: 1, color: 0x000000, alpha: 0.6 });
        // 竖线
        crosshairLayer
          .moveTo(cx, 0)
          .lineTo(cx, a.renderer.height)
          .stroke({ width: 1, color: 0x000000, alpha: 0.6 });
        // 中心点
        crosshairLayer.circle(cx, cy, 3).fill({ color: 0x000000, alpha: 0.7 });
      };

      let skeletonRef: Skeleton | null = null;
      const boneById = new Map<string, EngineBone>();

      const buildSkeleton = (nodes: BoneNode[]) => {
        boneById.clear();
        const rootNode = nodes.find((n) => n.parentId === null);
        if (!rootNode) { skeletonRef = null; return; }
        const rootBone = makeBone(rootNode);
        boneById.set(rootNode.id, rootBone);
        const skel = new Skeleton(rootBone);

        const addChildren = (parent: EngineBone, parentId: string) => {
          for (const n of nodes) {
            if (n.parentId === parentId) {
              const child = makeBone(n);
              boneById.set(n.id, child);
              parent.addChild(child);
              addChildren(child, n.id);
            }
          }
        };
        addChildren(rootBone, rootNode.id);
        skel.update();
        skeletonRef = skel;
      };

      const drawBones = (nodes: BoneNode[], selectedBoneId: string | null) => {
        bonesLayer.clear();
        while (handlesLayer.children.length > 0) {
          const c = handlesLayer.children[0];
          handlesLayer.removeChild(c);
          c.destroy();
        }
        if (!skeletonRef || nodes.length === 0) return;

        const sx = root.scale.x;
        const sy = root.scale.y;
        const ox = root.x;
        const oy = root.y;

        const BONE_COLOR = 0x9ca3af;     // 未选中：灰色
        const SELECTED_COLOR = 0xF0E020;   // 选中：黄色
        const sAvg = (Math.abs(sx) + Math.abs(sy)) / 2;  // 平均缩放

        const visit = (bone: EngineBone, isSelected: boolean, length: number) => {
          const p0 = skeletonRef!.getWorldPosition(bone);
          const p1 = skeletonRef!.getWorldTip(bone);
          if (length === 0) {
            // 0 长度骨骼 = 根骨骼图标（精确按用户 SVG 比例：446x335 viewBox）
            // SVG 中心 (167, 163)，4 条 20px 宽矩形臂 + 中心双圆环
            // 右臂比左/上/下臂长（指向骨骼默认 +X 方向）
            const cx = ox + p0.x * sx;
            const cy = oy + p0.y * sy;
            const color = isSelected ? SELECTED_COLOR : BONE_COLOR;
            // 整体缩放：基准 446x335 缩放到视觉宽度 W
            const W = 120 * sAvg;
            const H = W * (335 / 446);
            // 图标左上角（中心点对齐到 SVG 中心 (167,163)）
            const ix = cx - W * (167 / 446);
            const iy = cy - H * (163 / 335);
            // 4 条臂（20px 粗，原始坐标 → 归一化）
            const armW = W * (20 / 446);
            // 上臂：(157,14)→(177,95)，81 长
            bonesLayer.rect(ix + W * (157 / 446), iy + H * (14 / 335), armW, H * (81 / 335)).fill({ color });
            // 下臂：(157,231)→(177,312)，81 长
            bonesLayer.rect(ix + W * (157 / 446), iy + H * (231 / 335), armW, H * (81 / 335)).fill({ color });
            // 左臂：(18,153)→(99,173)，81 长
            bonesLayer.rect(ix + W * (18 / 446), iy + H * (153 / 335), W * (81 / 446), armW).fill({ color });
            // 右臂：(234,153)→(427,173)，193 长（最长，指向 +X）
            bonesLayer.rect(ix + W * (234 / 446), iy + H * (153 / 335), W * (193 / 446), armW).fill({ color });
            // 中心大圆环（外圆，半径 ~28 in 446 viewBox）
            bonesLayer.circle(cx, cy, W * (28 / 446)).stroke({ width: W * (8 / 446), color });
            // 中心小圆环（内圆，半径 ~11）
            bonesLayer.circle(cx, cy, W * (11 / 446)).stroke({ width: W * (5 / 446), color });
          } else {
            bonesLayer
              .moveTo(ox + p0.x * sx, oy + p0.y * sy)
              .lineTo(ox + p1.x * sx, oy + p1.y * sy)
              .stroke({ width: 4 * sAvg, color: isSelected ? SELECTED_COLOR : BONE_COLOR });
            bonesLayer
              .circle(ox + p0.x * sx, oy + p0.y * sy, 6 * sAvg)
              .fill({ color: 0xffffff });
          }
          for (const c of bone.children) {
            const sel = (c as unknown as { _id?: string })._id === selectedBoneId;
            visit(c, sel, c.length);
          }
        };
        const rootSelected = (skeletonRef.root as unknown as { _id?: string })._id === selectedBoneId;
        visit(skeletonRef.root, rootSelected, skeletonRef.root.length);

        for (const node of nodes) {
          const b = boneById.get(node.id);
          if (!b) continue;
          const isSelected = node.id === selectedBoneId;

          const origin = skeletonRef.getWorldPosition(b);
          const oX = ox + origin.x * sx;
          const oY = oy + origin.y * sy;
          const jointHit = new Gfx();
          // hit area：0 长度骨骼用大圆覆盖整个图标范围（图标最大半径约 30px）
          const hitR = node.length === 0 ? 32 : 16;
          jointHit
            .circle(0, 0, hitR)
            .fill({ color: 0xffffff, alpha: 0.001 });
          jointHit.x = oX;
          jointHit.y = oY;
          jointHit.eventMode = 'static';
          jointHit.cursor = 'pointer';
          jointHit.on('pointerdown', (ev: FederatedPointerEvent) => {
            ev.stopPropagation();
            const mode = usePixiBonesStore.getState().editorMode;
            if (mode === 'create') {
              // Create 模式：启动"从父骨骼拖出子骨骼"模式
              const origin = skeletonRef!.getWorldPosition(b);
              const startWorld = { x: origin.x, y: origin.y };
              const startScreen = { x: ev.global.x, y: ev.global.y };
              const preview = new Gfx();
              preview.eventMode = 'none';
              a.stage.addChild(preview);
              dragState = {
                kind: 'create-from',
                parentId: node.id,
                startWorld,
                startScreen,
                preview,
              };
            } else {
              // Pose 模式（或其他）：选中骨骼，并启动拖动 = 平移该骨骼
              usePixiBonesStore.getState().selectBone(node.id);
              dragState = {
                kind: 'tip',
                boneId: node.id,
                startLocal: { x: node.x, y: node.y },
                startScreen: { x: ev.global.x, y: ev.global.y },
              };
            }
          });
          handlesLayer.addChild(jointHit);

          const tip = skeletonRef.getWorldTip(b);
          const stageX = ox + tip.x * sx;
          const stageY = oy + tip.y * sy;

          const tipHandle = new Gfx();
          tipHandle
            .circle(0, 0, isSelected ? 9 : 6)
            .fill({ color: isSelected ? 0xfbbf24 : 0xffffff })
            .stroke({ width: 1.5, color: 0xfb923c });
          tipHandle.x = stageX;
          tipHandle.y = stageY;
          tipHandle.eventMode = 'static';
          tipHandle.cursor = 'grab';
          tipHandle.on('pointerdown', (ev: FederatedPointerEvent) => {
            ev.stopPropagation();
            // 拖 tip = 改变骨骼的 length 和 rotation
            const parentRotDeg = node.parentId
              ? (findBone(usePixiBonesStore.getState().bones, node.parentId)?.rotation ?? 0)
              : 0;
            dragState = {
              kind: 'tip-resize',
              boneId: node.id,
              startLength: node.length,
              startRotation: node.rotation,
              parentWorld: skeletonRef!.getWorldPosition(b),
              parentRotDeg,
              startScreen: { x: ev.global.x, y: ev.global.y },
              startScreenParent: {
                x: ox + (skeletonRef!.getWorldPosition(b).x) * root.scale.x,
                y: oy + (skeletonRef!.getWorldPosition(b).y) * root.scale.y,
              },
            };
            tipHandle.cursor = 'grabbing';
          });
          handlesLayer.addChild(tipHandle);
        }
      };

      const onPointerMove = (ev: FederatedPointerEvent) => {
        if (!dragState) return;
        const st = usePixiBonesStore.getState();

        if (dragState.kind === 'tip') {
          const dxScreen = ev.global.x - dragState.startScreen.x;
          const dyScreen = ev.global.y - dragState.startScreen.y;
          const sx = root.scale.x;
          const sy = root.scale.y;
          // 屏幕 delta → 世界 delta
          const dxWorld = sx !== 0 ? dxScreen / sx : 0;
          const dyWorld = sy !== 0 ? dyScreen / sy : 0;
          // 世界 delta → 父骨骼 local delta（反旋转父骨骼的 rotation）
          const dragNode = findBone(st.bones, dragState.boneId);
          const parentRotDeg = dragNode && dragNode.parentId !== null
            ? (findBone(st.bones, dragNode.parentId)?.rotation ?? 0)
            : 0;
          const parentRotRad = parentRotDeg * (Math.PI / 180);
          const cos = Math.cos(-parentRotRad);
          const sin = Math.sin(-parentRotRad);
          const localDx = dxWorld * cos - dyWorld * sin;
          const localDy = dxWorld * sin + dyWorld * cos;
          st.moveBone(
            dragState.boneId,
            dragState.startLocal.x + localDx,
            dragState.startLocal.y + localDy,
          );
        } else if (dragState.kind === 'tip-resize') {
          // 拖 tip = 根据鼠标相对父骨骼的角度/距离改变 rotation/length
          const sx = root.scale.x;
          const sy = root.scale.y;
          const boneId = dragState.boneId;
          const dxScreen = ev.global.x - dragState.startScreenParent.x;
          const dyScreen = ev.global.y - dragState.startScreenParent.y;
          // 屏幕 delta → 世界 delta
          const dxWorld = sx !== 0 ? dxScreen / sx : 0;
          const dyWorld = sy !== 0 ? dyScreen / sy : 0;
          // 鼠标相对父骨骼的角度（世界空间）
          const worldRotRad = Math.atan2(dyWorld, dxWorld);
          // 子骨骼 rotation = 世界 rotation - 父骨骼 rotation
          const parentRotRad = dragState.parentRotDeg * (Math.PI / 180);
          const newRotationDeg = worldRotRad - parentRotRad * (180 / Math.PI);
          // length = 鼠标到父骨骼关节的距离 / 父骨骼缩放
          const dist = Math.sqrt(dxScreen * dxScreen + dyScreen * dyScreen);
          const scale = (Math.abs(sx) + Math.abs(sy)) / 2;
          const newLength = scale !== 0 ? dist / scale : dragState.startLength;
          usePixiBonesStore.setState((s) => ({
            bones: s.bones.map((n) => (n.id === boneId
              ? { ...n, length: Math.max(1, newLength), rotation: newRotationDeg }
              : n)),
          }));
        } else if (dragState.kind === 'rotate') {
          const node = findBone(st.bones, dragState.boneId);
          if (!node) return;
          const bone = boneById.get(dragState.boneId);
          if (!bone) return;
          const origin = skeletonRef!.getWorldPosition(bone);
          const oxS = root.x + origin.x * root.scale.x;
          const oyS = root.y + origin.y * root.scale.y;
          const startAngle = Math.atan2(dragState.startScreen.y - oyS, dragState.startScreen.x - oxS);
          const nowAngle = Math.atan2(ev.global.y - oyS, ev.global.x - oxS);
          st.setBoneRotation(dragState.boneId, dragState.startRot + (nowAngle - startAngle));
        } else if (dragState.kind === 'pan') {
          const newPanX = dragState.startPan.x + (ev.global.x - dragState.startScreen.x);
          const newPanY = dragState.startPan.y + (ev.global.y - dragState.startScreen.y);
          // 实时从 store 读最新 viewport（避免闭包捕获旧值，覆盖掉 wheel 改的 zoom）
          const curVp = usePixiBonesStore.getState().viewport;
          setViewport({ ...curVp, panX: newPanX, panY: newPanY });
          const s = usePixiBonesStore.getState();
          center(s.psd);
          drawGrid(s.psd);
          drawHighlight(s.psd, s.selectedLayerId);
          drawBones(s.bones, s.selectedBoneId);
        } else if (dragState.kind === 'create-from') {
          // 更新预览线：从父骨骼关节 → 鼠标位置（世界坐标）
          const sx = root.scale.x;
          const sy = root.scale.y;
          const ox = root.x;
          const oy = root.y;
          const dxScreen = ev.global.x - dragState.startScreen.x;
          const dyScreen = ev.global.y - dragState.startScreen.y;
          // 鼠标世界坐标
          const mouseWorldX = dragState.startWorld.x + (sx !== 0 ? dxScreen / sx : 0);
          const mouseWorldY = dragState.startWorld.y + (sy !== 0 ? dyScreen / sy : 0);
          const sx0 = ox + dragState.startWorld.x * sx;
          const sy0 = oy + dragState.startWorld.y * sy;
          const mx  = ox + mouseWorldX * sx;
          const my  = oy + mouseWorldY * sy;
          // 画预览线（从父骨骼 → 鼠标）
          dragState.preview.clear();
          dragState.preview
            .moveTo(sx0, sy0).lineTo(mx, my)
            .stroke({ width: 2, color: 0xf0e020, alpha: 0.7 });
          // 端点圆
          dragState.preview.circle(mx, my, 4).fill({ color: 0xf0e020 });
          // 暂存当前鼠标世界坐标，pointerup 用
          (dragState as { currentMouseWorld?: { x: number; y: number } }).currentMouseWorld = { x: mouseWorldX, y: mouseWorldY };
        }
      };
      const onPointerUp = () => {
        if (!dragState) return;
        // 创建子骨骼：pointerup 时如果在 create-from 状态，根据当前鼠标位置 addBone
        if (dragState.kind === 'create-from') {
          const mouseWorld = (dragState as { currentMouseWorld?: { x: number; y: number } }).currentMouseWorld;
          if (mouseWorld) {
            // 鼠标相对父骨骼关节的偏移（世界空间）
            const dx = mouseWorld.x - dragState.startWorld.x;
            const dy = mouseWorld.y - dragState.startWorld.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            if (length > 1) {
              // 父骨骼的世界 rotation（从 worldMatrix 提取角度）
              // 这里假设 root 永远 rotation=0（spine 标准），父骨骼 rotation 就是 world rotation
              const parentNode = findBone(usePixiBonesStore.getState().bones, dragState.parentId);
              const parentRotDeg = parentNode ? parentNode.rotation : 0;
              const parentRotRad = parentRotDeg * (Math.PI / 180);
              // 子骨骼 tip 朝向鼠标方向（世界）→ 在父骨骼 local frame 下
              // localRot = worldRot - parentRot
              const worldRot = Math.atan2(dy, dx);
              const localRot = worldRot - parentRotRad;
              usePixiBonesStore.getState().addBone(dragState.parentId, {
                x: 0, y: 0,
                rotation: localRot * (180 / Math.PI),  // store 用度数
                length,
              });
            }
          }
          // 清理预览
          a.stage.removeChild(dragState.preview);
          dragState.preview.destroy();
        }
        dragState = null;
        a.canvas.style.cursor = 'default';
      };

      a.stage.eventMode = 'static';
      a.stage.hitArea = a.screen;
      a.stage.on('pointermove', onPointerMove);
      a.stage.on('pointerup', onPointerUp);
      a.stage.on('pointerupoutside', onPointerUp);

      a.stage.on('pointerdown', (ev: FederatedPointerEvent) => {
        if (ev.target === a.stage && ev.button === 0) {
          const mode = usePixiBonesStore.getState().editorMode;
          if (mode === 'create') {
            // Create 模式：点空白 = 在点击位置创建新骨骼
            // 父骨骼 = 当前选中骨骼（没有则选根）
            const sx = root.scale.x;
            const sy = root.scale.y;
            const ox = root.x;
            const oy = root.y;
            // 屏幕 → 世界坐标
            const worldX = (ev.global.x - ox) / (sx || 1);
            const worldY = (ev.global.y - oy) / (sy || 1);
            // 找父骨骼：当前选中骨骼（无选中则根骨骼）
            const state = usePixiBonesStore.getState();
            const rootBone = state.bones.find((b) => b.parentId === null);
            const parentId = state.selectedBoneId || (rootBone ? rootBone.id : null);
            if (!parentId) return;
            // 子骨骼的世界坐标 = 鼠标位置
            // 子骨骼相对父骨骼的 local 坐标 = (worldX - parentWorldX, worldY - parentWorldY)
            // 需要先拿到父骨骼的世界坐标
            const parentBone = boneById.get(parentId);
            if (!parentBone) return;
            // 在父骨骼 local frame 下：先旋转 -parentRot，再平移 -parentPos
            const parentNode = state.bones.find((b) => b.id === parentId);
            const parentRotDeg = parentNode ? parentNode.rotation : 0;
            const parentRotRad = parentRotDeg * (Math.PI / 180);
            const parentWorld = skeletonRef!.getWorldPosition(parentBone);
            const dx = worldX - parentWorld.x;
            const dy = worldY - parentWorld.y;
            // 反旋转到父骨骼 local frame
            const cos = Math.cos(-parentRotRad);
            const sin = Math.sin(-parentRotRad);
            const localX = dx * cos - dy * sin;
            const localY = dx * sin + dy * cos;
            // length = 子骨骼长度（先默认 100）
            // rotation = 0（朝父骨骼 +X 方向）
            state.addBone(parentId, { x: localX, y: localY, length: 100, rotation: 0 });
          } else {
            usePixiBonesStore.getState().selectLayer(null);
            usePixiBonesStore.getState().selectBone(null);
          }
        }
      });

      a.stage.on('pointerdown', (ev: FederatedPointerEvent) => {
        if (ev.button === 2) {
          ev.stopPropagation();
          dragState = {
            kind: 'pan',
            startScreen: { x: ev.global.x, y: ev.global.y },
            startPan: { x: usePixiBonesStore.getState().viewport.panX, y: usePixiBonesStore.getState().viewport.panY },
          };
          a.canvas.style.cursor = 'grabbing';
        }
      });

      // 直接在 canvas DOM 上挂 wheel（原 a.stage.on('wheel') 不知为何触发不了）
      const wheelHandler = (ev: WheelEvent) => {
        ev.preventDefault();
        const ZOOM_STEP = 1.1;
        const factor = ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        // 记下旧的 image 底部中心
        const sOld = usePixiBonesStore.getState();
        let oldBottomX = 0, oldBottomY = 0;
        if (sOld.psd && sOld.psd.width > 0 && sOld.psd.height > 0) {
          oldBottomX = root.x + (sOld.psd.width / 2) * root.scale.x;
          oldBottomY = root.y + sOld.psd.height * root.scale.y;
        }
        // 从 store 实时读 zoom
        const curVp = usePixiBonesStore.getState().viewport;
        const newZoom = Math.max(0.05, Math.min(curVp.zoom * factor, 16));
        setViewport({ ...curVp, zoom: newZoom });
        const s = usePixiBonesStore.getState();
        // 重新算 center（保持 bottom-center 在 oldBottomX/Y）
        if (s.psd && s.psd.width > 0 && s.psd.height > 0) {
          const cssW = host.clientWidth;
          const cssH = host.clientHeight;
          const margin = 30;
          const baseFit = Math.max(0.01, Math.min(
            Math.max(1, cssW - margin * 2) / s.psd.width,
            Math.max(1, cssH - margin * 2) / s.psd.height,
            1
          ));
          const scale = baseFit * newZoom;
          root.scale.set(scale, scale);
          root.x = oldBottomX - (s.psd.width / 2) * scale;
          root.y = oldBottomY - s.psd.height * scale;
        } else {
          center(s.psd);
        }
        drawGrid(s.psd);
        drawHighlight(s.psd, s.selectedLayerId);
        drawBones(s.bones, s.selectedBoneId);
        drawCrosshair(s.psd);
      };
      a.canvas.addEventListener('wheel', wheelHandler, { passive: false });

      cleanups.push(() => {
        a.stage.off('pointermove', onPointerMove);
        a.stage.off('pointerup', onPointerUp);
        a.stage.off('pointerupoutside', onPointerUp);
        a.canvas.removeEventListener('wheel', wheelHandler);
      });

      const initial = usePixiBonesStore.getState();
      rebuildPsd(initial.psd);
      center(initial.psd);
      drawGrid(initial.psd);
      applyVisibility(initial.psd, initial.layerVisibility);
      drawHighlight(initial.psd, initial.selectedLayerId);
      buildSkeleton(initial.bones);
      drawBones(initial.bones, initial.selectedBoneId);

      let prev = usePixiBonesStore.getState();
      const unsub = usePixiBonesStore.subscribe((state) => {
        if (destroyed) return;
        if (state.psd !== prev.psd) {
          rebuildPsd(state.psd);
          // 新 PSD：重置视口（用户之前可能 zoom 过）
          // 用 queueMicrotask 异步执行，避免在 subscribe 回调里再 setState 触发递归
          queueMicrotask(() => {
            if (!destroyed) {
              usePixiBonesStore.getState().setViewport({ panX: 0, panY: 0, zoom: 1 });
            }
          });
        }
        if (state.bones !== prev.bones) buildSkeleton(state.bones);
// fit-to-content 请求：通过 setViewport 写入 vp.zoom/panX/panY，让 center() 自动重算 root
        if (state.fitRequestId !== prev.fitRequestId) {
          const b = root.getLocalBounds();
          const psd = state.psd;
          if (b.width > 0 && b.height > 0) {
            const cssW = host.clientWidth;
            const cssH = host.clientHeight;
            const margin = 40;
            const fitScale = Math.min(
              (cssW - margin * 2) / b.width,
              (cssH - margin * 2) / b.height,
            );
            const z = Math.max(0.05, Math.min(fitScale, 8));
            // center 用 vp.zoom * baseFit 作为实际 scale
            const psd = state.psd;
            const baseFit = psd && psd.width > 0 && psd.height > 0
              ? Math.min((cssW - margin * 2) / psd.width, (cssH - margin * 2) / psd.height)
              : 1;
            const targetVpZoom = z / baseFit;
            // panX/panY：root.x = cssW/2 - psd.width*scale/2 + panX
            // 要让 bbox.center 落在 cssW/2：
            //   root.x + (b.x + b.width/2) * scale = cssW/2
            //   cssW/2 - psd.width*scale/2 + panX + (b.x + b.width/2) * scale = cssW/2
            //   panX = (psd.width/2 - b.x - b.width/2) * scale
            const scale = z;
            const panX = psd && psd.width > 0
              ? (psd.width / 2 - b.x - b.width / 2) * scale
              : -(b.x + b.width / 2) * scale;
            const panY = psd && psd.height > 0
              ? (psd.height - b.y - b.height / 2) * scale
              : -(b.y + b.height / 2) * scale;
            queueMicrotask(() => {
              if (!destroyed) {
                const curVp = usePixiBonesStore.getState().viewport;
                setViewport({
                  ...curVp,
                  zoom: Math.max(0.05, Math.min(targetVpZoom, 8)),
                  panX,
                  panY,
                });
              }
            });
          }
        }
        applyVisibility(state.psd, state.layerVisibility);
        drawHighlight(state.psd, state.selectedLayerId);
        drawBones(state.bones, state.selectedBoneId);
        center(state.psd);
        drawGrid(state.psd);
        drawCrosshair(state.psd);
        prev = state;
      });
      cleanups.push(unsub);

      resizeObs = new ResizeObserver(() => {
        if (destroyed) return;
        const s = usePixiBonesStore.getState();
        center(s.psd);
        drawGrid(s.psd);
        drawHighlight(s.psd, s.selectedLayerId);
        drawBones(s.bones, s.selectedBoneId);
      });
      resizeObs.observe(host);
    })();

    return cleanup;
  }, []);

  // 监听 editorMode：create 模式下画布 cursor 变十字
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = host.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    canvas.style.cursor = editorMode === 'create' ? 'crosshair' : 'default';
  }, [editorMode]);

  return (
    <div
      className="canvas-host flex-1 relative overflow-hidden"
      ref={hostRef}
      style={{ position: 'relative' }}
    >
      <CanvasOverlay />
    </div>
  );
}

function makeBone(node: BoneNode): EngineBone {
  const b = new EngineBone(node.name, {
    x: node.x, y: node.y,
    rotation: node.rotation,
    scaleX: node.scaleX, scaleY: node.scaleY,
    length: node.length,
  });
  (b as unknown as { _id: string })._id = node.id;
  return b;
}

function findLayerInPsd(psd: PixiBonesPsd, id: string): PixiBonesLayer | null {
  const visit = (layers: PixiBonesLayer[]): PixiBonesLayer | null => {
    for (const l of layers) {
      if (l.id === id) return l;
      const r = visit(l.children);
      if (r) return r;
    }
    return null;
  };
  return visit(psd.layers);
}
