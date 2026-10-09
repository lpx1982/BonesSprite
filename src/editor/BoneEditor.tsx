import { useEffect, useRef, useState } from 'react';
import {
  Application,
  Container,
  Graphics as Gfx,
  Matrix,
  Mesh,
  MeshGeometry,
  Rectangle,
  Sprite,
  Texture,
  FederatedPointerEvent,
  FederatedWheelEvent,
} from 'pixi.js';
import { usePixiBonesStore, findBone, orderLayers, attachmentLayers, type BoneNode, type SlotBinding } from './store';
import { Bone as EngineBone } from '@engine/Bone';
import { Skeleton } from '@engine/Skeleton';
import { parsePsd, type PixiBonesLayer, type PixiBonesPsd, type PixiBonesSlot } from '@psd/index';
import type { MeshData } from '@psd/types';
import { importAssetFile } from './importAsset';
import { CanvasOverlay } from './CanvasOverlay';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * 骨骼调色板（按绑定顺序循环取色，权重面板 / 饼图 / 叠加 共用）。
 * 与 Editor.tsx 中的 BONE_PALETTE 保持一致。
 */
const BONE_PALETTE = [
  '#E61E1E', '#1E78E6', '#2EC75E', '#F0A020', '#9B59B6', '#16A085',
  '#E67E22', '#3498DB', '#E84393', '#27AE60', '#8E44AD', '#D35400',
];

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
  const activeTool = usePixiBonesStore((s) => s.activeTool);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let destroyed = false;
    let app: Application | null = null;
    let resizeObs: ResizeObserver | null = null;
    const cleanups: Array<() => void> = [];
    type DragState =
      | {
          kind: 'tip';
          boneId: string;
          startLocal: { x: number; y: number };
          startScreen: { x: number; y: number };
          /** 移动手柄分区：green=垂直骨方向、red=沿骨方向、center=自由移动 */
          moveZone?: 'green' | 'red' | 'center';
          /** 约束轴的世界角度（弧度），仅 moveZone 非 center 时有意义 */
          axisAngle?: number;
        }
      | { kind: 'rotate'; boneId: string; startRot: number; startScreen: { x: number; y: number } }
      | { kind: 'root-move'; boneId: string; startLocal: { x: number; y: number }; startScreen: { x: number; y: number } }
      | { kind: 'pan'; startScreen: { x: number; y: number }; startPan: { x: number; y: number } }
      | { kind: 'create-from'; parentId: string; startWorld: { x: number; y: number }; startScreen: { x: number; y: number }; preview: Gfx }
      | {
          kind: 'marquee';
          additive: boolean;
          startScreen: { x: number; y: number };
          nowScreen: { x: number; y: number };
          rect: Gfx;
          /** 按下时已选中的骨骼 / 素材（Shift 增量框选用） */
          prevSelIds: string[];
          prevSlotIds: string[];
          /** 按下位置命中的插槽（用于「单击图层 = 选中其插槽」） */
          hitSlotId: string | null;
        }
      | { kind: 'scale'; boneId: string; startScaleX: number; startScaleY: number; startScreen: { x: number; y: number }; originScreen: { x: number; y: number }; angle: number; zone: 'green' | 'red' | 'center' }
      | { kind: 'shear'; boneId: string; startSkew: number; startScreen: { x: number; y: number }; originScreen: { x: number; y: number } }
      /** 在图层上做 4 个变换（旋转/移动/缩放/倾斜）。 */
      | {
          kind: 'layer-transform';
          tool: 'rotate' | 'move' | 'scale' | 'shear';
          slotId: string;
          start: { tx: number; ty: number; rotation: number; scaleX: number; scaleY: number; skewX: number; skewY: number };
          startScreen: { x: number; y: number };
          /** 图层锚点屏幕坐标（left+tx, top+ty 映射到画布） */
          anchorScreen: { x: number; y: number };
          /** 'red' / 'green' / 'center' —— move/scale/shear 区分区（决定约束轴） */
          zone: 'red' | 'green' | 'center';
          /**
           * 约束轴的屏幕角度（弧度）：
           *   - move:   red=沿图层 X 轴，green=垂直（绕图层旋转后的 +90°）
           *   - scale:  red=沿 X 轴缩放，green=沿 Y 轴缩放
           *   - shear:  red=沿 X 倾斜，green=沿 Y 倾斜
           *   - rotate: 总是绕锚点，axisAngle 未使用
           */
          axisAngle: number;
          /** 手柄在屏幕上的当前旋转角（move/scale/shear 手柄的 rotation，用于轴换算） */
          handleRotation: number;
        }
      /** 网格编辑：拖动一批顶点（修改工具） */
      | {
          kind: 'mesh-vertex';
          slotId: string;
          attachmentId: string;
          /** 参与拖动的顶点索引 */
          indices: number[];
          /** 拖动开始时的完整顶点数组副本 */
          startVertices: number[];
          /** 按下时的鼠标「附件局部坐标」 */
          startLocal: { x: number; y: number };
          /** 位移是否已写入 store（首帧才推历史） */
          moved: boolean;
          /** 软选择：每个顶点的位移权重（0..1）。未开软选择时 null → 只动 indices */
          softWeights: number[] | null;
        }
      /** 网格编辑：框选顶点（修改工具，空白处拖动） */
      | {
          kind: 'mesh-marquee';
          slotId: string;
          attachmentId: string;
          startScreen: { x: number; y: number };
          nowScreen: { x: number; y: number };
          rect: Gfx;
          additive: boolean;
          /** 按下时已选中的顶点 */
          prevSel: number[];
        }
      | null;
    /** 0 长度骨骼上的悬停分区（黑圈内=移动，圈外=旋转） */
    type HoverZone = { boneId: string; kind: 'move' | 'rotate' };
    let dragState: DragState = null;
    /** 最近一次鼠标在 stage 上的位置（Command 键按下/抬起时刷新悬停虚线框用） */
    let lastPointer = { x: -99999, y: -99999 };
    /** Command（mac ⌘）键是否按下 */
    let metaDown = false;
    /** 网格编辑：上一次点击的顶点（双击同一顶点 320ms 内 = 删除） */
    let lastVertexClick = { idx: -1, t: 0 };

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

      // IK 旋转手柄单独一层，永远压在骨骼命中区之上，
      // 避免手柄与子骨骼关节重合时点不到手柄
      const ikLayer = new Container();
      ikLayer.eventMode = 'static';
      a.stage.addChild(ikLayer);

      const highlight = new Gfx();
      a.stage.addChild(highlight);

      // 创建模式 + 按住 Command 时，鼠标悬停素材显示的白色虚线框（拾取提示）
      const attachmentHover = new Gfx();
      a.stage.addChild(attachmentHover);

      // 选中图层 + 4 个变换工具（move / rotate / scale / shear）时画在图层上的手柄。
      // 画在 sprite 旁边（不是它的子节点），便于接收 pointerdown 触发 layer-transform 拖动。
      const slotHandles = new Gfx();
      a.stage.addChild(slotHandles);

      // 网格编辑：顶点 / 边 / 三角形的绘制层（仿 Spine 的网格编辑）。
      // 不接收事件（命中由 stage 的 pointerdown + 自己算顶点距离处理）。
      const meshHandles = new Gfx();
      meshHandles.eventMode = 'none';
      a.stage.addChild(meshHandles);

      // 旋转拖动时跟随鼠标的绿色旋转光标（Spine 风格：按下出现，松开消失）
      const rotateCursor = new Gfx();
      rotateCursor.eventMode = 'none';
      rotateCursor.visible = false;
      drawIkHandle(rotateCursor, 0x4FF800, 0.85);
      a.stage.addChild(rotateCursor);

      // 「旋转工具」激活时，绘制在选中骨骼关节处的红色环（让用户知道当前是旋转模式）
      //   - 子骨骼：关节处画红环
      //   - 根骨骼：根骨图标外面画红环
      const rotateToolIndicator = new Gfx();
      rotateToolIndicator.eventMode = 'none';
      rotateToolIndicator.visible = false;
      a.stage.addChild(rotateToolIndicator);

      const showRotateCursor = (x: number, y: number) => {
        rotateCursor.x = x;
        rotateCursor.y = y;
        rotateCursor.visible = true;
        // 隐藏系统光标，只显示绿色旋转图标（!important 才能压过 PIXI 写的 cursor）
        a.canvas.style.setProperty('cursor', 'none', 'important');
      };
      const hideRotateCursor = () => {
        rotateCursor.visible = false;
        a.canvas.style.removeProperty('cursor');
      };

      /** 插槽 id → 该插槽渲染出来的 wrap（内含 1 个 Sprite 或 Mesh）。
       *  ★ 每个插槽一份 view：同一素材被多个插槽引用时，两处各自渲染一份。 */
      const viewBySlotId = new Map<string, Container>();
      /** 插槽 id → 该插槽 wrap 相对 root 的矩阵（6 元组，由 applyBindings 写入）。
       *  供「屏幕 ⇄ 附件局部坐标」换算用，避免依赖 PIXI 内部矩阵的更新时机。 */
      const wrapMatrixBySlot = new Map<string, number[]>();
      const canvasRefs = new Set<HTMLCanvasElement>();

      a.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      // ---- PSD 拖拽进画布 ----
      let dragCounter = 0;
      const showDropHint = (show: boolean) => {
        let hint = document.getElementById('pixibones-drop-hint');
        if (show && !hint) {
          hint = document.createElement('div');
          hint.id = 'pixibones-drop-hint';
          hint.textContent = '📁 放开导入素材（.psd / 图片）';
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
        try {
          await importAssetFile(file);
        } catch (err) {
          console.error('[BoneEditor] 素材解析失败:', err);
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

      /** PSD 图层 + 单独导入的图片 → 全部「附件」（可渲染的）。 */
      const allAttachmentsOf = (psd: PixiBonesPsd | null, images: PixiBonesLayer[]): PixiBonesLayer[] =>
        attachmentLayers(psd, images);

      /**
       * 当前「要绘制的插槽 → 激活附件」列表，按绘制顺序（slotOrder，索引 0 = 最底层）排列。
       * 只有插槽的 activeAttachmentId 指向的那个附件会被绘制。
       */
      const renderablesOf = (
        psd: PixiBonesPsd | null,
        images: PixiBonesLayer[],
        slots: PixiBonesSlot[],
      ): Array<{ slot: PixiBonesSlot; layer: PixiBonesLayer }> => {
        const byId = new Map(allAttachmentsOf(psd, images).map((l) => [l.id, l]));
        const ordered = orderLayers(slots, usePixiBonesStore.getState().slotOrder);
        const out: Array<{ slot: PixiBonesSlot; layer: PixiBonesLayer }> = [];
        for (const slot of ordered) {
          const id = slot.activeAttachmentId;
          if (!id) continue;
          const layer = byId.get(id);
          if (layer) out.push({ slot, layer });
        }
        return out;
      };

      /** 插槽渲染出来的 view：区域附件是 Sprite（4 角），网格附件是 Mesh（三角网格）。 */
      type AttachView = Sprite | Mesh;

      /**
       * 为一个插槽创建 view —— 渲染它当前激活的那个附件。
       * ★ 每个插槽一份 view：同一素材被多个插槽引用时（如一把枪给左手 / 右手），
       *   两处各自渲染一份，互不影响。
       * ★ 有网格数据（attachmentMeshes[layer.id]）→ 用 Mesh 渲染三角网格；否则用 Sprite。
       *   两者坐标系一致（都在 wrap 局部，position = layer.left/top），后续绑定 / 变换 / 颜色逻辑通用。
       */
      const addSlotView = (
        slot: PixiBonesSlot,
        layer: PixiBonesLayer,
        mesh: MeshData | undefined,
      ) => {
        if (!layer.canvas) return;
        if (layer.canvas.width === 0 || layer.canvas.height === 0) return;

        const tex = Texture.from(layer.canvas);
        tex.source.resize();

        let view: AttachView;
        if (mesh && mesh.vertices.length >= 6 && mesh.indices.length >= 6) {
          // 网格附件：顶点已是「相对图层左上角」的像素坐标，UV 归一化 0..1
          const geometry = new MeshGeometry({
            positions: new Float32Array(mesh.vertices),
            uvs: new Float32Array(mesh.uvs),
            indices: new Uint32Array(mesh.indices),
          });
          const m = new Mesh({ geometry, texture: tex });
          m.position.set(layer.left, layer.top);
          view = m;
        } else {
          const s = new Sprite(tex);
          s.position.set(layer.left, layer.top);
          view = s;
        }

        view.alpha = layer.opacity;
        view.visible = true;
        (view as unknown as { blendMode: string }).blendMode = layer.blendMode;
        view.eventMode = 'static';
        view.cursor = 'pointer';
        // 标记：让 stage 的 pointerdown 能识别「点在哪个插槽画出来的图」上。
        // view 自身不拦截事件，统一交给 stage 处理（单击=选中插槽 / 拖动=框选）。
        (view as unknown as { __slotId: string }).__slotId = slot.id;

        const wrap = new Container();
        wrap.label = slot.name;
        wrap.addChild(view);
        root.addChild(wrap);

        viewBySlotId.set(slot.id, wrap);
        canvasRefs.add(layer.canvas);
      };

      /** 重建全部 view —— 按绘制顺序，每个插槽渲染它当前激活的附件。 */
      const rebuildAssets = (
        psd: PixiBonesPsd | null,
        images: PixiBonesLayer[],
        slots: PixiBonesSlot[],
      ) => {
        while (root.children.length > 0) {
          const c = root.children[0];
          root.removeChild(c);
          c.destroy({ children: true, texture: true });
        }
        viewBySlotId.clear();
        canvasRefs.clear();

        const st = usePixiBonesStore.getState();
        const meshes = st.attachmentMeshes;
        wrapMatrixBySlot.clear();
        for (const { slot, layer } of renderablesOf(psd, images, slots)) {
          // ★ 网格「作用于画面」的规则（对齐 Spine）：
          //   - **裁切永远生效**：只要有网格（新建闭合 / 描绘确定后 / 退出编辑后），
          //     画面就裁到网格轮廓内，只显示轮廓内像素；
          //   - **顶点不产生"变形"**：只有权重绑定后才按骨骼变形（蒙皮）。
          //   - 例外：**正在编辑**这个插槽 且 未勾选「变形」→ 显示完整原图（方便看清整张图调顶点）；
          //     正在用「新建」逐点描绘轮廓时 → 也必须显示完整原图（否则看不见要描的边）。
          const m = meshes[layer.id];
          const hasWeights = !!(m && m.bones && m.bones.length > 0);
          const editingThisSlot = slot.id === st.meshEditSlotId;
          const drawingNew = editingThisSlot && !!st.meshNewPolygon;
          const showFullImage = (editingThisSlot && !st.meshDeformed) || drawingNew;
          const useMesh = !showFullImage || hasWeights;
          addSlotView(slot, layer, useMesh ? meshes[layer.id] : undefined);
        }
      };

      /**
       * 应用显隐：插槽可见 → 该插槽的 sprite 可见。
       * sprite 本身已经是「该插槽当前激活附件」的那一份（非激活附件不参与渲染）。
       * 插槽可见性默认取激活附件自身的 visible（保留 PSD 里隐藏图层的语义）。
       */
      const applyVisibility = (
        psd: PixiBonesPsd | null,
        images: PixiBonesLayer[],
        slots: PixiBonesSlot[],
        overrides: Record<string, boolean>,
      ) => {
        const byId = new Map(allAttachmentsOf(psd, images).map((l) => [l.id, l]));
        const st = usePixiBonesStore.getState();
        // 网格「隔离」：只显示正在编辑的那个插槽，其余全部隐藏
        const isolateId = st.meshIsolate ? st.meshEditSlotId : null;
        for (const slot of slots) {
          const wrap = viewBySlotId.get(slot.id);
          if (!wrap) continue;
          if (isolateId && slot.id !== isolateId) {
            wrap.visible = false;
            continue;
          }
          const active = slot.activeAttachmentId ? byId.get(slot.activeAttachmentId) ?? null : null;
          wrap.visible = overrides[slot.id] ?? active?.visible ?? true;
        }
      };

      /**
       * 应用「插槽 → 骨骼」绑定 + 插槽的局部变换（key 都是 slotId）。
       *
       * 绑定表里存的是「绑定那一刻骨骼的世界矩阵 ref」。
       *   渲染时用增量 delta = 当前世界矩阵 × ref⁻¹ 驱动 wrap：
       *   所以绑定动作本身不会让图层跳动（delta = I），之后骨骼怎么动图层就怎么跟。
       *
       * 插槽的旋转/缩放/倾斜/平移（slotTransforms）**叠加在**骨骼矩阵之后，
       * 枢轴 = 该插槽**当前激活附件**的中心。
       * 非激活附件保持原位（它们本来就不显示）。
       */
      const applyBindings = (
        psd: PixiBonesPsd | null,
        images: PixiBonesLayer[],
        slots: PixiBonesSlot[],
        bindings: Record<string, SlotBinding>,
        slotTransforms: Record<string, { tx: number; ty: number; rotation: number; scaleX: number; scaleY: number; skewX: number; skewY: number }>,
      ) => {
        const byId = new Map(allAttachmentsOf(psd, images).map((l) => [l.id, l]));
        // ★ 读一下当前 store 的 attachmentMeshes：
        //   当某 attachment 已绑骨骼（mesh.bones 非空）时，applyBindings 不要把它绑的骨骼矩阵当 wrap.matrix 的骨骼驱动用
        //   （wrap.matrix 此时只承担 slot transform + 图层偏移；顶点位置由 applySkinning 按权重算 root 坐标）。
        const meshesNow = usePixiBonesStore.getState().attachmentMeshes;
        for (const slot of slots) {
          // ★ 每插槽一份 sprite：直接取该插槽当前激活的附件
          const wrap = viewBySlotId.get(slot.id);
          if (!wrap) continue;
          const aid = slot.activeAttachmentId;
          const layer = aid ? byId.get(aid) ?? null : null;
          if (!layer) continue;
          const view = wrap.children[0] as AttachView | undefined;
          {
            const binding = bindings[slot.id];
            const bone = binding ? boneById.get(binding.boneId) : null;
            const lt = slotTransforms[slot.id];
            // 1) 计算骨骼驱动矩阵（列主序 6 元组）
            let m = [1, 0, 0, 1, 0, 0]; // 单位
            // ★ 已绑骨骼（mesh 形态）→ 跳过骨骼驱动（由 applySkinning 接管）
            const meshSkinned = aid ? (meshesNow[aid]?.bones && meshesNow[aid]!.bones!.length > 0) : false;
            if (binding && bone && !meshSkinned) {
              const inv = invAffine(binding.ref);
              if (inv) {
                const e = bone.worldMatrix.elements;
                const cur = [e[0], e[1], e[3], e[4], e[6], e[7]];
                m = mulAffine(cur, inv);
              }
            }
            // 2) 叠加插槽的局部变换（平移 = C − L×(w/2, h/2)，枢轴 = 激活附件中心）
            const txL = lt?.tx ?? 0;
            const tyL = lt?.ty ?? 0;
            const rot = lt?.rotation ?? 0;
            const sx = lt?.scaleX ?? 1;
            const sy = lt?.scaleY ?? 1;
            const skx = lt?.skewX ?? 0;
            const sky = lt?.skewY ?? 0;
            const tanKx = Math.tan(skx);
            const tanKy = Math.tan(sky);
            // aM = shear(skx, sky) ∘ scale(sx, sy)
            const aMx = sx;
            const aMy = 0;
            const aCx = tanKx * sx;
            const aCy = sy;
            const aBx = tanKy * sy;
            const aBy = 0;
            // 再叠加旋转 R ∘ M（对 M 的两列分别左乘 R）
            const cosR = Math.cos(rot);
            const sinR = Math.sin(rot);
            const Xx = aMx, Xy = aMy;
            const Yx = aCx + aBx, Yy = aCy + aBy;
            const m_a = cosR * Xx - sinR * Xy;
            const m_b = sinR * Xx + cosR * Xy;
            const m_c = cosR * Yx - sinR * Yy;
            const m_d = sinR * Yx + cosR * Yy;
            // ★ 枢轴居中化：枢轴 C = 激活附件中心
            const halfW = layer.width / 2;
            const halfH = layer.height / 2;
            const Cx = layer.left + txL + halfW;
            const Cy = layer.top + tyL + halfH;
            const lx = Cx - (m_a * halfW + m_c * halfH);
            const ly = Cy - (m_b * halfW + m_d * halfH);
            const slotLocal = [m_a, m_b, m_c, m_d, lx, ly];
            // 骨骼矩阵 m（左乘）：wrap = m × slotLocal
            const out = mulAffine(m, slotLocal);
            wrap.setFromMatrix(new Matrix(out[0], out[1], out[2], out[3], out[4], out[5]));
            wrapMatrixBySlot.set(slot.id, out);
            if (view) view.position.set(0, 0);
          }
        }
      };

      /**
       * 应用插槽 / 附件的颜色与混合模式（仿 Spine）：
       *   - 颜色：tint = 插槽色 × 附件色（逐分量相乘），都没设 = 白（不改）
       *   - 混合：附件 blend 优先，否则插槽 blend，都没设则沿用 PSD 自带的 layer.blendMode
       * 成本很低（遍历 slot × 附件，只写 sprite 属性），所以每次状态变化都可调用。
       */
      const applySlotStyles = (
        psd: PixiBonesPsd | null,
        images: PixiBonesLayer[],
        slots: PixiBonesSlot[],
        slotStyle: Record<string, { color: string; blend: string }>,
        attachmentStyle: Record<string, { color: string; blend: string }>,
      ) => {
        const byId = new Map(allAttachmentsOf(psd, images).map((l) => [l.id, l]));
        // 网格编辑模式：正在编辑的插槽用「网格工具」的指针
        //   （修改=移动 / 创建=箭头+「+」/ 删除=箭头+「-」，仿 Spine）
        const st = usePixiBonesStore.getState();
        const editingId = st.meshEditSlotId;
        const editCursor = editingId ? meshToolCursor(st.meshTool) : 'pointer';
        for (const slot of slots) {
          const wrap = viewBySlotId.get(slot.id);
          const view = wrap?.children[0] as AttachView | undefined;
          if (!view) continue;
          const aid = slot.activeAttachmentId;
          const layer = aid ? byId.get(aid) ?? null : null;
          if (!layer) continue;
          view.tint = composeTint(attachmentStyle[layer.id]?.color, slotStyle[slot.id]?.color);
          const blend = attachmentStyle[layer.id]?.blend || slotStyle[slot.id]?.blend || layer.blendMode;
          (view as unknown as { blendMode: string }).blendMode = blend || 'normal';
          const wantCursor = slot.id === editingId ? editCursor : 'pointer';
          if (view.cursor !== wantCursor) view.cursor = wantCursor;
        }
      };

      /** 鼠标悬停在手柄上时的高亮分区（与 zone 同义，但供绘图使用）。 */
      let slotHandleHover: 'red' | 'green' | 'center' | null = null;

      /**
       * 图层「手柄锚点」= 图层中心（含 tx/ty）在画布上的屏幕坐标。
       * ★ 手柄的绘制 / hover 判定 / pointerdown 分区 / 旋转，全部必须用这一个锚点，
       *   否则会像之前那样「画在中心、命中在左上角」而完全错位。
       */
      const attachmentAnchorScreen = (
        layer: { left: number; top: number; width: number; height: number },
        lt: { tx: number; ty: number },
      ) => {
        const sx = root.scale.x;
        const sy = root.scale.y;
        return {
          x: root.x + (layer.left + layer.width / 2 + lt.tx) * sx,
          y: root.y + (layer.top + layer.height / 2 + lt.ty) * sy,
        };
      };

      /**
       * 选中图层 + 4 个变换工具激活时，绘制对应手柄。
       * 直接复用骨骼的零长度手柄图标（drawRootMoveHandle / drawRotateIcon / drawScaleHandle* / drawInclineHandle），
       * 画在 slotHandles 中心（通过 Gfx 的 x/y 移动位置，draw 函数都按原点居中画）。
       *
       * 复用 drawScaleHandle* / drawRootMoveHandle 时不能直接传 hover 颜色（它们写死颜色），
       * 因此 hover 时先正常画，然后**叠一层白色**在命中区上做高亮。
       */
      const drawSlotHandles = (
        psd: PixiBonesPsd | null,
        images: PixiBonesLayer[],
        slots: PixiBonesSlot[],
        selectedSlotId: string | null,
        tool: 'rotate' | 'move' | 'scale' | 'shear' | null,
        _transforms: Record<string, { tx: number; ty: number; rotation: number; scaleX: number; scaleY: number; skewX: number; skewY: number }>,
      ) => {
        slotHandles.clear();
        // ★ 不要在这里改 eventMode！init 里已经设为 'static' 且只设一次；
        //   若每次 clear 后重设会把 init 的 'static' 覆盖成 'none' → 手柄永远收不到事件。
        //   没有几何图形时（clear 后未画）PIXI 命中测试自然失败，不会误吞事件。
        // 网格编辑模式下不显示插槽变换手柄（避免和网格顶点编辑冲突）
        if (usePixiBonesStore.getState().meshEditSlotId) return;
        if (!selectedSlotId || !tool) return;
        const slot = slots.find((s) => s.id === selectedSlotId) ?? null;
        const layer = slot?.activeAttachmentId
          ? allAttachmentsOf(psd, images).find((l) => l.id === slot.activeAttachmentId) ?? null
          : null;
        if (!slot || !layer || layer.width === 0 || layer.height === 0) return;
        const lt = _transforms[selectedSlotId] ?? { tx: 0, ty: 0, rotation: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 };
        // ★ 选中插槽「激活附件」的 sprite 光标：有工具时改成"可操作"光标，避免 PIXI 一直显示 pointer
        {
          const selSprite = viewBySlotId.get(slot.id)?.children[0] as AttachView | undefined;
          if (selSprite) {
            selSprite.cursor = tool === 'move' ? 'move'
              : tool === 'scale' ? 'nwse-resize'
              : tool === 'shear' ? 'move'
              : 'crosshair';
          }
        }
        // 把手柄放在图层中心（统一锚点）
        const { x: cx, y: cy } = attachmentAnchorScreen(layer, lt);
        slotHandles.x = cx;
        slotHandles.y = cy;
        // ★ 手柄跟着图层自身旋转（红轴 = 图层 X 方向、绿轴 = 图层 Y 方向），
        //   这样 axisAngle / 分区判定（都按 -lt.rotation 反旋转）和视觉轴完全一致。
        slotHandles.rotation = lt.rotation ?? 0;
        if (tool === 'move') {
          drawRootMoveHandle(slotHandles, slotHandleHover === 'green' ? 'green' : slotHandleHover === 'red' ? 'red' : null);
        } else if (tool === 'rotate') {
          drawRotateIcon(slotHandles, 1.4);
        } else if (tool === 'scale') {
          // 复画一次：默认色；再按 hover 叠对应轴为白
          drawScaleHandleGreen(slotHandles);
          drawScaleHandleRed(slotHandles);
          if (slotHandleHover === 'green') {
            refillPolys(slotHandles, SCALE_GREEN_POLYS, 0.15, SCALE_HANDLE_ANCHOR.x, SCALE_HANDLE_ANCHOR.y, 0xFFFFFF);
          } else if (slotHandleHover === 'red') {
            refillPolys(slotHandles, SCALE_RED_POLYS, 0.15, SCALE_HANDLE_ANCHOR.x, SCALE_HANDLE_ANCHOR.y, 0xFFFFFF);
          }
        } else if (tool === 'shear') {
          drawInclineHandle(slotHandles);
          // 倾斜 hover：左半(red)=X 倾斜 / 右半(green)=Y 倾斜；用 white 覆盖整块作为简版
          if (slotHandleHover === 'red' || slotHandleHover === 'green') {
            // 找到屏外手柄的 x 范围（粗略）：手柄外接半径约 ±25px
            // 用白色十字作为 hover 提示（中心点 + 横线 / 竖线）
            if (slotHandleHover === 'red') {
              // X 倾斜高亮：横向条
              slotHandles.rect(-22, -3, 44, 6).fill({ color: 0xFFFFFF, alpha: 0.5 });
            } else {
              // Y 倾斜高亮：纵向条
              slotHandles.rect(-3, -22, 6, 44).fill({ color: 0xFFFFFF, alpha: 0.5 });
            }
          }
        }
      };

      /**
       * 当前正在编辑的网格上下文（不在网格编辑态 / 数据不全时返回 null）。
       */
      const meshEditContext = () => {
        const s = usePixiBonesStore.getState();
        const slotId = s.meshEditSlotId;
        if (!slotId) return null;
        const slot = s.slots.find((x) => x.id === slotId) ?? null;
        const attachmentId = slot?.activeAttachmentId ?? null;
        const mesh = attachmentId ? s.attachmentMeshes[attachmentId] ?? null : null;
        const layer = attachmentId
          ? allAttachmentsOf(s.psd, s.images).find((l) => l.id === attachmentId) ?? null
          : null;
        if (!slot || !attachmentId || !mesh || !layer) return null;
        return { slot, attachmentId, mesh, layer };
      };

      /** 网格顶点 → 屏幕坐标数组 */
      const meshVerticesScreen = (slotId: string, layer: PixiBonesLayer, mesh: MeshData) => {
        const n = Math.floor(mesh.vertices.length / 2);
        const out: Array<{ x: number; y: number }> = new Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = attachmentLocalToScreen(slotId, layer, mesh.vertices[i * 2], mesh.vertices[i * 2 + 1]);
        }
        return out;
      };

      /**
       * 网格顶点 → 屏幕坐标数组（**考虑蒙皮**）。
       *  - 有骨骼绑定时：顶点 = (left,top) + bindPose + Σ w_j·(bone_now - bone_bind)，再转屏幕；
       *    这样拖动骨骼后，画布上的顶点手柄也会跟着变形后的位置走。
       *  - 无骨骼绑定时：直接退回 meshVerticesScreen（顶点 = mesh.vertices）。
       */
      const skinnedVerticesScreen = (slotId: string, layer: PixiBonesLayer, mesh: MeshData) => {
        const bones = mesh.bones;
        const weights = mesh.weights;
        const bindPose = mesh.bindPose;
        if (!bones || bones.length === 0 || !weights || !bindPose) {
          return meshVerticesScreen(slotId, layer, mesh);
        }
        const boneBindWorld = mesh.boneBindWorld ?? [];
        const nb = bones.length;
        const n = Math.floor(bindPose.length / 2);
        const out: Array<{ x: number; y: number }> = new Array(n);
        for (let i = 0; i < n; i++) {
          // v_root = (left,top) + bindPose + Σ w_j·(bone_now - bone_bind)
          let vx = layer.left + bindPose[i * 2];
          let vy = layer.top + bindPose[i * 2 + 1];
          const row = i * nb;
          for (let j = 0; j < nb; j++) {
            const w = weights[row + j];
            if (w === 0) continue;
            const bn = skeletonRef ? findBoneByRefWorld(skeletonRef, bones[j]) : null;
            let nowX = 0, nowY = 0;
            if (bn) { const e = bn.worldMatrix.elements; nowX = e[6]; nowY = e[7]; }
            const dx = nowX - (boneBindWorld[j * 2] ?? 0);
            const dy = nowY - (boneBindWorld[j * 2 + 1] ?? 0);
            vx += w * dx;
            vy += w * dy;
          }
          out[i] = { x: root.x + vx * root.scale.x, y: root.y + vy * root.scale.y };
        }
        return out;
      };

      /** 唯一网格边 + 每条边被几个三角形共享（n=1 → 边界边；n=2 → 内部边）。 */
      const meshEdgeInfo = (mesh: MeshData) => {
        const map = new Map<number, { a: number; b: number; n: number }>();
        const idx = mesh.indices;
        const vn = Math.max(1, Math.floor(mesh.vertices.length / 2));
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const tri = [idx[t], idx[t + 1], idx[t + 2]];
          for (let k = 0; k < 3; k++) {
            const a = tri[k];
            const b = tri[(k + 1) % 3];
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            const key = lo * vn + hi;
            const cur = map.get(key);
            if (cur) cur.n++;
            else map.set(key, { a: lo, b: hi, n: 1 });
          }
        }
        return [...map.values()];
      };

      /**
       * 「网格工具」软选择：算出每个顶点的位移权重（0..1）。
       *   显式选中的顶点 = 1；
       *   其余顶点按「到最近选中顶点的距离 d」（附件局部单位）：
       *     d ≤ (1−羽化)·大小        → 1（完全选中）
       *     (1−羽化)·大小 < d ≤ 大小 → 线性衰减到 0
       *     d > 大小                 → 0
       *   「外壳顶点」未勾选时，外壳（边界）顶点权重强制 0 —— 这样拖内部顶点
       *   伪造 3D 时不会改变网格外形（对齐 Spine 文档）。
       */
      const computeSoftWeights = (
        mesh: MeshData,
        selected: number[],
        size: number,
        feather: number,
        includeHull: boolean,
      ): number[] => {
        const n = Math.max(0, Math.floor(mesh.vertices.length / 2));
        const w = new Array<number>(n).fill(0);
        const sel = selected.filter((i) => i >= 0 && i < n);
        for (const i of sel) w[i] = 1;
        if (sel.length === 0 || size <= 0) return w;
        let hull: Set<number> | null = null;
        if (!includeHull) {
          hull = new Set<number>();
          for (const e of meshEdgeInfo(mesh)) {
            if (e.n === 1) { hull.add(e.a); hull.add(e.b); }
          }
        }
        const inner = Math.max(0, Math.min(feather, 0.99)) * size;   // 完全选中半径
        const outer = Math.max(size, inner + 1e-6);
        for (let i = 0; i < n; i++) {
          if (w[i] === 1) continue;                  // 显式选中
          if (hull && hull.has(i)) continue;         // 外壳顶点不参与
          let best = Infinity;
          const x = mesh.vertices[i * 2];
          const y = mesh.vertices[i * 2 + 1];
          for (const j of sel) {
            const d = Math.hypot(x - mesh.vertices[j * 2], y - mesh.vertices[j * 2 + 1]);
            if (d < best) best = d;
          }
          if (!isFinite(best) || best > outer) continue;
          w[i] = best <= inner ? 1 : (outer - best) / (outer - inner);
        }
        return w;
      };

      /** 两个 0xRRGGBB 颜色按 t 线性插值（软选择顶点着色用）。 */
      const lerpColor = (a: number, b: number, t: number): number => {
        const k = Math.max(0, Math.min(1, t));
        const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
        const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
        const r = Math.round(ar + (br - ar) * k);
        const g = Math.round(ag + (bg - ag) * k);
        const bl = Math.round(ab + (bb - ab) * k);
        return (r << 16) | (g << 8) | bl;
      };

      /**
       * 画网格的顶点 / 边 / 三角形。三种情况会画：
       *   1) 该插槽正在网格编辑 → 顶点高亮、可交互
       *   2) 该插槽被选中 → 只读显示
       *   3) 该附件勾了「线框」→ 只读显示
       * 边界边（只属于 1 个三角形）总是画；内部边只在勾选「三角形」时画（显示三角剖分）。
       */
      const drawMeshHandles = () => {
        meshHandles.clear();
        const s = usePixiBonesStore.getState();
        const byId = new Map(allAttachmentsOf(s.psd, s.images).map((l) => [l.id, l]));
        const selected = new Set(s.meshSelectedVertices);
        const editSlotId = s.meshEditSlotId;
        // 网格「隔离」：只画正在编辑的插槽的顶点 / 边
        const isolateId = s.meshIsolate ? s.meshEditSlotId : null;
        // 正在描绘新轮廓时不画旧网格（避免干扰）
        const drawingNew = !!s.meshNewPolygon;

        for (const slot of s.slots) {
          if (drawingNew) break;
          if (isolateId && slot.id !== isolateId) continue;
          const aid = slot.activeAttachmentId;
          if (!aid) continue;
          const mesh = s.attachmentMeshes[aid];
          if (!mesh) continue;
          // ★ 绑定模式：目标网格进入「只显示选中蓝外轮廓」状态（顶点/三角隐藏）
          const isBindTarget = s.weightBindMode && !!s.weightMeshId && aid === s.weightMeshId;
          const isEditing = slot.id === editSlotId;
          const isSelected = slot.id === s.selectedSlotId;
          const isWire = !!s.meshWireframe[aid];
          if (!isBindTarget && !isEditing && !isSelected && !isWire) continue;
          if (s.slotVisibility[slot.id] === false) continue;
          const layer = byId.get(aid);
          if (!layer) continue;

          const pts = skinnedVerticesScreen(slot.id, layer, mesh);
          const edges = meshEdgeInfo(mesh);

          // 绑定模式：只画外轮廓边线（被选中的蓝线状态），顶点与三角剖分都隐藏
          if (isBindTarget) {
            for (const e of edges) {
              if (e.n !== 1) continue;
              const p0 = pts[e.a];
              const p1 = pts[e.b];
              if (!p0 || !p1) continue;
              meshHandles.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y);
            }
            meshHandles.stroke({ width: 1.4, color: 0x4FB8F8, alpha: 0.95 });
            continue;
          }

          // 边界边：总是画（网格外轮廓）
          for (const e of edges) {
            if (e.n !== 1) continue;
            const p0 = pts[e.a];
            const p1 = pts[e.b];
            if (!p0 || !p1) continue;
            meshHandles.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y);
          }
          meshHandles.stroke({
            width: isEditing ? 1.4 : 1,
            color: 0x4FB8F8,
            alpha: isEditing ? 0.95 : 0.55,
          });

          // 内部边（三角剖分线）：★ 只在「编辑网格」时显示（退出编辑后不画三角，对齐 Spine）
          if (isEditing && s.meshShowTriangles) {
            for (const e of edges) {
              if (e.n === 1) continue;
              const p0 = pts[e.a];
              const p1 = pts[e.b];
              if (!p0 || !p1) continue;
              meshHandles.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y);
            }
            meshHandles.stroke({
              width: 1,
              color: 0x9BD1FF,
              alpha: 0.7,
            });
          }

          // 顶点手柄：★ 编辑 / 选中 / 线框 时都显示（对齐 Spine：有顶点、无三角）。
          //   软选择着色只在编辑态有意义（softW 为 null 时走普通白点）。
          {
            const softOn = isEditing && s.meshSoftSelect && selected.size > 0;
            const softW = softOn
              ? computeSoftWeights(mesh, [...selected], s.meshSoftSize, s.meshSoftFeather, s.meshSoftHull)
              : null;
            const SEL_COLOR = softOn ? 0x4FE3E3 : 0xFFD34D;
            const SOFT_DARK = 0x1B2A4A;

            for (let i = 0; i < pts.length; i++) {
              const p = pts[i];
              if (!p) continue;
              const sel = isEditing && selected.has(i);
              const sw = softW ? softW[i] : 0;
              const softHit = !sel && sw > 0.001;
              const r = sel ? 5 : softHit ? 4 : (isEditing ? 3.5 : 2.5);
              const color = sel ? SEL_COLOR : softHit ? lerpColor(SOFT_DARK, SEL_COLOR, sw) : 0xFFFFFF;
              meshHandles.circle(p.x, p.y, r);
              meshHandles.fill({ color, alpha: isEditing ? 1 : 0.65 });
              meshHandles.circle(p.x, p.y, r);
              meshHandles.stroke({ width: 1, color: 0x1E6FBF, alpha: isEditing ? 1 : 0.5 });
            }
          }
        }

        // ---- 网格「新建」：正在描绘轮廓（逐点画多边形，点回起点即闭合）----
        const newPoly = s.meshNewPolygon;
        const editSlot = editSlotId ? s.slots.find((x) => x.id === editSlotId) ?? null : null;
        const editLayer = editSlot?.activeAttachmentId
          ? byId.get(editSlot.activeAttachmentId) ?? null
          : null;

        // ---- 权重可视化：饼图 / 叠加 / 已选 ----
        //   - weightPie：为每个顶点画权重饼图（选中的顶点饼图更大）
        //   - weightOverlay：用骨骼颜色填充网格
        //   - weightSelectedOnly：仅对选中顶点 / 选中骨骼绘制（叠加时未选骨用黑色）
        // ★ 绑定模式下不画（顶点要隐藏，只留外轮廓蓝线）
        const showPie = s.weightPie && !newPoly && !s.weightBindMode;
        const showOverlay = s.weightOverlay && !newPoly && !s.weightBindMode;
        if (showPie || showOverlay) {
          for (const slot of s.slots) {
            const aid = slot.activeAttachmentId;
            if (!aid) continue;
            const mesh = s.attachmentMeshes[aid];
            if (!mesh || !mesh.bones || mesh.bones.length === 0) continue;
            if (s.slotVisibility[slot.id] === false) continue;
            const layer = byId.get(aid);
            if (!layer) continue;
            const nb = mesh.bones.length;
            const vertCount = Math.floor(mesh.vertices.length / 2);
            // 找出每个骨骼的稳定颜色：按 mesh.bones 顺序，从 BONE_PALETTE 取
            const boneColorArr: number[] = mesh.bones.map((_, i) => {
              const hex = BONE_PALETTE[i % BONE_PALETTE.length];
              return parseInt(hex.replace('#', ''), 16);
            });
            // 选取中骨骼列表（用于「已选」过滤）
            const selBones = new Set(s.selectedBoneIds);
            const onlySel = s.weightSelectedOnly;

            // 顶点屏幕坐标（走 skinnedVerticesScreen，让饼图/叠加也跟随蒙皮后的位置）
            const pts = skinnedVerticesScreen(slot.id, layer, mesh);

            // 叠加：每个三角形内部按该三角形顶点权重均值上色
            if (showOverlay) {
              const idx = mesh.indices;
              for (let t = 0; t + 2 < idx.length; t += 3) {
                const a = idx[t], b = idx[t + 1], c = idx[t + 2];
                if (a >= vertCount || b >= vertCount || c >= vertCount) continue;
                const pa = pts[a], pb = pts[b], pc = pts[c];
                if (!pa || !pb || !pc) continue;
                // 三角形颜色 = 三个顶点权重向量中最大权重的骨骼（按"权重最大"决定颜色，仿 Spine 三角形顺序逻辑）
                // 取 a 顶点的最大权重骨作为三角形主色
                const ar = a * nb;
                let maxW2 = -1, maxBj = 0;
                for (let j = 0; j < nb; j++) {
                  const w = mesh.weights![ar + j];
                  if (onlySel && !selBones.has(mesh.bones[j])) continue;
                  if (w > maxW2) { maxW2 = w; maxBj = j; }
                }
                const color = onlySel && maxW2 < 0 ? 0x000000 : boneColorArr[maxBj];
                meshHandles.poly([pa.x, pa.y, pb.x, pb.y, pc.x, pc.y]);
                meshHandles.fill({ color, alpha: 0.35 });
              }
            }

            // 饼图：每个顶点画饼图（按权重比例切扇形）
            if (showPie) {
              for (let i = 0; i < vertCount; i++) {
                // 「已选」过滤：仅选中顶点 + 其权重中包含选中骨骼的顶点
                const isVertexSelected = selected.has(i);
                const row = i * nb;
                let hasSelectedBone = false;
                if (onlySel) {
                  for (let j = 0; j < nb; j++) {
                    if (selBones.has(mesh.bones[j]) && mesh.weights![row + j] > 0) {
                      hasSelectedBone = true; break;
                    }
                  }
                  if (!isVertexSelected && !hasSelectedBone) continue;
                }
                const p = pts[i];
                if (!p) continue;
                const r = isVertexSelected ? 16 : 10;
                // 累计扇形：起点角度 0，依次按权重叠加
                let startAngle = -Math.PI / 2;
                for (let j = 0; j < nb; j++) {
                  const w = mesh.weights![row + j];
                  if (w <= 0) continue;
                  const endAngle = startAngle + w * Math.PI * 2;
                  // 三角形扇形用 poly 近似：12 段
                  const segs = 12;
                  const pts3: number[] = [p.x, p.y];
                  for (let k = 0; k <= segs; k++) {
                    const a = startAngle + (endAngle - startAngle) * (k / segs);
                    pts3.push(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
                  }
                  meshHandles.poly(pts3);
                  meshHandles.fill({ color: boneColorArr[j], alpha: 0.85 });
                  meshHandles.stroke({ width: 0.5, color: 0x000000, alpha: 0.5 });
                  startAngle = endAngle;
                }
                // 边框
                meshHandles.circle(p.x, p.y, r);
                meshHandles.stroke({ width: isVertexSelected ? 1.4 : 0.8, color: 0xFFFFFF, alpha: 0.9 });
              }
            }
          }
        }

        if (newPoly && editSlot && editLayer) {
          // 图片原始边界的白色虚线框（提示描绘范围）
          const c0 = attachmentLocalToScreen(editSlot.id, editLayer, 0, 0);
          const c1 = attachmentLocalToScreen(editSlot.id, editLayer, editLayer.width, editLayer.height);
          drawDashedRect(
            meshHandles,
            Math.min(c0.x, c1.x), Math.min(c0.y, c1.y),
            Math.abs(c1.x - c0.x), Math.abs(c1.y - c0.y),
            8, 6, 0xFFFFFF, 2,
          );
          const pts = newPoly.map((q) => attachmentLocalToScreen(editSlot.id, editLayer, q.x, q.y));
          // 已画出的边（青绿实线）
          if (pts.length >= 2) {
            for (let i = 0; i + 1 < pts.length; i++) {
              meshHandles.moveTo(pts[i].x, pts[i].y).lineTo(pts[i + 1].x, pts[i + 1].y);
            }
            meshHandles.stroke({ width: 2, color: 0x27D2BF, alpha: 1 });
          }
          // 从最后一个点到鼠标的预览虚线
          if (pts.length >= 1 && lastPointer.x > -90000) {
            const last = pts[pts.length - 1];
            drawDashedLine(meshHandles, last.x, last.y, lastPointer.x, lastPointer.y, 6, 5, 0x4FB8F8, 1.5);
          }
          // 够 3 个点时，给起点画一圈提示（点它即可闭合）
          if (pts.length >= 3) {
            meshHandles.circle(pts[0].x, pts[0].y, 9);
            meshHandles.stroke({ width: 1.5, color: 0x3BE06B, alpha: 0.9 });
          }
          // 顶点：最后一个绿色高亮（仿 Spine）
          pts.forEach((q, i) => {
            const isLast = i === pts.length - 1;
            meshHandles.circle(q.x, q.y, isLast ? 5 : 4);
            meshHandles.fill({ color: isLast ? 0x3BE06B : 0x27D2BF, alpha: 1 });
          });
        }
      };

      /** 给选中的插槽画蓝色选框（选的是插槽，框画在它当前激活的附件上）。 */
      const drawHighlight = (
        psd: PixiBonesPsd | null,
        images: PixiBonesLayer[],
        slots: PixiBonesSlot[],
        selectedSlotIds: string[],
      ) => {
        highlight.clear();
        if (selectedSlotIds.length === 0) return;
        const byId = new Map(allAttachmentsOf(psd, images).map((l) => [l.id, l]));
        for (const sid of selectedSlotIds) {
          const slot = slots.find((s) => s.id === sid) ?? null;
          const layer = slot?.activeAttachmentId ? byId.get(slot.activeAttachmentId) ?? null : null;
          if (!layer || layer.width === 0 || layer.height === 0) continue;
          // ★ 附件一旦有网格：可见范围已被裁到网格轮廓内，整图外框（原图边界）会误导
          //   → 不再画蓝框（选中提示改由 drawMeshHandles 的网格边界承担）
          if (usePixiBonesStore.getState().attachmentMeshes[layer.id]) continue;

          const stageX = root.x + layer.left * root.scale.x;
          const stageY = root.y + layer.top * root.scale.y;
          const stageW = layer.width * root.scale.x;
          const stageH = layer.height * root.scale.y;

          highlight
            .rect(stageX - 2, stageY - 2, stageW + 4, stageH + 4)
            .stroke({ width: 2, color: 0x60a5fa, alpha: 0.9 });
        }
      };

      /** 判断事件目标是不是插槽 sprite（用来把「点图」也纳入框选/选中流程）。 */
      const isSlotSprite = (t: unknown): boolean =>
        typeof (t as { __slotId?: unknown } | null)?.__slotId === 'string';

      /**
       * 屏幕坐标 → 某插槽渲染内容的「附件局部坐标」（= 网格顶点所在坐标系）。
       * 链路：屏幕 → 世界（root 平移/缩放）→ 附件局部（wrap 矩阵求逆）。
       * ★ wrap 矩阵已包含图层 left/top 的平移（applyBindings 的枢轴居中化写法），
       *   且 view 的 position 被归零，所以顶点坐标不需要再加/减 left/top。
       */
      const screenToAttachmentLocal = (
        slotId: string,
        layer: PixiBonesLayer,
        gx: number,
        gy: number,
      ): { x: number; y: number } | null => {
        const sx = root.scale.x;
        const sy = root.scale.y;
        if (sx === 0 || sy === 0) return null;
        const wx = (gx - root.x) / sx;
        const wy = (gy - root.y) / sy;
        const m = wrapMatrixBySlot.get(slotId);
        if (!m) return { x: wx - layer.left, y: wy - layer.top };
        const inv = invAffine(m);
        if (!inv) return null;
        return {
          x: inv[0] * wx + inv[2] * wy + inv[4],
          y: inv[1] * wx + inv[3] * wy + inv[5],
        };
      };

      /** 附件局部坐标 → 屏幕坐标（screenToAttachmentLocal 的逆）。 */
      const attachmentLocalToScreen = (
        slotId: string,
        layer: PixiBonesLayer,
        px: number,
        py: number,
      ): { x: number; y: number } => {
        const m = wrapMatrixBySlot.get(slotId);
        let X: number;
        let Y: number;
        if (m) {
          X = m[0] * px + m[2] * py + m[4];
          Y = m[1] * px + m[3] * py + m[5];
        } else {
          X = px + layer.left;
          Y = py + layer.top;
        }
        return { x: root.x + X * root.scale.x, y: root.y + Y * root.scale.y };
      };

      /** 屏幕坐标下最上层（最后绘制的）可见**插槽** id；无则 null。
       *  （每个插槽渲染它当前激活的附件，所以命中插槽即确定是哪张图）
       *  ★ 网格附件用**三角形精确命中**（变形后依然准）；区域附件仍是矩形 bbox。 */
      const topSlotAt = (gx: number, gy: number): string | null => {
        const s = usePixiBonesStore.getState();
        // 网格「隔离」：只有正在编辑的插槽可被命中
        const isolateId = s.meshIsolate ? s.meshEditSlotId : null;
        const items = renderablesOf(s.psd, s.images, s.slots);
        for (let i = items.length - 1; i >= 0; i--) {
          const { slot, layer: l } = items[i];
          if (isolateId && slot.id !== isolateId) continue;
          if (s.slotVisibility[slot.id] === false) continue;
          if (l.width === 0 || l.height === 0) continue;
          const mesh = s.attachmentMeshes[l.id];
          if (mesh) {
            const p = screenToAttachmentLocal(slot.id, l, gx, gy);
            if (p && pointInMesh(p.x, p.y, mesh)) return slot.id;
          } else {
            const sx = root.scale.x;
            const sy = root.scale.y;
            if (sx === 0 || sy === 0) continue;
            const wx = (gx - root.x) / sx;
            const wy = (gy - root.y) / sy;
            if (wx >= l.left && wx <= l.left + l.width && wy >= l.top && wy <= l.top + l.height) {
              return slot.id;
            }
          }
        }
        return null;
      };

      /**
       * 把附件当前的网格顶点同步到已渲染的 Mesh 上（拖动顶点时用，避免整棵重建）。
       * 顶点数一致 → 原地改 + 上传 GPU；数量变了（增删顶点）由调用方 rebuildAssets。
       */
      const syncMeshVertices = (attachmentId: string) => {
        const s = usePixiBonesStore.getState();
        const mesh = s.attachmentMeshes[attachmentId];
        if (!mesh) return;
        for (const slot of s.slots) {
          if (slot.activeAttachmentId !== attachmentId) continue;
          const wrap = viewBySlotId.get(slot.id);
          const v = wrap?.children[0];
          if (!v || !(v instanceof Mesh)) continue;
          const geo = v.geometry as MeshGeometry;
          const pos = geo.positions;
          if (pos.length === mesh.vertices.length) {
            pos.set(mesh.vertices);
            geo.getBuffer('aPosition').update();
          }
        }
      };

      /**
       * 骨骼蒙皮（线性混合蒙皮）—— 把 mesh.bones / mesh.weights / mesh.bindPose 烘焙到 PIXI Mesh。
       *
       * 公式（简化版）：
       *   v_root = (left, top) + bindPose + Σ w_j · (bone_world_now_j - bone_world_bind_j)
       *
       * 实现：
       *   - wrap.matrix 由 applyBindings 算成 slotLocal（无骨骼驱动，因为 mesh 已绑骨骼）
       *   - wrap.matrix 把 wrap 局部坐标 → root 坐标（带枢轴居中化的 slot transform）
       *   - 我们把 v_root 喂进 wrap.matrix⁻¹ 得到 wrap 局部坐标，写进 view.positions
       *   - 这样 view.positions 走 wrap.matrix → 正确屏幕位置
       *
       * 适用：父骨骼平移带动整个网格跟随（最常见）；骨骼旋转时网格近似跟随。
       */
      const applySkinning = (slotId: string) => {
        const s = usePixiBonesStore.getState();
        const slot = s.slots.find((x) => x.id === slotId);
        if (!slot) return;
        const aid = slot.activeAttachmentId;
        if (!aid) return;
        const mesh = s.attachmentMeshes[aid];
        if (!mesh || !mesh.bones || mesh.bones.length === 0 || !mesh.weights || !mesh.bindPose) {
          return;
        }
        const wrap = viewBySlotId.get(slotId);
        if (!wrap) return;
        const view = wrap.children[0];
        if (!view || !(view instanceof Mesh)) return;
        const geo = view.geometry as MeshGeometry;
        const pos = geo.positions;
        const bindPose = mesh.bindPose;
        const bones = mesh.bones;
        const weights = mesh.weights;
        const boneBindWorld = mesh.boneBindWorld ?? [];
        const nb = bones.length;
        const vertCount = Math.floor(pos.length / 2);
        if (bindPose.length !== pos.length || weights.length !== vertCount * nb) {
          return;
        }
        const all = allAttachmentsOf(s.psd, s.images);
        const layer = all.find((l) => l.id === aid);
        const layerLeft = layer?.left ?? 0;
        const layerTop = layer?.top ?? 0;
        // 每个骨骼当前的世界位置（root 坐标系）：worldMatrix.elements[6..7]
        const boneDx = new Array(nb);
        const boneDy = new Array(nb);
        for (let j = 0; j < nb; j++) {
          const boneNode = skeletonRef ? findBoneByRefWorld(skeletonRef, bones[j]) : null;
          if (!boneNode) { boneDx[j] = 0; boneDy[j] = 0; continue; }
          const e = boneNode.worldMatrix.elements;
          boneDx[j] = e[6];
          boneDy[j] = e[7];
        }
        // wrap.matrix⁻¹（6 元仿射）：把 root 坐标 → wrap 局部坐标
        const wm = wrapMatrixBySlot.get(slotId);
        if (!wm) {
          // wrap 不存在 → 用近似（layer.left/top 偏移）
          for (let i = 0; i < vertCount; i++) {
            let vx = layerLeft + bindPose[i * 2];
            let vy = layerTop + bindPose[i * 2 + 1];
            const row = i * nb;
            for (let j = 0; j < nb; j++) {
              const w = weights[row + j];
              if (w === 0) continue;
              const dx = boneDx[j] - (boneBindWorld[j * 2] ?? 0);
              const dy = boneDy[j] - (boneBindWorld[j * 2 + 1] ?? 0);
              vx += w * dx;
              vy += w * dy;
            }
            pos[i * 2] = vx;
            pos[i * 2 + 1] = vy;
          }
        } else {
          const inv = invAffine(wm);
          if (!inv) return;
          // inv 6 元：[a, b, c, d, tx, ty]  即 v_local = inv · v_root
          const ia = inv[0], ib = inv[1], ic = inv[2], id_ = inv[3], itx = inv[4], ity = inv[5];
          for (let i = 0; i < vertCount; i++) {
            // v_root = (left, top) + bindPose + Σ w_j · (now - bind)
            let vx = layerLeft + bindPose[i * 2];
            let vy = layerTop + bindPose[i * 2 + 1];
            const row = i * nb;
            for (let j = 0; j < nb; j++) {
              const w = weights[row + j];
              if (w === 0) continue;
              const dx = boneDx[j] - (boneBindWorld[j * 2] ?? 0);
              const dy = boneDy[j] - (boneBindWorld[j * 2 + 1] ?? 0);
              vx += w * dx;
              vy += w * dy;
            }
            // v_local = inv · v_root
            pos[i * 2] = ia * vx + ic * vy + itx;
            pos[i * 2 + 1] = ib * vx + id_ * vy + ity;
          }
        }
        geo.getBuffer('aPosition').update();
      };

      /** 在 skeleton 里按 id 反查 Bone 节点。 */
      function findBoneByRefWorld(skel: Skeleton, id: string): EngineBone | null {
        const root = (skel as unknown as { root?: EngineBone }).root;
        if (!root) return null;
        const walk = (b: EngineBone): EngineBone | null => {
          const bid = (b as unknown as { _id?: string })._id;
          if (bid === id) return b;
          const children = (b as unknown as { children?: EngineBone[] }).children ?? [];
          for (const c of children) {
            const r = walk(c);
            if (r) return r;
          }
          return null;
        };
        return walk(root);
      }

      // ===== 网格顶点编辑：拓扑操作 =====

      /** 附件局部坐标 p 落在哪个三角形内（返回三角形序号 = 索引/3；-1 = 没命中）。 */
      const triangleAt = (mesh: MeshData, px: number, py: number): number => {
        const v = mesh.vertices;
        const idx = mesh.indices;
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const a = idx[t] * 2;
          const b = idx[t + 1] * 2;
          const c = idx[t + 2] * 2;
          if (pointInTriangle(px, py, v[a], v[a + 1], v[b], v[b + 1], v[c], v[c + 1])) {
            return t / 3;
          }
        }
        return -1;
      };

      /** 离 p 最近的边（附件局部坐标，容差内）；无则 null。 */
      const edgeNear = (mesh: MeshData, px: number, py: number, tol: number): [number, number] | null => {
        const v = mesh.vertices;
        let best: [number, number] | null = null;
        let bestD = tol;
        for (const e of meshEdgeInfo(mesh)) {
          const d = distToSegment(px, py, v[e.a * 2], v[e.a * 2 + 1], v[e.b * 2], v[e.b * 2 + 1]);
          if (d < bestD) {
            bestD = d;
            best = [e.a, e.b];
          }
        }
        return best;
      };

      /** 用重心坐标把三角形 (a,b,c) 内点 p 的 UV 插值出来（加点时保证纹理正确）。 */
      const barycentricUv = (
        mesh: MeshData, a: number, b: number, c: number, px: number, py: number,
      ): [number, number] => {
        const v = mesh.vertices;
        const ax = v[a * 2], ay = v[a * 2 + 1];
        const bx = v[b * 2], by = v[b * 2 + 1];
        const cx = v[c * 2], cy = v[c * 2 + 1];
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-9) return [mesh.uvs[a * 2], mesh.uvs[a * 2 + 1]];
        const w1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const w2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        const w3 = 1 - w1 - w2;
        return [
          w1 * mesh.uvs[a * 2] + w2 * mesh.uvs[b * 2] + w3 * mesh.uvs[c * 2],
          w1 * mesh.uvs[a * 2 + 1] + w2 * mesh.uvs[b * 2 + 1] + w3 * mesh.uvs[c * 2 + 1],
        ];
      };

      /**
       * 删除顶点（顶点塌陷）：把该顶点合并到一个邻居上，删掉因此退化的三角形，
       * 再移除该顶点并重映射索引 —— 网格保持封闭、不留洞。
       */
      const collapseMeshVertex = (attachmentId: string, vi: number) => {
        const s = usePixiBonesStore.getState();
        const mesh = s.attachmentMeshes[attachmentId];
        if (!mesh) return;
        const n = Math.floor(mesh.vertices.length / 2);
        if (n <= 3) return;   // 至少保留一个三角形
        const idx = mesh.indices;
        // 找邻居：与 vi 共边的第一个顶点
        let neighbor = -1;
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const tri = [idx[t], idx[t + 1], idx[t + 2]];
          const k = tri.indexOf(vi);
          if (k >= 0) {
            neighbor = tri[(k + 1) % 3];
            break;
          }
        }
        if (neighbor < 0) return;
        const remapped = idx.map((x) => (x === vi ? neighbor : x));
        const kept: number[] = [];
        for (let t = 0; t + 2 < remapped.length; t += 3) {
          const a = remapped[t], b = remapped[t + 1], c = remapped[t + 2];
          if (a === b || b === c || a === c) continue;   // 退化三角形
          kept.push(a, b, c);
        }
        const map = new Array<number>(n).fill(-1);
        const vertices: number[] = [];
        const uvs: number[] = [];
        let k2 = 0;
        for (let i = 0; i < n; i++) {
          if (i === vi) continue;
          map[i] = k2++;
          vertices.push(mesh.vertices[i * 2], mesh.vertices[i * 2 + 1]);
          uvs.push(mesh.uvs[i * 2], mesh.uvs[i * 2 + 1]);
        }
        const indices = kept.map((x) => map[x]);
        s.pushHistory();
        // 删点后同样重新合法化，保证剩下的连接依然最优
        s.setMeshData(attachmentId, {
          vertices, uvs,
          indices: delaunayRefine(flatToPoints(vertices), indices),
        });
        s.setMeshSelectedVertices([]);
      };

      /** 在三角形内部插入一个顶点（该三角形一分为三）。 */
      const splitTriangle = (id: string, triIdx: number, px: number, py: number) => {
        const s = usePixiBonesStore.getState();
        const mesh = s.attachmentMeshes[id];
        if (!mesh) return;
        const idx = mesh.indices;
        const a = idx[triIdx * 3], b = idx[triIdx * 3 + 1], c = idx[triIdx * 3 + 2];
        if (a === undefined || b === undefined || c === undefined) return;
        const nv = Math.floor(mesh.vertices.length / 2);
        const uv = barycentricUv(mesh, a, b, c, px, py);
        const vertices = [...mesh.vertices, px, py];
        const uvs = [...mesh.uvs, uv[0], uv[1]];
        const indices = idx.slice();
        // 原三角形 → (a,b,nv)，再补 (b,c,nv) (c,a,nv)
        indices[triIdx * 3] = a;
        indices[triIdx * 3 + 1] = b;
        indices[triIdx * 3 + 2] = nv;
        indices.push(b, c, nv, c, a, nv);
        s.pushHistory();
        // ★ 加完顶点后全局重新合法化：新顶点与附近顶点按最优（Delaunay）方式连接，
        //   而不是只在原三角形里切三刀 —— 和 Spine「自动连接所有顶点」的行为一致。
        s.setMeshData(id, {
          vertices, uvs,
          indices: delaunayRefine(flatToPoints(vertices), indices),
        });
        s.setMeshSelectedVertices([nv]);
      };

      /** 在边上插入顶点（细分边）：新顶点落在「点击处在边上最近的点」，
       *  而不是边的中点 —— 否则点下去顶点会跳到远处。UV 按同样的比例插值。 */
      const splitEdgeAt = (id: string, va: number, vb: number, px: number, py: number) => {
        const s = usePixiBonesStore.getState();
        const mesh = s.attachmentMeshes[id];
        if (!mesh) return;
        const nv = Math.floor(mesh.vertices.length / 2);
        // 把点击点投影到边 AB 上求参数 t，再取边上的落点
        const ax = mesh.vertices[va * 2], ay = mesh.vertices[va * 2 + 1];
        const bx = mesh.vertices[vb * 2], by = mesh.vertices[vb * 2 + 1];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let tt = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0.5;
        tt = Math.max(0, Math.min(1, tt));
        const nx = ax + dx * tt;
        const ny = ay + dy * tt;
        // 新顶点 UV = 两端 UV 按同样的 t 插值（保证纹理不畸变）
        const u = mesh.uvs[va * 2] + (mesh.uvs[vb * 2] - mesh.uvs[va * 2]) * tt;
        const vv = mesh.uvs[va * 2 + 1] + (mesh.uvs[vb * 2 + 1] - mesh.uvs[va * 2 + 1]) * tt;
        const vertices = [...mesh.vertices, nx, ny];
        const uvs = [...mesh.uvs, u, vv];
        const idx = mesh.indices;
        const indices: number[] = [];
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const tri = [idx[t], idx[t + 1], idx[t + 2]];
          let i0 = -1, i1 = -1, i2 = -1;
          for (let k = 0; k < 3; k++) {
            const p = tri[k];
            const q = tri[(k + 1) % 3];
            if ((p === va && q === vb) || (p === vb && q === va)) {
              i0 = p;
              i1 = q;
              i2 = tri[(k + 2) % 3];
              break;
            }
          }
          if (i0 < 0) {
            indices.push(tri[0], tri[1], tri[2]);
            continue;
          }
          // 保持绕序： (i0, nv, i2) + (nv, i1, i2)
          indices.push(i0, nv, i2, nv, i1, i2);
        }
        s.pushHistory();
        // ★ 加完顶点后全局重新合法化（同 splitTriangle）
        s.setMeshData(id, {
          vertices, uvs,
          indices: delaunayRefine(flatToPoints(vertices), indices),
        });
        s.setMeshSelectedVertices([nv]);
      };

      /**
       * 闭合「新建」描绘的轮廓 → 用该多边形重建网格。
       * ★ UV 由每个点在图片上的位置决定（uv = position / 图层尺寸），
       *   所以只有多边形内部的纹理会出现在网格里 —— 图片自然被裁到轮廓内。
       */
      const finishNewPolygon = (
        attachmentId: string,
        layer: PixiBonesLayer,
        poly: Array<{ x: number; y: number }>,
      ) => {
        const s = usePixiBonesStore.getState();
        s.setMeshNewPolygon(null);
        if (poly.length < 3) return;
        const indices = triangulatePolygon(poly);
        if (indices.length < 3) return;   // 退化多边形：放弃
        const vertices: number[] = [];
        const uvs: number[] = [];
        for (const p of poly) {
          vertices.push(p.x, p.y);
          uvs.push(p.x / layer.width, p.y / layer.height);
        }
        s.pushHistory();
        s.setMeshData(attachmentId, { vertices, uvs, indices });
        s.setMeshSelectedVertices([]);
      };

      /**
       * 鼠标悬停附件时的反馈（Gfx = attachmentHover）：
       *   1) 创建模式 + 按住 Command → 画白色虚线外框（提示将被 ⌘ 点击选中）
       *   2) 四变换工具（旋转/移动/缩放/倾斜）激活时 → 画白色虚线外框 +
       *      alpha>0 像素的外轮廓描边（仿 Spine 选中/悬停视觉）
       *
       * 选中状态下也保留 hover 反馈（高亮叠加，与角色驱动不一致）。
       */
      const updateAttachmentHover = (gx: number, gy: number, createCmdHover: boolean) => {
        attachmentHover.clear();
        const s = usePixiBonesStore.getState();
        // 计算是否进入"hover 显示"状态：
        //   - 创建模式 + 按住 Command（已有逻辑）
        //   - 四变换工具激活 + setup 模式（新增）
        const inCreateCmd = s.editorMode === 'create' && (createCmdHover || metaDown);
        // 网格编辑模式下不显示变换工具的悬停白框（避免和网格描绘/顶点混淆）
        const inTransform = s.editorMode === 'idle' && s.activeTool !== null && !s.meshEditSlotId;
        const showOutline = inTransform;
        // ★ 白色虚线外框只在「创建 + ⌘」时画；变换工具悬停只保留内部的图像边缘白线（不画外侧虚线框）
        const showDashedRect = inCreateCmd;
        if (!showDashedRect && !showOutline) return;
        const slotId = topSlotAt(gx, gy);
        if (!slotId) return;
        const slot = s.slots.find((x) => x.id === slotId) ?? null;
        const layer = slot?.activeAttachmentId
          ? allAttachmentsOf(s.psd, s.images).find((l) => l.id === slot.activeAttachmentId) ?? null
          : null;
        if (!layer || !layer.canvas || layer.width === 0 || layer.height === 0) return;
        const sx = root.scale.x;
        const sy = root.scale.y;
        const stageX = root.x + layer.left * sx;
        const stageY = root.y + layer.top * sy;
        const stageW = layer.width * sx;
        const stageH = layer.height * sy;
        if (showDashedRect) {
          drawDashedRect(
            attachmentHover,
            stageX - 2, stageY - 2, stageW + 4, stageH + 4,
            6, 4, 0xFFFFFF, 2,
          );
        }
        if (inTransform) {
          // alpha>0 轮廓描边（沿图层 canvas 像素边界）
          const outline = computeAttachmentOutline(layer.canvas);
          drawAttachmentOutline(
            attachmentHover,
            outline,
            stageX, stageY, sx, sy,
            0xFFFFFF, Math.max(1, 1 * Math.max(0.5, Math.min(sx, sy))),
          );
        }
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
        const scale = Math.max(0.01, Math.min(baseFit * vp.zoom, 16));
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

      const drawGrid = (_psd: PixiBonesPsd | null) => {
        gridLayer.clear();

        const sx = root.scale.x;
        const sy = root.scale.y;
        if (sx <= 0 || sy <= 0) return;
        // 棋盘格屏幕步长（像素）—— 与 updateCheckerSize 同步
        const CELL = checkerSize;
        // 棋盘格在 PSD 坐标系里的步长（世界单位）
        const CELL_W = CELL / Math.abs(sx);

        // 计算可视区域（世界坐标）：始终覆盖整个画布（棋盘格铺满画布，不夹紧到 PSD 边界）
        const minWX = (-root.x) / sx;
        const maxWX = (a.renderer.width - root.x) / sx;
        const minWY = (-root.y) / sy;
        const maxWY = (a.renderer.height - root.y) / sy;
        const left = Math.floor(minWX / CELL_W) * CELL_W;
        const right = Math.ceil(maxWX / CELL_W) * CELL_W;
        const top = Math.floor(minWY / CELL_W) * CELL_W;
        const bottom = Math.ceil(maxWY / CELL_W) * CELL_W;

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
      // ★ tipHandle 也用同样的 Map 复用，避免拖动时残留
      const tipById = new Map<string, Gfx>();

      // ===== 0 长度骨骼（根骨 + 单击创建的点骨骼）的移动 / 旋转手柄 =====
      // 悬停分区：黑圈内 = move，黑圈外（十字臂）= rotate。同一时刻只会悬停在一根骨骼上。
      const zoneRef: { cur: HoverZone | null } = { cur: null };
      const zeroHandles = new Map<string, { move: Gfx; rotate: Gfx; scale: Gfx; incline: Gfx }>();
      // 子骨骼（length > 0）的移动手柄（axis-arrows），move 工具 + 选中时在 tip 处显示
      const moveHandles = new Map<string, Gfx>();
      // 缩放 / 倾斜手柄：仅子骨骼（length > 0），对应工具激活 + 选中时在 joint 处显示
      type ScaleHandle = {
        visual: Gfx;     // 绿 + 红两轴手柄（hover 时对应轴变白）
        hit: Gfx;        // 透明命中区（覆盖整个图标，用于 pointermove 判定绿/红/中心）
        hoverZone: 'green' | 'red' | 'center' | null;
        dragZone: 'green' | 'red' | 'center' | null;  // pointerdown 时锁定的缩放轴
      };
      const scaleHandles = new Map<string, ScaleHandle>();
      const inclineHandles = new Map<string, Gfx>();

      /** 该 0 长度骨骼此刻是否该显示手柄（Pose 模式 + 被选中） */
      const zeroHandleActive = (boneId: string) => {
        const st = usePixiBonesStore.getState();
        return st.editorMode === 'pose' && st.selectedBoneIds.includes(boneId);
      };

      /**
       * 骨骼 joint 的「屏幕坐标」以及骨骼在屏幕空间的方向角。
       * 与 drawBones 里手柄定位的公式保持一致（根骨用 render 锚点，其余用 root 容器映射）。
       * 注意必须用 world 位置：node.x/node.y 是相对父骨骼的 local 偏移，直接用会导致原点错误。
       */
      const jointScreenInfo = (boneId: string, fresh: BoneNode) => {
        const isRoot = fresh.parentId === null;
        const bRef = boneById.get(boneId);
        const wp = bRef && skeletonRef ? skeletonRef.getWorldPosition(bRef) : { x: fresh.x, y: fresh.y };
        const rr = usePixiBonesStore.getState().render;
        const baseX = isRoot ? rr.x : root.x;
        const baseY = isRoot ? rr.y : root.y;
        const x = baseX + wp.x * root.scale.x;
        const y = baseY + wp.y * root.scale.y;
        let angle = fresh.rotation || 0;
        if (bRef && skeletonRef && fresh.length > 0) {
          const p1 = skeletonRef.getWorldTip(bRef);
          angle = Math.atan2(p1.y - wp.y, p1.x - wp.x);
        }
        return { x, y, angle };
      };

      /** 同步所有 0 长度骨骼手柄的显隐 + 光标 */
      const syncZeroHandles = () => {
        const z = zoneRef.cur;
        for (const [id, h] of zeroHandles) {
          const active = zeroHandleActive(id);
          const kind = z && z.boneId === id ? z.kind : null;
          h.move.visible = active && kind === 'move';
          h.rotate.visible = active && kind === 'rotate';
          // scale / incline 在 Pose 模式下不显示（由后续 move/scale/shear 工具分支按需覆盖）
          h.scale.visible = false;
          h.incline.visible = false;
          // PIXI 每次 pointermove 结束都会用命中区的 cursor 覆盖 canvas 光标，
          // 所以光标必须写到命中区对象上，光写 canvas.style 会被覆盖掉。
          const hit = hitById.get(id);
          if (hit) {
            hit.cursor = active && kind === 'move' ? 'move'
              : active && kind === 'rotate' ? 'crosshair'
              : 'pointer';
          }
        }
        // 拖动过程中不改光标（由各自的拖动逻辑控制）
        if (dragState) return;
        const hovering = z && zeroHandleActive(z.boneId) ? z.kind : null;
        a.canvas.style.cursor = hovering === 'move' ? 'move' : hovering === 'rotate' ? 'crosshair' : 'default';
      };

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
        rotateToolIndicator.clear();
        rotateToolIndicator.visible = false;
        // ★ 即使 nodes.length === 0 也要清理所有缓存手柄，避免「删完最后一根骨」后残留
        // 清理已被删除的 0 长度骨骼手柄，避免残留
        for (const [id, h] of zeroHandles) {
          if (nodes.some((n) => n.id === id)) continue;
          h.move.destroy();
          h.rotate.destroy();
          h.scale.destroy();
          h.incline.destroy();
          zeroHandles.delete(id);
          if (zoneRef.cur && zoneRef.cur.boneId === id) zoneRef.cur = null;
        }
        // 清理已被删除的子骨骼移动手柄，避免残留
        for (const [id, h] of moveHandles) {
          if (nodes.some((n) => n.id === id)) continue;
          h.destroy();
          moveHandles.delete(id);
        }
        // 清理已被删除的子骨骼缩放 / 倾斜手柄
        for (const [id, h] of scaleHandles) {
          if (nodes.some((n) => n.id === id)) continue;
          h.visual.destroy();
          h.hit.destroy();
          scaleHandles.delete(id);
        }
        for (const [id, h] of inclineHandles) {
          if (nodes.some((n) => n.id === id)) continue;
          h.destroy();
          inclineHandles.delete(id);
        }
        // ★ 清理已被删除的子骨骼 IK tipHandle，避免残留红色 ik 图标
        for (const [id, h] of tipById) {
          if (nodes.some((n) => n.id === id)) continue;
          h.destroy();
          tipById.delete(id);
        }
        // 清完残留后，若没有可绘骨骼或骨架未初始化，直接返回
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

        const visit = (bone: EngineBone, node: BoneNode, isSelected: boolean) => {
          const length = node.length;
          const p0 = skeletonRef!.getWorldPosition(bone);
          const p1 = skeletonRef!.getWorldTip(bone);
          if (length === 0) {
            // 0 长度骨骼 = 十字图标（根骨骼，以及创建模式下单击生成的「点骨骼」）
            // 几何：viewBox 446x335，anchor (223, 167)，左右臂不对称（右侧更长指向 +X）
            // 4 条 line + 双圆环（外环 stroke、内环深色填充当背景）
            // 根骨图标画在「锚点」上（PSD 底部中心 / 画布中心），其它骨骼走常规映射
            const isRootBone = node.parentId === null;
            const cx = (isRootBone ? rootAnchorX : ox) + p0.x * sx;
            const cy = (isRootBone ? rootAnchorY : oy) + p0.y * sy;
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
            const A = rootIconScale(sAvg);
            // 图标跟着根骨一起旋转（旋转手柄拖动时十字会同步转）
            const rotRad = node.rotation || 0;
            const cosR = Math.cos(rotRad);
            const sinR = Math.sin(rotRad);
            // 局部 viewBox → 屏幕（先绕图标中心旋转，再平移到图标中心）
            const project = (lx: number, ly: number): { x: number; y: number } => {
              const dx = (lx - ax) * A;
              const dy = (ly - ay) * A;
              return { x: cx + dx * cosR - dy * sinR, y: cy + dx * sinR + dy * cosR };
            };
            // 画一条手臂
            const arm = (x1: number, y1: number, x2: number, y2: number) => {
              const a1 = project(x1, y1);
              const a2 = project(x2, y2);
              bonesLayer.moveTo(a1.x, a1.y).lineTo(a2.x, a2.y)
                .stroke({ width: strokeW * A, color, cap: 'round' });
            };
            // 4 条带圆头的线段（左/上/下 短，右 长 指向 +X）
            // 左臂 [121, 167] → [176, 167]（靠近中心）
            arm(121, 167, 176, 167);
            // 右臂 [270, 167] → [370, 167]（最长，指向 +X）
            arm(270, 167, 370, 167);
            // 上臂 [223, 65] → [223, 120]
            arm(223, 65, 223, 120);
            // 下臂 [223, 214] → [223, 269]
            arm(223, 214, 223, 269);
            // 双圆环（先画内圈深色背景，再画外圈 stroke 覆盖）
            // 内圈实心填充（深色）— 让中央不会透出画布
            const c0 = project(223, 167);
            bonesLayer.circle(c0.x, c0.y, 26 * A).fill({ color: innerBg });
            // 外圈 stroke（带圆角端点，模仿原图）
            bonesLayer.circle(c0.x, c0.y, 32 * A)
              .stroke({ width: 12 * A, color, cap: 'round' });
          } else {
            // 普通子骨骼（按 Codex 设计的 spine 风格）
            // 几何（viewBox 446x335，anchor (50, 167)，关节在左，尖端在右）：
            //   - 关节圆环：r=18 stroke + r=13 fill（深色背景）
            //   - 三角形主体（指向 tip）：4 点 [78,153] → [410,167] → [78,181] → [62,167]
            //   - viewBox 长度 = 410 - 50 = 360 单位，对应 bone.length 世界单位
            // 颜色优先级：选中 > hover > 默认
            let color: number;
            const bId = (bone as unknown as { _id?: string })._id;
            if (isSelected) {
              color = SELECTED_COLOR;
            } else if (hoveredBoneId === bId) {
              color = HOVER_COLOR;
            } else {
              color = BONE_COLOR;
            }
            // anchor 位置 = 骨骼 joint 屏幕位置；尖端 = world tip 屏幕位置
            const jx = ox + p0.x * sx;
            const jy = oy + p0.y * sy;
            const tx = ox + p1.x * sx;
            const ty = oy + p1.y * sy;
            // 用 bone.worldMatrix 直接变换 viewBox 顶点（Spine 风格）：
            //   - X 列 = (cos·scaleX, sin·scaleX) × (length/360) → 沿骨方向（用 length 决定三角形长度）
            //   - Y 列 = (-sin·scaleY, cos·scaleY)                → 垂直骨方向
            // scaleX 只改尖端 X 位置，三角形厚度由 scaleY 决定，符合 Spine 标准行为。
            // 注意：三角形 viewBox 长 360 单位，bone.length 是任意世界单位；
            //   所以 X 列要乘 length/360，让 viewBox 360 单位 = bone.length 世界单位。
            // ★ 宽度比例：短骨骼整体等比缩小（细），长度超过 BONE_WIDTH_LOCK_LENGTH 后宽度锁定。
            //   系数只跟骨骼自身的 length 走 —— 之后拖红手柄做 scaleX 缩放时长度变、宽度不变。
            const wm = bone.worldMatrix.elements;
            const lenFactor = length / 360;
            const wScale = boneWidthScale(length);
            const e0x = wm[0] * sx * lenFactor;
            const e0y = wm[1] * sx * lenFactor;
            const e1x = wm[3] * sx * wScale;
            const e1y = wm[4] * sy * wScale;
            // 关节圆环跟 root zoom 走，并且和三角形一样乘宽度系数
            //（短骨骼整体等比缩小，所以圆也一起变小；超过锁定长度后一起锁定）
            const jointR = 9 * Math.max(Math.abs(sx), Math.abs(sy)) * wScale;
            drawBoneShape(bonesLayer, jx, jy, e0x, e0y, e1x, e1y, color, jointR);
          }
          for (const c of bone.children) {
            const sel = isMultiSel((c as unknown as { _id?: string })._id);
            const childNode = nodes.find((n) => n.id === (c as unknown as { _id?: string })._id);
            if (childNode) visit(c, childNode, sel);
          }
        };
        const rootSelected = isMultiSel((skeletonRef.root as unknown as { _id?: string })._id);
        const rootNode = nodes.find((n) => n.parentId === null);
        if (rootNode) visit(skeletonRef.root, rootNode, rootSelected);

        for (const node of nodes) {
          const b = boneById.get(node.id);
          if (!b) continue;
          // 单选兼容：优先用 selectedBoneIds（多选），fallback 到 selectedBoneId
          const isSelected = (selectedBoneIds && selectedBoneIds.length > 0)
            ? selectedBoneIds.includes(node.id)
            : node.id === selectedBoneId;

          const origin = skeletonRef.getWorldPosition(b);
          // 根骨图标画在 rootAnchor + 自身世界位移上（见 visit 里的 cx/cy），
          // 其它骨骼画在 root 容器映射后的世界坐标上
          const isRoot = node.parentId === null;
          const oX = (isRoot ? rootAnchorX : ox) + origin.x * sx;
          const oY = (isRoot ? rootAnchorY : oy) + origin.y * sy;
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
            // ★ 0 长度骨骼（根骨 / 点骨骼）：悬停分区判定（黑圈内=移动，圈外=旋转）
            if (node.length === 0) {
              jointHit.on('pointermove', (ev: FederatedPointerEvent) => {
                const st = usePixiBonesStore.getState();
                if (st.editorMode !== 'pose') return;
                const rb = boneById.get(node.id);
                if (!rb || !skeletonRef) return;
                const rr = st.render;
                const wp = skeletonRef.getWorldPosition(rb);
                // 根骨图标画在 render 锚点上，其它 0 长度骨骼走常规映射
                const baseX = node.parentId === null ? rr.x : root.x;
                const baseY = node.parentId === null ? rr.y : root.y;
                const cxS = baseX + wp.x * root.scale.x;
                const cyS = baseY + wp.y * root.scale.y;
                const innerR = ROOT_ICON_INNER_R * rootIconScale(rr.scale);
                const d = Math.hypot(ev.global.x - cxS, ev.global.y - cyS);
                const kind: 'move' | 'rotate' = d <= innerR ? 'move' : 'rotate';
                const cur = zoneRef.cur;
                if (!cur || cur.boneId !== node.id || cur.kind !== kind) {
                  zoneRef.cur = { boneId: node.id, kind };
                  syncZeroHandles();
                }
              });
              jointHit.on('pointerleave', () => {
                if (zoneRef.cur && zoneRef.cur.boneId === node.id) {
                  zoneRef.cur = null;
                  syncZeroHandles();
                }
              });
            }
            handlesLayer.addChild(jointHit);
            hitById.set(node.id, jointHit);
          }
          jointHit.x = oX;
          jointHit.y = oY;
          // ★ 命中区域：覆盖整根骨骼的画面（关节圆 + 三角主体），
          //   而不只是关节圆，这样鼠标停在骨骼任意像素上都能选中。
          //   几何随骨骼长度/方向变化，所以每次 drawBones 都重绘（对象复用，hover 状态不丢）。
          jointHit.clear();
          if (node.length === 0) {
            // 根骨：覆盖整块十字图标（臂长随 zoom 夹紧变化）
            jointHit.circle(0, 0, ROOT_ICON_OUTER_R * rootIconScale(sx))
              .fill({ color: 0xffffff, alpha: 0.001 });
          } else {
            const wp0 = skeletonRef.getWorldPosition(b);
            const wp1 = skeletonRef.getWorldTip(b);
            const jxS = ox + wp0.x * sx;
            const jyS = oy + wp0.y * sy;
            const txS = ox + wp1.x * sx;
            const tyS = oy + wp1.y * sy;
            const screenLen = Math.hypot(txS - jxS, tyS - jyS);
            const angleRad = Math.atan2(tyS - jyS, txS - jxS);
            drawBoneHitShape(jointHit, screenLen, angleRad);
          }
          // ★ pointerdown 只注册一次：jointHit 复用后若每次 drawBones 都 .on('pointerdown')，
          //   会在拖动（每个 pointermove 触发一次 drawBones）时给每条骨无限叠加监听器，
          //   骨越多拖越久 => 累积成百上千个 handler => 卡顿甚至卡死。
          const wired = jointHit as Gfx & { __downWired?: boolean };
          if (!wired.__downWired) {
            wired.__downWired = true;
            jointHit.on('pointerdown', (ev: FederatedPointerEvent) => {
              ev.stopPropagation();
              // ★ 拾取父级模式：点击骨骼 → 把等待中的素材绑定到该骨骼，然后退出
              const attachId = usePixiBonesStore.getState().attachingSlotId;
              if (attachId) {
                const target = boneById.get(node.id);
                if (target) {
                  const el = target.worldMatrix.elements;
                  usePixiBonesStore.getState().bindSlot(attachId, {
                    boneId: node.id,
                    ref: [el[0], el[1], el[3], el[4], el[6], el[7]],
                  });
                }
                return;
              }
              // ★ 权重「绑定模式」：点击骨骼 → 绑到当前选中网格（流程 A：先选网格）
              //   若当前已选骨骼 + 又点骨骼 → 累加绑定（多根一起绑）
              const stBind = usePixiBonesStore.getState();
              if (stBind.weightBindMode) {
                // 目标网格：优先用权重视图登记的「当前网格」（选骨骼不会清它），
                // 再退回当前选中附件 / 单选插槽；
                // 最后兜底：场景里只有一个网格时自动用它。
                let currentAid: string | null = stBind.weightMeshId
                  ?? stBind.selectedAttachmentId
                  ?? (stBind.selectedSlotIds.length === 1
                        ? stBind.slots.find((x) => x.id === stBind.selectedSlotIds[0])?.activeAttachmentId ?? null
                        : null);
                if (!currentAid) {
                  const keys = Object.keys(stBind.attachmentMeshes);
                  if (keys.length === 1) currentAid = keys[0];
                }
                if (currentAid) {
                  const mesh = stBind.attachmentMeshes[currentAid];
                  // 已有 → 累加，否则 = 新绑
                  const existing: string[] = mesh?.bones ?? [];
                  const merged = existing.includes(node.id) ? existing : [...existing, node.id];
                  // 取每根骨骼当前的 world 坐标（作为绑定姿态），存进 mesh.boneBindWorld
                  const boneWorlds: number[] = [];
                  for (const bid of merged) {
                    const bn = skeletonRef ? findBoneByRefWorld(skeletonRef, bid) : null;
                    if (bn) {
                      const e = bn.worldMatrix.elements;
                      boneWorlds.push(e[6], e[7]);
                    } else {
                      const b = stBind.bones.find((x) => x.id === bid);
                      boneWorlds.push(b ? b.x : 0, b ? b.y : 0);
                    }
                  }
                  stBind.bindBonesToMesh(currentAid, merged, undefined, boneWorlds);
                  // ★ 反馈：选中这根骨，权重面板骨骼列表 / 层级树会高亮它，
                  //   避免「点了没反应」的错觉（不退出绑定模式，可继续点其它骨）
                  stBind.selectBone(node.id);
                  return;
                }
                // 没选网格 → 不做事（用户该走流程 B：先选骨骼再点网格）
                return;
              }
              const mode = usePixiBonesStore.getState().editorMode;
              // ★ 0 长度骨骼（根骨 / 点骨骼）：
              //   - Pose 模式 + 该骨已选中：按悬停分区决定「移动」还是「旋转」
              //   - 旋转工具激活 + 该骨已选中：拖动整骨旋转（不需要分区判断）
              //   - 未选中时走下面的常规路径（先选中）
              const st0 = usePixiBonesStore.getState();
              const zeroSelected = st0.selectedBoneIds.includes(node.id);
              const canManipulateZero = node.length === 0 && zeroSelected && (
                mode === 'pose'
                || (st0.activeTool === 'rotate' && mode !== 'create')
                || (st0.activeTool === 'move' && mode !== 'create')
                || (st0.activeTool === 'scale' && mode !== 'create')
                || (st0.activeTool === 'shear' && mode !== 'create')
              );
              if (canManipulateZero) {
                const store = usePixiBonesStore.getState();
                const fresh = store.bones.find((n) => n.id === node.id) ?? node;
                store.pushHistory();
                // 旋转工具激活时直接进入旋转拖动；Pose 模式下按悬停分区决定
                const wantRotate = st0.activeTool === 'rotate' || (
                  st0.editorMode === 'pose'
                  && zoneRef.cur
                  && zoneRef.cur.boneId === node.id
                  && zoneRef.cur.kind === 'rotate'
                );
                if (wantRotate) {
                  showRotateCursor(ev.global.x, ev.global.y);
                  dragState = {
                    kind: 'rotate',
                    boneId: node.id,
                    startRot: fresh.rotation,
                    startScreen: { x: ev.global.x, y: ev.global.y },
                  };
                } else if (st0.activeTool === 'scale') {
                  // scale 中心 = joint 屏幕位置（world 坐标换算）
                  const jt = jointScreenInfo(node.id, fresh);
                  const lx = (ev.global.x - jt.x) * Math.cos(-jt.angle) - (ev.global.y - jt.y) * Math.sin(-jt.angle);
                  const ly = (ev.global.x - jt.x) * Math.sin(-jt.angle) + (ev.global.y - jt.y) * Math.cos(-jt.angle);
                  dragState = {
                    kind: 'scale',
                    boneId: node.id,
                    startScaleX: fresh.scaleX,
                    startScaleY: fresh.scaleY,
                    startScreen: { x: ev.global.x, y: ev.global.y },
                    originScreen: { x: jt.x, y: jt.y },
                    angle: jt.angle,
                    zone: detectScaleZone(lx, ly),
                  };
                } else if (st0.activeTool === 'shear') {
                  const jt = jointScreenInfo(node.id, fresh);
                  dragState = {
                    kind: 'shear',
                    boneId: node.id,
                    startSkew: 0,
                    startScreen: { x: ev.global.x, y: ev.global.y },
                    originScreen: { x: jt.x, y: jt.y },
                  };
                } else {
                  dragState = {
                    kind: 'root-move',
                    boneId: node.id,
                    startLocal: { x: fresh.x, y: fresh.y },
                    startScreen: { x: ev.global.x, y: ev.global.y },
                  };
                }
                return;
              }
              // ★ 子骨骼（length > 0）：旋转 / 缩放 / 倾斜工具 + 已选中 → 工具驱动拖动
              if (node.length > 0 && mode !== 'create' && zeroSelected && (
                st0.activeTool === 'rotate'
                || st0.activeTool === 'scale'
                || st0.activeTool === 'shear'
              )) {
                const store = usePixiBonesStore.getState();
                const fresh = store.bones.find((n) => n.id === node.id) ?? node;
                store.pushHistory();
                if (st0.activeTool === 'rotate') {
                  showRotateCursor(ev.global.x, ev.global.y);
                  dragState = {
                    kind: 'rotate',
                    boneId: node.id,
                    startRot: fresh.rotation,
                    startScreen: { x: ev.global.x, y: ev.global.y },
                  };
                } else {
                  // scale / shear 起点 = joint 屏幕位置（world 坐标换算）
                  const jt = jointScreenInfo(node.id, fresh);
                  dragState = st0.activeTool === 'scale'
                    ? {
                        kind: 'scale',
                        boneId: node.id,
                        startScaleX: fresh.scaleX,
                        startScaleY: fresh.scaleY,
                        startScreen: { x: ev.global.x, y: ev.global.y },
                        originScreen: { x: jt.x, y: jt.y },
                        angle: jt.angle,
                        zone: detectScaleZone(
                          (ev.global.x - jt.x) * Math.cos(-jt.angle) - (ev.global.y - jt.y) * Math.sin(-jt.angle),
                          (ev.global.x - jt.x) * Math.sin(-jt.angle) + (ev.global.y - jt.y) * Math.cos(-jt.angle),
                        ),
                      }
                    : {
                        kind: 'shear',
                        boneId: node.id,
                        startSkew: 0,
                        startScreen: { x: ev.global.x, y: ev.global.y },
                        originScreen: { x: jt.x, y: jt.y },
                      };
                }
                return;
              }
              if (mode === 'create') {
                // Create 模式：点骨骼同样从鼠标按下位置拖出子骨骼
                //   - joint 起点 = 鼠标按下位置（不在父骨骼 origin 上）
                //   - parent = 当前选中骨骼（无选中则根骨骼）
                const sx = root.scale.x;
                const sy = root.scale.y;
                const startWorld = {
                  x: (ev.global.x - root.x) / (sx || 1),
                  y: (ev.global.y - root.y) / (sy || 1),
                };
                const store = usePixiBonesStore.getState();
                const rootBone = store.bones.find((bb) => bb.parentId === null);
                const parentId = store.selectedBoneId || (rootBone ? rootBone.id : null);
                if (!parentId) return;
                const parentBone = boneById.get(parentId);
                if (!parentBone) return;
                const parentWorld = skeletonRef!.getWorldPosition(parentBone);
                const preview = new Gfx();
                preview.eventMode = 'none';
                a.stage.addChild(preview);
                dragState = {
                  kind: 'create-from',
                  parentId,
                  startWorld,
                  startScreen: { x: ev.global.x, y: ev.global.y },
                  parentWorld: { x: parentWorld.x, y: parentWorld.y },
                  preview,
                } as typeof dragState & { parentWorld: { x: number; y: number } };
                return;
              } else {
                // Pose 模式（或其他）：单击选中 / Shift+点击多选 / 拖动平移
                const store = usePixiBonesStore.getState();
                // ★ 闭包里的 node 是首次创建 jointHit 时的旧对象，务必实时从 store 取最新
                const fresh = store.bones.find((n) => n.id === node.id) ?? node;
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
                  startLocal: { x: fresh.x, y: fresh.y },
                  startScreen: { x: ev.global.x, y: ev.global.y },
                };
              }
            });
          }

          // 0 长度骨骼（根骨 / 点骨骼）没有 tipHandle，改为「移动 / 旋转 / 缩放 / 倾斜」手柄
          if (node.length === 0) {
            let h = zeroHandles.get(node.id);
            if (!h) {
              const move = new Gfx();
              move.eventMode = 'none';   // 纯视觉，交互一律走 jointHit
              drawRootMoveHandle(move);
              ikLayer.addChild(move);
              const rot = new Gfx();
              rot.eventMode = 'none';
              drawRootRotateHandle(rot);
              ikLayer.addChild(rot);
              const scl = new Gfx();
              scl.eventMode = 'static';   // 需要触发 pointermove/leave 才能 hover 变白
              drawScaleHandleGreen(scl);
              drawScaleHandleRed(scl);
              ikLayer.addChild(scl);
              // 命中区覆盖整块图标，hover 到绿/红块时对应轴变白，拖动则沿该轴缩放
              scl.hitArea = new Rectangle(-48, -48, 96, 96);
              const repaintScl = (zone: 'green' | 'red' | null) => {
                scl.clear();
                refillPolys(scl, SCALE_GREEN_POLYS, 0.15, SCALE_HANDLE_ANCHOR.x, SCALE_HANDLE_ANCHOR.y, zone === 'green' ? 0xFFFFFF : 0x4FF800);
                refillPolys(scl, SCALE_RED_POLYS, 0.15, SCALE_HANDLE_ANCHOR.x, SCALE_HANDLE_ANCHOR.y, zone === 'red' ? 0xFFFFFF : 0xFB3F3F);
              };
              const localOf = (gx: number, gy: number) => {
                const c = Math.cos(-scl.rotation);
                const s = Math.sin(-scl.rotation);
                const dx = gx - scl.x;
                const dy = gy - scl.y;
                return { lx: dx * c - dy * s, ly: dx * s + dy * c };
              };
              scl.on('pointermove', (ev: FederatedPointerEvent) => {
                const { lx, ly } = localOf(ev.global.x, ev.global.y);
                const zone = detectScaleZone(lx, ly);
                repaintScl(zone === 'green' ? 'green' : zone === 'red' ? 'red' : null);
                scl.cursor = zone === 'center' ? 'move'
                  : zone === 'green' ? 'ns-resize'
                  : 'ew-resize';
              });
              scl.on('pointerleave', () => repaintScl(null));
              scl.on('pointerdown', (ev: FederatedPointerEvent) => {
                ev.stopPropagation();
                const store = usePixiBonesStore.getState();
                const fresh = store.bones.find((n) => n.id === node.id) ?? node;
                store.pushHistory();
                const jt = jointScreenInfo(node.id, fresh);
                const c = Math.cos(-jt.angle), s = Math.sin(-jt.angle);
                const dx = ev.global.x - jt.x, dy = ev.global.y - jt.y;
                dragState = {
                  kind: 'scale',
                  boneId: node.id,
                  startScaleX: fresh.scaleX,
                  startScaleY: fresh.scaleY,
                  startScreen: { x: ev.global.x, y: ev.global.y },
                  originScreen: { x: jt.x, y: jt.y },
                  angle: jt.angle,
                  zone: detectScaleZone(dx * c - dy * s, dx * s + dy * c),
                };
              });
              const inc = new Gfx();
              inc.eventMode = 'none';
              drawInclineHandle(inc);
              ikLayer.addChild(inc);
              h = { move, rotate: rot, scale: scl, incline: inc };
              zeroHandles.set(node.id, h);
            }
            h.move.x = oX;
            h.move.y = oY;
            // 手柄跟着骨骼旋转：箭头始终对齐骨骼自身的局部 X/Y 轴
            h.move.rotation = node.rotation || 0;
            h.rotate.x = oX;
            h.rotate.y = oY;
            h.rotate.rotation = node.rotation || 0;
            h.scale.x = oX;
            h.scale.y = oY;
            h.scale.rotation = node.rotation || 0;
            h.incline.x = oX;
            h.incline.y = oY;
            h.incline.rotation = node.rotation || 0;
            // 仅 Pose 模式 + 该骨选中 + 对应悬停分区时才显示（同时同步光标）
            syncZeroHandles();
            // ★ move 工具激活 + 选中：在中心显示 axis-arrows 移动手柄（覆盖 Pose 的分区显隐）
            const stMove = usePixiBonesStore.getState();
            if (stMove.activeTool === 'move' && isSelected && stMove.editorMode !== 'create') {
              h.move.visible = true;
              h.rotate.visible = false;
              h.scale.visible = false;
              h.incline.visible = false;
            }
            // ★ scale 工具激活 + 选中：显示缩放手柄（可见并可交互）
            if (stMove.activeTool === 'scale' && isSelected && stMove.editorMode !== 'create') {
              h.move.visible = false;
              h.rotate.visible = false;
              h.scale.visible = true;
              h.incline.visible = false;
            }
            // ★ shear 工具激活 + 选中：显示倾斜手柄
            if (stMove.activeTool === 'shear' && isSelected && stMove.editorMode !== 'create') {
              h.move.visible = false;
              h.rotate.visible = false;
              h.scale.visible = false;
              h.incline.visible = true;
            }
            // 显隐可能被上面的工具分支改动，这里统一按最终可见性设置事件模式
            h.scale.eventMode = h.scale.visible ? 'static' : 'none';
            // ★「旋转工具」激活时：在该骨骼处显示红色 rotate 图标
            //   - 子骨骼：用关节圆环做指示（之前的红线）
            //   - 根骨骼：用 Codex rotate.json 的环+柄图标包住根骨
            // 注意：这里必须实时读 store（getState），不能用 useEffect 闭包里的 activeTool/editorMode，
            //   否则主 useEffect 依赖 [] 导致这两个值永远停在首次渲染。
            const stNow = usePixiBonesStore.getState();
            if (stNow.activeTool === 'rotate' && isSelected && stNow.editorMode !== 'create') {
              rotateToolIndicator.visible = true;
              if (node.parentId === null) {
                // 根骨：drawRotateIcon 居中放在根骨圆心；用 rootIconScale 让大小跟着 zoom
                rotateToolIndicator.x = oX;
                rotateToolIndicator.y = oY;
                rotateToolIndicator.rotation = node.rotation || 0;  // 图标跟着根骨一起转
                const S = rootIconScale(sAvg) / 0.15; // 红色旋转图标 = 根骨图标的两倍大
                drawRotateIcon(rotateToolIndicator, S);
              } else {
                // 子骨骼：joint 处画 rotate 图标（红色圆环 + 顶部小柄）
                rotateToolIndicator.x = oX;
                rotateToolIndicator.y = oY;
                rotateToolIndicator.rotation = 0;  // 旋转中心标记，保持世界朝向
                drawRotateIcon(rotateToolIndicator, 1);
              }
            }
            continue;
          }

          // ★ 子骨骼（length > 0）：旋转工具 + 已选中 → joint 处显示红色 rotate 图标
          const stNow2 = usePixiBonesStore.getState();
          if (stNow2.activeTool === 'rotate' && isSelected && stNow2.editorMode !== 'create') {
            rotateToolIndicator.visible = true;
            rotateToolIndicator.x = oX;
            rotateToolIndicator.y = oY;
            rotateToolIndicator.rotation = 0;  // 旋转中心标记，保持世界朝向
            drawRotateIcon(rotateToolIndicator, 1);
          }

          const tip = skeletonRef.getWorldTip(b);
          // 根骨 tip = 自身位置，用 rootAnchor 而不是 ox/oy
          const stageX = ox + tip.x * sx;
          const stageY = oy + tip.y * sy;

          // ★ tipHandle = IK 旋转手柄（Codex 设计的 ik-handle）：
          //   - 只有 Pose 模式 + 该骨被选中时才显示
          //   - 只能控制骨骼的旋转（绕自身关节），不改变长度
          //   - 按 id 缓存复用，避免每次 drawBones 新建 Gfx 留下残影
          let tipHandle = tipById.get(node.id) as (Gfx & { __boneId?: string }) | undefined;
          if (!tipHandle) {
            tipHandle = new Gfx() as Gfx & { __boneId?: string };
            tipHandle.__boneId = node.id;
            drawIkHandle(tipHandle);
            tipHandle.cursor = 'grab';
            tipHandle.on('pointerdown', (ev: FederatedPointerEvent) => {
              ev.stopPropagation();
              // 只旋转：绕骨骼自身关节改变 local rotation，长度不变
              // ★ 闭包里的 node 是创建时的旧引用，实时从 store 取最新
              const store = usePixiBonesStore.getState();
              const freshNode = store.bones.find((n) => n.id === node.id) ?? node;
              store.pushHistory();
              showRotateCursor(ev.global.x, ev.global.y);
              dragState = {
                kind: 'rotate',
                boneId: node.id,
                startRot: freshNode.rotation,
                startScreen: { x: ev.global.x, y: ev.global.y },
              };
            });
            ikLayer.addChild(tipHandle);
            tipById.set(node.id, tipHandle);
          }
          tipHandle.x = stageX;
          tipHandle.y = stageY;
          // 子骨骼 ik-handle 只在 Pose 模式显示（旋转模式改用 joint 处的 rotate 图标）
          const s0 = usePixiBonesStore.getState();
          const showHandle = isSelected && s0.editorMode === 'pose';
          tipHandle.visible = showHandle;
          tipHandle.eventMode = showHandle ? 'static' : 'none';

          // ★ 子骨骼移动手柄（axis-arrows）：move 工具 + 该骨选中时在 tip 处显示，拖动移动整骨
          let moveHandle = moveHandles.get(node.id);
          if (!moveHandle) {
            moveHandle = new Gfx();
            drawRootMoveHandle(moveHandle);
            moveHandle.eventMode = 'static';
            moveHandle.cursor = 'move';
            // 命中区覆盖整块图标（含箭头交叉点）——否则交叉点处没有图形、点不到、无法自由移动
            moveHandle.hitArea = new Rectangle(-48, -48, 96, 96);
            // hover 分区：命中哪组箭头，哪组变白
            let hoverZone: 'green' | 'red' | 'center' | null = null;
            const setHover = (zone: 'green' | 'red' | 'center' | null) => {
              if (hoverZone === zone) return;
              hoverZone = zone;
              const mh = moveHandle!;
              mh.clear();
              drawRootMoveHandle(mh, zone === 'green' ? 'green' : zone === 'red' ? 'red' : null);
              mh.cursor = zone === 'center' ? 'move'
                : zone === 'green' ? 'ns-resize'
                : zone === 'red' ? 'ew-resize'
                : 'move';
            };
            moveHandle.on('pointermove', (ev: FederatedPointerEvent) => {
              const mh = moveHandle!;
              const c = Math.cos(-mh.rotation);
              const s = Math.sin(-mh.rotation);
              const dx = ev.global.x - mh.x;
              const dy = ev.global.y - mh.y;
              setHover(detectMoveZone(dx * c - dy * s, dx * s + dy * c));
            });
            moveHandle.on('pointerleave', () => setHover(null));
            moveHandle.on('pointerdown', (ev: FederatedPointerEvent) => {
              ev.stopPropagation();
              const store = usePixiBonesStore.getState();
              const fresh = store.bones.find((n) => n.id === node.id) ?? node;
              store.pushHistory();
              // 判定按下时的分区 → 锁定本次拖动的移动轴
              const mh = moveHandle!;
              const c = Math.cos(-mh.rotation);
              const s = Math.sin(-mh.rotation);
              const dx = ev.global.x - mh.x;
              const dy = ev.global.y - mh.y;
              const zone = detectMoveZone(dx * c - dy * s, dx * s + dy * c);
              dragState = {
                kind: 'tip',
                boneId: node.id,
                startLocal: { x: fresh.x, y: fresh.y },
                startScreen: { x: ev.global.x, y: ev.global.y },
                moveZone: zone,
                // 红箭头 = 沿骨方向（手柄 rotation）；绿箭头 = 垂直骨方向（+90°）
                axisAngle: zone === 'green' ? mh.rotation + Math.PI / 2 : mh.rotation,
              };
            });
            ikLayer.addChild(moveHandle);
            moveHandles.set(node.id, moveHandle);
          }
          // ★ 子骨骼移动手柄：放在 joint（左侧圆圈）处，按骨骼方向对齐
          moveHandle.x = oX;
          moveHandle.y = oY;
          // 移动手柄对齐骨骼世界方向（红箭头沿骨、绿箭头垂直）
          moveHandle.rotation = Math.atan2(stageY - oY, stageX - oX);
          const stMoveChild = usePixiBonesStore.getState();
          const showMoveChild = isSelected && stMoveChild.activeTool === 'move' && stMoveChild.editorMode !== 'create';
          moveHandle.visible = showMoveChild;
          moveHandle.eventMode = showMoveChild ? 'static' : 'none';

          // ★ 缩放手柄（scale.json）：scale 工具 + 选中 → joint 处显示，拖动改变 scaleX/Y
          //   visual = 绿/红两轴手柄（hover 时对应轴变白）；hit = 透明命中区（判定绿/红/中心）
          let scaleHandle = scaleHandles.get(node.id);
          if (!scaleHandle) {
            const visual = new Gfx();
            visual.eventMode = 'none';
            drawScaleHandleGreen(visual);
            drawScaleHandleRed(visual);
            ikLayer.addChild(visual);

            const hit = new Gfx();
            hit.eventMode = 'static';
            hit.cursor = 'nwse-resize';
            // 命中区必须覆盖整块图标（绿/红色块远端距中心 ≈ 35px），
            // 否则点色块外侧会漏到骨骼命中区，被当成 center 等比缩放。
            // 命中区稍大于视觉图标，方便用户进入/离开 hover 状态
            hit.rect(-48, -48, 96, 96).fill({ color: 0xffffff, alpha: 0.001 });

            const repaint = (zone: 'green' | 'red' | null) => {
              visual.clear();
              refillPolys(visual, SCALE_GREEN_POLYS, 0.15, SCALE_HANDLE_ANCHOR.x, SCALE_HANDLE_ANCHOR.y, zone === 'green' ? 0xFFFFFF : 0x4FF800);
              refillPolys(visual, SCALE_RED_POLYS, 0.15, SCALE_HANDLE_ANCHOR.x, SCALE_HANDLE_ANCHOR.y, zone === 'red' ? 0xFFFFFF : 0xFB3F3F);
            };

            const setScaleHandleHover = (zone: 'green' | 'red' | 'center' | null) => {
              if (scaleHandle!.hoverZone === zone) return;
              scaleHandle!.hoverZone = zone;
              repaint(zone === 'green' ? 'green' : zone === 'red' ? 'red' : null);
              hit.cursor = zone === 'center' ? 'move'
                : zone === 'green' ? 'ns-resize'
                : zone === 'red' ? 'ew-resize'
                : 'nwse-resize';
            };

            const detectZone = (lx: number, ly: number) => detectScaleZone(lx, ly);

            hit.on('pointermove', (ev: FederatedPointerEvent) => {
              // 屏幕坐标 → Gfx 局部坐标（消去 hit.rotation）
              const lx = (ev.global.x - hit.x) * Math.cos(-hit.rotation) - (ev.global.y - hit.y) * Math.sin(-hit.rotation);
              const ly = (ev.global.x - hit.x) * Math.sin(-hit.rotation) + (ev.global.y - hit.y) * Math.cos(-hit.rotation);
              setScaleHandleHover(detectZone(lx, ly));
            });
            hit.on('pointerleave', () => {
              setScaleHandleHover(null);
            });
            hit.on('pointerdown', (ev: FederatedPointerEvent) => {
              ev.stopPropagation();
              const store = usePixiBonesStore.getState();
              const fresh = store.bones.find((n) => n.id === node.id) ?? node;
              store.pushHistory();
              // scale 中心 = 骨骼 joint 的屏幕位置（世界坐标换算，非 local x/y）
              const jt = jointScreenInfo(node.id, fresh);
              // 锁定本次拖动的轴
              const lx = (ev.global.x - hit.x) * Math.cos(-hit.rotation) - (ev.global.y - hit.y) * Math.sin(-hit.rotation);
              const ly = (ev.global.x - hit.x) * Math.sin(-hit.rotation) + (ev.global.y - hit.y) * Math.cos(-hit.rotation);
              scaleHandle!.dragZone = detectZone(lx, ly);
              dragState = {
                kind: 'scale' as const,
                boneId: node.id,
                startScaleX: fresh.scaleX,
                startScaleY: fresh.scaleY,
                startScreen: { x: ev.global.x, y: ev.global.y },
                originScreen: { x: jt.x, y: jt.y },
                angle: hit.rotation,
                zone: scaleHandle!.dragZone ?? 'center',
              };
            });
            ikLayer.addChild(hit);
            scaleHandle = { visual, hit, hoverZone: null, dragZone: null };
            scaleHandles.set(node.id, scaleHandle);
          }
          const sh = scaleHandle;
          sh.visual.x = oX;
          sh.hit.x = oX;
          sh.visual.y = oY;
          sh.hit.y = oY;
          // 缩放图标对齐骨骼世界方向（红轴沿骨、绿轴垂直）
          const rot = Math.atan2(stageY - oY, stageX - oX);
          sh.visual.rotation = rot;
          sh.hit.rotation = rot;
          const stScaleChild = usePixiBonesStore.getState();
          const showScaleChild = isSelected && stScaleChild.activeTool === 'scale' && stScaleChild.editorMode !== 'create';
          sh.visual.visible = showScaleChild;
          sh.hit.visible = showScaleChild;
          sh.hit.eventMode = showScaleChild ? 'static' : 'none';

          // ★ 倾斜手柄（incline.json）：shear 工具 + 选中 → joint 处显示，拖动改变 skewX
          let inclineHandle = inclineHandles.get(node.id);
          if (!inclineHandle) {
            inclineHandle = new Gfx();
            drawInclineHandle(inclineHandle);
            inclineHandle.eventMode = 'static';
            inclineHandle.cursor = 'grab';
            inclineHandle.on('pointerdown', (ev: FederatedPointerEvent) => {
              ev.stopPropagation();
              const store = usePixiBonesStore.getState();
              const fresh = store.bones.find((n) => n.id === node.id) ?? node;
              store.pushHistory();
              // 倾斜起点 = joint 屏幕位置
              const isRoot = fresh.parentId === null;
              const rr = store.render;
              const baseX = isRoot ? rr.x : root.x;
              const baseY = isRoot ? rr.y : root.y;
              const oxS = baseX + fresh.x * root.scale.x;
              const oyS = baseY + fresh.y * root.scale.y;
              dragState = {
                kind: 'shear' as const,
                boneId: node.id,
                startSkew: 0,
                startScreen: { x: ev.global.x, y: ev.global.y },
                originScreen: { x: oxS, y: oyS },
              };
            });
            ikLayer.addChild(inclineHandle);
            inclineHandles.set(node.id, inclineHandle);
          }
          inclineHandle.x = oX;
          inclineHandle.y = oY;
          inclineHandle.rotation = Math.atan2(stageY - oY, stageX - oX);
          const stInclineChild = usePixiBonesStore.getState();
          const showInclineChild = isSelected && stInclineChild.activeTool === 'shear' && stInclineChild.editorMode !== 'create';
          inclineHandle.visible = showInclineChild;
          inclineHandle.eventMode = showInclineChild ? 'static' : 'none';
        }
      };

      const onPointerMove = (ev: FederatedPointerEvent) => {
        if (!dragState) {
          // 无拖动时：处理「创建模式 + Command」的素材悬停虚线框
          lastPointer = { x: ev.global.x, y: ev.global.y };
          const stHover = usePixiBonesStore.getState();
          updateAttachmentHover(
            ev.global.x,
            ev.global.y,
            stHover.editorMode === 'create' && (ev.metaKey || metaDown),
          );
          // 网格「新建」描绘中：鼠标移动 → 刷新「最后一点 → 鼠标」的预览虚线
          if (stHover.meshNewPolygon) drawMeshHandles();
          return;
        }
        const st = usePixiBonesStore.getState();

        if (dragState.kind === 'tip') {
          const dxScreen = ev.global.x - dragState.startScreen.x;
          const dyScreen = ev.global.y - dragState.startScreen.y;
          const sx = root.scale.x;
          const sy = root.scale.y;
          // 屏幕 delta → 世界 delta
          let dxWorld = sx !== 0 ? dxScreen / sx : 0;
          let dyWorld = sy !== 0 ? dyScreen / sy : 0;
          // ★ 轴约束：moveZone 非 center 时，把位移投影到锁定轴上
          //   红箭头（沿骨方向）/ 绿箭头（垂直骨方向）——两端点确定的直线，投影即可
          const zone = dragState.moveZone ?? 'center';
          if (zone !== 'center' && dragState.axisAngle !== undefined) {
            const ax = Math.cos(dragState.axisAngle);
            const ay = Math.sin(dragState.axisAngle);
            const proj = dxWorld * ax + dyWorld * ay;
            dxWorld = proj * ax;
            dyWorld = proj * ay;
          }
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
        } else if (dragState.kind === 'rotate') {
          // 绿色旋转光标跟随鼠标
          showRotateCursor(ev.global.x, ev.global.y);
          const node = findBone(st.bones, dragState.boneId);
          if (!node) return;
          const bone = boneById.get(dragState.boneId);
          if (!bone) return;
          const origin = skeletonRef!.getWorldPosition(bone);
          // 根骨图标画在 render 锚点上（不是 root 容器左上角），旋转轴心要跟图标一致
          const isRoot = node.parentId === null;
          const rr = st.render;
          const baseX = isRoot ? rr.x : root.x;
          const baseY = isRoot ? rr.y : root.y;
          const oxS = baseX + origin.x * root.scale.x;
          const oyS = baseY + origin.y * root.scale.y;
          const startAngle = Math.atan2(dragState.startScreen.y - oyS, dragState.startScreen.x - oxS);
          const nowAngle = Math.atan2(ev.global.y - oyS, ev.global.x - oxS);
          const newRot = dragState.startRot + (nowAngle - startAngle);
          // 直接写 state，不入栈（避免每次 mousemove 都产生一条 history）
          const boneId = dragState.boneId;
          usePixiBonesStore.setState((s) => ({
            bones: s.bones.map((n) => (n.id === boneId ? { ...n, rotation: newRot } : n)),
          }));
        } else if (dragState.kind === 'root-move') {
          // 根骨移动：改变自身 local (x,y)，整棵骨骼树跟着走
          const sx = root.scale.x;
          const sy = root.scale.y;
          const dxScreen = ev.global.x - dragState.startScreen.x;
          const dyScreen = ev.global.y - dragState.startScreen.y;
          const newX = dragState.startLocal.x + (sx !== 0 ? dxScreen / sx : 0);
          const newY = dragState.startLocal.y + (sy !== 0 ? dyScreen / sy : 0);
          const boneId = dragState.boneId;
          usePixiBonesStore.setState((s) => ({
            bones: s.bones.map((n) => (n.id === boneId ? { ...n, x: newX, y: newY } : n)),
          }));
        } else if (dragState.kind === 'scale') {
          // 缩放：把拖动位移投影到「手柄自身坐标轴」（考虑骨骼旋转角），再按锁定 zone 计算
          //   - zone='green'（绿=Y 轴块）：只改 scaleY
          //   - zone='red'（红=X 轴块）：只改 scaleX
          //   - zone='center'（中间）：等比缩放
          const boneId = dragState.boneId;
          const θ = dragState.angle;
          const cos = Math.cos(-θ);
          const sin = Math.sin(-θ);
          const proj = (dx: number, dy: number) => ({
            x: dx * cos - dy * sin,
            y: dx * sin + dy * cos,
          });
          const nowP = proj(ev.global.x - dragState.originScreen.x, ev.global.y - dragState.originScreen.y);
          const startP = proj(dragState.startScreen.x - dragState.originScreen.x, dragState.startScreen.y - dragState.originScreen.y);
          let newScaleX = dragState.startScaleX;
          let newScaleY = dragState.startScaleY;
          if (dragState.zone === 'green') {
            // 沿绿块（局部 Y 轴）方向：远离关节放大
            if (startP.y !== 0) newScaleY = dragState.startScaleY * (nowP.y / startP.y);
          } else if (dragState.zone === 'red') {
            // 沿红块（局部 X 轴）方向：远离关节放大
            if (startP.x !== 0) newScaleX = dragState.startScaleX * (nowP.x / startP.x);
          } else {
            // center = 等比：两轴比例取平均
            const rx = startP.x !== 0 ? nowP.x / startP.x : 1;
            const ry = startP.y !== 0 ? nowP.y / startP.y : 1;
            const ratio = (rx + ry) / 2;
            newScaleX = dragState.startScaleX * ratio;
            newScaleY = dragState.startScaleY * ratio;
          }
          const safeX = Math.min(20, Math.max(0.05, newScaleX));
          const safeY = Math.min(20, Math.max(0.05, newScaleY));
          // ★ 只写真正变化的轴：red 只改 scaleX、green 只改 scaleY、center 两个都改
          const patch: Partial<{ scaleX: number; scaleY: number }> =
            dragState.zone === 'red' ? { scaleX: safeX }
            : dragState.zone === 'green' ? { scaleY: safeY }
            : { scaleX: safeX, scaleY: safeY };
          usePixiBonesStore.setState((s) => ({
            bones: s.bones.map((n) => (n.id === boneId ? { ...n, ...patch } : n)),
          }));
        } else if (dragState.kind === 'shear') {
          // 倾斜：沿骨骼方向的水平偏移换算成 rotation 增量（视觉近似）
          //   实际 Spine 用 skewX，本引擎没有该字段；为可交互先映射为 rotation 改变
          const boneId = dragState.boneId;
          const node = findBone(usePixiBonesStore.getState().bones, boneId);
          if (!node) return;
          const dxScreen = ev.global.x - dragState.startScreen.x;
          // 1 像素 = 0.5 度倾斜，便于感知
          const delta = dxScreen * 0.01;
          const newRot = node.rotation + delta;
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
          drawHighlight(s.psd, s.images, s.slots, s.selectedSlotIds);
          drawBones(s.bones, s.selectedBoneId, s.selectedBoneIds);
        } else if (dragState.kind === 'layer-transform') {
          // 仿 Spine SlotTransform：移动/旋转/缩放/倾斜当前选中的图层。
          const { tool, start, startScreen, anchorScreen, slotId, zone, axisAngle, handleRotation } = dragState;
          const dxScreen = ev.global.x - startScreen.x;
          const dyScreen = ev.global.y - startScreen.y;
          const sxr = root.scale.x;
          const syr = root.scale.y;
          const next = { ...start };
          if (tool === 'move') {
            // 平移：根据 zone 约束到 axisAngle 一根轴上
            if (zone === 'center' || axisAngle === undefined) {
              next.tx = start.tx + (sxr !== 0 ? dxScreen / sxr : 0);
              next.ty = start.ty + (syr !== 0 ? dyScreen / syr : 0);
            } else {
              const ax = Math.cos(axisAngle);
              const ay = Math.sin(axisAngle);
              // 投影到约束轴上
              const proj = (dxScreen * ax + dyScreen * ay);
              const wLen = sxr !== 0 ? proj / sxr : 0;
              next.tx = start.tx + ax * wLen;
              next.ty = start.ty + ay * wLen;
            }
          } else if (tool === 'rotate') {
            // 旋转：以锚点为中心，绕中心角度变化（不受 zone 影响）
            const a0 = Math.atan2(startScreen.y - anchorScreen.y, startScreen.x - anchorScreen.x);
            const a1 = Math.atan2(ev.global.y - anchorScreen.y, ev.global.x - anchorScreen.x);
            next.rotation = start.rotation + (a1 - a0);
          } else if (tool === 'scale') {
            // 缩放：center = 等比，red/green = 单轴
            if (zone === 'center' || axisAngle === undefined) {
              const d0 = Math.hypot(startScreen.x - anchorScreen.x, startScreen.y - anchorScreen.y);
              const d1 = Math.hypot(ev.global.x - anchorScreen.x, ev.global.y - anchorScreen.y);
              const k = d0 > 1e-3 ? d1 / d0 : 1;
              next.scaleX = start.scaleX * k;
              next.scaleY = start.scaleY * k;
            } else {
              // 单轴缩放 k = (startLen + proj) / startLen
              //   startLen = 该方向在屏幕上的初始长度（按图层旋转后轴向）
              //   proj     = 屏幕 delta 投影到 axisAngle
              const ax = Math.cos(axisAngle);
              const ay = Math.sin(axisAngle);
              const proj = (dxScreen * ax + dyScreen * ay);
              // 把 startLen 算成"按下时该方向的屏幕长度"（用插槽当前激活附件）
              // red=沿 X（局部 width），green=沿 Y（height）
              const st = usePixiBonesStore.getState();
              const scaleSlot = st.slots.find((x) => x.id === slotId) ?? null;
              const layer = scaleSlot?.activeAttachmentId
                ? allAttachmentsOf(st.psd, st.images).find((l) => l.id === scaleSlot.activeAttachmentId) ?? null
                : null;
              const startLen = layer
                ? (zone === 'red' ? layer.width * Math.abs(sxr) : layer.height * Math.abs(syr))
                : 0;
              if (startLen > 0.5) {
                const k = (startLen + proj) / startLen;
                if (zone === 'red') next.scaleX = start.scaleX * k;
                else next.scaleY = start.scaleY * k;
              }
            }
          } else if (tool === 'shear') {
            // 倾斜：center = 同时改 X/Y；red = 仅 skewX（X 倾斜）；green = 仅 skewY（Y 倾斜）
            if (zone === 'red' || zone === 'center') {
              next.skewX = start.skewX + (zone === 'center' ? dxScreen * 0.5 : dxScreen);
            }
            if (zone === 'green' || zone === 'center') {
              next.skewY = start.skewY + (zone === 'center' ? dyScreen * 0.5 : dyScreen);
            }
          }
          usePixiBonesStore.getState().setSlotTransform(slotId, next);
        } else if (dragState.kind === 'mesh-vertex') {
          // 拖动顶点：把选中的顶点按「附件局部坐标」的位移整体平移
          const ctx = meshEditContext();
          if (ctx && ctx.attachmentId === dragState.attachmentId) {
            const p = screenToAttachmentLocal(dragState.slotId, ctx.layer, ev.global.x, ev.global.y);
            if (p) {
              const dx = p.x - dragState.startLocal.x;
              const dy = p.y - dragState.startLocal.y;
              if (!dragState.moved && (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01)) {
                dragState.moved = true;
                st.pushHistory();   // 首次真正位移时才推历史（避免点一下也入栈）
              }
              if (dragState.moved) {
                const verts = dragState.startVertices.slice();
                const sw = dragState.softWeights;
                if (sw) {
                  // 软选择：每个顶点按自己的权重位移（羽化衰减）
                  for (let i = 0; i < sw.length; i++) {
                    const k = sw[i];
                    if (k <= 0) continue;
                    verts[i * 2] = dragState.startVertices[i * 2] + dx * k;
                    verts[i * 2 + 1] = dragState.startVertices[i * 2 + 1] + dy * k;
                  }
                } else {
                  for (const vi of dragState.indices) {
                    verts[vi * 2] = dragState.startVertices[vi * 2] + dx;
                    verts[vi * 2 + 1] = dragState.startVertices[vi * 2 + 1] + dy;
                  }
                }
                st.setMeshVertices(dragState.attachmentId, verts);
                syncMeshVertices(dragState.attachmentId);
                drawMeshHandles();
              }
            }
          }
        } else if (dragState.kind === 'mesh-marquee') {
          // 框选顶点：实时画矩形 + 更新选中集合
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
          const ctxM = meshEditContext();
          if (ctxM && ctxM.attachmentId === dragState.attachmentId) {
            const pts = meshVerticesScreen(dragState.slotId, ctxM.layer, ctxM.mesh);
            const picked: number[] = [];
            for (let i = 0; i < pts.length; i++) {
              const q = pts[i];
              if (q.x >= x && q.x <= x + w && q.y >= y && q.y <= y + h) picked.push(i);
            }
            st.setMeshSelectedVertices(
              dragState.additive ? Array.from(new Set([...dragState.prevSel, ...picked])) : picked,
            );
            drawMeshHandles();
          }
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
          // 更新预览：画出子骨骼形状（跟随鼠标），而不是一条黄线
          const sx = root.scale.x;
          const sy = root.scale.y;
          const ox = root.x;
          const oy = root.y;
          const dxScreen = ev.global.x - dragState.startScreen.x;
          const dyScreen = ev.global.y - dragState.startScreen.y;
          // 鼠标世界坐标
          const mouseWorldX = dragState.startWorld.x + (sx !== 0 ? dxScreen / sx : 0);
          const mouseWorldY = dragState.startWorld.y + (sy !== 0 ? dyScreen / sy : 0);
          // joint 屏幕坐标（起点）与 tip 屏幕坐标（鼠标）
          const sx0 = ox + dragState.startWorld.x * sx;
          const sy0 = oy + dragState.startWorld.y * sy;
          const mx = ox + mouseWorldX * sx;
          const my = oy + mouseWorldY * sy;
          const screenLen = Math.hypot(mx - sx0, my - sy0);
          const angleRad = Math.atan2(my - sy0, mx - sx0);
          // 预览 = 一根 scaleX=scaleY=1 的新骨骼，世界长度 = screenLen / sx。
          // 直接套用「正式渲染」的公式（保证预览与创建结果形状完全一致）：
          //   e0 = (cos·scaleX·sx, sin·scaleX·sx) × (length/360)
          //      length = screenLen/sx ⇒ e0 = (cos·screenLen, sin·screenLen) / 360
          //   e1 = (-sin·sx, cos·sy) × 宽度系数   ← 短骨骼等比变细、超长后宽度锁定
          const cosP = Math.cos(angleRad);
          const sinP = Math.sin(angleRad);
          const lenForVb = Math.max(screenLen, 1) / 360;   // 1 viewBox 单位 = lenForVb 屏幕像素
          const previewWorldLen = Math.max(screenLen, 1) / (Math.abs(sx) > 1e-6 ? Math.abs(sx) : 1);
          const wScale = boneWidthScale(previewWorldLen);
          const e0x = cosP * lenForVb;
          const e0y = sinP * lenForVb;
          const e1x = -sinP * sx * wScale;
          const e1y = cosP * sy * wScale;
          dragState.preview.clear();
          // 用和正式渲染完全一致的骨骼形状（黄色 = 创建后即被选中的颜色）
          // 关节圆环跟 root zoom 走，并同样乘宽度系数（跟正式渲染一致）
          const previewJointR = 9 * Math.max(Math.abs(sx), Math.abs(sy)) * wScale;
          drawBoneShape(dragState.preview, sx0, sy0, e0x, e0y, e1x, e1y, 0xF0E020, previewJointR);
          // 暂存当前鼠标世界坐标，pointerup 用
          (dragState as { currentMouseWorld?: { x: number; y: number } }).currentMouseWorld = { x: mouseWorldX, y: mouseWorldY };
        }
      };
      const onPointerUp = (ev: FederatedPointerEvent) => {
        if (!dragState) return;
        // 网格编辑：顶点框选收尾（销毁选框；顶点拖动无需特殊处理）
        if (dragState.kind === 'mesh-marquee') {
          a.stage.removeChild(dragState.rect);
          dragState.rect.destroy();
        }
        // 创建子骨骼：pointerup 时如果在 create-from 状态，根据当前鼠标位置 addBone
        if (dragState.kind === 'create-from') {
          // 单击（没有 pointermove）时鼠标世界坐标就是按下点
          const mouseWorld =
            (dragState as { currentMouseWorld?: { x: number; y: number } }).currentMouseWorld
            ?? dragState.startWorld;
          const parentWorld = (dragState as { parentWorld?: { x: number; y: number } }).parentWorld;
          if (mouseWorld && parentWorld) {
            // joint 起点 = 鼠标按下位置（dragState.startWorld）
            // tip = 鼠标松开位置（mouseWorld）
            const startX = dragState.startWorld.x;
            const startY = dragState.startWorld.y;
            const dx = mouseWorld.x - startX;
            const dy = mouseWorld.y - startY;
            const dragLen = Math.sqrt(dx * dx + dy * dy);
            // ★ 单击（几乎没拖动）=> 创建一个 0 长度的「点骨骼」，
            //   它的图标和根骨骼一样是十字，用来当纯旋转/挂载节点
            const isClick = dragLen <= 1;
            const length = isClick ? 0 : dragLen;
            // 父骨骼的世界旋转（弧度）：由父骨骼 world joint → world tip 方向得出；
            // 根骨（长度 0、无 tip 方向）时为 0。
            let parentWorldRot = 0;
            const parentBone = boneById.get(dragState.parentId);
            if (parentBone) {
              const pa = skeletonRef!.getWorldPosition(parentBone);
              const pt = skeletonRef!.getWorldTip(parentBone);
              parentWorldRot = Math.atan2(pt.y - pa.y, pt.x - pa.x);
            }
            // 新骨骼世界方向（弧度）：单击没有方向，直接继承父骨骼
            const worldRot = isClick ? parentWorldRot : Math.atan2(dy, dx);
            // joint 在父骨骼 local frame 下的 (x, y)：反旋转父世界旋转
            const offX = startX - parentWorld.x;
            const offY = startY - parentWorld.y;
            const cos = Math.cos(-parentWorldRot);
            const sin = Math.sin(-parentWorldRot);
            const localX = offX * cos - offY * sin;
            const localY = offX * sin + offY * cos;
            // 子骨骼 local rotation（弧度，store/引擎统一用弧度）
            const localRot = worldRot - parentWorldRot;
            // 若当前选中了插槽（创建模式下 ⌘ 点击素材选中的），
            //   新骨骼自动绑定到该插槽，并以插槽名命名。
            const stCreate = usePixiBonesStore.getState();
            const targetSlot = stCreate.selectedSlotId
              ? stCreate.slots.find((s) => s.id === stCreate.selectedSlotId) ?? null
              : null;
            // ★ addBone 内部会自动设置 selectedBoneId = 新骨 id，
            //   因此创建后新骨高亮选中，下次拖动即以它为父，实现递归创建
            stCreate.addBone(dragState.parentId, {
              x: localX,
              y: localY,
              rotation: localRot,
              length,
              ...(targetSlot ? { name: targetSlot.name, slotId: targetSlot.id } : {}),
            });
            if (targetSlot) {
              const newId = usePixiBonesStore.getState().selectedBoneId;
              const nb = newId ? boneById.get(newId) : null;
              if (newId && nb) {
                const el = nb.worldMatrix.elements;
                usePixiBonesStore.getState().bindSlot(targetSlot.id, {
                  boneId: newId,
                  ref: [el[0], el[1], el[3], el[4], el[6], el[7]],
                });
                // 绑定完成：目标是一次性的 → 取消插槽选中，新骨成为当前选中
                usePixiBonesStore.getState().selectBone(newId);
              }
            }
          }
          // 清理预览
          a.stage.removeChild(dragState.preview);
          dragState.preview.destroy();
        } else if (dragState.kind === 'marquee') {
          const { startScreen, nowScreen, rect, additive, prevSelIds, prevSlotIds, hitSlotId } = dragState;
          const store = usePixiBonesStore.getState();
          // ★ 姿势模式下（editorMode === 'pose'）：画布上的图层不允许被选中（只能选骨骼）
          const layerSelectable = store.editorMode !== 'pose';
          const moved = Math.hypot(nowScreen.x - startScreen.x, nowScreen.y - startScreen.y) > 3;
          if (!moved) {
            // 单击：若点在图层上 → 选中它所属的**插槽**（Shift = 加选，跟骨骼一致）
            if (hitSlotId && layerSelectable) {
              if (additive) store.selectSlots([...prevSlotIds, hitSlotId], false);
              else store.selectSlots([hitSlotId], false);
            }
            // 点空白：pointerdown 时已清空选中，无需处理
          } else {
            const xMin = Math.min(startScreen.x, nowScreen.x);
            const xMax = Math.max(startScreen.x, nowScreen.x);
            const yMin = Math.min(startScreen.y, nowScreen.y);
            const yMax = Math.max(startScreen.y, nowScreen.y);
            // 1) 框内骨骼：关节 或 尖端 落在框内即命中
            const hitBones: string[] = [];
            if (skeletonRef) {
              const insideRect = (x: number, y: number) =>
                x >= xMin && x <= xMax && y >= yMin && y <= yMax;
              for (const n of store.bones) {
                const bone = boneById.get(n.id);
                if (!bone) continue;
                // 根 world → screen（根骨用 store.render 不用 ox/oy，避免被映射到 PSD 左上角）
                const r = store.render;
                const p0 = skeletonRef.getWorldPosition(bone);
                const isRootNode = n.parentId === null;
                const sx0 = (isRootNode ? r.x : root.x) + p0.x * root.scale.x;
                const sy0 = (isRootNode ? r.y : root.y) + p0.y * root.scale.y;
                // tip world → screen
                const p1 = skeletonRef.getWorldTip(bone);
                const sx1 = root.x + p1.x * root.scale.x;
                const sy1 = root.y + p1.y * root.scale.y;
                if (insideRect(sx0, sy0) || insideRect(sx1, sy1)) {
                  hitBones.push(n.id);
                }
              }
            }
            // 2) 框内插槽：插槽的激活附件矩形与框相交；姿势模式下不参与
            const hitSlots: string[] = [];
            if (layerSelectable) {
              const sxr = root.scale.x;
              const syr = root.scale.y;
              for (const { slot, layer: l } of renderablesOf(store.psd, store.images, store.slots)) {
                if (store.slotVisibility[slot.id] === false) continue;
                if (l.width === 0 || l.height === 0) continue;
                const lx0 = root.x + l.left * sxr;
                const ly0 = root.y + l.top * syr;
                const lx1 = lx0 + l.width * sxr;
                const ly1 = ly0 + l.height * syr;
                if (lx1 >= xMin && lx0 <= xMax && ly1 >= yMin && ly0 <= yMax) {
                  hitSlots.push(slot.id);
                }
              }
            }
            // 骨骼与插槽一起选中（两个选中集独立）：
            //   - 骨骼被框中的判定：关节/尖端在框内
            //   - 插槽被框中的判定：其激活附件矩形与框相交
            // 增量（Shift）时各自与「按下时已有的选中」合并。
            const mergedBones = additive ? Array.from(new Set([...prevSelIds, ...hitBones])) : hitBones;
            // 姿势模式：插槽选中集保持为空（不选图层）
            const mergedLayers = layerSelectable
              ? (additive ? Array.from(new Set([...prevSlotIds, ...hitSlots])) : hitSlots)
              : [];
            store.selectBox(mergedBones, mergedLayers);
          }
          // 清理框选矩形
          a.stage.removeChild(rect);
          rect.destroy();
        } else if (dragState.kind === 'pan') {
          // 创建模式下「单击右键」= 自动回到姿势模式（拖动平移不算单击）
          const dx = ev.global.x - dragState.startScreen.x;
          const dy = ev.global.y - dragState.startScreen.y;
          const store = usePixiBonesStore.getState();
          if (Math.hypot(dx, dy) <= 4 && store.editorMode === 'create') {
            store.setEditorMode('pose');
          }
        }
        dragState = null;
        hideRotateCursor();
        a.canvas.style.cursor = 'default';
        // 拖动结束后重新评估 0 长度骨骼手柄的显隐 / 光标
        syncZeroHandles();
        drawMeshHandles();
      };

      a.stage.eventMode = 'static';
      a.stage.hitArea = a.screen;
      a.stage.on('pointermove', onPointerMove);
      a.stage.on('pointerup', onPointerUp);
      a.stage.on('pointerupoutside', onPointerUp);

      // ★ 选中图层 + 变换工具时：slotHandles 接收 pointerdown 启动 layer-transform 拖动。
      //   一次绑定即可（drawSlotHandles 每帧清空但不 destroy Gfx，事件正常发到 slotHandles.target）。
      slotHandles.eventMode = 'static';
      // ★ hover 高亮：pointermove 时把屏幕坐标转到手柄局部，按工具调对应 zone 检测
      //   → 把对应轴画白；同时设置光标样式以提示操作类型
      const updateLayerHandleHover = (gx: number, gy: number) => {
        const st = usePixiBonesStore.getState();
        if (!st.selectedSlotId || !st.activeTool || st.editorMode === 'create' || st.attachingSlotId) {
          if (slotHandleHover !== null) {
            slotHandleHover = null;
            a.canvas.style.cursor = 'default';
          }
          return;
        }
        const tool = st.activeTool;
        const lt = st.slotTransforms[st.selectedSlotId] ?? { tx: 0, ty: 0, rotation: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 };
        // 用选中插槽的「激活附件」求锚点（手柄画在它中心）
        const hoverSlot = st.slots.find((s) => s.id === st.selectedSlotId) ?? null;
        const layer = hoverSlot?.activeAttachmentId
          ? allAttachmentsOf(st.psd, st.images).find((l) => l.id === hoverSlot.activeAttachmentId) ?? null
          : null;
        if (!layer) return;
        // ★ 锚点 = 图层中心（与绘制手柄一致）
        const { x: ax, y: ay } = attachmentAnchorScreen(layer, lt);
        const c = Math.cos(-lt.rotation);
        const s = Math.sin(-lt.rotation);
        const dx = gx - ax;
        const dy = gy - ay;
        const lx = dx * c - dy * s;
        const ly = dx * s + dy * c;
        let zone: 'red' | 'green' | 'center' | null = null;
        if (tool === 'move') zone = detectMoveZone(lx, ly);
        else if (tool === 'scale') zone = detectScaleZone(lx, ly);
        else if (tool === 'shear') zone = Math.abs(lx) < 4 ? 'center' : (lx < 0 ? 'red' : 'green');
        // rotate 永远整个手柄 = 一个区，不单独高亮
        if (tool === 'rotate') {
          // 整个圆环都是有效区，高亮不强分区
          const R = 30;
          if (lx * lx + ly * ly <= R * R) zone = 'center';
          else zone = null;
        }
        if (slotHandleHover !== zone) {
          slotHandleHover = zone;
          // ★ 光标必须设到 slotHandles.cursor —— PIXI 每次 pointermove 会用「命中对象的 cursor」
          //   覆写 canvas.style.cursor，直接写 canvas.style 会被立刻覆盖掉。
          if (zone === 'red') slotHandles.cursor = tool === 'scale' ? 'ew-resize' : 'move';
          else if (zone === 'green') slotHandles.cursor = tool === 'scale' ? 'ns-resize' : 'move';
          else if (zone === 'center') slotHandles.cursor = tool === 'scale' ? 'nwse-resize' : tool === 'rotate' ? 'crosshair' : 'move';
          else slotHandles.cursor = 'default';
          // ★ hover 变化后立刻重画手柄（否则白色高亮不会出现）
          drawSlotHandles(st.psd, st.images, st.slots, st.selectedSlotId, tool, st.slotTransforms);
        }
      };
      slotHandles.on('pointermove', (ev: FederatedPointerEvent) => {
        updateLayerHandleHover(ev.global.x, ev.global.y);
      });
      slotHandles.on('pointerleave', () => {
        if (slotHandleHover !== null) {
          slotHandleHover = null;
          slotHandles.cursor = 'default';
          const st = usePixiBonesStore.getState();
          drawSlotHandles(st.psd, st.images, st.slots, st.selectedSlotId, st.activeTool, st.slotTransforms);
        }
      });
      slotHandles.on('pointerdown', (ev: FederatedPointerEvent) => {
        if (ev.button !== 0) return;
        const st = usePixiBonesStore.getState();
        const slotId = st.selectedSlotId;
        if (!slotId || !st.activeTool) return;
        // 创建模式、或在拾取父级模式、或层级在选骨骼时：不响应
        if (st.editorMode === 'create' || st.attachingSlotId) return;
        ev.stopPropagation();
        const lt = st.slotTransforms[slotId] ?? { tx: 0, ty: 0, rotation: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 };
        const slot = st.slots.find((s) => s.id === slotId) ?? null;
        const layer = slot?.activeAttachmentId
          ? allAttachmentsOf(st.psd, st.images).find((l) => l.id === slot.activeAttachmentId) ?? null
          : null;
        if (!layer) return;
        // 锚点 = 图层中心（与绘制 / hover 一致）
        const { x: ax, y: ay } = attachmentAnchorScreen(layer, lt);
        // ★ 推一次历史快照
        st.pushHistory();
        const { zone, axisAngle, handleRotation } = slotZoneAndAxis(st.activeTool, ev.global.x, ev.global.y, ax, ay, lt);
        dragState = {
          kind: 'layer-transform',
          tool: st.activeTool,
          slotId,
          start: lt,
          startScreen: { x: ev.global.x, y: ev.global.y },
          anchorScreen: { x: ax, y: ay },
          zone,
          axisAngle,
          handleRotation,
        };
      });

      // ★ hover 兜底：鼠标离开整个 stage 时清空 hover 状态。
      // 因为 drawBones 会 destroy 旧 jointHit（不触发 leave），新的也不会自动 enter，
      // 所以用 stage 级的 pointerleave 保证 hover 一定不会"粘住"。
      a.stage.on('pointerleave', () => {
        if (usePixiBonesStore.getState().hoveredBoneId !== null) {
          usePixiBonesStore.getState().setHoveredBoneId(null);
        }
      });

      // Command 键按下/抬起：刷新（或清除）「创建模式」下的素材悬停虚线框。
      // （鼠标不动只按键时，靠这里更新，避免虚线框残留）
      const onModifierKey = (e: KeyboardEvent) => {
        if (e.key !== 'Meta') return;
        metaDown = e.type === 'keydown';
        const st = usePixiBonesStore.getState();
        updateAttachmentHover(lastPointer.x, lastPointer.y, st.editorMode === 'create' && metaDown);
      };
      window.addEventListener('keydown', onModifierKey);
      window.addEventListener('keyup', onModifierKey);
      cleanups.push(() => {
        window.removeEventListener('keydown', onModifierKey);
        window.removeEventListener('keyup', onModifierKey);
      });

      a.stage.on('pointerdown', (ev: FederatedPointerEvent) => {
        if (ev.button !== 0) return;
        const stGrid = usePixiBonesStore.getState();
        // ★ 网格编辑模式优先：拖顶点 / 加顶点 / 删顶点 / 框选顶点
        if (stGrid.meshEditSlotId) {
          const ctx = meshEditContext();
          if (ctx) {
            const p = screenToAttachmentLocal(ctx.slot.id, ctx.layer, ev.global.x, ev.global.y);
            if (p) {
              // ★ 网格「新建」描绘中：点击逐点描绘轮廓；点回起点（12px 内）即闭合
              if (stGrid.meshNewPolygon) {
                ev.stopPropagation();
                const poly = stGrid.meshNewPolygon;
                if (poly.length >= 3) {
                  const s0 = attachmentLocalToScreen(ctx.slot.id, ctx.layer, poly[0].x, poly[0].y);
                  if (Math.hypot(s0.x - ev.global.x, s0.y - ev.global.y) < 12) {
                    finishNewPolygon(ctx.attachmentId, ctx.layer, poly);
                    drawMeshHandles();
                    return;
                  }
                }
                stGrid.setMeshNewPolygon([...poly, { x: p.x, y: p.y }]);
                drawMeshHandles();
                return;
              }
              const pts = meshVerticesScreen(ctx.slot.id, ctx.layer, ctx.mesh);
              // 命中顶点（屏幕距离阈值 9px）
              let hitIdx = -1;
              let bestD = 9;
              for (let i = 0; i < pts.length; i++) {
                const d = Math.hypot(pts[i].x - ev.global.x, pts[i].y - ev.global.y);
                if (d < bestD) {
                  bestD = d;
                  hitIdx = i;
                }
              }
              const tool = stGrid.meshTool;

              if (tool === 'delete') {
                ev.stopPropagation();
                if (hitIdx >= 0) collapseMeshVertex(ctx.attachmentId, hitIdx);
                return;
              }

              if (tool === 'create') {
                ev.stopPropagation();
                // 靠近某条边（容差按屏幕换算到局部）→ 在该边上离点击最近的落点插入；
                // 否则落在三角形内部 → 在该点把三角形一分为三。
                const sx = Math.abs(root.scale.x) || 1;
                const localTol = 8 / sx;
                const near = edgeNear(ctx.mesh, p.x, p.y, localTol);
                if (near) {
                  splitEdgeAt(ctx.attachmentId, near[0], near[1], p.x, p.y);
                } else {
                  const tri = triangleAt(ctx.mesh, p.x, p.y);
                  if (tri >= 0) splitTriangle(ctx.attachmentId, tri, p.x, p.y);
                }
                return;
              }

              // tool === 'modify'：命中顶点 → 拖动；否则空白 → 框选
              if (hitIdx >= 0) {
                ev.stopPropagation();
                // 双击同一顶点 → 删除（顶点塌陷）
                const now = performance.now();
                if (lastVertexClick.idx === hitIdx && now - lastVertexClick.t < 320) {
                  lastVertexClick = { idx: -1, t: 0 };
                  collapseMeshVertex(ctx.attachmentId, hitIdx);
                  return;
                }
                lastVertexClick = { idx: hitIdx, t: now };

                // 点未选中的顶点 → 单选它；点已选中的 → 保持多选整体拖动
                const cur = stGrid.meshSelectedVertices;
                const idxs = cur.includes(hitIdx) ? cur : [hitIdx];
                if (!cur.includes(hitIdx)) stGrid.setMeshSelectedVertices([hitIdx]);
                dragState = {
                  kind: 'mesh-vertex',
                  slotId: ctx.slot.id,
                  attachmentId: ctx.attachmentId,
                  indices: [...idxs],
                  startVertices: ctx.mesh.vertices.slice(),
                  startLocal: p,
                  moved: false,
                  // 「网格工具」软选择：按下时按当前位置算一次权重（拖动中不变）
                  softWeights: stGrid.meshSoftSelect
                    ? computeSoftWeights(ctx.mesh, [...idxs], stGrid.meshSoftSize, stGrid.meshSoftFeather, stGrid.meshSoftHull)
                    : null,
                };
                return;
              }

              // 空白处拖动 → 框选顶点
              const rectG = new Gfx();
              rectG.eventMode = 'none';
              a.stage.addChild(rectG);
              dragState = {
                kind: 'mesh-marquee',
                slotId: ctx.slot.id,
                attachmentId: ctx.attachmentId,
                startScreen: { x: ev.global.x, y: ev.global.y },
                nowScreen: { x: ev.global.x, y: ev.global.y },
                rect: rectG,
                additive: ev.shiftKey,
                prevSel: stGrid.meshSelectedVertices,
              };
              return;
            }
          }
        }

        const mode = usePixiBonesStore.getState().editorMode;
        // 创建模式：点空白 / 点 PSD 图层都可以从鼠标位置拖出子骨骼
        // （骨骼手柄自身会 stopPropagation，所以拖手柄不会走到这里）
        if (mode === 'create') {
          // ⌘ + 点击素材：把它设为「新建骨骼的目标素材」（不创建骨骼）。
          //   之后创建的骨骼会自动绑定到它，并以它的名称命名。
          //   ★ 只设置目标素材，**不动骨骼选中** —— 保证父骨骼链不断：
          //     新骨仍是「当前选中骨骼」的子骨，而不是 root 下的兄弟骨。
          if (ev.metaKey || metaDown) {
            // 命中检测本身就是「插槽」维度（每个插槽渲染自己的激活附件）
            const hitSlotId = topSlotAt(ev.global.x, ev.global.y);
            if (hitSlotId) {
              usePixiBonesStore.getState().setTargetSlot(hitSlotId);
              attachmentHover.clear();
              return;
            }
          }
          // Create 模式：点空白 = 启动拖动创建骨骼
          //   - joint 起点 = 鼠标按下位置（不在父骨骼 origin 上）
          //   - tip = 鼠标松开位置
          //   - parent = 当前选中骨骼（无选中则根）
          const sx = root.scale.x;
          const sy = root.scale.y;
          const ox = root.x;
          const oy = root.y;
          // 鼠标按下时的世界坐标 = 新骨骼 joint 起点
          const startWorldX = (ev.global.x - ox) / (sx || 1);
          const startWorldY = (ev.global.y - oy) / (sy || 1);
          // 找父骨骼：当前选中骨骼（无选中则根骨骼）
          const state = usePixiBonesStore.getState();
          const rootBone = state.bones.find((b) => b.parentId === null);
          const parentId = state.selectedBoneId || (rootBone ? rootBone.id : null);
          if (!parentId) return;
          const parentBone = boneById.get(parentId);
          if (!parentBone) return;
          // 父骨骼的世界坐标（pointerup 时用来算新骨骼的 local (x,y)）
          const parentWorld = skeletonRef!.getWorldPosition(parentBone);
          // 创建预览 Gfx（pointermove 时画线，pointerup 时销毁）
          const preview = new Gfx();
          preview.eventMode = 'none';
          a.stage.addChild(preview);
          dragState = {
            kind: 'create-from',
            parentId,
            // ★ 起点 = 鼠标按下位置（不是父骨骼 joint！）
            startWorld: { x: startWorldX, y: startWorldY },
            startScreen: { x: ev.global.x, y: ev.global.y },
            // 扩展字段：父骨骼世界坐标（pointerup 时用）
            parentWorld: { x: parentWorld.x, y: parentWorld.y },
            preview,
          } as typeof dragState & { parentWorld: { x: number; y: number } };
        } else if (ev.target === a.stage || isSlotSprite(ev.target)) {
          const st0p = usePixiBonesStore.getState();
          // ★ 权重「绑定模式」流程 B：先选骨骼 → 点网格 → 把所选骨骼绑到该网格
          if (
            st0p.weightBindMode
            && isSlotSprite(ev.target)
            && st0p.selectedBoneIds.length > 0
          ) {
            const clickedSlotId = (ev.target as { __slotId?: string } | null)?.__slotId ?? null;
            if (clickedSlotId) {
              const slot = st0p.slots.find((s) => s.id === clickedSlotId) ?? null;
              const aid = slot?.activeAttachmentId ?? null;
              if (aid && st0p.attachmentMeshes[aid]) {
                ev.stopPropagation();
                // 取所选骨骼的 world 坐标作为绑定姿态
                const boneWorlds: number[] = [];
                for (const bid of st0p.selectedBoneIds) {
                  const bn = skeletonRef ? findBoneByRefWorld(skeletonRef, bid) : null;
                  if (bn) {
                    const e = bn.worldMatrix.elements;
                    boneWorlds.push(e[6], e[7]);
                  } else {
                    const b = st0p.bones.find((x) => x.id === bid);
                    boneWorlds.push(b ? b.x : 0, b ? b.y : 0);
                  }
                }
                st0p.bindBonesToMesh(aid, st0p.selectedBoneIds, undefined, boneWorlds);
                st0p.toggleWeightBindMode();   // 流程 B 完成即退出绑定模式
                return;
              }
            }
          }
          // ★ 选中插槽 + 4 个变换工具激活时，且点在「该插槽画出来的图」上：走 layer-transform，不进框选
          const clickedSlotId = (ev.target as { __slotId?: string } | null)?.__slotId ?? null;
          if (
            isSlotSprite(ev.target)
            && st0p.selectedSlotId
            && clickedSlotId === st0p.selectedSlotId
            && st0p.activeTool
            && st0p.editorMode !== 'create'
            && !st0p.attachingSlotId
          ) {
            ev.stopPropagation();
            const slotId = st0p.selectedSlotId;
            const lt = st0p.slotTransforms[slotId] ?? { tx: 0, ty: 0, rotation: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 };
            const slot = st0p.slots.find((s) => s.id === slotId) ?? null;
            const layer = slot?.activeAttachmentId
              ? allAttachmentsOf(st0p.psd, st0p.images).find((l) => l.id === slot.activeAttachmentId) ?? null
              : null;
            if (layer) {
              // 锚点 = 图层中心（与绘制 / hover 一致）
              const { x: ax, y: ay } = attachmentAnchorScreen(layer, lt);
              // ★ 推一次历史快照（拖动期间不再入栈，结束才能回退到拖动前状态）
              st0p.pushHistory();
              const { zone, axisAngle, handleRotation } = slotZoneAndAxis(st0p.activeTool, ev.global.x, ev.global.y, ax, ay, lt);
              dragState = {
                kind: 'layer-transform',
                tool: st0p.activeTool,
                slotId,
                start: lt,
                startScreen: { x: ev.global.x, y: ev.global.y },
                anchorScreen: { x: ax, y: ay },
                zone,
                axisAngle,
                handleRotation,
              };
              return;
            }
          }
          // Pose 模式：在空白或素材上按下 = 启动框选
          //   - 单击素材 = 选中；Shift+单击 = 加选（pointerup 时判定「是否拖动」）
          //   - 拖动 = 框选；按住 Shift = 增量框选
          const additive = ev.shiftKey;
          const rect = new Gfx();
          rect.eventMode = 'none';
          a.stage.addChild(rect);
          const store = usePixiBonesStore.getState();
          if (!additive) {
            // 未按 Shift：先清空（若单击到素材，pointerup 会重新选中它）
            store.selectBone(null);
          }
          dragState = {
            kind: 'marquee',
            additive,
            startScreen: { x: ev.global.x, y: ev.global.y },
            nowScreen: { x: ev.global.x, y: ev.global.y },
            rect,
            prevSelIds: store.selectedBoneIds,
            prevSlotIds: store.selectedSlotIds,
            hitSlotId: topSlotAt(ev.global.x, ev.global.y),
          };
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
      /**
       * 滚轮缩放：**以鼠标位置为中心** —— 鼠标下的那个点在屏幕上保持不动。
       *
       * 思路：先算出鼠标当前指向的「世界坐标」w，缩放后要求它仍落在同一个屏幕点上，
       * 反推 panX / panY（root 的位置由 center() 用 viewport 重新算出）。
       */
      const wheelHandler = (ev: WheelEvent) => {
        ev.preventDefault();
        const ZOOM_STEP = 1.1;
        const factor = ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;

        const rect = a.canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        lastPointer = { x: mx, y: my };

        const s0 = usePixiBonesStore.getState();
        const curVp = s0.viewport;
        const newZoom = Math.max(0.05, Math.min(curVp.zoom * factor, 16));
        const psd = s0.psd;
        const rw = host.clientWidth;
        const rh = host.clientHeight;
        if (rw <= 0 || rh <= 0) return;

        if (!psd || psd.width === 0 || psd.height === 0) {
          // 无 PSD：root.x = cssW/2 + panX、root.y = cssH/2 + panY、root.scale = zoom
          const oldScale = root.scale.x || 1;
          const wx = (mx - root.x) / oldScale;
          const wy = (my - root.y) / oldScale;
          const panX = mx - wx * newZoom - rw / 2;
          const panY = my - wy * newZoom - rh / 2;
          setViewport({ ...curVp, zoom: newZoom, panX, panY });
          return;
        }

        // 有 PSD：scale = baseFit × zoom；root.x = (rw − psdW·scale)/2 + panX；root.y = rh/2 − psdH·scale + panY
        const margin = 40;
        const baseFit = Math.min(
          Math.max(1, rw - margin * 2) / psd.width,
          Math.max(1, rh - margin * 2) / psd.height,
        );
        const clampScale = (z: number) => Math.max(0.01, Math.min(baseFit * z, 16));
        const oldScale = clampScale(curVp.zoom);
        const newScale = clampScale(newZoom);
        // 鼠标下的世界坐标（缩放前后保持不变）
        const wx = (mx - root.x) / oldScale;
        const wy = (my - root.y) / oldScale;
        const panX = mx - wx * newScale - (rw - psd.width * newScale) / 2;
        const panY = my - wy * newScale - (rh / 2 - psd.height * newScale);
        setViewport({ ...curVp, zoom: newZoom, panX, panY });
        // 后续重绘（grid / 骨骼 / 悬停框 …）由 store 订阅统一处理
      };
      a.canvas.addEventListener('wheel', wheelHandler, { passive: false });

      /**
       * 网格编辑：**右键轮转工具** —— 修改 → 创建 → 删除 → 修改 …（仿 Spine）。
       * 只在网格编辑状态下接管右键（其它时候保留浏览器默认右键菜单）。
       */
      const meshToolOrder: Array<'modify' | 'create' | 'delete'> = ['modify', 'create', 'delete'];
      const onCanvasContextMenu = (e: MouseEvent) => {
        const st = usePixiBonesStore.getState();
        if (!st.meshEditSlotId) return;   // 非网格编辑 → 不拦截
        e.preventDefault();
        const next = meshToolOrder[(meshToolOrder.indexOf(st.meshTool) + 1) % meshToolOrder.length];
        st.setMeshTool(next);
        drawMeshHandles();
      };
      a.canvas.addEventListener('contextmenu', onCanvasContextMenu);

      cleanups.push(() => {
        a.stage.off('pointermove', onPointerMove);
        a.stage.off('pointerup', onPointerUp);
        a.stage.off('pointerupoutside', onPointerUp);
        a.canvas.removeEventListener('wheel', wheelHandler);
        a.canvas.removeEventListener('contextmenu', onCanvasContextMenu);
      });

      const initial = usePixiBonesStore.getState();
      rebuildAssets(initial.psd, initial.images, initial.slots);
      center(initial.psd);
      drawGrid(initial.psd);
      applyVisibility(initial.psd, initial.images, initial.slots, initial.slotVisibility);
      drawHighlight(initial.psd, initial.images, initial.slots, initial.selectedSlotIds);
      buildSkeleton(initial.bones);
      applyBindings(initial.psd, initial.images, initial.slots, initial.slotBindings, initial.slotTransforms);
      applySlotStyles(initial.psd, initial.images, initial.slots, initial.slotStyle, initial.attachmentStyle);
      drawMeshHandles();
      drawBones(initial.bones, initial.selectedBoneId);

      let prev = usePixiBonesStore.getState();
      const unsub = usePixiBonesStore.subscribe((state) => {
        if (destroyed) return;
        // 插槽结构（增删/切换激活附件/绘制顺序）变化 → 重建 sprite
        // ★ 进出「网格编辑」/ 切换「变形」/ 开始·结束「新建」描绘，都会改变用 Mesh 还是 Sprite 渲染 → 一并重建
        if (
          state.psd !== prev.psd
          || state.images !== prev.images
          || state.slotOrder !== prev.slotOrder
          || state.slots !== prev.slots
          || state.meshEditSlotId !== prev.meshEditSlotId
          || state.meshDeformed !== prev.meshDeformed
          // 开始 / 结束「新建」描绘时（null ↔ 数组），在完整原图 ↔ 网格裁切之间切换
          || (state.meshNewPolygon === null) !== (prev.meshNewPolygon === null)
        ) {
          rebuildAssets(state.psd, state.images, state.slots);
        }
        // 网格数据变化：
        //   - 拓扑变了（新增/删除网格、顶点数或索引变了）→ 重建 view
        //   - 只是顶点位置变了（拖动）→ 原地同步，不重建（高频路径）
        if (state.attachmentMeshes !== prev.attachmentMeshes) {
          const keys = new Set([
            ...Object.keys(state.attachmentMeshes),
            ...Object.keys(prev.attachmentMeshes),
          ]);
          let structural = false;
          for (const k of keys) {
            const a = state.attachmentMeshes[k];
            const b = prev.attachmentMeshes[k];
            if (
              !a || !b
              || a.vertices.length !== b.vertices.length
              || a.indices !== b.indices
              || a.uvs !== b.uvs
              // ★ 权重绑定状态变化（0 ↔ 非0）会切换 Mesh / Sprite 渲染 → 必须重建
              || (a.bones?.length ?? 0) !== (b.bones?.length ?? 0)
            ) {
              structural = true;
              break;
            }
          }
          if (structural) {
            rebuildAssets(state.psd, state.images, state.slots);
            applyVisibility(state.psd, state.images, state.slots, state.slotVisibility);
            applyBindings(state.psd, state.images, state.slots, state.slotBindings, state.slotTransforms);
            applySlotStyles(state.psd, state.images, state.slots, state.slotStyle, state.attachmentStyle);
            // 新建的 mesh 没重建了 → 蒙皮（如果该插槽已绑骨骼）
            for (const slot of state.slots) {
              const aid = slot.activeAttachmentId;
              const mesh = aid ? state.attachmentMeshes[aid] : null;
              if (mesh && mesh.bones && mesh.bones.length > 0) applySkinning(slot.id);
            }
          } else {
            for (const k of Object.keys(state.attachmentMeshes)) {
              const m = state.attachmentMeshes[k];
              // ★ 有骨骼绑定时跳过 syncMeshVertices——顶点由 applySkinning 算
              if (m && m.bones && m.bones.length > 0) continue;
              syncMeshVertices(k);
            }
          }
        }
        if (state.psd !== prev.psd) {
          // 新 PSD：重置视口（用户之前可能 zoom 过）
          // 用 queueMicrotask 异步执行，避免在 subscribe 回调里再 setState 触发递归
          queueMicrotask(() => {
            if (!destroyed) {
              usePixiBonesStore.getState().setViewport({ panX: 0, panY: 0, zoom: 1 });
            }
          });
        }
        if (state.bones !== prev.bones) {
          buildSkeleton(state.bones);
          // ★ 骨骼平移 / 旋转 / 缩放 → 重算所有已绑定网格的顶点蒙皮
          //   注意：applySkinning 需要 wrapMatrixBySlot 已有该插槽记录，
          //   所以先调一次 applyBindings 把 slot 变换矩阵算好（即使骨骼驱动被跳过也无碍）。
          applyBindings(state.psd, state.images, state.slots, state.slotBindings, state.slotTransforms);
          for (const slot of state.slots) {
            const aid = slot.activeAttachmentId;
            const mesh = aid ? state.attachmentMeshes[aid] : null;
            if (mesh && mesh.bones && mesh.bones.length > 0) applySkinning(slot.id);
          }
          // ★ 重画顶点手柄 / 饼图 / 叠加，让它们跟着蒙皮后的顶点位置走
          drawMeshHandles();
        }
        // 离开创建模式时清掉素材悬停虚线框（避免残留）
        if (state.editorMode !== prev.editorMode && state.editorMode !== 'create') {
          attachmentHover.clear();
        }
        // 描绘（Trace）：弹窗打开时进入「实时预览」模式，每次 trace* 参数变化都重算，
        //   把结果直接写进网格（不入历史，由「确定」统一入一次）。
        //   apply 时也再触发一次 requestTrace 写最终结果（一次性入历史）。
        if (state.traceRequestId !== prev.traceRequestId) {
          const slotId = state.meshEditSlotId;
          const slot = slotId ? state.slots.find((x) => x.id === slotId) ?? null : null;
          const aid = slot?.activeAttachmentId ?? null;
          const layer = aid
            ? allAttachmentsOf(state.psd, state.images).find((l) => l.id === aid) ?? null
            : null;
          if (aid && layer?.canvas && layer.width > 0 && layer.height > 0) {
            const params = {
              detail: state.traceDetail,
              concavity: state.traceConcavity,
              refinement: state.traceRefinement,
              merge: state.traceMerge,
              alphaThreshold: state.traceAlphaThreshold,
              padding: state.tracePadding,
            };
            const poly = traceAlphaHull(layer.canvas, params.alphaThreshold, params.detail, params);
            const count = poly.length;
            queueMicrotask(() => {
              if (destroyed) return;
              const st0 = usePixiBonesStore.getState();
              if (st0.meshEditSlotId !== slotId) return;   // 期间已退出编辑 → 放弃
              st0.setTraceVertexCount(count);
              if (count < 3) return;
              const indices = triangulatePolygon(poly);
              if (indices.length < 3) return;
              const vertices: number[] = [];
              const uvs: number[] = [];
              for (const p of poly) {
                vertices.push(p.x, p.y);
                uvs.push(p.x / layer.width, p.y / layer.height);
              }
              const isLivePreview = st0.traceLivePreview;
              st0.setMeshNewPolygon(null);
              // 实时预览中：写网格但**不入历史**（不污染撤销栈，用户可能继续调）
              // apply 触发的最后一次写：要入历史
              if (!isLivePreview) st0.pushHistory();
              st0.setMeshData(aid, { vertices, uvs, indices });
              st0.setMeshSelectedVertices([]);
            });
          }
        }
        // 取消描绘：从快照还原网格（取消 = 不入历史）
        if (state.traceRestoreRequestId !== prev.traceRestoreRequestId) {
          queueMicrotask(() => {
            if (destroyed) return;
            const st0 = usePixiBonesStore.getState();
            const snap = st0.traceSnapshot;
            if (!snap) {
              // 没有快照（例如从未打开就被外部触发）→ 忽略
              return;
            }
            const meshes = { ...st0.attachmentMeshes };
            if (snap.mesh) {
              meshes[snap.layerId] = snap.mesh;
            } else {
              delete meshes[snap.layerId];
            }
            // 还原：直接 setState（不走 setMeshData，那只覆盖 mesh；这里要一次性写 + 清快照）
            usePixiBonesStore.setState({ attachmentMeshes: meshes });
            st0.clearTraceSnapshot();
            st0.setMeshSelectedVertices([]);
          });
        }
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
            const z = Math.max(0.05, Math.min(fitScale, 16));
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
                  zoom: Math.max(0.05, Math.min(targetVpZoom, 16)),
                  panX,
                  panY,
                });
              }
            });
          }
        }
        applyVisibility(state.psd, state.images, state.slots, state.slotVisibility);
        applyBindings(state.psd, state.images, state.slots, state.slotBindings, state.slotTransforms);
        applySlotStyles(state.psd, state.images, state.slots, state.slotStyle, state.attachmentStyle);
        // ★ 先更新 root（缩放 / 平移会改 root 位置），后面所有绘制才能用最新的变换
        center(state.psd);
        drawGrid(state.psd);
        drawHighlight(state.psd, state.images, state.slots, state.selectedSlotIds);
        drawBones(state.bones, state.selectedBoneId, state.selectedBoneIds);
        drawSlotHandles(state.psd, state.images, state.slots, state.selectedSlotId, state.activeTool, state.slotTransforms);
        drawMeshHandles();
        // 缩放 / 平移后，悬停提示框要跟着重画（否则会残留在旧位置）
        updateAttachmentHover(
          lastPointer.x,
          lastPointer.y,
          state.editorMode === 'create' && metaDown,
        );
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
          drawHighlight(s.psd, s.images, s.slots, s.selectedSlotIds);
          drawBones(s.bones, s.selectedBoneId, s.selectedBoneIds);
        });
      });
      // ---- 图层绑定事件（PsdPanel 分发）：绑定 / 解绑 ----
      // 绑定：把「当前选中骨骼的世界矩阵」记进绑定表做参考基准（ref），
      //       之后渲染用 delta = 当前矩阵 × ref⁻¹ 驱动图层 → 绑定瞬间图层不动。
      const onBindSlot = (e: Event) => {
        const slotId = (e as CustomEvent<{ slotId: string }>).detail?.slotId;
        if (!slotId) return;
        const st = usePixiBonesStore.getState();
        const boneId = st.selectedBoneId;
        if (!boneId) return;
        const bone = boneById.get(boneId);
        if (!bone) return;
        const el = bone.worldMatrix.elements;
        st.bindSlot(slotId, {
          boneId,
          ref: [el[0], el[1], el[3], el[4], el[6], el[7]],
        });
      };
      const onUnbindSlot = (e: Event) => {
        const slotId = (e as CustomEvent<{ slotId: string }>).detail?.slotId;
        if (!slotId) return;
        usePixiBonesStore.getState().unbindSlot(slotId);
      };
      window.addEventListener('spine:bind-slot', onBindSlot);
      window.addEventListener('spine:unbind-slot', onUnbindSlot);
      cleanups.push(() => {
        window.removeEventListener('spine:bind-slot', onBindSlot);
        window.removeEventListener('spine:unbind-slot', onUnbindSlot);
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

  // 监听全局 "ask-delete" 事件（Editor.tsx 在 Del/Backspace 时分发），弹 Spine 风格确认框
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
  useEffect(() => {
    const onAsk = (e: Event) => {
      const ids = (e as CustomEvent<{ ids: string[] }>).detail?.ids;
      if (ids && ids.length > 0) setPendingDeleteIds(ids);
    };
    window.addEventListener('spine:ask-delete', onAsk);
    return () => window.removeEventListener('spine:ask-delete', onAsk);
  }, []);

  return (
    <div
      className="canvas-host flex-1 relative overflow-hidden"
      ref={hostRef}
      style={{ position: 'relative' }}
    >
      <CanvasOverlay />
      <ConfirmDialog
        open={pendingDeleteIds !== null}
        title="确认删除"
        message="确定要删除此骨骼?"
        confirmLabel="是"
        cancelLabel="否"
        onConfirm={() => {
          if (pendingDeleteIds) {
            const s = usePixiBonesStore.getState();
            pendingDeleteIds.forEach((id) => s.removeBone(id));
          }
          setPendingDeleteIds(null);
        }}
        onCancel={() => setPendingDeleteIds(null)}
      />
    </div>
  );
}

/**
 * 画一个虚线矩形（Pixi v8 Graphics 不支持 setLineDash，手动拆成小线段）。
 * 仅构建路径 + 一次 stroke，调用方只需给目标 Gfx。
 */
function drawDashedRect(
  g: Gfx,
  x: number, y: number, w: number, h: number,
  dash: number, gap: number,
  color: number, width: number,
) {
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 0.01) return;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    let d = 0;
    while (d < len) {
      const d2 = Math.min(d + dash, len);
      g.moveTo(x0 + ux * d, y0 + uy * d).lineTo(x0 + ux * d2, y0 + uy * d2);
      d = d2 + gap;
    }
  };
  seg(x, y, x + w, y);
  seg(x + w, y, x + w, y + h);
  seg(x + w, y + h, x, y + h);
  seg(x, y + h, x, y);
  g.stroke({ width, color });
}

