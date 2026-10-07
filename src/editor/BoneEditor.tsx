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
      | { kind: 'marquee'; additive: boolean; startScreen: { x: number; y: number }; nowScreen: { x: number; y: number }; rect: Gfx; prevSelIds: string[] }
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
        // 画布还没初始化好尺寸时直接返回，避免算出 renderX/Y ≈ 0 把根骨推到画布外
        if (rw <= 0 || rh <= 0) return;
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

      // 网格 + 棋盘格一体化绘制：用同一个 checkerSize、同一个 sx/sy，
      // 保证棋盘格方块和 grid 线永远 100% 对齐（不会因为 float 误差错位）。
      // 棋盘格：浅色方块按奇偶坐标交替填在 gridLayer 上
      // grid line：在棋盘格交界处画 1px 线
      const CHECKER_LIGHT = 0x444446;   // 浅格（亮色）
      const CHECKER_DARK = 0x393939;    // 深格（暗色）—— 与 CSS 兜底色一致
      const GRID_LINE = 0x454548;       // grid 线颜色

      const drawGrid = (psd: PixiBonesPsd | null) => {
        gridLayer.clear();

        const sx = root.scale.x;
        const sy = root.scale.y;
        if (sx <= 0 || sy <= 0) return;
        // 棋盘格屏幕步长（像素）—— 与 updateCheckerSize 同步
        const CELL = checkerSize;
        // 棋盘格在 PSD 坐标系里的步长（世界单位）
        const CELL_W = CELL / Math.abs(sx);

        // 计算可视区域（世界坐标）。有 PSD 时夹紧到 PSD 边界，无 PSD 时覆盖整个画布。
        const minWX = (-root.x) / sx;
        const maxWX = (a.renderer.width - root.x) / sx;
        const minWY = (-root.y) / sy;
        const maxWY = (a.renderer.height - root.y) / sy;
        let left = Math.floor(minWX / CELL_W) * CELL_W;
        let right = Math.ceil(maxWX / CELL_W) * CELL_W;
        let top = Math.floor(minWY / CELL_W) * CELL_W;
        let bottom = Math.ceil(maxWY / CELL_W) * CELL_W;
        if (psd && psd.width > 0 && psd.height > 0) {
          // 有 PSD：夹紧到 PSD 边界（Spine 风格只在图像区域显示）
          left = Math.max(0, left);
          right = Math.min(psd.width, right);
          top = Math.max(0, top);
          bottom = Math.min(psd.height, bottom);
        }

        // ★ 关键：用整型 cell index 算奇偶（不要用 Math.floor(x/CELL_W)，
        //   当 x 是负数时 Math.floor 会向负无穷取整，导致第一个方块 index=-1 而不是 0）
        // 我们循环变量 x 从 left 开始，每次 +CELL_W，所以第 i 个方块的 index =
        // Math.round(left / CELL_W) + i。这样无论 left 是正数负数，奇偶判定都稳定。
        const xStart = Math.round(left / CELL_W);
        const yStart = Math.round(top / CELL_W);

        // ★ 棋盘格：在奇数行/列填浅色方块（(行+列) % 2 === 0 时填浅色）
        let iy = 0;
        for (let y = top; y < bottom; y += CELL_W) {
          const sy0 = root.y + y * sy;
          const h = Math.min(CELL_W, bottom - y) * sy;
          let ix = 0;
          for (let x = left; x < right; x += CELL_W) {
            const sx0 = root.x + x * sx;
            const w = Math.min(CELL_W, right - x) * sx;
            const isLight = ((xStart + ix + (yStart + iy)) % 2) === 0;
            gridLayer.rect(sx0, sy0, w, h).fill({ color: isLight ? CHECKER_LIGHT : CHECKER_DARK });
            ix++;
          }
          iy++;
        }

        // ★ grid 线：画在棋盘格交界（用世界步长 CELL_W 算屏幕坐标）
        // 起点 = left，终点 = right + 半个格子（最后一条线在棋盘格最右边）
        const lastX = right;
        const lastY = bottom;
        for (let x = left; x <= lastX; x += CELL_W) {
          const sx0 = root.x + x * sx;
          gridLayer
            .moveTo(sx0, root.y + top * sy)
            .lineTo(sx0, root.y + lastY * sy)
            .stroke({ width: 1, color: GRID_LINE, alpha: 0.5 });
        }
        for (let y = top; y <= lastY; y += CELL_W) {
          const sy0 = root.y + y * sy;
          gridLayer
            .moveTo(root.x + left * sx, sy0)
            .lineTo(root.x + lastX * sx, sy0)
            .stroke({ width: 1, color: GRID_LINE, alpha: 0.5 });
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

      // ★ 棋盘格尺寸：
      //   - 默认：vp.zoom=1 时 = CHECKER_BASE = 20px
      //   - 下限：zoom=0.1 时 = 5px（再小就看不见了）
      //   - 上限：zoom=8 时 = 160px（封顶防爆屏）
      // 公式：size = round(CHECKER_BASE * min(rawScale, MAX_SCALE))
      //       再夹下限 max(CHECKER_MIN_PX, size)
      const CHECKER_BASE = 20;          // vp.zoom=1 时的初始棋盘格大小（像素）
      const CHECKER_MIN_PX = 5;         // 棋盘格最小像素（zoom=0.1 时 = 5px）
      const CHECKER_MAX_SCALE = 8;      // 棋盘格最大缩放倍数（封顶防爆屏）
      let checkerSize = CHECKER_BASE;
      const updateCheckerSize = () => {
        const rawScale = Math.abs(root.scale.x);
        // 1. 先按 vp.zoom 比例算，再封顶
        const scaled = Math.round(CHECKER_BASE * Math.min(rawScale, CHECKER_MAX_SCALE));
        // 2. 夹下限（避免 zoom 极小时棋盘格变成 1-2px 的噪点）
        const size = Math.max(CHECKER_MIN_PX, scaled);
        if (size === checkerSize) return;
        checkerSize = size;
      };

      let skeletonRef: Skeleton | null = null;
      const boneById = new Map<string, EngineBone>();
      // ★ jointHit 缓存：按 id 复用，drawBones 频繁调用时同一个 jointHit 不被 destroy，
      //   PIXI 的 hit-test 和 hover 状态才能正常工作。
      const hitById = new Map<string, Gfx>();

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

      const drawBones = (nodes: BoneNode[], selectedBoneId: string | null, selectedBoneIds?: string[]) => {
        bonesLayer.clear();
        if (!skeletonRef || nodes.length === 0) return;
        // 当前 hover 的骨骼 id（用于图标 hover 高亮变浅）
        const hoveredBoneId = usePixiBonesStore.getState().hoveredBoneId;

        // 多选判定：传入 selectedBoneIds 则用其，否则 fallback 到单选 id
        const isMultiSel = (id: string | undefined) =>
          id !== undefined && (selectedBoneIds ? selectedBoneIds.includes(id) : id === selectedBoneId);

        const sx = root.scale.x;
        const sy = root.scale.y;
        const ox = root.x;
        const oy = root.y;

        const BONE_COLOR = 0x9ca3af;     // 未选中：灰色
        const SELECTED_COLOR = 0xF0E020;   // 选中：黄色
        const HOVER_COLOR = 0xC8CCD4;     // hover：浅灰（比默认亮一档）
        const sAvg = (Math.abs(sx) + Math.abs(sy)) / 2;  // 平均缩放

        // 根骨视觉锚点：center() 推给 store.render 的"十字位置"
        // - 有 PSD 时 = PSD 底部中心（Spine 风格：根骨 = 图像原点）
        // - 无 PSD 时 = 画布中心
        // 用它代替 ox/oy 来画根骨图标，否则会画在 root.x/y（PSD 模式下是左上角，跑偏到 -100/-100）
        const renderInfo = usePixiBonesStore.getState().render;
        const rootAnchorX = renderInfo.x;
        const rootAnchorY = renderInfo.y;

        const visit = (bone: EngineBone, isSelected: boolean, length: number) => {
          const p0 = skeletonRef!.getWorldPosition(bone);
          const p1 = skeletonRef!.getWorldTip(bone);
          if (length === 0) {
            // 0 长度骨骼 = 根骨骼图标（按 Codex 设计的 spine 风格图标）
            // 几何：viewBox 446x335，anchor (223, 167)，左右臂不对称（右侧更长指向 +X）
            // 4 条 line + 双圆环（外环 stroke、内环深色填充当背景）
            const cx = rootAnchorX;
            const cy = rootAnchorY;
            // 颜色优先级：选中 > hover > 默认
            // - 选中：黄色
            // - 未选中但 hover：浅灰（HOVER_COLOR）
            // - 默认：灰（BONE_COLOR）
            let color: number;
            const rootBoneId = (bone as unknown as { _id?: string })._id;
            if (isSelected) {
              color = SELECTED_COLOR;
            } else if (hoveredBoneId === rootBoneId) {
              color = HOVER_COLOR;
            } else {
              color = BONE_COLOR;
            }
            // anchor (viewBox 中心) — 4 条 line 都相对它对称布置
            const ax = 223;
            const ay = 167;
            // 4 条 line 端点（viewBox 局部坐标）
            const strokeW = 12;
            // 内圈背景色（深灰，避免和外圈 stroke 之间留白显出画布底色）
            const innerBg = 0x1a1d22;
            // ★ Spine 风格：图标尺寸不严格跟着 root.scale 走。
            // 原因：zoom 很小时图标消失、zoom 很大时图标爆炸。
            // 策略：在 MIN/MAX 之间跟随 zoom，超出范围夹紧。
            // 这样新建项目（默认 zoom=1）图标适中，放到最大也不会变巨无霸。
            const MIN_ICON_SCALE = 0.1;   // zoom < 0.6 时图标固定 0.6 倍
            const MAX_ICON_SCALE = 0.3;   // zoom > 1.8 时图标固定 1.8 倍（不再放大）
            const A = Math.max(MIN_ICON_SCALE, Math.min(sAvg, MAX_ICON_SCALE));
            // 局部→屏幕 = (cx + (localX - ax) * A, cy + (localY - ay) * A)
            const tx = (lx: number) => cx + (lx - ax) * A;
            const ty = (ly: number) => cy + (ly - ay) * A;
            // 4 条带圆头的线段（左/上/下 短，右 长 指向 +X）
            // 左臂 [121, 167] → [176, 167]（靠近中心）
            bonesLayer.moveTo(tx(121), ty(167)).lineTo(tx(176), ty(167))
              .stroke({ width: strokeW * A, color, cap: 'round' });
            // 右臂 [270, 167] → [370, 167]（最长，指向 +X）
            bonesLayer.moveTo(tx(270), ty(167)).lineTo(tx(370), ty(167))
              .stroke({ width: strokeW * A, color, cap: 'round' });
            // 上臂 [223, 65] → [223, 120]
            bonesLayer.moveTo(tx(223), ty(65)).lineTo(tx(223), ty(120))
              .stroke({ width: strokeW * A, color, cap: 'round' });
            // 下臂 [223, 214] → [223, 269]
            bonesLayer.moveTo(tx(223), ty(214)).lineTo(tx(223), ty(269))
              .stroke({ width: strokeW * A, color, cap: 'round' });
            // 双圆环（先画内圈深色背景，再画外圈 stroke 覆盖）
            // 内圈实心填充（深色）— 让中央不会透出画布
            bonesLayer.circle(tx(223), ty(167), 26 * A).fill({ color: innerBg });
            // 外圈 stroke（带圆角端点，模仿原图）
            bonesLayer.circle(tx(223), ty(167), 32 * A)
              .stroke({ width: 12 * A, color, cap: 'round' });
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
            const sel = isMultiSel((c as unknown as { _id?: string })._id);
            visit(c, sel, c.length);
          }
        };
        const rootSelected = isMultiSel((skeletonRef.root as unknown as { _id?: string })._id);
        visit(skeletonRef.root, rootSelected, skeletonRef.root.length);

        for (const node of nodes) {
          const b = boneById.get(node.id);
          if (!b) continue;
          // 单选兼容：优先用 selectedBoneIds（多选），fallback 到 selectedBoneId
          const isSelected = (selectedBoneIds && selectedBoneIds.length > 0)
            ? selectedBoneIds.includes(node.id)
            : node.id === selectedBoneId;

          const origin = skeletonRef.getWorldPosition(b);
          // 根骨 (length=0) 的世界坐标 (0,0) 经过 ox/oy 映射会跑到 root.x/root.y
          // （PSD 模式下是左上角 ~-100/-100），必须用 rootAnchor（PSD 底部中心 / 画布中心）
          const oX = node.length === 0 ? rootAnchorX : ox + origin.x * sx;
          const oY = node.length === 0 ? rootAnchorY : oy + origin.y * sy;
          // ★ jointHit 复用：按 id 缓存到 hitById 里，drawBones 多次调用时复用同一对象，
          //   PIXI 的 hit-test / hover 状态就不会失效。
          let jointHit = hitById.get(node.id) as (Gfx & { __boneId?: string }) | undefined;
          if (jointHit) {
            // 复用：只更新位置（hover 监听保留）
            jointHit.x = oX;
            jointHit.y = oY;
          } else {
            // 新建：带 hover 监听 + 标记 id
            jointHit = new Gfx() as Gfx & { __boneId?: string };
            jointHit.__boneId = node.id;
            // hit area：0 长度骨骼用大圆覆盖整个图标范围（图标最大半径约 30px）
            const hitR = node.length === 0 ? 32 : 16;
            jointHit
              .circle(0, 0, hitR)
              .fill({ color: 0xffffff, alpha: 0.001 });
            jointHit.eventMode = 'static';
            jointHit.cursor = 'pointer';
            // ★ hover 监听：进入时 setHoveredBoneId(id)，离开时清空。
            // 用 pointerenter/pointerleave 不冒泡，避免内部子元素切换误触发。
            jointHit.on('pointerenter', (ev: FederatedPointerEvent) => {
              ev.stopPropagation();
              usePixiBonesStore.getState().setHoveredBoneId(node.id);
            });
            jointHit.on('pointerleave', (ev: FederatedPointerEvent) => {
              ev.stopPropagation();
              const cur = usePixiBonesStore.getState().hoveredBoneId;
              if (cur === node.id) {
                usePixiBonesStore.getState().setHoveredBoneId(null);
              }
            });
            handlesLayer.addChild(jointHit);
            hitById.set(node.id, jointHit);
          }
          jointHit.x = oX;
          jointHit.y = oY;
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
              // Pose 模式（或其他）：单击选中 / Shift+点击多选 / 拖动平移
              const store = usePixiBonesStore.getState();
              const additive = ev.shiftKey;
              if (additive) {
                // Shift 多选：已在选 → 取消；未选 → 加入
                const cur = store.selectedBoneIds;
                if (cur.includes(node.id)) {
                  store.selectBones(cur.filter((id) => id !== node.id), false);
                } else {
                  store.selectBones([...cur, node.id], false);
                }
              } else {
                store.selectBone(node.id);
              }
              // 拖动开始前先快照一次 history（撤销能回到拖之前的位置）
              // pointermove 期间直接改 state 不入栈，避免一次拖出 N 条 history
              store.pushHistory();
              dragState = {
                kind: 'tip',
                boneId: node.id,
                startLocal: { x: node.x, y: node.y },
                startScreen: { x: ev.global.x, y: ev.global.y },
              };
            }
          });

          // 根骨 (length=0) 没有 tip，不画 tipHandle
          if (node.length === 0) {
            continue;
          }

          const tip = skeletonRef.getWorldTip(b);
          // 根骨 tip = 自身位置，用 rootAnchor 而不是 ox/oy
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
            // 拖动开始前快照一次 history（pointermove 期间不入栈）
            usePixiBonesStore.getState().pushHistory();
            dragState = {
              kind: 'tip-resize',
              boneId: node.id,
              startLength: node.length,
              startRotation: node.rotation,
              parentWorld: skeletonRef!.getWorldPosition(b),
              parentRotDeg,
              startScreen: { x: ev.global.x, y: ev.global.y },
              startScreenParent: {
                x: node.length === 0 ? rootAnchorX : ox + (skeletonRef!.getWorldPosition(b).x) * root.scale.x,
                y: node.length === 0 ? rootAnchorY : oy + (skeletonRef!.getWorldPosition(b).y) * root.scale.y,
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
          // 拖动期间直接写 state，不走 moveBone（moveBone 会入栈 history，导致一次拖出 N 条）
          const boneId = dragState.boneId;
          const newX = dragState.startLocal.x + localDx;
          const newY = dragState.startLocal.y + localDy;
          usePixiBonesStore.setState((s) => ({
            bones: s.bones.map((n) => (n.id === boneId ? { ...n, x: newX, y: newY } : n)),
          }));
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
          const newRot = dragState.startRot + (nowAngle - startAngle);
          // 直接写 state，不入栈（避免每次 mousemove 都产生一条 history）
          const boneId = dragState.boneId;
          usePixiBonesStore.setState((s) => ({
            bones: s.bones.map((n) => (n.id === boneId ? { ...n, rotation: newRot } : n)),
          }));
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
          drawBones(s.bones, s.selectedBoneId, s.selectedBoneIds);
        } else if (dragState.kind === 'marquee') {
          // 框选：实时画蓝色矩形 + 命中检测
          dragState.nowScreen = { x: ev.global.x, y: ev.global.y };
          const { startScreen, nowScreen, rect } = dragState;
          const x = Math.min(startScreen.x, nowScreen.x);
          const y = Math.min(startScreen.y, nowScreen.y);
          const w = Math.abs(nowScreen.x - startScreen.x);
          const h = Math.abs(nowScreen.y - startScreen.y);
          rect.clear();
          rect.rect(x, y, w, h)
              .stroke({ width: 1, color: 0x4FB8F8, alpha: 0.8 })
              .fill({ color: 0x4FB8F8, alpha: 0.12 });
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
        } else if (dragState.kind === 'marquee') {
          // 框选提交：计算框内骨 → setState
          const { startScreen, nowScreen, rect, additive, prevSelIds } = dragState;
          const xMin = Math.min(startScreen.x, nowScreen.x);
          const xMax = Math.max(startScreen.x, nowScreen.x);
          const yMin = Math.min(startScreen.y, nowScreen.y);
          const yMax = Math.max(startScreen.y, nowScreen.y);
          const hit: string[] = [];
          if (skeletonRef) {
            const insideRect = (x: number, y: number) =>
              x >= xMin && x <= xMax && y >= yMin && y <= yMax;
            for (const n of usePixiBonesStore.getState().bones) {
              const bone = boneById.get(n.id);
              if (!bone) continue;
              // 根 world → screen（根骨用 store.render 不用 ox/oy，避免被映射到 PSD 左上角）
              const r = usePixiBonesStore.getState().render;
              const p0 = skeletonRef.getWorldPosition(bone);
              const sx0 = n.length === 0 ? r.x : root.x + p0.x * root.scale.x;
              const sy0 = n.length === 0 ? r.y : root.y + p0.y * root.scale.y;
              // tip world → screen
              const p1 = skeletonRef.getWorldTip(bone);
              const sx1 = root.x + p1.x * root.scale.x;
              const sy1 = root.y + p1.y * root.scale.y;
              // 根 或 tip 任何一在框内即认为该骨被框中（Spine 风格）
              if (insideRect(sx0, sy0) || insideRect(sx1, sy1)) {
                hit.push(n.id);
              }
            }
          }
          if (additive) {
            // 增量：保留之前选 + 加入框选
            const merged = Array.from(new Set([...prevSelIds, ...hit]));
            usePixiBonesStore.getState().selectBones(merged, false);
          } else {
            usePixiBonesStore.getState().selectBones(hit, false);
          }
          // 清理框选矩形
          a.stage.removeChild(rect);
          rect.destroy();
        }
        dragState = null;
        a.canvas.style.cursor = 'default';
      };

      a.stage.eventMode = 'static';
      a.stage.hitArea = a.screen;
      a.stage.on('pointermove', onPointerMove);
      a.stage.on('pointerup', onPointerUp);
      a.stage.on('pointerupoutside', onPointerUp);

      // ★ hover 兜底：鼠标离开整个 stage 时清空 hover 状态。
      // 因为 drawBones 会 destroy 旧 jointHit（不触发 leave），新的也不会自动 enter，
      // 所以用 stage 级的 pointerleave 保证 hover 一定不会"粘住"。
      a.stage.on('pointerleave', () => {
        if (usePixiBonesStore.getState().hoveredBoneId !== null) {
          usePixiBonesStore.getState().setHoveredBoneId(null);
        }
      });

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
            // Pose 模式：点空白 = 启动框选 + 清空选中
            // 按住 Shift = 增量框选（不清空已有）
            const additive = ev.shiftKey;
            const rect = new Gfx();
            rect.eventMode = 'none';
            a.stage.addChild(rect);
            const store = usePixiBonesStore.getState();
            if (!additive) {
              // 单击空白且未拖动 = 清空选中
              store.selectBone(null);
            }
            dragState = {
              kind: 'marquee',
              additive,
              startScreen: { x: ev.global.x, y: ev.global.y },
              nowScreen: { x: ev.global.x, y: ev.global.y },
              rect,
              prevSelIds: store.selectedBoneIds,
            };
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
        const newZoom = Math.max(0.05, Math.min(curVp.zoom * factor, 8));
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
        drawBones(s.bones, s.selectedBoneId, s.selectedBoneIds);
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
        drawBones(state.bones, state.selectedBoneId, state.selectedBoneIds);
        center(state.psd);
        drawGrid(state.psd);
        drawCrosshair(state.psd);
        updateCheckerSize();   // ★ 棋盘格尺寸跟 zoom 走，但有 min/max 夹紧
        prev = state;
      });
      cleanups.push(unsub);

      // ResizeObserver debounce：CSS 动画（如 hierarchy-pop 220ms）过程中 host 宽度会变，
      // 但中间帧的尺寸是"过渡态"，拿去做 center 会导致 store.render 被推错值。
      // 用 rAF debounce 把多次回调合并成"动画结束后"的稳定尺寸。
      let resizeRaf = 0;
      resizeObs = new ResizeObserver(() => {
        if (destroyed) return;
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          if (destroyed) return;
          const s = usePixiBonesStore.getState();
          center(s.psd);
          drawGrid(s.psd);
          drawHighlight(s.psd, s.selectedLayerId);
          drawBones(s.bones, s.selectedBoneId, s.selectedBoneIds);
        });
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
