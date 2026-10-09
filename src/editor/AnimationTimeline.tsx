import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from './i18n';
import { usePixiBonesStore, ANIM_PROPERTIES, type AnimProperty, type AnimTrack } from './store';

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 600;
/** 每帧占的像素宽度（时间轴横向比例）。 */
const PX_PER_FRAME = 4;
const ROW_H = 24;
const RULER_H = 20;
const LEFT_W = 170;

/** 属性 → 短标签（时间轴轨道行显示）。 */
const PROP_LABEL: Record<AnimProperty, string> = {
  x: 'X',
  y: 'Y',
  rotation: '旋转',
  scaleX: '缩放X',
  scaleY: '缩放Y',
};

/** 骨骼颜色（与画布 / 权重面板一致）。 */
const BONE_PALETTE = [
  '#E61E1E', '#1E78E6', '#2EC75E', '#F0A020', '#9B59B6', '#16A085',
  '#E67E22', '#3498DB', '#E84393', '#27AE60', '#8E44AD', '#D35400',
];
function boneColor(index: number): string {
  return BONE_PALETTE[index % BONE_PALETTE.length];
}

/**
 * 动画时间轴（Spine 风格）—— 已接入真实动画数据。
 *
 * - 顶部工具条：播放控制（首帧/上一帧/播放/下一帧/末帧/循环）+ 动画管理（新增/复制/重命名/删除/时长）
 * - 左侧：轨道列表（每根骨骼 × 每个有关键帧的属性一行）
 * - 右侧：帧标尺 + 关键帧菱形 + 播放头
 *   - 点击标尺 / 拖动 → seek
 *   - 点击轨道空白 → 在 currentTime 处给该轨道写关键帧（值 = 当前骨骼值）
 *   - 拖动菱形 → 移动关键帧；双击菱形 → 删除
 * - 播放：rAF 推进 currentTime，动画 tab 下采样应用到骨骼（由 store.applyActiveAnimation 驱动）
 */
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

  const anim = animations.find((a) => a.id === activeAnimationId) ?? animations[0] ?? null;
  const duration = anim?.duration ?? 0;
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const timelineW = totalFrames * PX_PER_FRAME + 60; // 末尾留一点空白方便点选

  // ---- 播放循环：rAF 推进 currentTime（动画 tab 且正在播放；拖动任何东西时暂停推进）----
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
      if (st.loop) {
        tt = tt % dur;
      } else {
        tt = Math.min(tt, dur);
        if (tt >= dur) st.setPlaying(false);
      }
      st.seekTo(tt);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  // ---- 轨道（只显示有关键帧的轨道；按骨骼顺序 + 属性顺序排序）----
  const tracks = useMemo(() => {
    if (!anim) return [] as AnimTrack[];
    const boneIdx = new Map(bones.map((b, i) => [b.id, i]));
    return anim.tracks
      .filter((tr) => tr.keys.length > 0)
      .sort((a, b) => {
        const ai = boneIdx.get(a.boneId) ?? 9999;
        const bi = boneIdx.get(b.boneId) ?? 9999;
        if (ai !== bi) return ai - bi;
        return ANIM_PROPERTIES.indexOf(a.property) - ANIM_PROPERTIES.indexOf(b.property);
      });
  }, [anim, bones]);

  const boneName = (id: string): string => bones.find((b) => b.id === id)?.name ?? id;
  const boneIndex = (id: string): number => bones.findIndex((b) => b.id === id);
  const boneColorOf = (id: string): string => boneColor(boneIndex(id));

  // ---- 拖动调整高度（复用原逻辑）----
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = d.startY - e.clientY;
      const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, d.startH + delta));
      setHeight(next);
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setHeight]);
  const onHandleDown = (e: React.MouseEvent) => {
    dragRef.current = { startY: e.clientY, startH: height };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  // ---- 标尺 seek：按下 / 拖动 -> seekTo ----
  const rulerRef = useRef<HTMLDivElement>(null);
  const seekFromClientX = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clientX - rect.left;
    const t = Math.max(0, Math.min(duration, x / PX_PER_FRAME / fps));
    seekTo(t);
  };
  const seekRef = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (seekRef.current) seekFromClientX(e.clientX); };
    const onUp = () => { seekRef.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  });

  // ---- 关键帧拖动（本地预览，松开时 moveKeyframe 一次入历史）----
  const [dragKey, setDragKey] = useState<{ boneId: string; property: AnimProperty; fromTime: number } | null>(null);
  const [dragTime, setDragTime] = useState(0);

  // 时长输入（本地草稿，Enter / 失焦提交）
  const [durDraft, setDurDraft] = useState<string | null>(null);
  useEffect(() => { setDurDraft(null); }, [duration]);

  const frameOf = (time: number) => Math.floor(time * fps);

  return (
    <div
      className="absolute left-0 right-0 bottom-0 z-20 flex flex-col"
      style={{
        height,
        background: 'var(--spine-bg-toolbar)',
        borderTop: '1px solid var(--spine-border)',
      }}
    >
      {/* 顶部 resize handle */}
      <div
        onMouseDown={onHandleDown}
        className="timeline-resize-handle"
        style={{
          position: 'absolute', top: -2, left: 0, right: 0, height: 4,
          cursor: 'ns-resize', zIndex: 1,
        }}
        title="拖动调整高度"
      />

      {/* 顶部工具条 */}
      <div
        className="flex items-center gap-1 px-2 shrink-0"
        style={{
          height: 32,
          background: 'var(--spine-bg-panel-dark)',
          borderBottom: '1px solid var(--spine-border)',
        }}
      >
        <span style={{ color: 'var(--spine-text)', fontSize: 11 }}>📊</span>
        <button className="spine-btn" title={t('tab.timeline_anim')}>{t('tab.timeline_anim')}</button>

        {/* 播放控制 */}
        <PlayBtn title="到首帧" onClick={() => seekTo(0)}>⏮</PlayBtn>
        <PlayBtn title="上一帧" onClick={() => stepFrame(-1)}>◀</PlayBtn>
        <PlayBtn title={playing ? '暂停' : '播放'} onClick={togglePlay} highlight={playing}>
          {playing ? '⏸' : '▶'}
        </PlayBtn>
        <PlayBtn title="下一帧" onClick={() => stepFrame(1)}>⏭</PlayBtn>
        <PlayBtn title="到末帧" onClick={() => seekTo(duration)}>⏭|</PlayBtn>
        <PlayBtn
          title={loop ? '循环播放（开）' : '循环播放（关）'}
          onClick={() => setLoop(!loop)}
          highlight={loop}
        >⟳</PlayBtn>

        <div className="w-px h-5 mx-1" style={{ background: 'var(--spine-border)' }} />

        {/* 动画管理 */}
        <select
          value={anim?.id ?? ''}
          onChange={(e) => {
            const id = e.target.value;
            setActiveAnimation(id);
            seekTo(usePixiBonesStore.getState().currentTime);
          }}
          style={{
            height: 22, background: '#3a3a3a', color: 'var(--spine-text)',
            border: '1px solid var(--spine-border)', borderRadius: 3, fontSize: 11,
            outline: 'none', maxWidth: 160,
          }}
          title="切换当前编辑 / 播放的动画"
        >
          {animations.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <ToolBtn title="新增动画" onClick={() => addAnimation()}>＋</ToolBtn>
        <ToolBtn title="复制当前动画" onClick={() => anim && duplicateAnimation(anim.id)} disabled={!anim}>⧉</ToolBtn>
        <ToolBtn
          title="重命名当前动画"
          onClick={() => {
            if (!anim) return;
            const name = window.prompt('动画名称', anim.name);
            if (name != null) renameAnimation(anim.id, name);
          }}
          disabled={!anim}
        >✎</ToolBtn>
        <ToolBtn
          title="删除当前动画（至少保留一个）"
          onClick={() => anim && removeAnimation(anim.id)}
          disabled={!anim || animations.length <= 1}
        >🗑</ToolBtn>

        {/* 时长 */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--spine-text-dim)' }}>
          时长
          <input
            type="number"
            min={0.1} step={0.1}
            value={durDraft ?? (duration || 0).toFixed(1)}
            onChange={(e) => setDurDraft(e.target.value)}
            onBlur={() => {
              if (durDraft != null && anim) {
                const v = parseFloat(durDraft);
                if (Number.isFinite(v) && v > 0) setAnimationDuration(anim.id, v);
                setDurDraft(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            style={{
              width: 44, height: 20, background: '#3a3a3a', color: 'var(--spine-text)',
              border: '1px solid var(--spine-border)', borderRadius: 3, fontSize: 11,
              outline: 'none', textAlign: 'center',
            }}
            title="动画时长（秒）"
          />
        </label>

        {/* 右侧：当前时间 + 帧 */}
        <div className="ml-auto flex items-center gap-2" style={{ color: 'var(--spine-text-dim)', fontSize: 11 }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            帧 {frameOf(currentTime)} / {totalFrames - 1}
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
          </span>
        </div>
      </div>

      {/* 主体：左侧轨道 + 右侧时间轴（同一滚动容器，左标签 sticky 保横滚可见） */}
      <div className="flex-1 overflow-auto" style={{ position: 'relative' }}>
        <div style={{ width: LEFT_W + timelineW }}>
          <div className="flex">
            {/* 左侧轨道列表（横滚时 sticky 固定） */}
            <div
              style={{
                width: LEFT_W, flex: 'none', position: 'sticky', left: 0, zIndex: 3,
                background: 'var(--spine-bg-panel-dark)', borderRight: '1px solid var(--spine-border)',
              }}
            >
              <div style={{ height: RULER_H, borderBottom: '1px solid var(--spine-border)' }} />
              {tracks.length === 0 && (
                <div
                  style={{
                    padding: '10px 8px', fontSize: 11, color: 'var(--spine-text-dim)', lineHeight: 1.6,
                  }}
                >
                  空动画。
                  <br />在动画 tab 下用变换工具拖骨骼，或点击右侧轨道行添加关键帧。
                </div>
              )}
              {tracks.map((tr) => (
                <div
                  key={`${tr.boneId}:${tr.property}`}
                  className="flex items-center px-2"
                  style={{ height: ROW_H, fontSize: 11, color: 'var(--spine-text)', borderBottom: '1px solid var(--spine-border)' }}
                >
                  <span style={{ display: 'inline-block', width: 6, height: 6, background: boneColorOf(tr.boneId), borderRadius: 1, marginRight: 6, flex: 'none' }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {boneName(tr.boneId)}
                  </span>
                  <span style={{ color: 'var(--spine-text-dim)', flex: 'none' }}>{PROP_LABEL[tr.property]}</span>
                </div>
              ))}
            </div>

            {/* 右侧时间轴（标尺 sticky 顶部，内容随横滚） */}
            <div style={{ flex: 'none', width: timelineW, position: 'relative' }}>
              {/* 帧标尺 */}
              <div
                ref={rulerRef}
                onPointerDown={(e) => {
                  seekRef.current = true;
                  seekFromClientX(e.clientX);
                }}
                style={{
                  position: 'sticky', top: 0, zIndex: 2, height: RULER_H, cursor: 'pointer',
                  background: 'var(--spine-bg-panel-dark)', borderBottom: '1px solid var(--spine-border)',
                  fontSize: 10, color: 'var(--spine-text-dim)', userSelect: 'none',
                  display: 'flex',
                }}
              >
                {Array.from({ length: totalFrames + 1 }, (_, f) => (
                  <div
                    key={f}
                    style={{
                      width: PX_PER_FRAME, flex: 'none', borderRight: '1px solid var(--spine-border)',
                      position: 'relative',
                    }}
                  >
                    {f % 5 === 0 && (
                      <span style={{ position: 'absolute', top: 1, left: 2, lineHeight: '14px' }}>{f}</span>
                    )}
                  </div>
                ))}
              </div>

              {/* 轨道行 + 关键帧 */}
              {tracks.map((tr) => (
                <div
                  key={`row:${tr.boneId}:${tr.property}`}
                  onPointerDown={(e) => {
                    // 点击轨道空白：在点击处写关键帧（值 = 当前骨骼值）
                    if (dragKey) return;
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const t = Math.max(0, Math.min(duration, (e.clientX - rect.left) / PX_PER_FRAME / fps));
                    const bone = bones.find((b) => b.id === tr.boneId);
                    if (bone) setKeyframe(tr.boneId, tr.property, t, bone[tr.property]);
                  }}
                  style={{
                    position: 'relative', height: ROW_H,
                    borderBottom: '1px solid var(--spine-border)',
                    cursor: 'crosshair',
                  }}
                >
                  {tr.keys.map((k) => {
                    const left = k.time * fps * PX_PER_FRAME - 4;
                    const isDragging = dragKey
                      && dragKey.boneId === tr.boneId
                      && dragKey.property === tr.property
                      && dragKey.fromTime === k.time;
                    const showLeft = isDragging ? dragTime * fps * PX_PER_FRAME - 4 : left;
                    return (
                      <div
                        key={k.time}
                        title={`${boneName(tr.boneId)}.${PROP_LABEL[tr.property]} @ ${k.time.toFixed(2)}s = ${k.value.toFixed(2)}`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                          setDragKey({ boneId: tr.boneId, property: tr.property, fromTime: k.time });
                          setDragTime(k.time);
                        }}
                        onPointerMove={(e) => {
                          if (!dragKey) return;
                          const rect = rulerRef.current?.getBoundingClientRect();
                          if (!rect) return;
                          const t = Math.max(0, Math.min(duration, (e.clientX - rect.left) / PX_PER_FRAME / fps));
                          setDragTime(t);
                        }}
                        onPointerUp={(e) => {
                          if (!dragKey) return;
                          const rect = rulerRef.current?.getBoundingClientRect();
                          const t = rect
                            ? Math.max(0, Math.min(duration, (e.clientX - rect.left) / PX_PER_FRAME / fps))
                            : dragKey.fromTime;
                          moveKeyframe(dragKey.boneId, dragKey.property, dragKey.fromTime, t);
                          setDragKey(null);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          removeKeyframe(tr.boneId, tr.property, k.time);
                        }}
                        style={{
                          position: 'absolute', top: 6, left: showLeft,
                          width: 9, height: 9, background: boneColorOf(tr.boneId),
                          borderRadius: 1.5, transform: 'rotate(45deg)',
                          cursor: 'grab', userSelect: 'none', zIndex: 4,
                          boxShadow: isDragging ? '0 0 0 1px #fff' : 'none',
                        }}
                      />
                    );
                  })}
                </div>
              ))}

              {/* 播放头 */}
              <div
                style={{
                  position: 'absolute', top: 0, bottom: 0,
                  left: currentTime * fps * PX_PER_FRAME, width: 1,
                  background: '#5eb3ff', pointerEvents: 'none', zIndex: 5,
                }}
              />
              <div
                style={{
                  position: 'absolute', top: 0,
                  left: currentTime * fps * PX_PER_FRAME - 6, width: 12, height: 10,
                  background: '#5eb3ff', clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
                  pointerEvents: 'none', zIndex: 5,
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 播放控制小按钮（激活时高亮蓝底）。 */
function PlayBtn({
  title, onClick, children, highlight = false,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      className="spine-btn-icon"
      title={title}
      onClick={onClick}
      style={{
        width: 22, height: 22, fontSize: 11,
        background: highlight ? 'var(--spine-accent)' : undefined,
        color: highlight ? '#fff' : undefined,
        borderColor: highlight ? 'var(--spine-accent)' : undefined,
      }}
    >
      {children}
    </button>
  );
}

/** 工具栏里的图标按钮（新增/复制/重命名/删除动画）。 */
function ToolBtn({
  title, onClick, children, disabled = false,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="spine-btn-icon"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 20, height: 20, fontSize: 11,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}