/**
 * 网格编辑三种工具的鼠标指针（仿 Spine）：
 *   修改 → 系统「移动」指针；创建 → 箭头 + 右侧「+」；删除 → 箭头 + 右侧「-」。
 * ★ 浏览器没有「箭头 + 减号」这种光标，所以用离屏 canvas 画一个箭头加角标，
 *   再转成 PNG data URI 当 cursor（比 SVG cursor 的浏览器兼容性稳）。
 * 结果缓存（每种只画一次）。
 */
const _meshCursorCache: Partial<Record<'create' | 'delete', string>> = {};

function buildArrowCursor(badge: '+' | '-' | null): string {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  if (!g) return 'auto';
  // 经典箭头指针轮廓
  g.beginPath();
  g.moveTo(1, 1);
  g.lineTo(1, 17);
  g.lineTo(5.6, 12.4);
  g.lineTo(8.8, 19.6);
  g.lineTo(11.6, 18.3);
  g.lineTo(8.4, 11.2);
  g.lineTo(13.4, 11.2);
  g.closePath();
  g.lineJoin = 'round';
  g.lineWidth = 1.6;
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#1a1a1a';
  g.fill();
  g.stroke();
  if (badge) {
    g.font = 'bold 15px -apple-system, Helvetica, Arial, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.lineWidth = 3.5;
    g.strokeStyle = '#ffffff';
    g.strokeText(badge, 15, 24);
    g.fillStyle = '#1a1a1a';
    g.fillText(badge, 15, 24);
  }
  return `url(${c.toDataURL('image/png')}) 1 1, auto`;
}

