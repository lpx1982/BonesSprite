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
import { useT } from './i18n';
import { usePixiBonesStore, ANIM_PROPERTIES, type AnimProperty, type BoneNode } from './store';

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 600;
const PX_PER_FRAME = 5;     // 默认缩放值
const MIN_PX_PER_FRAME = 1; // 最细：1 px/帧，能看到几千帧范围
const MAX_PX_PER_FRAME = 20; // 最粗：20 px/帧，确保 30 帧动画能占约 600px（精细编辑）
const RULER_H = 22;
const BONE_ROW_H = 22;
const PROP_ROW_H = 16;
const KEY_LINE_W = 2;
const LEFT_W = 180;
const INDENT = 14;

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
// =============== 子组件：时间轴行（右侧） ===============
const PROP_COLOR: Record<AnimProperty, string> = {
  x: '#E61E1E',
  y: '#2EC75E',
  rotation: '#F0A020',
  scaleX: '#1E78E6',
  scaleY: '#9B59B6',
  mix: '#F0E020',
};

/** 属性 → 行末短标签。 */
const PROP_SHORT: Record<AnimProperty, string> = {
  x: 'X', y: 'Y', rotation: '↻', scaleX: '⇆', scaleY: '⇅', mix: 'mix',
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
  const { t } = useT();
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
  // 「全部展开」：让动画最后帧刚好在容器右边缘
  const fitTimeline = () => {
    const total = totalFrames * pxPerFrame;
    const avail = Math.max(scrollerW - LEFT_W, 200);
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
  const tree = useMemo(
    () => buildBoneTree(bones, anim, constraints, constraintRuntimeMix),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bonesIdsKey, anim, constraints, constraintRuntimeMix],
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
  const clickRowCb = useCallback((boneId: string, prop: AnimProperty, isC?: boolean) => {
    // 点击轨道空白写关键帧（值从 store 实时读，避免闭包依赖 bones 导致回调每帧变化）
    if (dragKey) return;
    const st = usePixiBonesStore.getState();
    const t = st.currentTime;
    if (isC) {
      const def = st.constraints.find((c) => c.id === boneId);
      const cur = st.constraintRuntimeMix[boneId] ?? def?.mix ?? 1;
      st.setConstraintMixKeyframe(boneId, t, cur);
    } else {
      const b = st.bones.find((x) => x.id === boneId);
      if (b) st.setKeyframe(boneId, prop, t, b[prop as Exclude<AnimProperty, 'mix'>]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragKey]);
  const selectBoneCb = useCallback((id: string) => selectBone(id), [selectBone]);
  const removeKeyCb = useCallback((boneId: string, prop: AnimProperty, t: number, isC?: boolean) => {
    if (isC) removeConstraintMixKeyframe(boneId, t);
    else removeKeyframe(boneId, prop, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // =============== 渲染 ===============
  const frameOf = (time: number) => Math.floor(time * fps);
  const showTree = true;  // 未来可作为开关

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

      {/* ============ 顶部工具条（Spine 风格）============ */}
      <div
        className="flex items-center gap-1 px-1.5 shrink-0"
        style={{ height: 30, background: 'var(--spine-bg-panel-dark)', borderBottom: '1px solid var(--spine-border)' }}
      >
        {/* 撤销/重做 */}
        <IconBtn title="撤销 (Cmd+Z)" onClick={undo}>{ICON.undo}</IconBtn>
        <IconBtn title="重做 (Cmd+Shift+Z)" onClick={redo}>{ICON.redo}</IconBtn>
        <Sep />

        {/* 同步：让画布跟随当前动画时间（按住编辑） */}
        <IconBtn
          title="同步：编辑时画布跟随当前时间"
          onClick={() => usePixiBonesStore.getState().seekTo(usePixiBonesStore.getState().currentTime)}
        >{ICON.sync}</IconBtn>

        {/* 自动关键帧（红点 = 开） */}
        <IconBtn
          title={keyframeLock ? '自动关键帧已开启（点击关闭）' : '自动关键帧已关闭（点击开启）'}
          onClick={toggleKeyframeLock}
          active={keyframeLock}
          color={keyframeLock ? '#E61E1E' : undefined}
        >{keyframeLock ? ICON.autoKeyOn : ICON.autoKeyOff}</IconBtn>
        <Sep />

        {/* 8 个属性快捷按钮（Spine 风格：点击 = 给所有选中骨写该属性关键帧） */}
        {ANIM_PROPERTIES.map((p) => (
          <IconBtn
            key={p}
            title={`${PROP_SHORT[p]}（点击给所有选中骨写 ${PROP_SHORT[p]} 关键帧）`}
            color={PROP_COLOR[p]}
            onClick={() => {
              // 给所有选中骨在 currentTime 写一个该属性关键帧（值 = 当前骨值）
              const st = usePixiBonesStore.getState();
              const t = st.currentTime;
              const ids = st.selectedBoneIds.length > 0 ? st.selectedBoneIds : (st.selectedBoneId ? [st.selectedBoneId] : []);
              for (const id of ids) {
                const b = st.bones.find((x) => x.id === id);
                if (!b) continue;
                if (p === 'mix') continue;  // mix 是约束轨道，不走这里
                setKeyframe(id, p, t, b[p]);
              }
            }}
          >{PROP_SHORT[p]}</IconBtn>
        ))}
        <Sep />

        {/* 动画时长（顶栏保留） */}
        <GroupLabel>当前</GroupLabel><SmallInput width={50} placeholder="0" />
        <IconBtn title="循环开始（占位）">{ICON.loopStart}</IconBtn>
        <IconBtn title="循环结束（占位）">{ICON.loopEnd}</IconBtn>
        <Sep />

        {/* 动画管理（增/复制/重命名/删除） */}
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
        <Sep />

        {/* 当前 / 循环开始 / 结束（占位） */}
        <GroupLabel>当前</GroupLabel><SmallInput width={50} placeholder="0" />
        <IconBtn title="循环开始（占位）">{ICON.loopStart}</IconBtn>
        <IconBtn title="循环结束（占位）">{ICON.loopEnd}</IconBtn>

        <Sep />

        {/* 动画时长（顶栏保留） */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--spine-text-dim)' }}>
          时长
          <DurationInput duration={duration} animId={anim?.id} set={setAnimationDuration} />
        </label>

        {/* 右侧：当前帧 + 时间 */}
        <div className="ml-auto flex items-center gap-3" style={{ color: 'var(--spine-text-dim)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
          <span>帧 {frameOf(currentTime)} / {totalFrames - 1}</span>
          <span>{currentTime.toFixed(2)}s / {duration.toFixed(2)}s</span>
        </div>
      </div>

      {/* ============ 主体：左树 + 右时间轴 ============ */}
      <div ref={scrollerRef} className="flex-1 overflow-auto" style={{ position: 'relative' }}>
        <div style={{ width: LEFT_W + timelineW, minHeight: '100%', position: 'relative' }}>
          {/* 左：轨道树（缩进，sticky） */}
          <div
            style={{
              position: 'sticky', left: 0, zIndex: 4, width: LEFT_W, float: 'left',
              background: 'var(--spine-bg-panel-dark)', borderRight: '1px solid var(--spine-border)',
            }}
          >
            {/* 标尺高度占位 */}
            <div style={{ height: RULER_H, borderBottom: '1px solid var(--spine-border)', display: 'flex', alignItems: 'center', paddingLeft: 8, fontSize: 10, color: 'var(--spine-text-dim)' }}>
              {showTree ? t('tab.timeline_anim') : t('tab.timeline_phot')}
            </div>
            {showTree ? (
              <BoneTree
                nodes={tree}
                depth={0}
                collapsed={collapsed}
                onToggle={toggleCollapsed}
                onSelectBone={(id) => selectBone(id)}
              />
            ) : (
              <div style={{ padding: '10px 8px', fontSize: 11, color: 'var(--spine-text-dim)' }}>摄影表：占位</div>
            )}
          </div>

          {/* 右：时间轴（标尺 + 关键帧）—— 用固定宽度的绝对布局，方便每行叠加 */}
          <div style={{ marginLeft: LEFT_W, position: 'relative' }}>
            {/* 标尺 sticky 顶部（memo：播放时 270+ 格子不重建） */}
            <Ruler
              totalFrames={totalFrames}
              pxPerFrame={pxPerFrame}
              innerRef={rulerRef}
              onPointerDown={rulerPointerDownCb}
            />

            {/* 关键帧：每个骨头 + 它的属性各自一行 */}
            {showTree && tree.map((n) => (
              <BoneRow
                key={n.bone.id}
                node={n}
                depth={0}
                duration={duration}
                fps={fps}
                pxPerFrame={pxPerFrame}
                dragKey={dragKey}
                dragTime={dragTime}
                onDragStart={dragStartCb}
                onDragMove={dragMoveCb}
                onDragEnd={dragEndCb}
                onClickRow={clickRowCb}
                onSelectBone={selectBoneCb}
                onRemoveKey={removeKeyCb}
              />
            ))}

            {/* 播放头（醒目绿线 + 顶三角） */}
            <div
              style={{
                position: 'absolute', top: 0, bottom: 0,
                left: currentTime * fps * pxPerFrame, width: 1,
                background: '#5BFF5B', pointerEvents: 'none', zIndex: 5,
                boxShadow: '0 0 4px rgba(91,255,91,0.5)',
              }}
            />
            <div
              style={{
                position: 'absolute', top: 0,
                left: currentTime * fps * pxPerFrame - 7, width: 14, height: 12,
                background: '#5BFF5B', clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
                pointerEvents: 'none', zIndex: 6,
              }}
            />
          </div>
        </div>
      </div>

      {/* ============ 底部工具条（Spine 风格）：播放控制 + 缩放滑块 ============ */}
      <div
        className="flex items-center gap-1 px-1.5 shrink-0"
        style={{ height: 26, background: 'var(--spine-bg-panel-dark)', borderTop: '1px solid var(--spine-border)' }}
      >
        {/* 播放控制（Spine 风位置：左下角） */}
        <IconBtn title="到首帧" onClick={() => seekTo(0)}>⏮</IconBtn>
        <IconBtn title="上一帧" onClick={() => stepFrame(-1)}>◀</IconBtn>
        <IconBtn title={playing ? '暂停' : '播放'} onClick={togglePlay} active={playing} highlight>{playing ? '⏸' : '▶'}</IconBtn>
        <IconBtn title="下一帧" onClick={() => stepFrame(1)}>⏭</IconBtn>
        <IconBtn title="到末帧" onClick={() => seekTo(duration)}>⏭|</IconBtn>
        <IconBtn title={loop ? '循环（开）' : '循环（关）'} onClick={() => setLoop(!loop)} active={loop}>⟳</IconBtn>
        <Sep />

        {/* 缩放滑块（Spine 风位置：左下角，水平拖动调节 px/帧） */}
        <span style={{ color: 'var(--spine-text-dim)', fontSize: 10, marginRight: 2 }}>－</span>
        <input
          type="range"
          min={MIN_PX_PER_FRAME}
          max={MAX_PX_PER_FRAME}
          step={0.5}
          value={pxPerFrame}
          onChange={(e) => setPxPerFrame(Number(e.target.value))}
          style={{ width: 180, accentColor: 'var(--spine-accent)' }}
          title={`缩放时间轴（${pxPerFrame.toFixed(1)} px/帧）`}
        />
        <span style={{ color: 'var(--spine-text-dim)', fontSize: 10, marginLeft: 2 }}>＋</span>
        <IconBtn title="全部展开（按容器宽度自动算 px/帧）" onClick={fitTimeline}>⊕</IconBtn>
        <IconBtn title="全部收起（每帧 1 px）" onClick={() => setPxPerFrame(MIN_PX_PER_FRAME)}>⊖</IconBtn>
      </div>
    </div>
  );
}

// =============== 树形轨道模型构建 ===============
function buildBoneTree(
  bones: BoneNode[],
  anim: ReturnType<typeof usePixiBonesStore.getState>['animations'][number] | null,
  constraints: ReturnType<typeof usePixiBonesStore.getState>['constraints'],
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
      arr.push({ property: tr.property, time: k.time, value: k.value, isConstraint: !!tr.constraintMix });
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
  return build(null);
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

/** 标尺（时间刻度条）：memo 化。只依赖 totalFrames / pxPerFrame（播放时不变），
 *  播放头（父组件里的绿线）单独渲染，因此播放时标尺的 270+ 个格子完全不会重建。 */
const Ruler = memo(function Ruler({
  totalFrames, pxPerFrame, innerRef, onPointerDown,
}: {
  totalFrames: number;
  pxPerFrame: number;
  innerRef: React.RefObject<HTMLDivElement>;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      ref={innerRef}
      onPointerDown={onPointerDown}
      style={{
        position: 'sticky', top: 0, zIndex: 3, height: RULER_H,
        background: 'var(--spine-bg-panel-dark)', borderBottom: '1px solid var(--spine-border)',
        fontSize: 10, color: 'var(--spine-text-dim)', userSelect: 'none',
        display: 'flex',
      }}
    >
      {Array.from({ length: totalFrames + 1 }, (_, f) => {
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

// =============== 子组件：轨道树（左侧） ===============
const BoneTree = memo(function BoneTree({
  nodes, depth, collapsed, onToggle, onSelectBone,
}: {
  nodes: BoneNodeT[];
  depth: number;
  collapsed: Record<string, boolean>;
  onToggle: (id: string) => void;
  onSelectBone: (id: string) => void;
}) {
  return (
    <>
      {nodes.map((n) => {
        const isCollapsed = collapsed[n.bone.id];
        return (
          <div key={n.bone.id}>
            <div
              onClick={() => onSelectBone(n.bone.id)}
              style={{
                display: 'flex', alignItems: 'center',
                height: BONE_ROW_H, paddingLeft: 8 + depth * INDENT, paddingRight: 8,
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
            {/* 子骨（折叠时隐藏） */}
            {!isCollapsed && n.children.map((c) => (
              <BoneTree
                key={c.bone.id}
                nodes={[c]}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                onSelectBone={onSelectBone}
              />
            ))}
            {/* 该骨自身的属性行：缩进一格 */}
            {!isCollapsed && n.props.length > 0 && (
              <BonePropLabels props={n.props} depth={depth + 1} />
            )}
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

function BonePropLabels({ props, depth }: { props: PropKey[]; depth: number }) {
  // 按属性聚合（去重）
  const propsUnique: AnimProperty[] = [];
  for (const p of props) {
    const ap: AnimProperty = p.property;
    if (!propsUnique.includes(ap)) propsUnique.push(ap);
  }
  return (
    <>
      {propsUnique.map((p) => (
        <div
          key={p}
          style={{
            display: 'flex', alignItems: 'center', height: PROP_ROW_H,
            paddingLeft: 8 + depth * INDENT + 16, paddingRight: 8,
            fontSize: 10, color: 'var(--spine-text-dim)',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
          }}
        >
          <span style={{ display: 'inline-block', width: 6, height: 6, background: PROP_COLOR[p], marginRight: 4 }} />
          {PROP_SHORT[p]}
        </div>
      ))}
    </>
  );
}

/** 属性 → 关键帧竖线颜色（Spine 风格：每种属性不同色）。 */
const BoneRow = memo(function BoneRow({
  node, depth, duration, fps, dragKey, dragTime, pxPerFrame,
  onDragStart, onDragMove, onDragEnd, onClickRow, onSelectBone, onRemoveKey,
}: {
  node: BoneNodeT;
  depth: number;
  duration: number;
  fps: number;
  pxPerFrame: number;
  dragKey: { boneId: string; property: AnimProperty; fromTime: number; isConstraint?: boolean } | null;
  dragTime: number;
  onDragStart: (boneId: string, prop: AnimProperty, fromTime: number, isC?: boolean) => void;
  onDragMove: (t: number) => void;
  onDragEnd: (t: number) => void;
  onClickRow: (boneId: string, prop: AnimProperty, isC?: boolean) => void;
  onSelectBone: (id: string) => void;
  onRemoveKey: (boneId: string, prop: AnimProperty, t: number, isC?: boolean) => void;
}) {
  // 收集每条属性的关键帧（按属性分组）
  const byProp = new Map<AnimProperty, PropKey[]>();
  for (const k of node.props) {
    const arr = byProp.get(k.property) ?? [];
    arr.push(k);
    byProp.set(k.property, arr);
  }
  // 关键帧竖线渲染：每个 (property, time) 一个竖线
  const isCollapsed = false;  // 折叠态由 useState 控制
  return (
    <>
      {/* 骨行（无关键帧，仅占位 → 仍可点击选中骨） */}
      <div
        onClick={() => onSelectBone(node.bone.id)}
        style={{ height: BONE_ROW_H, position: 'relative', borderBottom: '1px solid var(--spine-border)', cursor: 'pointer' }}
      />
      {/* 属性行：每行 = 一种属性的关键帧轨道 */}
      {Array.from(byProp.entries()).map(([p, ks]) => (
        <PropRow
          key={p}
          boneId={node.bone.id}
          property={p}
          isConstraint={ks[0]?.isConstraint}
          keys={ks}
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
        />
      ))}
      {/* 子骨行递归 */}
      {!isCollapsed && node.children.map((c) => (
        <BoneRow
          key={c.bone.id}
          node={c}
          depth={depth + 1}
          duration={duration}
          fps={fps}
          pxPerFrame={pxPerFrame}
          dragKey={dragKey}
          dragTime={dragTime}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onClickRow={onClickRow}
          onSelectBone={onSelectBone}
          onRemoveKey={onRemoveKey}
        />
      ))}
    </>
  );
});

const PropRow = memo(function PropRow({
  boneId, property, isConstraint, keys, fps, duration, dragKey, dragTime, pxPerFrame,
  onDragStart, onDragMove, onDragEnd, onClickRow, onRemoveKey,
}: {
  boneId: string;
  property: AnimProperty;
  isConstraint?: boolean;
  keys: PropKey[];
  fps: number;
  duration: number;
  pxPerFrame: number;
  dragKey: { boneId: string; property: AnimProperty; fromTime: number; isConstraint?: boolean } | null;
  dragTime: number;
  onDragStart: (boneId: string, prop: AnimProperty, fromTime: number, isC?: boolean) => void;
  onDragMove: (t: number) => void;
  onDragEnd: (t: number) => void;
  onClickRow: (boneId: string, prop: AnimProperty, isC?: boolean) => void;
  onRemoveKey: (boneId: string, prop: AnimProperty, t: number, isC?: boolean) => void;
}) {
  return (
    <div
      onPointerDown={() => {
        if (dragKey) return;
        // 不用本地 t：onClickRow 内部用 store 的 currentTime
        onClickRow(boneId, property, isConstraint);
      }}
      style={{
        position: 'relative', height: PROP_ROW_H,
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        cursor: 'crosshair',
      }}
    >
      {keys.map((k) => {
        const isDragging = dragKey
          && dragKey.boneId === boneId
          && dragKey.property === property
          && Math.abs(dragKey.fromTime - k.time) < 1e-6;
        const showLeft = isDragging ? dragTime * fps * pxPerFrame - KEY_LINE_W / 2 : k.time * fps * pxPerFrame - KEY_LINE_W / 2;
        return (
          <div
            key={k.time}
            title={`${isConstraint ? '约束 mix' : PROP_SHORT[property]} @ ${k.time.toFixed(2)}s = ${k.value.toFixed(2)}`}
            onPointerDown={(e) => {
              e.stopPropagation(); e.preventDefault();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
              left: showLeft, width: KEY_LINE_W,
              height: '100%',
              background: PROP_COLOR[property],
              cursor: 'grab', userSelect: 'none', zIndex: 4,
              boxShadow: isDragging ? '0 0 0 1px #fff' : 'none',
            }}
          />
        );
      })}
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

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--spine-text-dim)', fontSize: 10 }}>{children}</span>;
}

function SmallInput({ width = 40, placeholder }: { width?: number; placeholder?: string }) {
  return (
    <input
      type="text"
      placeholder={placeholder}
      style={{
        width, height: 18, padding: '0 4px',
        background: '#3a3a3a', color: 'var(--spine-text)',
        border: '1px solid var(--spine-border)', borderRadius: 3, fontSize: 10,
        outline: 'none', textAlign: 'center',
      }}
    />
  );
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
