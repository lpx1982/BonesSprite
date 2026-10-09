/**
 * 「导入数据」UI 入口：
 *   1. 一次性让用户在同一个文件选择器里选 JSON + 全部 PNG（更不容易出错）
 *   2. 调 buildProjectFromSpineJson 解析，得到 ProjectData
 *   3. 把工程数据**新开一个工程**（不弹保存提示）落到 store
 *
 * 关键约束（按用户确认）：
 *   - PNG 文件名（去扩展名）必须 === JSON 里的 attachment key
 *   - 创建到新工程（不弹「是否保存当前工程」）
 */
import { usePixiBonesStore } from '../editor/store';
import { buildProjectFromSpineJson } from './importSpineData';

/** 一次性让用户选 JSON + 多张 PNG。返回 { json: File|null, pngs: File[] }。 */
async function pickJsonAndPngs(): Promise<{ json: File | null; pngs: File[] }> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // 同时接受 JSON 和常见图片；用户在同一个对话框里多选
    input.accept = '.json,application/json,image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
    input.multiple = true;
    // 注意：不能 display:none，否则 click() 在某些浏览器无效
    input.style.position = 'fixed';
    input.style.left = '0';
    input.style.top = '0';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    document.body.appendChild(input);
    let done = false;
    const finish = (v: { json: File | null; pngs: File[] } | null) => {
      if (done) return;
      done = true;
      input.remove();
      if (v) resolve(v);
      else resolve({ json: null, pngs: [] });
    };
    input.addEventListener('change', () => {
      const files = input.files;
      if (!files || files.length === 0) { finish({ json: null, pngs: [] }); return; }
      let json: File | null = null;
      const pngs: File[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f) continue;
        if (/\.json$/i.test(f.name)) json = f;
        else if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)) pngs.push(f);
      }
      finish({ json, pngs });
    });
    // 用户取消 → window 失焦，1.5s 内无 change → 视为取消
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (!done) finish({ json: null, pngs: [] });
      }, 1500);
    }, { once: true });
    input.click();
  });
}

/** 主入口：在主菜单「导入数据…」点击时调用。 */
export async function importDataFromFiles(): Promise<void> {
  console.log('[importData] 开始：弹文件选择器…');
  const { json, pngs } = await pickJsonAndPngs();
  if (!json) {
    console.log('[importData] 用户取消或未选 JSON');
    return;
  }
  if (pngs.length === 0) {
    window.alert('未选择任何 PNG。请在同一个对话框里同时选中 JSON 和所有 PNG（按住 ⌘ / Shift 多选）。');
    return;
  }
  console.log(`[importData] 选中 JSON：${json.name}，PNG ${pngs.length} 张`);

  // 解析
  const jsonText = await json.text();
  let result;
  try {
    result = await buildProjectFromSpineJson(jsonText, pngs, {
      projectName: json.name.replace(/\.json$/i, ''),
    });
  } catch (err) {
    console.error('[importData] 解析失败', err);
    window.alert(`JSON 解析失败：${(err as Error).message ?? err}`);
    return;
  }

  // 报告缺失 + 警告
  if (result.missing.length > 0) {
    const list = result.missing.map((m) => `  - ${m.slotName} → ${m.attachmentName}`).join('\n');
    console.warn('[importData] 以下插槽找不到匹配的 PNG，已跳过：\n' + list);
  }
  for (const w of result.warnings) console.warn('[importData] 警告：' + w);

  // 落到 store：先开一个新工程 id（让"最近工程"也能看到它），再灌数据
  //   —— 这样从欢迎页调用时也能直接跳进编辑器
  const st = usePixiBonesStore.getState();
  const newId = `proj-imported-${Date.now().toString(36)}`;
  // 用 usePixiBonesStore.setState 一次性把 currentProjectId + data 写进去
  // （applyProjectData 内部也会跑 syncIdCounters 等清理工作）
  usePixiBonesStore.setState({
    currentProjectId: newId,
    projectName: result.data.projectName,
  });
  st.pushRecentProject(newId, result.data.projectName);
  st.applyProjectData(result.data);
  console.log(`[importData] 完成：${result.data.slots.length} 插槽 / ${result.data.bones.length} 骨骼 / ${result.data.animations.length} 动画`);

  if (result.missing.length > 0) {
    window.alert(
      `已导入 ${result.data.slots.length} 个插槽；${result.missing.length} 个找不到匹配 PNG，已跳过（看控制台）。`,
    );
  }
}