/** 取某个网格工具的 CSS cursor 值。 */
function meshToolCursor(tool: 'modify' | 'create' | 'delete'): string {
  if (tool === 'modify') return 'move';           // 系统「移动」指针
  const hit = _meshCursorCache[tool];
  if (hit) return hit;
  const cur = buildArrowCursor(tool === 'create' ? '+' : '-');
  _meshCursorCache[tool] = cur;
  return cur;
}

/** 点是否落在三角形内（重心坐标法，边界算命中）。 */
function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const v0x = cx - ax, v0y = cy - ay;
  const v1x = bx - ax, v1y = by - ay;
  const v2x = px - ax, v2y = py - ay;
  const d00 = v0x * v0x + v0y * v0y;
  const d01 = v0x * v1x + v0y * v1y;
  const d11 = v1x * v1x + v1y * v1y;
  const d20 = v2x * v0x + v2y * v0y;
  const d21 = v2x * v1x + v2y * v1y;
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-12) return false;
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;
  const eps = -1e-6;
  return u >= eps && v >= eps && w >= eps;
}

/** 点（附件局部坐标）是否落在网格的任一三角形内 —— 网格变形后命中依然准确。 */
function pointInMesh(px: number, py: number, mesh: MeshData): boolean {
  const v = mesh.vertices;
  const idx = mesh.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 2;
    const b = idx[t + 1] * 2;
    const c = idx[t + 2] * 2;
    if (a + 1 >= v.length || b + 1 >= v.length || c + 1 >= v.length) continue;
    if (pointInTriangle(px, py, v[a], v[a + 1], v[b], v[b + 1], v[c], v[c + 1])) return true;
  }
  return false;
}

