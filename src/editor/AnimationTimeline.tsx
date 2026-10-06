import { useT } from './i18n';

/**
 * 动画时间轴（Spine 风格）—— 当前为 UI 占位
 *
 * 截图里大致结构：
 *   ┌────────────────────────────────────────────────────────────────────────┐
 *   │ 图表  ▢▢▢▢▢▢▢▢  ← 顶部工具条（筛选 / 创建关键帧 / 自动关键帧）              │
 *   ├──────┬───────────────────────────────────────────────────────────────────┤
 *   │ run  │ ◇ 10  20  30  40 ... 120   （帧/秒 标尺）                       │
 *   │ 事件 │ ▮▮▮▮▮▮▮▮▮▮ 关键帧 + 拖动条                                     │
 *   │ 事件││                                                            │    │
 *   └──────┴───────────────────────────────────────────────────────────────────┘
 *
 * 目前只渲染外壳 + 静态 demo 数据（run / event 两条轨道 + 一帧指示线）
 * 后续接：
 *   - 当前播放帧（playhead）随 currentTime 移动
 *   - 关键帧添加 / 拖动 / 删除
 *   - 多条动画轨道管理
 *   - 缩放 / 时间标尺密度切换
 */
export function AnimationTimeline() {
  const { t } = useT();

  // demo 数据：5 个动画轨道 + 几个关键帧
  const tracks = [
    { name: 'run',      color: '#5eb3ff', active: true,  keys: [0, 12, 24, 36, 48] },
    { name: '事件',      color: '#9b7fe5', active: false, keys: [10] },
    { name: '事件: footstep', color: '#5fb35f', active: false, keys: [18, 36] },
  ];

  return (
    <div
      className="absolute left-0 right-0 bottom-0 z-20 flex flex-col"
      style={{
        height: 240,
        background: 'var(--spine-bg-toolbar)',
        borderTop: '1px solid var(--spine-border)',
      }}
    >
      {/* 顶部工具条（占位） */}
      <div
        className="flex items-center gap-2 px-3 shrink-0"
        style={{
          height: 32,
          background: 'var(--spine-bg-panel-dark)',
          borderBottom: '1px solid var(--spine-border)',
        }}
      >
        <span style={{ color: 'var(--spine-text)', fontSize: 11 }}>📊</span>
        <button className="spine-btn" title={t('tab.timeline_anim')}>
          {t('tab.timeline_anim')}
        </button>
        <button className="spine-btn" title={t('tab.timeline_phot')}>
          {t('tab.timeline_phot')}
        </button>
        <div className="w-px h-5" style={{ background: 'var(--spine-border)' }} />
        {/* 播放控制占位 */}
        {['⏮', '◀', '▶', '⏭', '⟳'].map((g, i) => (
          <button
            key={i}
            className="spine-btn-icon"
            style={{ width: 22, height: 22, fontSize: 11 }}
            title={['到首帧', '上一帧', '播放/暂停', '下一帧', '循环'][i]}
          >
            {g}
          </button>
        ))}
        <div className="w-px h-5" style={{ background: 'var(--spine-border)' }} />
        <button className="spine-btn" style={{ fontSize: 11 }}>➕ 移位</button>
        <button className="spine-btn" style={{ fontSize: 11 }}>➕ 偏移</button>
        <div className="ml-auto flex items-center gap-1" style={{ color: 'var(--spine-text-dim)', fontSize: 11 }}>
          <span>0 / 120</span>
        </div>
      </div>

      {/* 主体：左侧轨道列表 + 右侧时间轴网格 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧轨道 */}
        <div
          className="shrink-0 overflow-y-auto"
          style={{
            width: 160,
            background: 'var(--spine-bg-panel-dark)',
            borderRight: '1px solid var(--spine-border)',
          }}
        >
          {tracks.map((tr) => (
            <div
              key={tr.name}
              className="flex items-center px-2"
              style={{
                height: 24,
                fontSize: 11,
                color: tr.active ? 'var(--spine-text)' : 'var(--spine-text-dim)',
                background: tr.active ? 'var(--spine-bg-panel)' : 'transparent',
                borderBottom: '1px solid var(--spine-border)',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  background: tr.color,
                  borderRadius: 1,
                  marginRight: 6,
                }}
              />
              <span style={{ flex: 1 }}>{tr.name}</span>
            </div>
          ))}
        </div>

        {/* 右侧时间轴 */}
        <div className="flex-1 relative overflow-hidden">
          {/* 帧标尺 */}
          <div
            className="absolute left-0 right-0 top-0 flex"
            style={{
              height: 20,
              background: 'var(--spine-bg-panel-dark)',
              borderBottom: '1px solid var(--spine-border)',
              fontSize: 10,
              color: 'var(--spine-text-dim)',
            }}
          >
            {Array.from({ length: 13 }, (_, i) => (
              <div
                key={i}
                style={{
                  width: 40,
                  borderRight: '1px solid var(--spine-border)',
                  paddingLeft: 4,
                  lineHeight: '20px',
                }}
              >
                {i * 10}
              </div>
            ))}
          </div>

          {/* 轨道行 + 关键帧（占位） */}
          <div style={{ position: 'absolute', left: 0, right: 0, top: 20, bottom: 0 }}>
            {tracks.map((tr, rowIdx) => (
              <div
                key={tr.name}
                style={{
                  position: 'absolute',
                  top: rowIdx * 24,
                  left: 0,
                  right: 0,
                  height: 24,
                  borderBottom: '1px solid var(--spine-border)',
                  background: tr.active ? 'var(--spine-bg-panel)' : 'transparent',
                }}
              >
                {tr.keys.map((frame) => (
                  <div
                    key={frame}
                    style={{
                      position: 'absolute',
                      top: 4,
                      left: frame * 4,
                      width: 10,
                      height: 16,
                      background: tr.color,
                      borderRadius: 2,
                      transform: 'rotate(45deg)',
                      opacity: 0.85,
                    }}
                    title={`frame ${frame}`}
                  />
                ))}
              </div>
            ))}

            {/* playhead 指示线（占位，固定在 frame=5） */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 20,
                width: 1,
                background: '#5eb3ff',
                pointerEvents: 'none',
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 14,
                width: 12,
                height: 10,
                background: '#5eb3ff',
                clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}