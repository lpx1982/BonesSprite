/**
 * 动画时间轴 —— Spine 风格重制。
 *
 * 布局（仿 Spine 3.8 编辑器底部面板）：
 *  ┌─ 顶部工具条 ─────────────────────────────────────┐
 *  │ 撤销/重做 │ 同步 │ 自动关键帧 │ 8 属性图标 │ 缩放/偏移/调整 │ 当前/循环开始/结束 │ 动画管理 │ 帧/秒 │
 *  ├─ 左侧：树形嵌套轨道 ──┬─ 右侧：标尺 + 关键帧 ────┤
 *  │ ✦ root                  │  0  5  10  15  ...        │
 *  │   ▶ front-thigh         │   ┃┃┃  ┃  (X)            │
 *  │   ▶ front-shin          │   ┃ ┃┃  ┃  (Y)            │
 *  │     旋转                 │   ┃ ┃┃  ┃              │
 *  │     缩放                 │   ┊ 播放头              │
 *  └──────────────────────┴─────────────────────┘
 *
 * 交互（与原版一致）：
 *  - 点标尺 / 拖动 → seek
 *  - 点轨道空白 → 在 currentTime 写关键帧
 *  - 点关键帧竖线 → 选中（高亮），拖动 → 移动
 *  - 双击关键帧 → 删除
 *  - 点骨名 / 关键帧 → 选中该骨（focus 模式：自动切换）
 *  - 撤销/重做、动画管理（增/删/重命名/复制）
 *  - 自动关键帧：开关决定拖骨骼时是否自动写关键帧（红色录制按钮 = 开）
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePixiBonesStore, sampleTrackValue, ANIM_PROPERTIES, PC_ANIM_PROPS, PC_PROP_ANIM, PC_ANIM_PROP, isPathConstraintAnimProperty, type AnimProperty, type AnimCurveType, type BoneAnimProperty, type BoneNode } from './store';

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 600;
const PX_PER_FRAME = 5;     // 默认缩放值
const MIN_PX_PER_FRAME = 1; // 最细：1 px/帧，能看到几千帧范围
const MAX_PX_PER_FRAME = 20; // 最粗：20 px/帧，确保 30 帧动画能占约 600px（精细编辑）
const RULER_H = 22;
const KEY_MARK_H = 10;  // 标尺下方菱形关键帧标记行高度（Spine 风）
const BONE_ROW_H = 22;
const PROP_ROW_H = 16;
const GRAPH_TRACK_H = 44;   // Graph 视图中每条属性曲线行的高度
const KEY_LINE_W = 2;
const INDENT = 14;
// =============== Figma 骨架分层高度（对齐 Spine 底部面板） ===============
const TITLE_H = 26;    // 标题栏：视图 Tab + 动画管理 + 撤销/重做/同步
const TOOLBAR_H = 38;  // 工具条①：Spine 图表工具条（4 分区 21 格）
const PLAYROW_H = 32;  // 工具条②：播放控制 + 固定标尺（RULER_H 22 + KEY_MARK_H 10 叠放）
const STATUS_H = 26;   // 底部状态栏：缩放 + 属性快捷 + 帧率/时长
const LEFT_RATIO = 0.23; // 左树宽度 = 容器宽 × 23%（对齐 Figma 主区域比例）

// =============== 颜色 ===============
/** 骨骼颜色（与画布 / 权重面板一致）。 */
const BONE_PALETTE = [
  '#E61E1E', '#1E78E6', '#2EC75E', '#F0A020', '#9B59B6', '#16A085',
  '#E67E22', '#3498DB', '#E84393', '#27AE60', '#8E44AD', '#D35400',
];
function boneColor(index: number): string {
  return BONE_PALETTE[index % BONE_PALETTE.length];
}

/** 属性 → 关键帧竖线颜色（Spine 风格：每种属性不同色）。 */
// =============== 统一行模型（第0波：左树/右侧共用同一行序列） ===============
/** 扁平化的时间轴行：左侧树与右侧时间轴从同一数组渲染，天然左右对齐。
 *  骨行 = BONE_ROW_H（两种视图一致）；属性行 = PROP_ROW_H（DopeSheet）或 GRAPH_TRACK_H（Graph）。 */
interface TimelineRow {
  kind: 'bone' | 'prop';
  bone: BoneNodeT;
  depth: number;
  height: number;
  property?: AnimProperty;
  isConstraint?: boolean;
  /** 路径约束属性轨道行（pc_ 前缀属性；行点击 / 拖动走路径约束专用分发） */
  isPc?: boolean;
  keys?: PropKey[];
}