/** 点到线段的最短距离（网格编辑里做边命中用）。 */
function distToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 画一条虚线（Pixi v8 的 Graphics 不支持 setLineDash，手动拆成小线段）。 */
function drawDashedLine(
  g: Gfx,
  x0: number, y0: number, x1: number, y1: number,
  dash: number, gap: number,
  color: number, width: number,
) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 0.01) return;
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  let d = 0;
  while (d < len) {
    const d2 = Math.min(d + dash, len);
    g.moveTo(x0 + ux * d, y0 + uy * d).lineTo(x0 + ux * d2, y0 + uy * d2);
    d = d2 + gap;
  }
  g.stroke({ width, color });
}

/** 闭合多边形的有符号面积（正 = 逆时针）。 */
function polygonSignedArea(poly: Array<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** 二维定向：>0 表示 (o→a→b) 为正向（与 ear clipping 的 cross 约定一致）。 */
function orient2d(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** d 是否落在 (a,b,c) 的外接圆内（要求 orient2d(a,b,c) > 0）；>0 = 在内。 */
function inCircleDet(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  const adx = ax - dx, ady = ay - dy;
  const bdx = bx - dx, bdy = by - dy;
  const cdx = cx - dx, cdy = cy - dy;
  return (adx * adx + ady * ady) * (bdx * cdy - bdy * cdx)
       - (bdx * bdx + bdy * bdy) * (adx * cdy - ady * cdx)
       + (cdx * cdx + cdy * cdy) * (adx * bdy - ady * bdx);
}

/** 扁平顶点数组 [x0,y0,x1,y1,...] → {x,y}[]（网格数据 → 几何点，供三角剖分用）。 */
function flatToPoints(flat: number[]): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
  return out;
}

/**
 * Delaunay 边翻转（Lawson）：把 ear clipping 的结果「摊平」。
 *
 * 为什么需要：ear clipping 每次都从 0 号耳朵开始剪，在凸 / 近凸轮廓上必然退化成
 * **扇形** —— 所有三角形都挤在同一个顶点上（描绘完人脸轮廓后一眼可见的放射长条）。
 * 反复翻转不满足「空外接圆」条件的**内部边**，收敛到近似 Delaunay 剖分，三角形更
 * 均匀，与 Spine 勾勒后的观感一致。只翻转被两个三角形共享的边；边界边（只属于一个
 * 三角形）固定不动，保证轮廓不被破坏。
 *
 * 这个函数还会在**每次加/删顶点之后**被调用（见 splitTriangle / splitEdgeAt /
 * collapseMeshVertex）：Spine 的做法是「自动连接所有顶点」，即每次顶点集变化都重算
 * 一遍最优剖分，而不是只在局部三角形里切一刀 —— 那样会把网格切乱。
 */
function delaunayRefine(poly: Array<{ x: number; y: number }>, indices: number[]): number[] {
  const tris: number[][] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    tris.push([indices[i], indices[i + 1], indices[i + 2]]);
  }
  const EPS = 1e-7;
  const ekey = (a: number, b: number) => (a < b ? a * 100000 + b : b * 100000 + a);
  for (let pass = 0; pass < 500; pass++) {
    const edgeMap = new Map<number, number[]>();
    for (let t = 0; t < tris.length; t++) {
      const [a, b, c] = tris[t];
      const pairs: Array<[number, number]> = [[a, b], [b, c], [c, a]];
      for (const [u, v] of pairs) {
        const k = ekey(u, v);
        const arr = edgeMap.get(k);
        if (arr) arr.push(t);
        else edgeMap.set(k, [t]);
      }
    }
    let flipped = false;
    const used = new Set<number>();
    for (const ts of edgeMap.values()) {
      if (ts.length !== 2) continue;                 // 边界边：固定不动
      const [t1, t2] = ts;
      if (used.has(t1) || used.has(t2)) continue;    // 本轮已改过 → 下一轮再评估
      const T1 = tris[t1], T2 = tris[t2];
      // 在 T1 里找共享边的有序对 (p1 → p2) 与对角点 p3（T1 为正向）
      let p1 = -1, p2 = -1, p3 = -1;
      for (let k = 0; k < 3; k++) {
        const u = T1[k], v = T1[(k + 1) % 3];
        if (T2.includes(u) && T2.includes(v)) { p1 = u; p2 = v; p3 = T1[(k + 2) % 3]; break; }
      }
      if (p1 < 0) continue;
      const p4 = T2.find((x) => x !== p1 && x !== p2);
      if (p4 === undefined) continue;
      const A = poly[p1], B = poly[p2], C = poly[p3], D = poly[p4];
      // 已满足空外接圆 → 保持
      if (inCircleDet(A.x, A.y, B.x, B.y, C.x, C.y, D.x, D.y) <= EPS) continue;
      // 翻转有效性：新三角形 (p1,p4,p3) / (p4,p2,p3) 必须都正向且非退化
      if (orient2d(A.x, A.y, D.x, D.y, C.x, C.y) <= EPS) continue;
      if (orient2d(D.x, D.y, B.x, B.y, C.x, C.y) <= EPS) continue;
      tris[t1] = [p1, p4, p3];
      tris[t2] = [p4, p2, p3];
      used.add(t1); used.add(t2);
      flipped = true;
    }
    if (!flipped) break;
  }
  const out: number[] = [];
  for (const t of tris) out.push(t[0], t[1], t[2]);
  return out;
}

