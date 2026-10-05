import { useCallback, useRef, useState, type DragEvent, type ChangeEvent } from 'react';
import { parsePsd, flattenLayers, type PixiBonesLayer } from '@psd/index';
import { usePixiBonesStore, findLayer } from './store';

/**
 * Day 2 · 图层面板
 *   - 拖放 / 点击导入 PSD
 *   - 列出所有图层（含组递归展开）
 *   - 切换可见性、选中图层
 */
export function PsdPanel() {
  const psd = usePixiBonesStore((s) => s.psd);
  const setPsd = usePixiBonesStore((s) => s.setPsd);
  const layerVisibility = usePixiBonesStore((s) => s.layerVisibility);
  const selectedLayerId = usePixiBonesStore((s) => s.selectedLayerId);
  const selectLayer = usePixiBonesStore((s) => s.selectLayer);
  const toggleLayerVisibility = usePixiBonesStore((s) => s.toggleLayerVisibility);

  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const result = await parsePsd(file);
        if (result.layers.length === 0) {
          setError('PSD 没有可识别的图层');
          return;
        }
        setPsd(result);
      } catch (err) {
        console.error('[PsdPanel] 解析失败:', err);
        setError(err instanceof Error ? err.message : '未知错误');
      }
    },
    [setPsd],
  );

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = '';
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const flat = psd ? flattenLayers(psd) : [];

  return (
    <aside className="w-72 bg-gray-800 text-white p-3 flex flex-col gap-3 text-sm overflow-hidden">
      {/* 顶部：导入按钮 */}
      <div>
        <h2 className="font-semibold mb-2 flex items-center gap-2">
          <span>📁 PSD 图层</span>
          {psd && (
            <span className="text-xs text-gray-400 font-normal">
              {psd.width}×{psd.height} · {flat.length} 层
            </span>
          )}
        </h2>

        <button
          className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-xs font-medium"
          onClick={() => fileInputRef.current?.click()}
        >
          导入 .psd 文件
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".psd"
          className="hidden"
          onChange={onFileChange}
        />

        {/* 拖放区 */}
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={
            'mt-2 border-2 border-dashed rounded text-center text-xs py-4 transition-colors ' +
            (dragActive
              ? 'border-blue-400 bg-blue-900/40'
              : 'border-gray-600 text-gray-400')
          }
        >
          拖放 .psd 到这里
        </div>

        {error && (
          <div className="mt-2 text-xs text-red-300 bg-red-900/40 px-2 py-1 rounded">
            ⚠ {error}
          </div>
        )}
      </div>

      {/* 图层列表 */}
      <div className="flex-1 overflow-y-auto bg-gray-900/50 rounded p-1">
        {!psd && (
          <div className="text-xs text-gray-500 text-center py-6">
            还未导入 PSD
          </div>
        )}
        {psd && (
          <LayerTree
            layers={psd.layers}
            depth={0}
            layerVisibility={layerVisibility}
            selectedLayerId={selectedLayerId}
            onSelect={selectLayer}
            onToggle={toggleLayerVisibility}
            findLayer={(id) => findLayer(psd, id)}
          />
        )}
      </div>

      {/* 底部说明 */}
      <div className="text-xs text-gray-500 border-t border-gray-700 pt-2">
        Day 2 验收：拖入 PSD → 图层渲染 + 切换眼睛
      </div>
    </aside>
  );
}

interface LayerTreeProps {
  layers: PixiBonesLayer[];
  depth: number;
  layerVisibility: Record<string, boolean>;
  selectedLayerId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  findLayer: (id: string) => PixiBonesLayer | null;
}

function LayerTree(props: LayerTreeProps) {
  // Photoshop 的顶层图层排在最前 = 在视觉上是最上层 = 在 UI 上排在最前
  return (
    <ul className="space-y-0.5">
      {props.layers.map((l) => (
        <LayerRow
          key={l.id}
          layer={l}
          depth={props.depth}
          layerVisibility={props.layerVisibility}
          selectedLayerId={props.selectedLayerId}
          onSelect={props.onSelect}
          onToggle={props.onToggle}
          findLayer={props.findLayer}
        />
      ))}
    </ul>
  );
}

interface LayerRowProps {
  layer: PixiBonesLayer;
  depth: number;
  layerVisibility: Record<string, boolean>;
  selectedLayerId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  findLayer: (id: string) => PixiBonesLayer | null;
}

function LayerRow(props: LayerRowProps) {
  const { layer, depth, layerVisibility, selectedLayerId, onSelect, onToggle } = props;

  const override = layerVisibility[layer.id];
  const effective = override === undefined ? layer.visible : override;

  const isGroup = layer.children.length > 0;
  const isSelected = selectedLayerId === layer.id;

  // 缩略图：图层 canvas 缩小版
  const hasThumb = !!layer.canvas && layer.canvas.width > 0;

  return (
    <>
      <li
        className={
          'flex items-center gap-1 px-1 py-0.5 rounded cursor-pointer text-gray-200 ' +
          (isSelected ? 'bg-blue-700/60' : 'hover:bg-gray-700/60')
        }
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => onSelect(layer.id)}
      >
        {/* 眼睛 */}
        <button
          className="w-5 h-5 flex items-center justify-center text-xs shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(layer.id);
          }}
          title={effective ? '隐藏' : '显示'}
        >
          {effective ? '👁' : '🚫'}
        </button>

        {/* 缩略图 */}
        <div className="w-6 h-6 bg-gray-700 rounded shrink-0 overflow-hidden flex items-center justify-center">
          {hasThumb ? (
            <img
              src={layer.canvas!.toDataURL()}
              alt=""
              className="object-contain w-full h-full"
              style={{ imageRendering: 'pixelated' }}
              draggable={false}
            />
          ) : (
            <span className="text-[10px] text-gray-500">{isGroup ? '📂' : '∅'}</span>
          )}
        </div>

        {/* 名字 */}
        <span className="truncate flex-1" title={layer.name}>
          {layer.name || '(无层名)'}
        </span>

        {/* 类型提示 */}
        {isGroup && <span className="text-[10px] text-yellow-300">组</span>}
      </li>

      {/* 递归子层 */}
      {isGroup && (
        <LayerTree
          layers={layer.children}
          depth={depth + 1}
          layerVisibility={layerVisibility}
          selectedLayerId={selectedLayerId}
          onSelect={onSelect}
          onToggle={onToggle}
          findLayer={props.findLayer}
        />
      )}
    </>
  );
}