function flattenRows(
  nodes: BoneNodeT[],
  collapsed: Record<string, boolean>,
  viewMode: 'dopesheet' | 'graph',
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const propH = viewMode === 'graph' ? GRAPH_TRACK_H : PROP_ROW_H;
  const walk = (list: BoneNodeT[], depth: number) => {
    for (const n of list) {
      rows.push({ kind: 'bone', bone: n, depth, height: BONE_ROW_H });
      if (collapsed[n.bone.id]) continue;
      // 属性行：同一属性聚合关键帧（按 time 序），constraintMix 以 mix 属性并入
      const byProp = new Map<AnimProperty, PropKey[]>();
      for (const k of n.props) {
        const arr = byProp.get(k.property) ?? [];
        arr.push(k);
        byProp.set(k.property, arr);
      }
      for (const [p, ks] of byProp) {
        rows.push({
          kind: 'prop', bone: n, depth: depth + 1, height: propH,
          property: p, isConstraint: ks[0]?.isConstraint, isPc: ks[0]?.isPc, keys: ks,
        });
      }
      walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}

// =============== 子组件：时间轴行（右侧） ===============
const PROP_COLOR: Record<AnimProperty, string> = {
  x: '#E61E1E',
  y: '#2EC75E',
  rotation: '#F0A020',
  scaleX: '#1E78E6',
  scaleY: '#9B59B6',
  mix: '#F0E020',
  pc_position: '#4FE0B0',
  pc_spacing: '#8A7DFF',
  pc_rotateMix: '#FF8AD8',
  pc_translateMix: '#7DDBFF',
  pc_rotationOffset: '#FFC46B',
};

/** 属性 → 行末短标签。 */
const PROP_SHORT: Record<AnimProperty, string> = {
  x: 'X', y: 'Y', rotation: '↻', scaleX: '⇆', scaleY: '⇅', mix: 'mix',
  pc_position: '位置', pc_spacing: '间距', pc_rotateMix: '旋混', pc_translateMix: '平混', pc_rotationOffset: '偏角',
};

// =============== 工具条图标（emoji 占位，无字体实现） ===============
const ICON = {
  undo: '↶', redo: '↷',
  sync: '↻',
  autoKeyOn: '●', autoKeyOff: '○',
  zoom: '⊕', offset: '⇆', adjust: '⎌',
  current: '◉', loopStart: '⟨', loopEnd: '⟩',
  dopesheet: '☰', graph: '∿',
  addAnim: '＋', dupAnim: '⧉', renameAnim: '✎', delAnim: '🗑',
} as const;

// =============== 轨道模型（树形） ===============
/** 关键帧聚合结构：按 (property, time) 分组到所属 bone 节点。 */
interface PropKey {
  property: AnimProperty;
  time: number;
  value: number;
  isConstraint?: boolean;
  /** 路径约束属性关键帧（pc_ 前缀属性轨道） */
  isPc?: boolean;
}
interface BoneNodeT {
  bone: BoneNode;
  /** 该骨自身有关键帧的属性轨道（不含后代） */
  props: PropKey[];
  /** 子骨 */
  children: BoneNodeT[];
  /** 折叠状态（本地 UI 态，组件内 useState 维护） */
  collapsed: boolean;
  /** 该骨是否带「继承」标志（Spine 风格可关继承决定子骨是否跟随） */
  inherited: boolean;
}

// =============== 主组件 ===============
export function AnimationTimeline() {
  const height = usePixiBonesStore((s) => s.timelineHeight);
  const setHeight = usePixiBonesStore((s) => s.setTimelineHeight);

  // ---- 数据 ----
  const animations = usePixiBonesStore((s) => s.animations);
  const activeAnimationId = usePixiBonesStore((s) => s.activeAnimationId);
  const currentTime = usePixiBonesStore((s) => s.currentTime);
  const playing = usePixiBonesStore((s) => s.playing);
  const loop = usePixiBonesStore((s) => s.loop);
  const fps = usePixiBonesStore((s) => s.fps);
  const bones = usePixiBonesStore((s) => s.bones);
  const keyframeLock = usePixiBonesStore((s) => s.keyframeLock);
  const constraints = usePixiBonesStore((s) => s.constraints);
  const constraintRuntimeMix = usePixiBonesStore((s) => s.constraintRuntimeMix);
  const pathConstraints = usePixiBonesStore((s) => s.pathConstraints);

  // ---- actions ----
  const setActiveAnimation = usePixiBonesStore((s) => s.setActiveAnimation);
  const addAnimation = usePixiBonesStore((s) => s.addAnimation);
  const duplicateAnimation = usePixiBonesStore((s) => s.duplicateAnimation);
  const renameAnimation = usePixiBonesStore((s) => s.renameAnimation);
  const removeAnimation = usePixiBonesStore((s) => s.removeAnimation);
  const setAnimationDuration = usePixiBonesStore((s) => s.setAnimationDuration);
  const seekTo = usePixiBonesStore((s) => s.seekTo);
  const stepFrame = usePixiBonesStore((s) => s.stepFrame);
  const togglePlay = usePixiBonesStore((s) => s.togglePlay);
  const setLoop = usePixiBonesStore((s) => s.setLoop);
  const setKeyframe = usePixiBonesStore((s) => s.setKeyframe);
  const removeKeyframe = usePixiBonesStore((s) => s.removeKeyframe);
  const moveKeyframe = usePixiBonesStore((s) => s.moveKeyframe);
  const undo = usePixiBonesStore((s) => s.undo);
  const redo = usePixiBonesStore((s) => s.redo);
  const selectBone = usePixiBonesStore((s) => s.selectBone);
  const toggleKeyframeLock = usePixiBonesStore((s) => s.toggleKeyframeLock);
  const removeConstraintMixKeyframe = usePixiBonesStore((s) => s.removeConstraintMixKeyframe);

  const anim = animations.find((a) => a.id === activeAnimationId) ?? animations[0] ?? null;
  const duration = anim?.duration ?? 0;
  const totalFrames = Math.max(1, Math.ceil(duration * fps));

  // =============== 时间轴缩放 ===============
  // 缩放比例（px / 帧）：用户可改、点"全部展开"自动算。存为 useState 维持横滚位置。
  const [pxPerFrame, setPxPerFrame] = useState(PX_PER_FRAME);
  // 容器宽（左侧轨道占 180 后剩余的横滚容器宽度）— 用 ref 测
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollerW, setScrollerW] = useState(0);
  useEffect(() => {
    if (!scrollerRef.current) return;
    const el = scrollerRef.current;
    const ro = new ResizeObserver(() => setScrollerW(el.clientWidth));
    ro.observe(el);
    setScrollerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // =============== Figma 布局：左树宽 = 容器宽 × 23%，标尺宽 = 剩余 ===============
  const leftW = Math.max(140, Math.round(scrollerW * LEFT_RATIO));
  const rulerW = Math.max(0, scrollerW - leftW);
  // 「全部展开」：让动画最后帧刚好在容器右边缘
  const fitTimeline = () => {
    const total = totalFrames * pxPerFrame;
    const avail = Math.max(scrollerW - leftW, 200);
    if (total > avail) {
      setPxPerFrame(Math.max(MIN_PX_PER_FRAME, avail / totalFrames));
    } else if (total < avail * 0.6) {
      // 缩得过头时也适当放大（Spine 行为）
      setPxPerFrame(Math.min(MAX_PX_PER_FRAME, avail / totalFrames));
    }
  };

  const timelineW = totalFrames * pxPerFrame + 80;

  // 折叠状态（按骨 id）
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapsed = (id: string) => setCollapsed((m) => ({ ...m, [id]: !m[id] }));

  // =============== 树形轨道模型 ===============
  // ★ 依赖用「骨骼 id 序列」而非 bones 引用：播放采样只改 x/y/rotation 数值、
  //   不改变 id/name/parent → id 序列不变 → tree 不重算 → 时间轴轨道行（memo 子组件）
  //   在播放时完全不重渲染（这是时间轴流畅的关键）。
  const bonesIdsKey = bones.map((b) => b.id).join('|');
  const pcKey = pathConstraints.map((c) => c.id).join('|');
  const tree = useMemo(
    () => buildBoneTree(bones, anim, constraints, pathConstraints, constraintRuntimeMix),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bonesIdsKey, pcKey, anim, constraints, pathConstraints, constraintRuntimeMix],
  );

  // =============== 播放循环 ===============
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let anyPointerDown = false;
    const onDown = () => { anyPointerDown = true; };
    const onUp = () => { anyPointerDown = false; };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const st = usePixiBonesStore.getState();
      if (!st.playing || st.editorTab !== 'animate' || anyPointerDown) { last = now; return; }
      const a = st.animations.find((x) => x.id === st.activeAnimationId);
      const dur = a?.duration ?? 0;
      if (dur <= 0) { last = now; return; }
      let tt = st.currentTime + (now - last) / 1000;
      last = now;
      if (st.loop) tt = tt % dur;
      else { tt = Math.min(tt, dur); if (tt >= dur) st.setPlaying(false); }
      st.seekTo(tt);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  // =============== 高度拖动 ===============
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current; if (!d) return;
      const delta = d.startY - e.clientY;
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, d.startH + delta)));
    };
    const onUp = () => { dragRef.current = null; document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [setHeight]);
  const onHandleDown = (e: React.MouseEvent) => {
    dragRef.current = { startY: e.clientY, startH: height };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  // =============== 标尺 seek ===============
  const rulerRef = useRef<HTMLDivElement>(null);
  // ★ useCallback 稳定化：Ruler 是 memo 组件，onPointerDown / seekFromClientX 必须引用稳定，
  //   否则每次渲染（播放时每帧）都会让 Ruler 重渲（270 个 div 白白重建）。
  const seekFromClientX = useCallback((clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const t = Math.max(0, Math.min(duration, (clientX - rect.left) / pxPerFrame / fps));
    seekTo(t);
  }, [duration, pxPerFrame, fps, seekTo]);
  const seekRef = useRef(false);
  // 标尺按下：开始 seek（在 seekRef 声明后定义，避免 TDZ）
  const rulerPointerDownCb = useCallback((e: React.PointerEvent) => {
    seekRef.current = true;
    seekFromClientX(e.clientX);
  }, [seekFromClientX]);
  // ★ 加依赖数组：之前无依赖导致每次渲染都 add/remove window 监听器（播放时每帧一次）。
  //   现在只在 duration / pxPerFrame / fps 变化时重建（都不频繁）。
  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (seekRef.current) seekFromClientX(e.clientX); };
    const onUp = () => { seekRef.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, pxPerFrame, fps]);

  // =============== 关键帧拖动 ===============
  const [dragKey, setDragKey] = useState<{ boneId: string; property: AnimProperty; fromTime: number; isConstraint?: boolean } | null>(null);
  const [dragTime, setDragTime] = useState(0);

  // =============== 视图切换（DopeSheet / Graph）+ 关键帧选中（设插值用）===============
  const [viewMode, setViewMode] = useState<'dopesheet' | 'graph'>('dopesheet');
  // =============== Graph Filter（漏斗）：控制图中显示的内容类型（骨骼/图片/其他） ===============
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterFlags, setFilterFlags] = useState<{ bone: boolean; image: boolean; other: boolean }>({ bone: true, image: false, other: false });
  const [selectedKey, setSelectedKey] = useState<{ boneId: string; property: AnimProperty; time: number; isConstraint?: boolean } | null>(null);
  // ★ 统一行模型：左树与右侧时间轴共用同一行序列（行高按视图决定），天然左右对齐。
  //   依赖 [tree, collapsed, viewMode]：播放采样不改变三者 → rows 引用稳定 → memo 子组件不重渲。
  const rows = useMemo(
    () => flattenRows(tree, collapsed, viewMode),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, collapsed, viewMode],
  );
  // ★ 标尺菱形标记需要的关键帧时间集合（去重，跨所有行聚合）；rows 稳定 → 引用稳定
  const keyTimes = useMemo(() => {
    const s = new Set<number>();
    for (const r of rows) if (r.kind === 'prop' && r.keys) for (const k of r.keys) s.add(k.time);
    return s;
  }, [rows]);
  // Graph Filter 过滤后的行序列：骨骼被过滤 → 左树提示 + 轨道清空（保持左右对齐）
  const visibleRows = useMemo(
    () => (filterFlags.bone ? rows : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, filterFlags.bone],
  );
  // 点击 Graph Filter 菜单外部 → 关闭菜单
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('[data-graph-filter]')) setFilterOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [filterOpen]);
  const setKeyframeCurve = usePixiBonesStore((s) => s.setKeyframeCurve);
  // 设置当前选中关键帧的插值类型（bezier 时给一组默认控制点，用户后续在 Graph 里细调）
  const applyCurve = useCallback((curve: AnimCurveType) => {
    const sk = selectedKey;
    if (!sk) return;
    const bezier: [number, number, number, number] | undefined = curve === 'bezier'
      ? [0.5, 0, 0.5, 1]
      : undefined;
    setKeyframeCurve(sk.boneId, sk.property, sk.time, curve, bezier);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // =============== 稳定回调（memo 子组件要求 props 引用稳定，播放时才不会整树重渲）===============
  const dragStartCb = useCallback((boneId: string, prop: AnimProperty, fromTime: number, isC?: boolean) => {
    setDragKey({ boneId, property: prop, fromTime, isConstraint: isC });
    setDragTime(fromTime);
  }, []);
  const dragMoveCb = useCallback((t: number) => setDragTime(t), []);
  const dragEndCb = useCallback((t: number) => {
    if (dragKey) {
      if (dragKey.isConstraint) {
        // 约束 mix 轨道走专用的 move（保留 constraintMix 标记）
        const st = usePixiBonesStore.getState();
        const a = st.animations.find((x) => x.id === st.activeAnimationId);
        if (a) {
          const tr = a.tracks.find((x) => x.boneId === dragKey.boneId && x.property === 'mix' && x.constraintMix);
          if (tr) {
            const k = tr.keys.find((kk) => Math.abs(kk.time - dragKey.fromTime) < 1e-6);
            if (k) { st.setConstraintMixKeyframe(dragKey.boneId, t, k.value); st.removeConstraintMixKeyframe(dragKey.boneId, dragKey.fromTime); }
          }
        }
      } else {
        moveKeyframe(dragKey.boneId, dragKey.property, dragKey.fromTime, t);
      }
    }
    setDragKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragKey]);
  const clickRowCb = useCallback((boneId: string, prop: AnimProperty, isC?: boolean, isPc?: boolean) => {
    // 点击轨道空白写关键帧（值从 store 实时读，避免闭包依赖 bones 导致回调每帧变化）
    if (dragKey) return;
    const st = usePixiBonesStore.getState();
    const t = st.currentTime;
    if (isPc) {
      // 路径约束属性轨道：值 = 运行时采样 ?? 约束定义值
      const pcProp = PC_ANIM_PROP[prop]!;
      const def = st.pathConstraints.find((c) => c.id === boneId);
      const rt = st.pathConstraintRuntime[boneId];
      const cur = rt?.[pcProp] ?? def?.[pcProp] ?? 0;
      st.setPathConstraintKeyframe(boneId, pcProp, t, cur);
    } else if (isC) {
      const def = st.constraints.find((c) => c.id === boneId);
      const cur = st.constraintRuntimeMix[boneId] ?? def?.mix ?? 1;
      st.setConstraintMixKeyframe(boneId, t, cur);
    } else {
      const b = st.bones.find((x) => x.id === boneId);
      if (b) st.setKeyframe(boneId, prop, t, b[prop as BoneAnimProperty]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragKey]);
  const selectBoneCb = useCallback((id: string) => {
    // 顶层路径约束行：点行名选中约束（约束 id 前缀 pc_）；IK 约束没有顶层行不会走到
    const st = usePixiBonesStore.getState();
    if (st.pathConstraints.some((c) => c.id === id)) {
      st.selectConstraint(id);
      return;
    }
    selectBone(id);
  }, [selectBone]);
  const removeKeyCb = useCallback((boneId: string, prop: AnimProperty, t: number, isC?: boolean) => {
    if (isC) removeConstraintMixKeyframe(boneId, t);
    else removeKeyframe(boneId, prop, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // =============== 渲染 ===============
  const frameOf = (time: number) => Math.floor(time * fps);
  // 当前选中关键帧的插值类型（用于顶栏按钮高亮）
  const selectedCurve: AnimCurveType | undefined = (() => {
    if (!selectedKey || !anim) return undefined;
    const tr = anim.tracks.find((x) => x.boneId === selectedKey.boneId && x.property === selectedKey.property);
    return tr?.keys.find((k) => Math.abs(k.time - selectedKey.time) < 1e-6)?.curve;
  })();

  return (
    <div
      className="absolute left-0 right-0 bottom-0 z-20 flex flex-col"
      style={{
        height,
        background: 'var(--spine-bg-toolbar)',
        borderTop: '1px solid var(--spine-border)',
      }}
    >
      {/* 顶部 resize */}
      <div
        onMouseDown={onHandleDown}
        style={{ position: 'absolute', top: -2, left: 0, right: 0, height: 4, cursor: 'ns-resize', zIndex: 1 }}
        title="拖动调整高度"
      />

      {/* ============ 标题栏（TITLE_H）：视图 Tab + 动画管理 + 撤销/重做/同步 ============ */}
      <div
        className="flex items-center gap-1 px-1.5 shrink-0"
        style={{ height: TITLE_H, background: 'var(--spine-bg-panel-dark)', borderBottom: '1px solid var(--spine-border)' }}
      >
        {/* 视图 Tab（Spine 风格：图表 / 摄影表，点击切换） */}
        <div
          className="flex items-center"
          style={{ border: '1px solid var(--spine-border)', borderRadius: 3, overflow: 'hidden', marginRight: 4 }}
        >
          {([
            ['graph', '图表', '图表视图（曲线编辑）'],
            ['dopesheet', '摄影表', '摄影表视图（关键帧条）'],
          ] as const).map(([m, label, tip], i) => (
            <button
              key={m}
              type="button"
              onClick={() => setViewMode(m)}
              title={tip}
              style={{
                height: 20, padding: '0 10px', fontSize: 10, lineHeight: '20px',
                background: viewMode === m ? 'var(--spine-accent)' : 'transparent',
                color: viewMode === m ? '#fff' : 'var(--spine-text)',
                border: 'none', borderLeft: i === 0 ? 'none' : '1px solid var(--spine-border)',
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >{label}</button>
          ))}
        </div>

        {/* 撤销/重做 */}
        <IconBtn title="撤销 (Cmd+Z)" onClick={undo}>{ICON.undo}</IconBtn>
        <IconBtn title="重做 (Cmd+Shift+Z)" onClick={redo}>{ICON.redo}</IconBtn>
        <Sep />

        {/* 同步：让画布跟随当前动画时间（按住编辑） */}
        <IconBtn
          title="同步：编辑时画布跟随当前时间"
          onClick={() => usePixiBonesStore.getState().seekTo(usePixiBonesStore.getState().currentTime)}
        >{ICON.sync}</IconBtn>
        <Sep />

        {/* 动画管理（下拉 + 增/复制/重命名/删除） */}
        <select
          value={anim?.id ?? ''}
          onChange={(e) => { setActiveAnimation(e.target.value); seekTo(usePixiBonesStore.getState().currentTime); }}
          style={selectStyle({ width: 140 })}
          title="切换当前编辑 / 播放的动画"
        >
          {animations.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <IconBtn title="新增动画" onClick={() => addAnimation()}>{ICON.addAnim}</IconBtn>
        <IconBtn title="复制当前动画" onClick={() => anim && duplicateAnimation(anim.id)} disabled={!anim}>{ICON.dupAnim}</IconBtn>
        <IconBtn
          title="重命名当前动画"
          disabled={!anim}
          onClick={() => {
            if (!anim) return;
            const name = window.prompt('动画名称', anim.name);
            if (name != null) renameAnimation(anim.id, name);
          }}
        >{ICON.renameAnim}</IconBtn>
        <IconBtn title="删除当前动画（至少保留一个）" disabled={!anim || animations.length <= 1} onClick={() => anim && removeAnimation(anim.id)}>{ICON.delAnim}</IconBtn>

        {/* 右侧：当前帧 + 时间 */}
        <div className="ml-auto flex items-center gap-3" style={{ color: 'var(--spine-text-dim)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
          <span>帧 {frameOf(currentTime)} / {totalFrames - 1}</span>
          <span>{currentTime.toFixed(2)}s / {duration.toFixed(2)}s</span>
        </div>
      </div>

      {/* ============ 工具条①（TOOLBAR_H）：Spine 图表工具条（4 分区 21 格） ============ */}
      <div
        className="flex items-center gap-1 px-1.5 shrink-0"
        style={{ height: TOOLBAR_H, background: 'var(--spine-bg-panel-dark)', borderBottom: '1px solid var(--spine-border)', position: 'relative' }}
      >
        {/* 分区1：Graph Filter（漏斗，左键弹菜单 / 右键快速切换）+ 锁定 + 刷新 */}
        <div data-graph-filter style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setFilterOpen((o) => !o)}
            onContextMenu={(e) => {
              e.preventDefault();
              setFilterFlags((f) => ({ ...f, bone: !f.bone }));
            }}
            title="Graph Filter：自定义图中显示的内容，右键单击可切换"
            style={{
              width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: filterOpen ? 'rgba(255,255,255,0.10)' : 'transparent',
              color: 'var(--spine-text)', border: '1px solid transparent', borderRadius: 3, cursor: 'pointer',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1H11L7 6V10L5 11V6L1 1Z" fill="currentColor" /></svg>
          </button>
          {filterOpen && (
            <div data-graph-filter style={{ position: 'absolute', top: '100%', left: 0, zIndex: 50, minWidth: 110, background: '#333', border: '1px solid var(--spine-border)', borderRadius: 4, padding: '4px 0' }}>
              {([['bone', '骨骼'], ['image', '图片'], ['other', '其他']] as const).map(([k, label]) => (
                <label
                  key={k}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px',
                    fontSize: 11, color: 'var(--spine-text)', cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  <input type="checkbox" checked={filterFlags[k]} onChange={() => setFilterFlags((f) => ({ ...f, [k]: !f[k] }))} />
                  {label}
                </label>
              ))}
            </div>
          )}
        </div>
        <IconBtn title="锁定（占位）">🔒</IconBtn>
        <IconBtn title="刷新（占位）">⟳</IconBtn>
        <Sep />

        {/* 分区2：编辑工具（占位）+ 曲线工具（占位）+ 插值类型（已实现）+ 更多（占位） */}
        <IconBtn title="选择工具（占位）">▣</IconBtn>
        <IconBtn title="移动工具（占位）">✕</IconBtn>
        <IconBtn title="旋转工具（占位）">⌫</IconBtn>
        <IconBtn title="缩放工具（占位）">✎</IconBtn>
        <Sep />
        <IconBtn title="直线曲线（占位）">∕</IconBtn>
        <IconBtn title="自由曲线（占位）">∿</IconBtn>
        <Sep />
        <span className="flex items-center gap-0.5" style={{ fontSize: 10, color: 'var(--spine-text-dim)' }} title={selectedKey ? '设置选中关键帧的插值类型' : '先在时间轴选中一个关键帧'}>
          插值
          {(['linear', 'stepped', 'bezier'] as AnimCurveType[]).map((c) => (
            <button
              key={c}
              type="button"
              disabled={!selectedKey}
              onClick={() => applyCurve(c)}
              title={c === 'linear' ? '线性过渡' : c === 'stepped' ? '步进（保持到下一帧跳变）' : '贝塞尔曲线（可在 Graph 视图调节）'}
              style={{
                height: 20, padding: '0 6px', fontSize: 10,
                background: selectedCurve === c ? 'var(--spine-accent)' : 'transparent',
                color: selectedCurve === c ? '#fff' : 'var(--spine-text)',
                border: '1px solid ' + (selectedCurve === c ? 'var(--spine-accent)' : 'var(--spine-border)'),
                borderRadius: 3, cursor: selectedKey ? 'pointer' : 'not-allowed',
                opacity: selectedKey ? 1 : 0.4,
              }}
            >{c === 'linear' ? '线性' : c === 'stepped' ? '步进' : '贝塞尔'}</button>
          ))}
        </span>
        <Sep />
        <IconBtn title="更多工具（占位）">⋯</IconBtn>
        <Sep />

        {/* 分区3：位移（active）/ 偏移（占位）—— Spine 图表工具条的变换模式 */}
        <button
          type="button"
          title="位移（当前模式）"
          style={{
            height: 22, padding: '0 10px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
            background: 'var(--spine-accent)', color: '#fff', border: '1px solid var(--spine-accent)',
          }}
        >位移</button>
        <button
          type="button"
          title="偏移（占位）"
          style={{
            height: 22, padding: '0 10px', fontSize: 10, borderRadius: 3, cursor: 'not-allowed',
            background: 'transparent', color: 'var(--spine-text)', border: '1px solid var(--spine-border)', opacity: 0.5,
          }}
        >偏移</button>
        <Sep />

        {/* 分区4：帧（active）/ 自动 / ♡ / ✦ / ⤓ / ⋯（占位）+ 右侧时长输入 */}
        <button
          type="button"
          title="帧（当前模式）"
          style={{
            height: 22, padding: '0 10px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
            background: 'rgba(255,255,255,0.10)', color: 'var(--spine-text)', border: '1px solid var(--spine-border)',
          }}
        >帧</button>
        <IconBtn title="自动（占位）">自动</IconBtn>
        <IconBtn title="♡（占位）">♡</IconBtn>
        <IconBtn title="✦（占位）">✦</IconBtn>
        <IconBtn title="⤓（占位）">⤓</IconBtn>
        <IconBtn title="⋯（占位）">⋯</IconBtn>

        {/* 右侧：动画时长 */}
        <label className="ml-auto flex items-center gap-1" style={{ fontSize: 10, color: 'var(--spine-text-dim)' }}>
          时长
          <DurationInput duration={duration} animId={anim?.id} set={setAnimationDuration} />
        </label>
      </div>

      {/* ============ 工具条②（PLAYROW_H）：播放控制 + 固定标尺（对齐 Figma 第二行） ============ */}
      <div
        className="flex items-center shrink-0"
        style={{ height: PLAYROW_H, paddingLeft: 6, background: 'var(--spine-bg-panel-dark)', borderBottom: '1px solid var(--spine-border)' }}
      >
        {/* 播放按钮区（宽 = 左树宽，标尺起点正好对齐左树右缘） */}
        <div style={{ width: leftW - 6, flex: 'none', display: 'flex', alignItems: 'center', gap: 2 }}>
          <IconBtn title="到首帧" onClick={() => seekTo(0)}>⏮</IconBtn>
          <IconBtn title="上一帧" onClick={() => stepFrame(-1)}>◀</IconBtn>
          <IconBtn title={playing ? '暂停' : '播放'} onClick={togglePlay} active={playing} highlight>{playing ? '⏸' : '▶'}</IconBtn>
          <IconBtn title="下一帧" onClick={() => stepFrame(1)}>⏭</IconBtn>
          <IconBtn title="到末帧" onClick={() => seekTo(duration)}>⏭|</IconBtn>
          <IconBtn title={loop ? '循环（开）' : '循环（关）'} onClick={() => setLoop(!loop)} active={loop}>⟳</IconBtn>
          {/* 自动关键帧（红点 = 开） */}
          <IconBtn
            title={keyframeLock ? '自动关键帧已开启（点击关闭）' : '自动关键帧已关闭（点击开启）'}
            onClick={toggleKeyframeLock}
            active={keyframeLock}
            color={keyframeLock ? '#E61E1E' : undefined}
          >{keyframeLock ? ICON.autoKeyOn : ICON.autoKeyOff}</IconBtn>
        </div>
        {/* 标尺区：固定可视宽（不随轨道横滚）+ 菱形关键帧标记 */}
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <Ruler
            totalFrames={totalFrames}
            pxPerFrame={pxPerFrame}
            width={rulerW}
            innerRef={rulerRef}
            onPointerDown={rulerPointerDownCb}
          />
          <KeyMarkers
            keyTimes={keyTimes}
            fps={fps}
            pxPerFrame={pxPerFrame}
            width={rulerW}
          />
        </div>
      </div>

      {/* ============ 主体：左树 + 右轨道（横滚） ============ */}
      <div ref={scrollerRef} className="flex-1 overflow-auto" style={{ position: 'relative' }}>
        <div style={{ width: leftW + timelineW, minHeight: '100%', position: 'relative' }}>
          {/* 左：轨道树（缩进，sticky；Graph Filter 过滤掉骨骼时显示提示） */}
          <div
            style={{
              position: 'sticky', left: 0, zIndex: 4, width: leftW, float: 'left',
              background: 'var(--spine-bg-panel-dark)', borderRight: '1px solid var(--spine-border)',
            }}
          >
            {filterFlags.bone ? (
              <TreeRows
                rows={rows}
                collapsed={collapsed}
                onToggle={toggleCollapsed}
                onSelectBone={selectBoneCb}
              />
            ) : (
              <div style={{ padding: '10px 8px', fontSize: 11, color: 'var(--spine-text-dim)' }}>骨骼已过滤（Graph Filter）</div>
            )}
          </div>

          {/* 右：时间轴轨道（统一行序列，DopeSheet / Graph 共用） */}
          <div style={{ marginLeft: leftW, position: 'relative' }}>
            <TrackRows
              rows={visibleRows}
              viewMode={viewMode}
              duration={duration}
              fps={fps}
              pxPerFrame={pxPerFrame}
              dragKey={dragKey}
              dragTime={dragTime}
              selectedKey={selectedKey}
              onDragStart={dragStartCb}
              onDragMove={dragMoveCb}
              onDragEnd={dragEndCb}
              onClickRow={clickRowCb}
              onSelectBone={selectBoneCb}
              onRemoveKey={removeKeyCb}
              onSelectKey={setSelectedKey}
              onMoveKey={moveKeyframe}
              onSetValue={setKeyframe}
            />
          </div>
        </div>
      </div>

      {/* 播放头（Spine 风：青色竖线 + 顶三角；固定层覆盖轨道区，不随横滚） */}
      <div
        style={{
          position: 'absolute', top: TITLE_H + TOOLBAR_H + PLAYROW_H, bottom: STATUS_H,
          left: leftW + currentTime * fps * pxPerFrame, width: 1,
          background: 'var(--spine-accent)', pointerEvents: 'none', zIndex: 5,
          boxShadow: '0 0 4px rgba(79,184,248,0.5)',
        }}
      />
      <div
        style={{
          position: 'absolute', top: TITLE_H + TOOLBAR_H + PLAYROW_H,
          left: leftW + currentTime * fps * pxPerFrame - 7, width: 14, height: 12,
          background: 'var(--spine-accent)', clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
          pointerEvents: 'none', zIndex: 6,
        }}
      />

      {/* ============ 底部状态栏（STATUS_H）：缩放滑块 + 8 属性快捷 + 帧率 ============ */}
      <div
        className="flex items-center gap-1 px-1.5 shrink-0"
        style={{ height: STATUS_H, background: 'var(--spine-bg-panel-dark)', borderTop: '1px solid var(--spine-border)' }}
      >
        {/* 缩放滑块（Spine 风位置：左下角，水平拖动调节 px/帧） */}
        <span style={{ color: 'var(--spine-text-dim)', fontSize: 10, marginRight: 2 }}>－</span>
        <input
          type="range"
          min={MIN_PX_PER_FRAME}
          max={MAX_PX_PER_FRAME}
          step={0.5}
          value={pxPerFrame}
          onChange={(e) => setPxPerFrame(Number(e.target.value))}
          style={{ width: 140, accentColor: 'var(--spine-accent)' }}
          title={`缩放时间轴（${pxPerFrame.toFixed(1)} px/帧）`}
        />
        <span style={{ color: 'var(--spine-text-dim)', fontSize: 10, marginLeft: 2 }}>＋</span>
        <IconBtn title="全部展开（按容器宽度自动算 px/帧）" onClick={fitTimeline}>⊕</IconBtn>
        <IconBtn title="全部收起（每帧 1 px）" onClick={() => setPxPerFrame(MIN_PX_PER_FRAME)}>⊖</IconBtn>
        <Sep />

        {/* 8 个属性快捷按钮（Spine 风格：点击 = 给所有选中骨写该属性关键帧） */}
        {ANIM_PROPERTIES.map((p) => (
          <IconBtn
            key={p}
            title={`${PROP_SHORT[p]}（点击给所有选中骨写 ${PROP_SHORT[p]} 关键帧）`}
            color={PROP_COLOR[p]}
            onClick={() => {
              const st = usePixiBonesStore.getState();
              const t = st.currentTime;
              const ids = st.selectedBoneIds.length > 0 ? st.selectedBoneIds : (st.selectedBoneId ? [st.selectedBoneId] : []);
              for (const id of ids) {
                const b = st.bones.find((x) => x.id === id);
                if (!b) continue;
                setKeyframe(id, p, t, b[p]);
              }
            }}
          >{PROP_SHORT[p]}</IconBtn>
        ))}
        <Sep />

        {/* 右侧：帧率显示 */}
        <div className="ml-auto flex items-center gap-2" style={{ color: 'var(--spine-text-dim)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
          <span>帧率</span>
          <input
            type="number"
            min={1} max={120} step={1}
            value={fps}
            onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) usePixiBonesStore.getState().setFps(v); }}
            style={{
              width: 40, height: 18, background: '#3a3a3a', color: 'var(--spine-text)',
              border: '1px solid var(--spine-border)', borderRadius: 3, fontSize: 10,
              outline: 'none', textAlign: 'center',
            }}
            title="帧率（fps）"
          />
        </div>
      </div>
    </div>
  );
}

// =============== 树形轨道模型构建 ===============
function buildBoneTree(
  bones: BoneNode[],
  anim: ReturnType<typeof usePixiBonesStore.getState>['animations'][number] | null,
  constraints: ReturnType<typeof usePixiBonesStore.getState>['constraints'],
  pathConstraints: ReturnType<typeof usePixiBonesStore.getState>['pathConstraints'],
  _runtimeMix: Record<string, number>,
): BoneNodeT[] {
  if (!anim) return [];
  // 该动画的所有关键帧按 (boneId, prop) 索引
  const byKey = new Map<string, PropKey[]>();
  const keyOf = (boneId: string, prop: AnimProperty) => `${boneId}|${prop}`;
  for (const tr of anim.tracks) {
    if (tr.keys.length === 0) continue;
    const arr = byKey.get(keyOf(tr.boneId, tr.property)) ?? [];
    for (const k of tr.keys) {
      arr.push({
        property: tr.property,
        time: k.time,
        value: k.value,
        isConstraint: !!tr.constraintMix,
        isPc: isPathConstraintAnimProperty(tr.property),
      });
    }
    byKey.set(keyOf(tr.boneId, tr.property), arr);
  }
  // 骨骼树
  const childrenMap = new Map<string | null, BoneNode[]>();
  for (const b of bones) {
    const arr = childrenMap.get(b.parentId) ?? [];
    arr.push(b);
    childrenMap.set(b.parentId, arr);
  }
  // 约束条目（也作为顶级条目渲染）
  const build = (parentId: string | null): BoneNodeT[] => {
    const arr = childrenMap.get(parentId) ?? [];
    return arr.map((b) => {
      const props: PropKey[] = [];
      // 仅显示"有轨道"的属性
      for (const p of ANIM_PROPERTIES) {
        const ks = byKey.get(keyOf(b.id, p));
        if (ks && ks.length > 0) {
          for (const k of ks) props.push(k);
        }
      }
      // constraintMix 轨道里"约束"也算一条骨级轨道
      const cs = constraints.filter((c) => c.boneId === b.id || c.childBoneId === b.id);
      for (const c of cs) {
        const ks = byKey.get(keyOf(c.id, 'mix'));
        if (ks && ks.length > 0) {
          for (const k of ks) props.push({ property: 'mix', time: k.time, value: k.value, isConstraint: true });
        }
      }
      return {
        bone: b,
        props,
        children: build(b.id),
        collapsed: false,  // 由外部 useState 覆盖
        inherited: true,
      };
    });
  };
  // 路径约束作为「顶层虚拟行」追加（对齐 Spine：路径约束在树里单独一行，
  // 其下 5 个可动画属性轨道；id 用约束 id 便于行点击 / 拖动分发）。
  const pcNodes: BoneNodeT[] = pathConstraints.map((c) => {
    const props: PropKey[] = [];
    for (const prop of PC_ANIM_PROPS) {
      const ks = byKey.get(keyOf(c.id, PC_PROP_ANIM[prop]));
      if (ks && ks.length > 0) {
        for (const k of ks) props.push({ ...k, isPc: true });
      }
    }
    const synth: BoneNode = {
      id: c.id,
      name: c.name,
      parentId: null,
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 0, slotId: null,
    };
    return { bone: synth, props, children: [], collapsed: false, inherited: false };
  });
  return [...build(null), ...pcNodes];
}

/** 标尺标签密度：根据 pxPerFrame 算"每多少帧一个数字标签"，
 *  让标签间距 ≈ TARGET_PX（理想 ~40px，看起来既不挤也不散）。
 *  返回的数字是步长（1, 2, 5, 10, 20, 50, 100...）按 1-2-5 序列增长。 */
const RULER_TARGET_PX = 40;
function rulerStep(pxPerFrame: number): number {
  const raw = Math.max(1, Math.round(RULER_TARGET_PX / pxPerFrame));
  // 1-2-5 序列：raw 向上取整到 {1, 2, 5, 10, 20, 50, 100, 200, ...}
  const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (const c of candidates) {
    if (c >= raw) return c;
  }
  return candidates[candidates.length - 1];
}

/** 标尺（时间刻度条）：memo 化。固定可视宽度（不随轨道横滚，对齐 Spine/Figma 第二行布局），
 *  只渲染可视范围内的帧格子。播放头（父组件里的青色线）单独渲染。 */
const Ruler = memo(function Ruler({
  totalFrames, pxPerFrame, width, innerRef, onPointerDown,
}: {
  totalFrames: number;
  pxPerFrame: number;
  width: number;
  innerRef: React.RefObject<HTMLDivElement>;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const visibleFrames = Math.min(totalFrames, Math.max(0, Math.ceil(width / pxPerFrame)));
  return (
    <div
      ref={innerRef}
      onPointerDown={onPointerDown}
      style={{
        position: 'relative', height: RULER_H, width, flex: 'none',
        overflow: 'hidden',
        background: 'var(--spine-bg-panel-dark)', borderBottom: '1px solid var(--spine-border)',
        fontSize: 10, color: 'var(--spine-text-dim)', userSelect: 'none',
        display: 'flex',
      }}
    >
      {Array.from({ length: visibleFrames + 1 }, (_, f) => {
        const isLabel = f % rulerStep(pxPerFrame) === 0;
        return (
          <div
            key={f}
            style={{
              width: pxPerFrame, flex: 'none',
              // 标签帧画竖线 + 顶部加粗；非标签帧完全不画（避免密集竖线挤一起）
              borderRight: isLabel ? '1px solid var(--spine-text-dim)' : 'none',
              position: 'relative', boxSizing: 'border-box',
            }}
          >
            {isLabel && (
              <span style={{ position: 'absolute', top: 1, left: 2, lineHeight: '18px' }}>{f}</span>
            )}
          </div>
        );
      })}
    </div>
  );
});

/** 菱形关键帧标记行：标尺下方，橙色菱形 = 该帧存在关键帧，白竖线向下延伸至轨道区。
 *  固定可视宽度（随标尺固定，不随轨道横滚）；可视范围外的菱形裁剪掉。 */
const KeyMarkers = memo(function KeyMarkers({
  keyTimes, fps, pxPerFrame, width,
}: {
  keyTimes: Set<number>;
  fps: number;
  pxPerFrame: number;
  width: number;
}) {
  const times = Array.from(keyTimes).sort((a, b) => a - b);
  return (
    <div
      style={{
        position: 'relative', height: KEY_MARK_H, width, flex: 'none',
        overflow: 'hidden',
        background: 'var(--spine-bg-panel-dark)',
        borderBottom: '1px solid var(--spine-border)',
        pointerEvents: 'none',
      }}
    >
      {times.map((t) => {
        const x = t * fps * pxPerFrame;
        if (x < -4 || x > width + 4) return null;
        return (
          <div key={t} style={{ position: 'absolute', left: x, top: 0, width: 0, height: '100%' }}>
            {/* 白竖线（向下延伸到轨道区） */}
            <div style={{ position: 'absolute', left: 0, top: 6, bottom: 0, width: 1, background: 'rgba(255,255,255,0.4)' }} />
            {/* 橙色菱形 */}
            <div style={{
              position: 'absolute', left: -3, top: 1, width: 6, height: 6,
              background: 'var(--spine-warning)',
              transform: 'rotate(45deg)',
              border: '1px solid rgba(0,0,0,0.6)',
            }} />
          </div>
        );
      })}
    </div>
  );
});

// =============== 子组件：轨道树（左侧，基于统一行序列） ===============
/** 左侧轨道树：从统一的 rows 渲染（骨行 / 属性行），与右侧 TrackRows 严格对齐。 */
const TreeRows = memo(function TreeRows({
  rows, collapsed, onToggle, onSelectBone,
}: {
  rows: TimelineRow[];
  collapsed: Record<string, boolean>;
  onToggle: (id: string) => void;
  onSelectBone: (id: string) => void;
}) {
  return (
    <>
      {rows.map((r) => {
        if (r.kind === 'bone') {
          const n = r.bone;
          const isCollapsed = collapsed[n.bone.id];
          return (
            <div
              key={n.bone.id}
              onClick={() => onSelectBone(n.bone.id)}
              style={{
                display: 'flex', alignItems: 'center',
                height: r.height, paddingLeft: 8 + r.depth * INDENT, paddingRight: 8,
                fontSize: 11, color: 'var(--spine-text)', cursor: 'pointer',
                borderBottom: '1px solid var(--spine-border)',
                background: 'transparent',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {/* 折叠圆点 */}
              {n.children.length > 0 ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggle(n.bone.id); }}
                  style={{
                    width: 12, height: 12, marginRight: 4, padding: 0,
                    background: 'transparent', border: '1px solid var(--spine-text-dim)',
                    borderRadius: '50%', color: 'var(--spine-text-dim)', fontSize: 9,
                    lineHeight: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  title={isCollapsed ? '展开' : '折叠'}
                >{isCollapsed ? '+' : '−'}</button>
              ) : (
                <span style={{ width: 12, height: 12, marginRight: 4, display: 'inline-block' }} />
              )}
              {/* 骨色方块 */}
              <span style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: 1,
                background: boneColor(bonesFlatIndex(n.bone.id)), marginRight: 6, flex: 'none',
              }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {n.bone.name}
              </span>
              {/* 该骨是否带关键帧（白点=有，空圈=无，Spine 风） */}
              <span
                title={n.props.length > 0 ? '该骨有关键帧' : '该骨无关键帧'}
                style={{
                  width: 8, height: 8, borderRadius: '50%', marginRight: 6, flex: 'none',
                  background: n.props.length > 0 ? '#fff' : 'transparent',
                  border: '1px solid var(--spine-text-dim)',
                }}
              />
              {/* 显示该骨的"继承"标志（Spine 风：圆点） */}
              <span
                title="继承（点击切换，子骨是否跟随该骨）"
                style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: n.inherited ? 'var(--spine-text-dim)' : 'transparent',
                  border: '1px solid var(--spine-text-dim)',
                }}
              />
            </div>
          );
        }
        // 属性行
        return (
          <div
            key={`${r.bone.bone.id}|${r.property}`}
            style={{
              display: 'flex', alignItems: 'center', height: r.height,
              paddingLeft: 8 + r.depth * INDENT + 16, paddingRight: 8,
              fontSize: 10, color: 'var(--spine-text-dim)',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
            }}
          >
            <span style={{ display: 'inline-block', width: 6, height: 6, background: PROP_COLOR[r.property!], marginRight: 4 }} />
            {PROP_SHORT[r.property!]}
          </div>
        );
      })}
    </>
  );
});

// 骨 id → 扁平索引（用于颜色）；用模块级缓存避免每次重新算
let _bonesFlat: string[] = [];
let _bonesFlatVer = 0;
function bonesFlatIndex(id: string): number {
  const ver = (usePixiBonesStore.getState().bones.length);
  if (ver !== _bonesFlatVer) {
    _bonesFlat = usePixiBonesStore.getState().bones.map((b) => b.id);
    _bonesFlatVer = ver;
  }
  const i = _bonesFlat.indexOf(id);
  return i < 0 ? 0 : i;
}

// =============== 子组件：右侧统一行序列（DopeSheet / Graph 共用） ===============
const TrackRows = memo(function TrackRows({
  rows, viewMode, duration, fps, pxPerFrame,
  dragKey, dragTime, selectedKey,
  onDragStart, onDragMove, onDragEnd, onClickRow, onSelectBone, onRemoveKey,
  onSelectKey, onMoveKey, onSetValue,
}: {
  rows: TimelineRow[];
  viewMode: 'dopesheet' | 'graph';
  duration: number;
  fps: number;
  pxPerFrame: number;
  dragKey: { boneId: string; property: AnimProperty; fromTime: number; isConstraint?: boolean } | null;
  dragTime: number;
  selectedKey: SelectedKeyInfo | null;
  onDragStart: (boneId: string, prop: AnimProperty, fromTime: number, isC?: boolean) => void;
  onDragMove: (t: number) => void;
  onDragEnd: (t: number) => void;
  onClickRow: (boneId: string, prop: AnimProperty, isC?: boolean, isPc?: boolean) => void;
  onSelectBone: (id: string) => void;
  onRemoveKey: (boneId: string, prop: AnimProperty, t: number, isC?: boolean) => void;
  onSelectKey: (sel: SelectedKeyInfo) => void;
  onMoveKey: (boneId: string, prop: AnimProperty, fromTime: number, toTime: number) => void;
  onSetValue: (boneId: string, prop: AnimProperty, time: number, value: number) => void;
}) {
  return (
    <>
      {rows.map((r) => {
        if (r.kind === 'bone') {
          // 骨行：无关键帧，仅占位（可点击选中骨）
          return (
            <div
              key={r.bone.bone.id}
              onClick={() => onSelectBone(r.bone.bone.id)}
              style={{ height: r.height, position: 'relative', borderBottom: '1px solid var(--spine-border)', cursor: 'pointer' }}
            />
          );
        }
        const boneId = r.bone.bone.id;
        const property = r.property!;
        if (viewMode === 'dopesheet') {
          return (
            <PropRow
              key={`${boneId}|${property}`}
              boneId={boneId}
              property={property}
              isConstraint={r.isConstraint}
              isPc={r.isPc}
              keys={r.keys!}
              fps={fps}
              duration={duration}
              pxPerFrame={pxPerFrame}
              dragKey={dragKey}
              dragTime={dragTime}
              onDragStart={onDragStart}
              onDragMove={onDragMove}
              onDragEnd={onDragEnd}
              onClickRow={onClickRow}
              onRemoveKey={onRemoveKey}
              selectedKey={selectedKey}
              onSelectKey={onSelectKey}
            />
          );
        }
        return (
          <GraphTrack
            key={`${boneId}|${property}`}
            boneId={boneId}
            property={property}
            isConstraint={r.isConstraint}
            keys={r.keys!}
            fps={fps}
            duration={duration}
            pxPerFrame={pxPerFrame}
            color={PROP_COLOR[property]}
            selectedKey={selectedKey}
            onSelectKey={onSelectKey}
            onMoveKey={onMoveKey}
            onSetValue={onSetValue}
          />
        );
      })}
    </>
  );
});

/** 属性 → 关键帧竖线颜色（Spine 风格：每种属性不同色）。 */
const PropRow = memo(function PropRow({
  boneId, property, isConstraint, isPc, keys, fps, duration, dragKey, dragTime, pxPerFrame,
  onDragStart, onDragMove, onDragEnd, onClickRow, onRemoveKey,
  selectedKey, onSelectKey,
}: {
  boneId: string;
  property: AnimProperty;
  isConstraint?: boolean;
  isPc?: boolean;
  keys: PropKey[];
  fps: number;
  duration: number;
  pxPerFrame: number;
  dragKey: { boneId: string; property: AnimProperty; fromTime: number; isConstraint?: boolean } | null;
  dragTime: number;
  onDragStart: (boneId: string, prop: AnimProperty, fromTime: number, isC?: boolean) => void;
  onDragMove: (t: number) => void;
  onDragEnd: (t: number) => void;
  onClickRow: (boneId: string, prop: AnimProperty, isC?: boolean, isPc?: boolean) => void;
  onRemoveKey: (boneId: string, prop: AnimProperty, t: number, isC?: boolean) => void;
  selectedKey: { boneId: string; property: AnimProperty; time: number; isConstraint?: boolean } | null;
  onSelectKey: (sel: { boneId: string; property: AnimProperty; time: number; isConstraint?: boolean }) => void;
}) {
  return (
    <div
      onPointerDown={() => {
        if (dragKey) return;
        // 不用本地 t：onClickRow 内部用 store 的 currentTime
        onClickRow(boneId, property, isConstraint, isPc);
      }}
      style={{
        position: 'relative', height: PROP_ROW_H,
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        cursor: 'crosshair',
      }}
    >
      {/* 关键帧之间的插值连接线（Spine 风：两关键帧间按属性色画水平细线） */}
      {keys.length > 1 && keys.slice(0, -1).map((k, i) => {
        const next = keys[i + 1];
        const x1 = k.time * fps * pxPerFrame;
        const x2 = next.time * fps * pxPerFrame;
        const midY = PROP_ROW_H / 2;
        return (
          <div
            key={`${k.time}-${next.time}`}
            style={{
              position: 'absolute', left: x1, width: Math.max(0, x2 - x1), top: midY - 1, height: 2,
              background: PROP_COLOR[property], opacity: 0.55, zIndex: 2, pointerEvents: 'none',
            }}
          />
        );
      })}
      {keys.map((k) => {
        const isDragging = dragKey
          && dragKey.boneId === boneId
          && dragKey.property === property
          && Math.abs(dragKey.fromTime - k.time) < 1e-6;
        const isSelected = selectedKey
          && selectedKey.boneId === boneId
          && selectedKey.property === property
          && Math.abs(selectedKey.time - k.time) < 1e-6;
        const showLeft = isDragging ? dragTime * fps * pxPerFrame - KEY_LINE_W / 2 : k.time * fps * pxPerFrame - KEY_LINE_W / 2;
        return (
          <div
            key={k.time}
            title={`${isConstraint ? '约束 mix' : PROP_SHORT[property]} @ ${k.time.toFixed(2)}s = ${k.value.toFixed(2)}`}
            onPointerDown={(e) => {
              e.stopPropagation(); e.preventDefault();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              onSelectKey({ boneId, property, time: k.time, isConstraint });
              onDragStart(boneId, property, k.time, isConstraint);
            }}
            onPointerMove={(e) => {
              if (!dragKey) return;
              const t = Math.max(0, Math.min(duration, (e.clientX - (e.currentTarget.parentElement!.getBoundingClientRect().left)) / pxPerFrame / fps));
              onDragMove(t);
            }}
            onPointerUp={(e) => {
              if (!dragKey) return;
              const t = Math.max(0, Math.min(duration, (e.clientX - (e.currentTarget.parentElement!.getBoundingClientRect().left)) / pxPerFrame / fps));
              onDragEnd(t);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRemoveKey(boneId, property, k.time, isConstraint);
            }}
            style={{
              position: 'absolute', top: 0,
              left: showLeft, width: isSelected ? KEY_LINE_W + 2 : KEY_LINE_W,
              height: '100%',
              background: PROP_COLOR[property],
              cursor: 'grab', userSelect: 'none', zIndex: 4,
              boxShadow: isSelected ? '0 0 0 1px #fff, 0 0 6px rgba(255,255,255,0.6)' : (isDragging ? '0 0 0 1px #fff' : 'none'),
            }}
          />
        );
      })}
    </div>
  );
});

// =============== Graph 视图（曲线） ===============
type SelectedKeyInfo = { boneId: string; property: AnimProperty; time: number; isConstraint?: boolean };

const GraphTrack = memo(function GraphTrack({
  boneId, property, isConstraint, keys, fps, duration, pxPerFrame, color,
  selectedKey, onSelectKey, onMoveKey, onSetValue,
}: {
  boneId: string;
  property: AnimProperty;
  isConstraint?: boolean;
  keys: PropKey[];
  fps: number;
  duration: number;
  pxPerFrame: number;
  color: string;
  selectedKey: SelectedKeyInfo | null;
  onSelectKey: (sel: SelectedKeyInfo) => void;
  onMoveKey: (boneId: string, prop: AnimProperty, fromTime: number, toTime: number) => void;
  onSetValue: (boneId: string, prop: AnimProperty, time: number, value: number) => void;
}) {
  const W = Math.max(duration * fps * pxPerFrame + 20, 40);
  const H = GRAPH_TRACK_H;
  const pad = 6;
  // 值域（含两端 padding）→ 取整到好看刻度（对齐 Spine 右侧数值轴）
  let minV = Math.min(...keys.map((k) => k.value));
  let maxV = Math.max(...keys.map((k) => k.value));
  if (maxV - minV < 1e-6) { maxV += 1; minV -= 1; }
  const range = maxV - minV;
  const yOf = (v: number) => pad + (maxV - v) / range * (H - pad * 2);
  const xOf = (t: number) => t * fps * pxPerFrame;
  const vOf = (clientY: number, top: number) => maxV - (clientY - top - pad) / (H - pad * 2) * range;
  // 右侧数值刻度：niceStep 按 range 取 1-2-5 序列，最多 4 根刻度线
  const niceStep = (() => {
    const raw = range / 4;
    for (const c of [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) if (raw <= c) return c;
    return 1000;
  })();
  const ticks: number[] = [];
  for (let v = Math.ceil(minV / niceStep) * niceStep; v <= maxV; v += niceStep) ticks.push(v);
  // 曲线采样（用 store 的采样函数，linear/stepped/bezier 全部正确）
  const steps = Math.max(2, Math.ceil(duration * fps * 4));
  const setupV = keys[0]?.value ?? 0;
  const path = (() => {
    const pts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * duration;
      const v = sampleTrackValue(keys, t, setupV);
      pts.push(`${(i === 0 ? 'M' : 'L')}${xOf(t).toFixed(1)},${yOf(v).toFixed(1)}`);
    }
    return pts.join(' ');
  })();
  // 拖动关键帧点（同时改时间 + 值）
  const [drag, setDrag] = useState<{ fromTime: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const onPointMove = (e: React.PointerEvent) => {
    if (!drag || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const t = Math.max(0, Math.min(duration, (e.clientX - rect.left) / pxPerFrame / fps));
    const v = vOf(e.clientY, rect.top);
    // 移动时间 + 更新值（都保留关键帧的插值属性）
    if (Math.abs(t - drag.fromTime) > 1e-6) {
      onMoveKey(boneId, property, drag.fromTime, t);
      setDrag({ fromTime: t });
    }
    onSetValue(boneId, property, t, v);
  };
  const SQ = 6;  // 方形关键帧点边长
  return (
    <div style={{ position: 'relative', height: GRAPH_TRACK_H, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      {/* 行背景 + 属性标签 */}
      <span style={{ position: 'absolute', top: 2, left: 4, fontSize: 9, color: 'var(--spine-text-dim)', pointerEvents: 'none' }}>
        <span style={{ display: 'inline-block', width: 6, height: 6, background: color, marginRight: 3 }} />
        {PROP_SHORT[property]}
      </span>
      {/* 中线（值 = 0，超出值域时画在中值）+ 水平网格虚线 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: yOf(Math.max(minV, Math.min(0, maxV))), height: 0, borderTop: '1px dashed rgba(255,255,255,0.08)' }} />
      {ticks.map((v) => (
        <div
          key={v}
          style={{ position: 'absolute', left: 0, right: 0, top: yOf(v), height: 0, borderTop: '1px dashed rgba(255,255,255,0.05)' }}
        />
      ))}
      <svg
        ref={svgRef}
        width={W}
        height={H}
        style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', touchAction: 'none' }}
      >
        {/* 曲线 */}
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} opacity={0.9} />
        {/* 关键帧点（Spine 风：方形控制点） */}
        {keys.map((k) => {
          const isSel = selectedKey
            && selectedKey.boneId === boneId
            && selectedKey.property === property
            && Math.abs(selectedKey.time - k.time) < 1e-6;
          const cx = xOf(k.time);
          const cy = yOf(k.value);
          const s = isSel ? SQ + 2 : SQ;
          return (
            <rect
              key={k.time}
              x={cx - s / 2}
              y={cy - s / 2}
              width={s}
              height={s}
              fill={isSel ? '#fff' : color}
              stroke="#111"
              strokeWidth={1}
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => {
                e.stopPropagation(); e.preventDefault();
                (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                onSelectKey({ boneId, property, time: k.time, isConstraint });
                setDrag({ fromTime: k.time });
              }}
              onPointerMove={onPointMove}
              onPointerUp={() => setDrag(null)}
              onPointerCancel={() => setDrag(null)}
            >
              <title>{`${PROP_SHORT[property]} @ ${k.time.toFixed(2)}s = ${k.value.toFixed(2)}`}</title>
            </rect>
          );
        })}
      </svg>
      {/* 右侧 Y 轴数值刻度（Spine 风：右侧垂直数值轴） */}
      <div style={{ position: 'absolute', right: 2, top: 0, bottom: 0, width: 34, pointerEvents: 'none', fontSize: 8, color: 'var(--spine-text-dim)' }}>
        {ticks.map((v) => (
          <div key={v} style={{ position: 'absolute', right: 0, top: yOf(v) - 4, textAlign: 'right', lineHeight: '8px' }}>
            {v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}
          </div>
        ))}
      </div>
    </div>
  );
});

// =============== 通用小部件 ===============
function IconBtn({
  title, onClick, children, disabled, active, color, highlight,
}: {
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
  color?: string;
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 22, height: 22, fontSize: 11,
        background: highlight ? 'var(--spine-accent)' : (active ? 'rgba(255,255,255,0.10)' : 'transparent'),
        color: color ?? (active ? '#fff' : 'var(--spine-text)'),
        border: '1px solid transparent',
        borderRadius: 3,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
    >{children}</button>
  );
}

function Sep() {
  return <span style={{ display: 'inline-block', width: 1, height: 18, background: 'var(--spine-border)', margin: '0 4px' }} />;
}

function selectStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    height: 22, background: '#3a3a3a', color: 'var(--spine-text)',
    border: '1px solid var(--spine-border)', borderRadius: 3, fontSize: 11,
    outline: 'none', padding: '0 4px', ...extra,
  };
}

function DurationInput({ duration, animId, set }: { duration: number; animId: string | undefined; set: (id: string, v: number) => void; }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [duration]);
  const commit = (raw: string) => {
    if (!animId) return;
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v > 0 && v !== duration) set(animId, v);
  };
  return (
    <input
      type="number"
      min={0.1} step={0.1}
      value={draft ?? (duration || 0).toFixed(1)}
      onChange={(e) => {
        setDraft(e.target.value);
        commit(e.target.value);  // ★ 实时提交（拖滑块时同步更新）
      }}
      onBlur={() => {
        if (draft != null) commit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={{
        width: 44, height: 18, background: '#3a3a3a', color: 'var(--spine-text)',
        border: '1px solid var(--spine-border)', borderRadius: 3, fontSize: 10,
        outline: 'none', textAlign: 'center',
      }}
      title="动画时长（秒）"
    />
  );
}

// 防止 setIconBtn 之类的未使用警告
void ICON;