/**
 * 简单多边形三角化 —— 网格「新建」描绘轮廓后用它生成三角形。
 * 顶点顺序任意（内部统一成逆时针）；对凹多边形（人脸轮廓的耳朵 / 下巴）也正确。
 * ear clipping 先得到合法剖分，再做 Delaunay 边翻转把「扇形」摊匀。
 */
function triangulatePolygon(poly: Array<{ x: number; y: number }>): number[] {
  const n = poly.length;
  if (n < 3) return [];
  const idx: number[] = Array.from({ length: n }, (_, i) => i);
  if (polygonSignedArea(poly) < 0) idx.reverse();   // 统一成逆时针
  const out: number[] = [];
  let guard = n * n + 16;
  while (idx.length > 3 && guard-- > 0) {
    let found = false;
    for (let k = 0; k < idx.length; k++) {
      const len = idx.length;
      const i0 = idx[(k - 1 + len) % len];
      const i1 = idx[k];
      const i2 = idx[(k + 1) % len];
      const a = poly[i0];
      const b = poly[i1];
      const c = poly[i2];
      // 凸角判定（逆时针下 cross > 0）
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross <= 1e-9) continue;
      // 其余顶点不能落在这个「耳朵」三角形内
      let blocked = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTriangle(poly[j].x, poly[j].y, a.x, a.y, b.x, b.y, c.x, c.y)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push(i0, i1, i2);
      idx.splice(k, 1);
      found = true;
      break;
    }
    if (!found) break;   // 退化（自交等）：停止
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  // 把 ear clipping 的「扇形」剖分摊匀成近似 Delaunay（三角形更均匀，贴近 Spine）
  return delaunayRefine(poly, out);
}

