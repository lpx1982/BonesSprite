# PixiBones

> 轻量开源的 Web 端 **2D / 2.5D 骨骼绑定与动画工具**，对标 Spine，但完全免费开源。

PixiBones 专为 **Cocos Creator / Unity / WebGL 游戏开发者** 设计：
在浏览器里绑定骨骼、编辑关键帧、绘制网格权重，一键导出 **Spine v3.8 兼容 JSON**，
Cocos Creator 通过官方 spine-TS 插件即可直接使用。

## ✨ 特性

- 🦴 **骨骼系统**：父子继承、长度、变换插值
- 🎞️ **关键帧动画**：多轨道、Bezier 缓动、Newton-Raphson 求解
- 🎨 **PSD 导入**（计划中）：通过 `ag-psd` 解析图层
- 📦 **Spine v3.8 JSON 导出**（计划中）：Cocos / Unity 即插即用
- 🆓 **Apache 2.0**：无会员费、无功能阉割、可商用

## 🚀 快速开始

```bash
npm install
npm run dev
```

默认端口 `5173`，浏览器自动打开。

## 📁 项目结构

```
src/
├── engine/    # 纯 TS 引擎（Vec2/Mat3/Bone/Skeleton/Animation …）
├── editor/    # React + PixiJS 编辑器
└── exporters/ # JSON 导出器
```

## 📜 协议

Apache License 2.0
