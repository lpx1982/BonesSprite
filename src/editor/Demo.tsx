import { useEffect, useRef } from 'react';
import { Application, Graphics as Gfx } from 'pixi.js';
import { Bone } from '@engine/Bone';
import { Skeleton } from '@engine/Skeleton';
import { Track } from '@engine/Track';
import { Animation } from '@engine/Animation';

/**
 * Day 1 验收 Demo：
 *   骨骼链 root → torso → arm → forearm，
 *   Animation('wave', 2) 让 arm.rotation 在 0 ↔ π/2 之间往复。
 *
 *   注意事项：
 *   - StrictMode 双挂载安全：destroyed 标志位 + 从 host 摘 canvas
 *   - Skeleton.update() 使用独立 scratch buffer，避免与 bone.worldMatrix.elements 别名
 */
export function Demo() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let destroyed = false;
    let tickFn: (() => void) | null = null;
    let app: Application | null = null;

    const cleanup = () => {
      if (destroyed) return;
      destroyed = true;
      if (app) {
        if (tickFn) {
          try { app.ticker.remove(tickFn); } catch { /* ignore */ }
        }
        try {
          if (app.canvas && app.canvas.parentNode === host) {
            host.removeChild(app.canvas);
          }
          app.destroy(true, { children: true, texture: true });
        } catch {
          // init() 还没完成，吞掉
        }
      }
    };

    (async () => {
      const a = new Application();
      app = a;
      try {
        await a.init({
          background: '#1f2937',
          resizeTo: host,
          antialias: true,
        });
      } catch (err) {
        if (!destroyed) console.error('[PixiBones] PixiJS 初始化失败:', err);
        return;
      }

      if (destroyed || !host) {
        cleanup();
        return;
      }

      host.appendChild(a.canvas);
      a.canvas.style.display = 'block';

      // ---- 骨骼链 root → torso → arm → forearm ----
      const rootBone = new Bone('root');
      const torso = new Bone('torso', { length: 80 });
      const arm = new Bone('arm', { x: 80, length: 60 });
      const forearm = new Bone('forearm', { x: 60, length: 50 });
      rootBone.addChild(torso);
      torso.addChild(arm);
      arm.addChild(forearm);

      const skeleton = new Skeleton(rootBone);
      skeleton.update();

      // ---- 动画：arm.rotation 0 → π/2 → 0，2 秒循环 ----
      const rotationTrack = new Track<number>();
      rotationTrack.add({ time: 0, value: 0 });
      rotationTrack.add({ time: 1, value: Math.PI / 2 });
      rotationTrack.add({ time: 2, value: 0 });

      const wave = new Animation('wave', 2);
      wave.addTrack(arm, 'rotation', rotationTrack);

      // ---- 绘制：单层 Graphics，骨骼线 + 关节圆点 ----
      const layer = new Gfx();
      a.stage.addChild(layer);

      const BONE_COLOR = 0xff5566;
      const JOINT_COLOR = 0xffffff;
      const TIP_COLOR = 0x4ade80;

      const start = performance.now();

      tickFn = () => {
        if (destroyed) return;
        const elapsed = (performance.now() - start) / 1000;
        wave.apply(skeleton, elapsed);

        layer.clear();

        // 居中：链总长 190
        const cx = a.renderer.width / 2 - 95;
        const cy = a.renderer.height / 2;

        const joints: Array<{ x: number; y: number; r: number; color: number }> = [];

        skeleton.root.traverse((b) => {
          if (b.length <= 0) return;
          const p0 = skeleton.getWorldPosition(b);
          const p1 = skeleton.getWorldTip(b);

          layer
            .moveTo(cx + p0.x, cy + p0.y)
            .lineTo(cx + p1.x, cy + p1.y)
            .stroke({ width: 4, color: BONE_COLOR });

          joints.push({ x: cx + p0.x, y: cy + p0.y, r: 6, color: JOINT_COLOR });
        });

        const tip = skeleton.getWorldTip(forearm);
        joints.push({ x: cx + tip.x, y: cy + tip.y, r: 5, color: TIP_COLOR });

        for (const j of joints) {
          layer.circle(j.x, j.y, j.r).fill({ color: j.color });
        }
      };

      a.ticker.add(tickFn);
    })();

    return cleanup;
  }, []);

  return (
    <div className="flex h-full w-full">
      <aside className="w-64 bg-gray-800 text-white p-4 space-y-2 text-sm">
        <h2 className="font-semibold mb-2">骨骼列表</h2>
        <ul className="space-y-1">
          <li>🦴 root</li>
          <li className="ml-4">🦴 torso (length 80)</li>
          <li className="ml-8">🦴 arm (length 60) <span className="text-yellow-300">← 动画</span></li>
          <li className="ml-12">🦴 forearm (length 50)</li>
        </ul>
        <div className="mt-6 pt-4 border-t border-gray-700">
          <div className="font-semibold">动画</div>
          <div className="text-xs text-gray-400 mt-1">
            wave · duration 2s · arm.rotation ↔
          </div>
        </div>
        <div className="mt-6 pt-4 border-t border-gray-700 text-xs text-gray-400">
          Day 1 验收：红色骨骼链，arm 摆动 0 ↔ π/2
        </div>
      </aside>
      <div ref={hostRef} className="flex-1 relative bg-gray-700" />
    </div>
  );
}