/** CSS hex（'#rrggbb' / 'rrggbb'）→ RGB 分量；非法 / 空则 null。 */
function hexToRgb(hex: string | undefined): [number, number, number] | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 把若干 CSS hex 颜色相乘（逐分量）得到 PIXI tint（0xRRGGBB）。
 * 空 / 非法的颜色视为白色（不参与相乘），因此全空时返回 0xffffff。
 */
function composeTint(...colors: Array<string | undefined>): number {
  let r = 255, g = 255, b = 255;
  for (const c of colors) {
    const rgb = hexToRgb(c);
    if (!rgb) continue;
    r = Math.round((r * rgb[0]) / 255);
    g = Math.round((g * rgb[1]) / 255);
    b = Math.round((b * rgb[2]) / 255);
  }
  return (r << 16) | (g << 8) | b;
}

/**
 * 用 marching squares 把图层 canvas 上「alpha > 0」的轮廓抽成若干短线段。
 * 输出坐标 = 原图像素坐标（左上角原点）。调用方再按 layer.left/top + root.scale 平移/缩放到画布。
 *
 * 缓存到 module-level WeakMap：同一个 HTMLCanvasElement 只算一次。
 * 大图（约 1500×1500）≈ 10–30ms；典型工作区只 hover 1 个图层，无须担心。
 */
