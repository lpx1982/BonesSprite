/**
 * 中英文 i18n（最小集）
 *
 *   - 用法：const t = useT();  t.menu.open_project → '打开项目' / 'Open Project'
 *   - locale 在 store 里持久化（localStorage key: bones.locale）
 *   - 后续要加新字段：同时在 zh / en 里加同名 key
 */
export type Locale = 'zh' | 'en';

// =================================================================================
//  全部字符串（zh + en 一一对应，key 不能漏）
// =================================================================================
const dict = {
  // ===== header / 主菜单 =====
  header: {
    trial_short:        { zh: '',                en: '' },
    trial_long:         { zh: '',                en: '' },
    main_menu:          { zh: '主菜单',            en: 'Main Menu' },
    project_unnamed:    { zh: '(未命名)',          en: '(Untitled)' },
    layer_panel:        { zh: '🗂 图层',           en: '🗂 Layers' },
    layer_panel_tip:    { zh: '切换图层面板',       en: 'Toggle Layers Panel' },
    props_panel:        { zh: '⚙ 属性',           en: '⚙ Properties' },
    props_panel_tip:    { zh: '切换属性面板',       en: 'Toggle Properties Panel' },
    view_editor:        { zh: '🦴 编辑器',         en: '🦴 Editor' },
    view_demo:          { zh: '🎬 Demo',          en: '🎬 Demo' },
    view_tip:           { zh: '视图',              en: 'View' },
    settings_tip:       { zh: '设置',              en: 'Settings' },
  },

  // ===== 编辑器 tab（左上角按钮：装配 / 动画）=====
  tab: {
    setup:             { zh: '设置',              en: 'Setup' },
    animate:           { zh: '动画',              en: 'Animate' },
    timeline_anim:     { zh: '图表',              en: 'Animations' },
    timeline_phot:     { zh: '摄影表',            en: 'Dopesheet' },
  },

  // ===== 主菜单项 =====
  menu: {
    new_project:        { zh: '新建项目',          en: 'New Project' },
    open_project:       { zh: '打开项目…',         en: 'Open Project…' },
    recent:             { zh: '最近的项目',        en: 'Recent Projects' },
    save:               { zh: '保存项目',          en: 'Save Project' },
    save_as:            { zh: '项目另存为…',       en: 'Save Project As…' },
    pack:               { zh: '打包项目…',         en: 'Pack Project…' },
    new_skeleton:       { zh: '新建骨架',          en: 'New Skeleton' },
    import_project:     { zh: '导入项目…',         en: 'Import Project…' },
    import_data:        { zh: '导入数据…',         en: 'Import Data…' },
    import_psd:         { zh: '导入PSD…',         en: 'Import PSD…' },
    export:             { zh: '导出…',            en: 'Export…' },
    texture_packer:     { zh: '纹理打包器…',       en: 'Texture Packer…' },
    texture_unpacker:   { zh: '纹理解包器…',       en: 'Texture Unpacker…' },
    settings:           { zh: '设置…',            en: 'Settings…' },
    language:           { zh: '语言',              en: 'Language' },
    language_zh:        { zh: '中文',              en: 'Chinese' },
    language_en:        { zh: 'English',          en: 'English' },
  },

  // ===== 快捷键显示（macOS 风格，键名以英文为主）=====
  shortcut: {
    cmd_shift_n:        { zh: 'Cmd+Shift+N', en: 'Cmd+Shift+N' },
    cmd_o:              { zh: 'Cmd+O',       en: 'Cmd+O' },
    arrow_right:        { zh: '▸',          en: '▸' },
    cmd_s:              { zh: 'Cmd+S',       en: 'Cmd+S' },
    cmd_shift_s:        { zh: 'Cmd+Shift+S', en: 'Cmd+Shift+S' },
    cmd_n:              { zh: 'Cmd+N',       en: 'Cmd+N' },
    cmd_e:              { zh: 'Cmd+E',       en: 'Cmd+E' },
    cmd_p:              { zh: 'Cmd+P',       en: 'Cmd+P' },
    f12:                { zh: 'F12',         en: 'F12' },
  },

  // ===== QuickBtn tooltip =====
  quickbtn: {
    open_tip:           { zh: '打开项目…  (Cmd+O)',                                en: 'Open Project…  (Cmd+O)' },
    save_tip:           { zh: '保存项目 (Cmd+S) / Shift+点击 = 另存为',                en: 'Save Project (Cmd+S) / Shift+Click = Save As' },
    undo_tip:           { zh: '撤消 (Cmd+Z)',                                      en: 'Undo (Cmd+Z)' },
    redo_tip:           { zh: '重做 (Cmd+Shift+Z)',                                en: 'Redo (Cmd+Shift+Z)' },
    open_console:       { zh: '[QuickBtn] 打开项目',                               en: '[QuickBtn] Open Project' },
    save_console:       { zh: '[QuickBtn] 保存',                                   en: '[QuickBtn] Save' },
    save_as_console:    { zh: '[QuickBtn] 另存为',                                 en: '[QuickBtn] Save As' },
    undo_console:       { zh: '[QuickBtn] 撤消（未实现）',                          en: '[QuickBtn] Undo (not implemented)' },
    redo_console:       { zh: '[QuickBtn] 重做（未实现）',                          en: '[QuickBtn] Redo (not implemented)' },
  },

  // ===== 底部 5 张卡片 =====
  toolbar: {
    // 卡片 1：mode
    mode_pose:          { zh: '姿势',          en: 'Pose' },
    mode_weights:       { zh: '权重',          en: 'Weights' },
    mode_create:        { zh: '创建',          en: 'Create' },
    // 卡片 2：transform
    tx_rotate:          { zh: '旋转',          en: 'Rotate' },
    tx_move:            { zh: '移动',          en: 'Move' },
    tx_scale:           { zh: '缩放',          en: 'Scale' },
    tx_shear:           { zh: '倾斜',          en: 'Shear' },
    // 卡片 3：space
    space_local:        { zh: '本地',          en: 'Local' },
    space_parent:       { zh: '父级',          en: 'Parent' },
    space_world:        { zh: '世界',          en: 'World' },
    // 卡片 4：reference
    ref_bone:           { zh: '骨骼',          en: 'Bones' },
    ref_image:          { zh: '图片',          en: 'Images' },
    ref_pixel:          { zh: '像素',          en: 'P' },
    // 卡片 5：visibility
    vis_bone:           { zh: '骨骼',          en: 'B' },
    vis_image:          { zh: '图片',          en: 'I' },
    vis_other:          { zh: '其他',          en: 'O' },
    // 左下角锁按钮 tooltip
    lock_unlock:        { zh: '解锁：可横向移动卡片组',  en: 'Unlock: drag toolbar horizontally' },
    lock_lock:          { zh: '锁定：居中显示',          en: 'Lock: center' },
  },
} as const;

// =================================================================================
//  类型推导：自动生成 key 路径（保证调用方不会拼错）
// =================================================================================
type Dict = typeof dict;
type Path<T, P extends string = ''> = {
  [K in keyof T & string]:
    T[K] extends Record<string, string>
      ? Path<T[K], `${P}${K}.`>
      : `${P}${K}`;
}[keyof T & string];

export type I18nKey = Path<Dict>;

/** 根据 key 取中/英文字符串（找不到时返回 key 本身，便于排错） */
export function tr(locale: Locale, key: I18nKey): string {
  const parts = key.split('.');
  let cur: any = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return key; // 找不到原样返回
  }
  if (cur && typeof cur === 'object' && (locale in cur)) return cur[locale];
  return key;
}

/** React hook：订阅 store.locale，返回 tr 函数
 *  - t() 接受 string（宽松），调用方直接写 t('header.layer_panel') 即可
 */
import { usePixiBonesStore } from './store';
export function useT() {
  const locale = usePixiBonesStore((s) => s.locale);
  return {
    locale,
    t: (key: string) => tr(locale, key as I18nKey),
  };
}