type OutlineSegments = { w: number; h: number; segs: Float32Array };
const _outlineCache = new WeakMap<HTMLCanvasElement, OutlineSegments>();

// =================================================================================
//  描绘（Trace）：按图片 alpha 通道自动提取网格外壳
// =================================================================================

/** Ramer–Douglas–Peucker：把折线简化到 ε 容差内（递归）。 */
function rdp(pts: Array<{ x: number; y: number }>, eps: number): Array<{ x: number; y: number }> {
  if (pts.length <= 2) return pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  let idx = -1;
  let maxD = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i].x, pts[i].y, first.x, first.y, last.x, last.y);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (idx < 0 || maxD <= eps) return [first, last];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return [...left.slice(0, -1), ...right];
}

/** 闭合多边形的 RDP 简化：按离 poly[0] 最远的点切成两条折线分别简化，再拼回去。 */
function simplifyClosedPolygon(
  poly: Array<{ x: number; y: number }>,
  eps: number,
): Array<{ x: number; y: number }> {
  const n = poly.length;
  if (n <= 4) return poly;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (poly[i].x - poly[0].x) ** 2 + (poly[i].y - poly[0].y) ** 2;
    if (d > farD) { farD = d; far = i; }
  }
  const a = rdp(poly.slice(0, far + 1), eps);
  const b = rdp([...poly.slice(far), poly[0]], eps);
  // b 的末点就是 poly[0]，已在 a 的首位 → 去掉两端
  return [...a, ...b.slice(1, -1)];
}

/**
 * 描绘（Trace）——从图层 alpha 通道自动提取网格外壳多边形（图片像素坐标）：
 *   1) 二值化：alpha ≥ alphaThreshold（忽略几乎透明的像素）
 *   2) Moore 邻域边界跟踪 → 外轮廓（8 邻域；含凹处，不处理孔洞）
 *   3) RDP 简化成少量顶点（detail 越大 → ε 越小 → 顶点越多）
 * 无内容 / 轮廓退化时返回 []。
 */
function traceAlphaHull(
  canvas: HTMLCanvasElement,
  alphaThreshold: number | undefined,
  detail: number | undefined,
  params?: null | {
    detail: number;
    concavity: number;
    refinement: number;
    merge: number;
    alphaThreshold: number;
    padding: number;
  },
): Array<{ x: number; y: number }> {
  const W = canvas.width;
  const H = canvas.height;
  if (W === 0 || H === 0) return [];
  let ctx: CanvasRenderingContext2D | null = null;
  try { ctx = canvas.getContext('2d'); } catch { /* 跨域 canvas 会抛 */ }
  if (!ctx) return [];
  const img = ctx.getImageData(0, 0, W, H).data;
  // 对话框模式 → alpha 是 0..255；否则按 0..1 当 fraction。
  const thr01 = params ? Math.max(0, Math.min(255, params.alphaThreshold)) / 255
    : (alphaThreshold ?? 0.1);
  const thr = Math.max(0, Math.min(255, Math.round(thr01 * 255)));
  const solid = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H && img[(y * W + x) * 4 + 3] >= thr;

  // 起点：扫描顺序里第一个实心像素（最上最左，其北/西必为空，便于从西侧进入）
  let sx = -1;
  let sy = -1;
  for (let y = 0; y < H && sx < 0; y++) {
    for (let x = 0; x < W; x++) {
      if (solid(x, y)) { sx = x; sy = y; break; }
    }
  }
  if (sx < 0) return [];

  // 8 邻域方向（顺时针：N, NE, E, SE, S, SW, W, NW）
  const DIRS: Array<[number, number]> = [
    [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ];
  const dirIndex = (px: number, py: number, qx: number, qy: number) => {
    const dx = Math.sign(qx - px);
    const dy = Math.sign(qy - py);
    for (let d = 0; d < 8; d++) if (DIRS[d][0] === dx && DIRS[d][1] === dy) return d;
    return 0;
  };

  const contour: Array<{ x: number; y: number }> = [{ x: sx, y: sy }];
  let px = sx;
  let py = sy;
  let bx = sx - 1;   // 进入方向：从西侧进来
  let by = sy;
  // 用「(当前点, 回溯点)」状态去重来终止（比单纯 p===start 稳）
  const seen = new Set<string>();
  const guardMax = 8 * (W + H) + 64;
  for (let guard = 0; guard < guardMax; guard++) {
    const key = `${px},${py},${bx},${by}`;
    if (seen.has(key)) break;
    seen.add(key);
    const bd = dirIndex(px, py, bx, by);
    let foundDir = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (bd + k) % 8;
      if (solid(px + DIRS[d][0], py + DIRS[d][1])) { foundDir = d; break; }
    }
    if (foundDir < 0) break;                       // 孤立像素
    const prevD = (foundDir + 7) % 8;              // 顺时针的前一格回退点
    bx = px + DIRS[prevD][0];
    by = py + DIRS[prevD][1];
    px += DIRS[foundDir][0];
    py += DIRS[foundDir][1];
    if (px === sx && py === sy) break;
    contour.push({ x: px, y: py });
  }
  if (contour.length < 3) return [];

  // 太长先抽稀，限制 RDP 递归深度
  let pts = contour;
  const MAXP = 2000;
  if (pts.length > MAXP) {
    const step = Math.ceil(pts.length / MAXP);
    const thinned: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < pts.length; i += step) thinned.push(pts[i]);
    pts = thinned;
  }

  const maxDim = Math.max(W, H);
  // 细节 (1..100) → ε 系数 0.030 .. 0.004；越精细 ε 越小、顶点越多
  const dNum = params ? params.detail : (detail ?? 60);
  const dNorm = Math.max(0, Math.min(1, (dNum - 1) / 99));
  const eps = Math.max(1, maxDim * (0.030 - 0.026 * dNorm));

  let out = simplifyClosedPolygon(pts, eps);

  // 统一 (0..1)：合并过近的顶点对（与中位线长度比较）
  if (params) {
    const merge = Math.max(0, Math.min(1, params.merge));
    if (merge > 0 && out.length > 4) {
      const merge2 = merge * merge;
      const perim = polygonLength(out);
      const minDist2 = perim * perim * merge2 / out.length;
      out = mergeCloseVertices(out, minDist2);
    }
  }
  return out;
}

/** 多边形周长（像素）。 */
function polygonLength(pts: Array<{ x: number; y: number }>): number {
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    L += Math.hypot(p.x - q.x, p.y - q.y);
  }
  return L;
}

/** 反复合并距离 < d 的相邻顶点对（用线段长度近似，O(n)）。 */
function mergeCloseVertices(
  pts: Array<{ x: number; y: number }>,
  minDist2: number,
): Array<{ x: number; y: number }> {
  if (pts.length < 4) return pts;
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const dx = q.x - p.x, dy = q.y - p.y;
      if (dx * dx + dy * dy < minDist2) {
        // 合并到中点
        const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        pts = [...pts.slice(0, i), m, ...pts.slice(i + 2)];
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return pts;
}

/** 描绘的默认参数（Spine 的 Trace 面板里有 Detail / Concavity / Alpha threshold / Padding 等；
 *  这里先用一组稳妥的默认值，需要暴露 UI 时改成 store 字段即可）。 */
const TRACE_ALPHA_THRESHOLD = 0.1;
const TRACE_DETAIL = 0.6;

function computeAttachmentOutline(canvas: HTMLCanvasElement): OutlineSegments {
  const hit = _outlineCache.get(canvas);
  if (hit) return hit;

  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) {
    const empty: OutlineSegments = { w, h, segs: new Float32Array(0) };
    _outlineCache.set(canvas, empty);
    return empty;
  }

  // 拿 alpha 通道（PNG/PSD canvas 都会有 alpha 通道；image 数据按 RGBA 排列）
  let ctx: CanvasRenderingContext2D | null = null;
  try { ctx = canvas.getContext('2d'); } catch { /* 跨域 canvas 会抛 SecurityError */ }
  if (!ctx) {
    const empty: OutlineSegments = { w, h, segs: new Float32Array(0) };
    _outlineCache.set(canvas, empty);
    return empty;
  }
  const img: ImageData | null = ctx.getImageData(0, 0, w, h);
  if (!img) {
    const empty: OutlineSegments = { w, h, segs: new Float32Array(0) };
    _outlineCache.set(canvas, empty);
    return empty;
  }
  const data = img.data;
  // solid[y * w + x] = (alpha > threshold) ? 1 : 0
  // 64/255 是常用 alpha cut-off，能抗 JPG 压缩噪点又能识别半透明边缘
  const alphaTh = 64;
  const solid = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    solid[j] = data[i + 3] > alphaTh ? 1 : 0;
  }

  // 估算段数：每行相邻对最多 1 段，每列相邻对最多 1 段；保守预估 = (w-1)h + w*(h-1)
  const cap = (w - 1) * h + w * (h - 1);
  const buf = new Float32Array(cap * 4);
  let n = 0;

  // 横向边：相邻两像素 sA, sB（左边=A，右边=B）。在两者**之间**画一条垂直短线段。
  //   sA=0, sB=1 → 段 = (xA+1, y, xA+1, y+1)
  //   sA=1, sB=0 → 段 = (xA+1, y+1, xA+1, y)
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x + 1 < w; x++) {
      const a = solid[row + x];
      const b = solid[row + x + 1];
      if (a === b) continue;
      const xe = x + 1;
      if (a === 0 && b === 1) {
        buf[n++] = xe; buf[n++] = y;     buf[n++] = xe; buf[n++] = y + 1;
      } else {
        buf[n++] = xe; buf[n++] = y + 1; buf[n++] = xe; buf[n++] = y;
      }
    }
  }
  // 纵向边：相邻两像素 sA（上）, sB（下）。在两者**之间**画一条水平短线段。
  for (let x = 0; x < w; x++) {
    for (let y = 0; y + 1 < h; y++) {
      const a = solid[y * w + x];
      const b = solid[(y + 1) * w + x];
      if (a === b) continue;
      const ye = y + 1;
      if (a === 0 && b === 1) {
        buf[n++] = x;     buf[n++] = ye; buf[n++] = x + 1; buf[n++] = ye;
      } else {
        buf[n++] = x + 1; buf[n++] = ye; buf[n++] = x;     buf[n++] = ye;
      }
    }
  }

  const out: OutlineSegments = { w, h, segs: buf.subarray(0, n) };
  _outlineCache.set(canvas, out);
  return out;
}

/** 把「alpha 轮廓」按图层位置/缩放画到目标 Gfx（世界坐标系）。 */
function drawAttachmentOutline(
  g: Gfx,
  outline: OutlineSegments,
  layerLeft: number,
  layerTop: number,
  sx: number,
  sy: number,
  color: number,
  width: number,
) {
  const segs = outline.segs;
  if (segs.length === 0) return;
  for (let i = 0; i + 3 < segs.length; i += 4) {
    const x0 = layerLeft + segs[i + 0] * sx;
    const y0 = layerTop + segs[i + 1] * sy;
    const x1 = layerLeft + segs[i + 2] * sx;
    const y1 = layerTop + segs[i + 3] * sy;
    g.moveTo(x0, y0).lineTo(x1, y1);
  }
  g.stroke({ width, color });
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

/**
 * 绘制一根子骨骼的图形（关节圆环 + 指向尖端的三角形），
 * 供“正式渲染”和“创建预览”共用，保证二者形状完全一致。
 *
 * 三角形顶点用 bone.worldMatrix 直接变换（X 列 = cos·scaleX，Y 列 = cos·scaleY），
 *   → scaleX 拉伸只改尖端 X 位置，三角形厚度由 scaleY 控制（Spine 标准行为）。
 *
 * @param g            目标 Gfx（bonesLayer 或预览 Gfx）
 * @param jx, jy       关节屏幕坐标
 * @param e0x, e0y     worldMatrix 的 X 列（cos·scaleX, sin·scaleX）—— 骨方向
 * @param e1x, e1y     worldMatrix 的 Y 列（-sin·scaleY, cos·scaleY）—— 垂直骨方向
 * @param color        主体/圆环描边颜色
 * @param jointR       关节圆环的固定像素半径（不跟 scaleX/Y 走）
 */
function drawBoneShape(
  g: Gfx,
  jx: number,
  jy: number,
  e0x: number, e0y: number,
  e1x: number, e1y: number,
  color: number,
  jointR: number = 9,
) {
  const innerBg = 0x1a1d22;
  const strokeBg = 0x000000;
  // viewBox 几何：anchor (50,167)，关节在左，尖端在右；三角形 4 点
  const VB_ANC = { x: 50, y: 167 };
  // 三角形「最左端」在 viewBox (62, 167)，相对 anchor 偏移 (12, 0) 个单位。
  //   leftTip = joint + 12 * e0
  const LEFT_TIP_OFFSET = 12;
  const leftTipX = jx + LEFT_TIP_OFFSET * e0x;
  const leftTipY = jy + LEFT_TIP_OFFSET * e0y;
  // 圆心再沿「骨反方向」外移一个半径 → 圆圈与三角形最左端的角相切（紧挨着不重叠）
  const e0Len = Math.hypot(e0x, e0y);
  const ux = e0Len > 1e-6 ? e0x / e0Len : 1;
  const uy = e0Len > 1e-6 ? e0y / e0Len : 0;
  const circleCx = leftTipX - jointR * ux;
  const circleCy = leftTipY - jointR * uy;
  // 用 worldMatrix 直接变换 viewBox 顶点：
  //   screenPt = joint + (lx-50) * e0 + (ly-167) * e1
  const project = (lx: number, ly: number): { x: number; y: number } => {
    const dx = lx - VB_ANC.x;
    const dy = ly - VB_ANC.y;
    return {
      x: jx + dx * e0x + dy * e1x,
      y: jy + dx * e0y + dy * e1y,
    };
  };
  // 描边宽度按关节半径等比（基准半径 9 时描边 = 2 / 1.5），
  // 否则短骨骼的小圆圈会被固定 2px 描边糊成一坨
  const k = jointR / 9;
  // 1. 关节圆环：与三角形最左端的角相切（紧挨着，不重叠）
  g.circle(circleCx, circleCy, jointR).stroke({ width: 2 * k, color });
  g.circle(circleCx, circleCy, jointR * 0.72).fill({ color: innerBg });
  // 2. 三角形主体：用 worldMatrix 变换 —— scaleX 拉伸只改尖端 X 位置，
  //    三角形厚度只受 scaleY 影响（Spine 正确行为）
  const a = project(78, 153);
  const b2 = project(410, 167);
  const c2 = project(78, 181);
  const d = project(62, 167);
  g.moveTo(a.x, a.y)
    .lineTo(b2.x, b2.y)
    .lineTo(c2.x, c2.y)
    .lineTo(d.x, d.y)
    .closePath()
    .fill({ color })
    .stroke({ width: 1.5 * k, color: strokeBg });
}

/**
 * 绘制 IK 旋转手柄图标（Codex 设计的 ik-handle）：
 * 四向箭头 + 圆环 + 深色内芯。以自身原点为中心，尺寸固定不随骨骼缩放。
 *
 * viewBox 446x335，anchor (223,167) 即中心，外接半径 144 单位。
 *
 * @param color 主色（手柄用红 0xE02020，旋转光标用绿）
 * @param scale 整体缩放（1 = 约 30px）
 */
function drawIkHandle(g: Gfx, color = 0xE02020, scale = 1) {
  const INNER = 0x3a3f4b;
  // 外接半径 144 单位 → 15px（图标整体约 30px）
  const S = (15 / 144) * scale;
  const p = (lx: number, ly: number): { x: number; y: number } => ({
    x: (lx - 223) * S,
    y: (ly - 167) * S,
  });
  const tri = (pts: number[][]) => {
    const a = p(pts[0][0], pts[0][1]);
    const b = p(pts[1][0], pts[1][1]);
    const c = p(pts[2][0], pts[2][1]);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).lineTo(c.x, c.y).closePath().fill({ color });
  };
  tri([[223, 23], [193, 107], [253, 107]]);   // 上箭头
  tri([[367, 167], [283, 137], [283, 197]]);  // 右箭头
  tri([[223, 311], [253, 227], [193, 227]]);  // 下箭头
  tri([[79, 167], [163, 197], [163, 137]]);   // 左箭头
  g.circle(0, 0, 72 * S).stroke({ width: 36 * S, color });
  g.circle(0, 0, 54 * S).fill({ color: INNER });
}

/**
 * 绘制骨骼的“命中区域”（不可见，仅用于 hit-test）。
 * 与 drawBoneShape 形状一致（关节圆 + 三角主体），并带最小尺寸下限，
 * 保证短骨骼也有足够大的可点区域。坐标以关节为原点、+X 沿骨骼方向。
 *
 * @param g          目标 Gfx（jointHit）
 * @param screenLen  关节 → 尖端的屏幕距离
 * @param angleRad   骨骼在屏幕空间的方向角（弧度）
 */
function drawBoneHitShape(g: Gfx, screenLen: number, angleRad: number) {
  const VB_LEN = 360;
  const vScale = screenLen / VB_LEN;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const rot = (lx: number, ly: number): { x: number; y: number } => ({
    x: lx * cos - ly * sin,
    y: lx * sin + ly * cos,
  });
  // 关节圆（覆盖关节位置，含最小半径兜底）
  const jointR = Math.max(18 * vScale, 10);
  g.circle(0, 0, jointR);
  // 三角主体：近关节端 + 尖端，半高有最小值，短骨骼也点得到
  const halfH = Math.max(14 * vScale, 6);
  const nearX = Math.max(28 * vScale, 6);
  const tipX = Math.max(screenLen, nearX + 6);
  const tailX = Math.max(12 * vScale, 2);
  const a = rot(nearX, -halfH);
  const b2 = rot(tipX, 0);
  const c2 = rot(nearX, halfH);
  const d = rot(tailX, 0);
  g.moveTo(a.x, a.y).lineTo(b2.x, b2.y).lineTo(c2.x, c2.y).lineTo(d.x, d.y).closePath();
  // 透明填充：PIXI 需要非零填充才参与几何 hit-test
  g.fill({ color: 0xffffff, alpha: 0.001 });
}

// ===== 根骨图标几何常量 =====
// 图标尺寸固定，不跟随 zoom 缩放（否则 zoom 小时消失、大时爆炸）
const ROOT_ICON_MAX_SCALE = 0.15;
/** 图标中心「黑色圆圈」在 viewBox 中的半径（区分移动 / 旋转悬停区） */
const ROOT_ICON_INNER_R = 26;
/** 图标最外沿半径（viewBox 单位）：最长臂 147 + 描边半宽 6 + 余量，整块图标都可命中 */
const ROOT_ICON_OUTER_R = 156;

/** 根骨图标的实际缩放（固定，不再跟随 zoom） */
function rootIconScale(_scale: number): number {
  return ROOT_ICON_MAX_SCALE;
}

/**
 * 根骨「移动手柄」图形（Codex 的 axis-arrows.json）。
 * 4 个多边形合成 2 个箭头：绿=向上（垂直骨方向 / 局部 Y），红=向右（沿骨方向 / 局部 X）。
 *
 * 坐标是 viewBox(446×335) 绝对坐标。JSON 里的 anchor(223,167) 只是 viewBox 中心，
 * 而手柄真正的「原点」是两箭头轴线的交点 (108.5, 280.5) —— 该点要对齐到根骨圆心，
 * 这样两个箭头就像 Spine 那样从圆心向外伸出。
 */
// ===== 移动手柄几何常量（供绘制与命中分区共用）=====
/** 手柄原点 = 两箭头轴线交点（viewBox 绝对坐标），映射到 Gfx 局部 (0,0) */
const MOVE_ORIGIN = { x: 108.5, y: 280.5 };
/** viewBox 单位 → 屏幕像素 */
const MOVE_SCALE = 0.15;
const MOVE_COLOR_GREEN = 0x4FF800;
const MOVE_COLOR_RED = 0xFB3F3F;
const MOVE_HOVER_COLOR = 0xFFFFFF;
/** 绿色（Y 轴 / 垂直骨方向）多边形：箭头 + 箭杆 */
const MOVE_GREEN_SHAPES: number[][][] = [
  [[108.5, 0.2], [160.9, 78.5], [56.1, 78.5]],
  [[108.4, 204.6], [80.4, 50.5], [136, 50.5]],
];
/** 红色（X 轴 / 沿骨方向）多边形：箭头 + 箭杆 */
const MOVE_RED_SHAPES: number[][][] = [
  [[389.2, 284.3], [309.6, 231.9], [307.1, 332.3]],
  [[185, 277.4], [343, 258], [340, 310]],
];

/** 把一组 viewBox 多边形绘制到 Gfx 局部坐标（原点 = MOVE_ORIGIN）。 */
function drawMoveShapes(g: Gfx, shapes: number[][][], color: number) {
  for (const pts of shapes) {
    const p = pts.map(([x, y]) => ({
      x: (x - MOVE_ORIGIN.x) * MOVE_SCALE,
      y: (y - MOVE_ORIGIN.y) * MOVE_SCALE,
    }));
    g.moveTo(p[0].x, p[0].y)
      .lineTo(p[1].x, p[1].y)
      .lineTo(p[2].x, p[2].y)
      .closePath()
      .fill({ color });
  }
}

/**
 * 绘制移动手柄。hoverZone 命中的那组箭头会变白（Spine 风格）。
 * @param hoverZone 'green' | 'red' | null（null = 都保持原色）
 */
function drawRootMoveHandle(g: Gfx, hoverZone: 'green' | 'red' | null = null) {
  drawMoveShapes(g, MOVE_GREEN_SHAPES, hoverZone === 'green' ? MOVE_HOVER_COLOR : MOVE_COLOR_GREEN);
  drawMoveShapes(g, MOVE_RED_SHAPES, hoverZone === 'red' ? MOVE_HOVER_COLOR : MOVE_COLOR_RED);
}

/**
 * 判定鼠标落在移动手柄的哪个区：
 *   - 'green'  → 绿箭头（局部 Y 轴，垂直骨方向）
 *   - 'red'    → 红箭头（局部 X 轴，沿骨方向）
 *   - 'center' → 两者之外（交叉点附近 → 自由移动）
 */
function detectMoveZone(lx: number, ly: number): 'green' | 'red' | 'center' {
  const toLocal = (shapes: number[][][]) =>
    shapes.map((pts) => pts.map(([x, y]) => ({
      x: (x - MOVE_ORIGIN.x) * MOVE_SCALE,
      y: (y - MOVE_ORIGIN.y) * MOVE_SCALE,
    })));
  if (toLocal(MOVE_GREEN_SHAPES).some((p) => pointInPolygon(lx, ly, p))) return 'green';
  if (toLocal(MOVE_RED_SHAPES).some((p) => pointInPolygon(lx, ly, p))) return 'red';
  return 'center';
}

/**
 * 「缩放」工具手柄图形（Codex 的 scale.json）。
 * 4 个多边形 = 2 个绿色 Y 轴方块 + 2 个红色 X 轴方块，居中于自身原点。
 *
 * viewBox 446×335 中心 (223,167)。本函数把 viewBox 中心映射到自身原点 (0,0)，
 * 整个图标长宽 ≈ 各 167 单位，按 0.15 系数 ≈ 25px 外接半径（≈ 根骨十字臂大小）。
 */

/**
 * ★ scale 图标统一锚点：所有 scale.json 多边形都减这个点，让「整个图标的视觉中心」
 *  落在 Gfx (0, 0)。这样旋转图标时整体绕 (0,0) 转，位置不会偏移。
 *  若缩放手柄位置看起来跟关节圆圈对不齐，就调这个 (x, y) —— 当前是临时调试值。
 */
const SCALE_HANDLE_ANCHOR = { x: 110, y: 285 };

/** scale.json 中绿色（Y 轴）色块：上方块 + 朝下的箭头。 */
function drawScaleHandleGreen(g: Gfx) {
  const S = 0.15;
  const cx = SCALE_HANDLE_ANCHOR.x;
  const cy = SCALE_HANDLE_ANCHOR.y;
  const shapes: { pts: number[][] }[] = [
    { pts: [[56.09, 5.35], [161.23, 5.35], [161.23, 102.16], [56.09, 102.16]] },
    { pts: [[113.08, 202.55], [103.47, 200.77], [76.06, 87.98], [141.42, 86.73], [141.26, 87.98], [113.86, 200.77]] },
  ];
  for (const s of shapes) {
    const p = s.pts.map(([x, y]) => ({ x: (x - cx) * S, y: (y - cy) * S }));
    g.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) g.lineTo(p[i].x, p[i].y);
    g.closePath().fill({ color: 0x4FF800 });
  }
}

/** scale.json 中红色（X 轴）色块：右方块 + 朝左的箭头。 */
function drawScaleHandleRed(g: Gfx) {
  const S = 0.15;
  const cx = SCALE_HANDLE_ANCHOR.x;
  const cy = SCALE_HANDLE_ANCHOR.y;
  const shapes: { pts: number[][] }[] = [
    { pts: [[287.67, 235.21], [389.84, 235.21], [389.84, 335], [287.67, 335]] },
    { pts: [[187.28, 286.86], [189.07, 277.24], [301.86, 249.83], [308.46, 255.03], [308.46, 309.84], [189.07, 287.63]] },
  ];
  for (const s of shapes) {
    const p = s.pts.map(([x, y]) => ({ x: (x - cx) * S, y: (y - cy) * S }));
    g.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) g.lineTo(p[i].x, p[i].y);
    g.closePath().fill({ color: 0xFB3F3F });
  }
}

/** 用指定颜色追加绘制一组多边形（调用方需先 clear 一次）。 */
function refillPolys(g: Gfx, shapes: { pts: number[][] }[], S: number, cx: number, cy: number, color: number) {
  for (const s of shapes) {
    const p = s.pts.map(([x, y]) => ({ x: (x - cx) * S, y: (y - cy) * S }));
    g.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) g.lineTo(p[i].x, p[i].y);
    g.closePath().fill({ color });
  }
}

/** scale 绿色 / 红色 / 中间三组多边形（用于 hover 重绘与命中判定）。 */
const SCALE_GREEN_POLYS: { pts: number[][] }[] = [
  { pts: [[56.09, 5.35], [161.23, 5.35], [161.23, 102.16], [56.09, 102.16]] },
  { pts: [[113.08, 202.55], [103.47, 200.77], [76.06, 87.98], [141.42, 86.73], [141.26, 87.98], [113.86, 200.77]] },
];
const SCALE_RED_POLYS: { pts: number[][] }[] = [
  { pts: [[287.67, 235.21], [389.84, 235.21], [389.84, 335], [287.67, 335]] },
  { pts: [[187.28, 286.86], [189.07, 277.24], [301.86, 249.83], [308.46, 255.03], [308.46, 309.84], [189.07, 287.63]] },
];

/** 把 viewBox 多边形映射到 Gfx 局部坐标点集。 */
function projectScalePolys(shapes: { pts: number[][] }[], S: number, cx: number, cy: number): Array<Array<{ x: number; y: number }>> {
  return shapes.map((s) => s.pts.map(([x, y]) => ({ x: (x - cx) * S, y: (y - cy) * S })));
}

// ===== 骨骼形状比例（Spine 行为）=====

/**
 * 骨骼「宽度」锁定阈值（世界单位）。
 * 骨骼长度 ≤ 该值时：宽度与长度等比增长（短骨骼细、长骨骼粗，比例一致）；
 * 长度 > 该值时：宽度锁定不再增长，只有长度继续变长。
 */
const BONE_WIDTH_LOCK_LENGTH = 300;

/** 由骨骼世界长度算出「宽度系数」：0..1，1 = 已达锁定宽度。 */
function boneWidthScale(worldLength: number): number {
  return Math.min(Math.abs(worldLength), BONE_WIDTH_LOCK_LENGTH) / BONE_WIDTH_LOCK_LENGTH;
}

// ===== 2D 仿射矩阵工具（[a, b, c, d, tx, ty]，与 PIXI Matrix 同序）=====
// 用于图层绑定：delta = 当前骨骼世界矩阵 × 绑定参考矩阵⁻¹

/** 求 2D 仿射矩阵的逆。返回 null 表示不可逆（行列式为 0）。 */
function invAffine(m: number[]): number[] | null {
  const [a, b, c, d, tx, ty] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return [
    ia, ib, ic, id,
    -(ia * tx + ic * ty),
    -(ib * tx + id * ty),
  ];
}

/** 2D 仿射矩阵相乘：out = m1 × m2（先作用 m2，再作用 m1）。 */
function mulAffine(m1: number[], m2: number[]): number[] {
  const [a1, b1, c1, d1, tx1, ty1] = m1;
  const [a2, b2, c2, d2, tx2, ty2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * tx2 + c1 * ty2 + tx1,
    b1 * tx2 + d1 * ty2 + ty1,
  ];
}

/** 射线法判点在多边形内（用于 pointermove 判断鼠标在绿/红/中心区）。 */
function pointInPolygon(x: number, y: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 图层变换手柄的「分区」与「约束轴」判定。
 *   - move  : red=沿图层 X 轴，green=垂直（+90°），center=自由
 *   - scale : red=沿 X 轴缩放，green=沿 Y 轴缩放，center=等比
 *   - shear : red=X 倾斜，green=Y 倾斜，center=自由倾斜
 *   - rotate: 总是绕锚点旋转，zone/axisAngle 占位（zone=‘center'，axisAngle=0）
 *
 * 实现：把屏幕坐标转到「手柄局部坐标系」（以手柄位置为原点，旋转 = -handleRotation）。
 * 然后复用骨骼的 detectMoveZone / detectScaleZone；shear 自行按 lx 符号切 red/green。
 */
function slotZoneAndAxis(
  tool: 'rotate' | 'move' | 'scale' | 'shear',
  gx: number, gy: number,
  anchorX: number, anchorY: number,
  lt: { rotation: number },
): { zone: 'red' | 'green' | 'center'; axisAngle: number; handleRotation: number } {
  const handleRotation = lt.rotation || 0;
  if (tool === 'rotate') {
    return { zone: 'center', axisAngle: 0, handleRotation };
  }
  // 把全局坐标转到手柄局部（逆旋转 -handleRotation）
  const c = Math.cos(-handleRotation);
  const s = Math.sin(-handleRotation);
  const dx = gx - anchorX;
  const dy = gy - anchorY;
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  if (tool === 'move') {
    const zone = detectMoveZone(lx, ly);
    const axisAngle = zone === 'green' ? handleRotation + Math.PI / 2 : handleRotation;
    return { zone, axisAngle, handleRotation };
  }
  if (tool === 'scale') {
    const zone = detectScaleZone(lx, ly);
    const axisAngle = zone === 'green' ? handleRotation + Math.PI / 2 : handleRotation;
    return { zone, axisAngle, handleRotation };
  }
  if (tool === 'shear') {
    // 手柄视图：左/红=水平条、右/绿=水平条、上/绿=垂直条、下/绿=垂直条；
    // 简化：lx<0 → red (X 倾斜)，lx>0 → green (Y 倾斜)，|lx| 小 → center
    let zone: 'red' | 'green' | 'center';
    if (Math.abs(lx) < 4) zone = 'center';
    else if (lx < 0) zone = 'red';
    else zone = 'green';
    const axisAngle = zone === 'green' ? handleRotation + Math.PI / 2 : handleRotation;
    return { zone, axisAngle, handleRotation };
  }
  return { zone: 'center', axisAngle: 0, handleRotation };
}

/**
 * 根据「手柄局部坐标」(lx, ly) 判定鼠标落在缩放手柄的哪个区：
 *   - 'green'  → 绿块（Y 轴）
 *   - 'red'    → 红块（X 轴）
 *   - 'center' → 两者之外的中间区（等比）
 */
function detectScaleZone(lx: number, ly: number): 'green' | 'red' | 'center' {
  const S = 0.15;
  const greenLocal = projectScalePolys(SCALE_GREEN_POLYS, S, SCALE_HANDLE_ANCHOR.x, SCALE_HANDLE_ANCHOR.y);
  const redLocal = projectScalePolys(SCALE_RED_POLYS, S, SCALE_HANDLE_ANCHOR.x, SCALE_HANDLE_ANCHOR.y);
  if (greenLocal.some((p) => pointInPolygon(lx, ly, p))) return 'green';
  if (redLocal.some((p) => pointInPolygon(lx, ly, p))) return 'red';
  return 'center';
}

/**
 * 「倾斜」工具手柄图形（Codex 的 incline.json）。
 * 4 个对称长条 = 上、下、左、右 4 个倾斜指示，居中于自身原点。
 *
 * viewBox 446×335 中心 (223,167)。本函数把 viewBox 中心映射到自身原点 (0,0)。
 */
function drawInclineHandle(g: Gfx) {
  const GREEN = 0x4FF800;
  const RED = 0xFB3F3F;
  const S = 0.15;
  const cx = 223;
  const cy = 167;
  const shapes: { pts: number[][]; color: number }[] = [
    // 上条（绿）含把手+杆
    { color: GREEN, pts: [[218.33, 0.86], [228.73, 1.92], [233, 6.2], [235.42, 12.04], [233, 17.89], [228.73, 22.16], [222.88, 24.58], [217.04, 22.16], [212.76, 17.89], [210.34, 12.04], [212.76, 6.2], [217.04, 1.92]] },
    { color: GREEN, pts: [[220.14, 18.67], [225.65, 18.67], [225.65, 132.17], [220.14, 132.17]] },
    // 下条（绿）含把手+杆
    { color: GREEN, pts: [[227.43, 332.9], [217.04, 331.84], [212.76, 327.57], [210.34, 321.72], [212.76, 315.88], [217.04, 311.6], [222.88, 309.18], [228.73, 311.6], [233, 315.88], [235.42, 321.72], [233, 327.57], [228.73, 331.84]] },
    { color: GREEN, pts: [[220.11, 201.59], [225.62, 201.59], [225.62, 315.1], [220.11, 315.1]] },
    // 右条（红）含把手+杆
    { color: RED, pts: [[388.9, 162.33], [387.84, 172.73], [383.57, 177], [377.72, 179.42], [371.88, 177], [367.6, 172.73], [365.18, 166.88], [367.6, 161.04], [371.88, 156.76], [377.72, 154.34], [383.57, 156.76], [387.84, 161.04]] },
    { color: RED, pts: [[257.59, 164.14], [371.1, 164.14], [371.1, 169.65], [257.59, 169.65]] },
    // 左条（红）含把手+杆
    { color: RED, pts: [[56.86, 171.43], [57.92, 161.04], [62.2, 156.76], [68.04, 154.34], [73.89, 156.76], [78.16, 161.04], [80.58, 166.88], [78.16, 172.73], [73.89, 177], [68.04, 179.42], [62.2, 177], [57.92, 172.73]] },
    { color: RED, pts: [[74.67, 164.11], [188.17, 164.11], [188.17, 169.62], [74.67, 169.62]] },
  ];
  for (const s of shapes) {
    const p = s.pts.map(([x, y]) => ({ x: (x - cx) * S, y: (y - cy) * S }));
    g.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) g.lineTo(p[i].x, p[i].y);
    g.closePath().fill({ color: s.color });
  }
}

/**
 * 根骨「旋转手柄」图形 = Codex 的 ik-handle（红色四向箭头 + 圆环）。
 */
function drawRootRotateHandle(g: Gfx) {
  drawIkHandle(g);
}

/**
 * 「旋转」工具的视觉手柄（Codex 的 rotate.json）。
 * 一个近圆环 + 顶部有向上的小直柄（指示旋转方向）。
 * 红色 0xFF0000，居中于自身原点。
 *
 * @param g   目标 Gfx
 * @param S   整体缩放（默认 ≈30px 外接半径）
 */
function drawRotateIcon(g: Gfx, S = 1) {
  const RED = 0xFF0000;
  // viewBox (446x335) 中心 (223,167)，外接半径约 167；缩放到 15px 外接半径
  const scale = (15 / 167) * S;
  // 让调用方传 (x,y) 时「环中心」落在 (x,y)。
  // viewBox (223,167) 是 viewBox 原点；环中心在 (223,15)，相对原点 y = -152 单位。
  // cy = (15 - 167) * scale - yOffset ⇒ 设 =0 ⇒ yOffset = -152 * scale
  const yOffset = -152 * scale;
  // 圆环：中心 (223,15) 半径 144，宽 38（让顶部留个开口给柄）
  const cx = (223 - 223) * scale;
  const cy = (15 - 167) * scale - yOffset;
  const ringR = 144 * scale;
  const ringW = 38 * scale;
  g.circle(cx, cy, ringR).stroke({ width: ringW, color: RED, cap: 'round' });
  // 顶部的小柄：从圆环顶部往上凸出一段（6.7mm 长度）
  const stemH = 47 * scale;
  const stemW = 28 * scale;
  g.moveTo(cx - stemW / 2, cy - ringR)
    .lineTo(cx - stemW / 2, cy - ringR - stemH)
    .lineTo(cx + stemW / 2, cy - ringR - stemH)
    .lineTo(cx + stemW / 2, cy - ringR)
    .closePath()
    .fill({ color: RED });
}

