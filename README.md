# ComfyUI-RunGroup · 运行组开关

一个纯前端 ComfyUI 自定义节点：把工作流按分组框（Ctrl+G 创建）拆成多个"运行组"，
面板上**单选**一个组，只有该组会被执行，其余组整组静音——类似编程语言里的 switch，
只是 switch 的 case 变成了画布上的分组框。

```
┌─ 组A：抽卡 ────────────────┐   ╔═ 运行组开关 ═══════════╗
│ Loader → KSampler → SaveA  │   ║ ● 组A：抽卡 · 5节点  ▶运行 ║
└────────────────────────────┘   ║ ○ 组B：高清放大 · 4节点 静音 ║
┌─ 组B：高清放大 ─────────────┐   ╚═════════════════════════╝
│ LoadImg → USDU → SaveB     │        点行切组 → 直接 Queue
└────────────────────────────┘
```

## 为什么不是旁路（Bypass）

- 旁路需要输入输出类型一致才能直通，链路类型一变就断——这正是本节点要消灭的痛点
- 本节点只用**静音**（mode=2）：前端 `graphToPrompt()` 在提交前把静音节点从 prompt
  里整段剔除，后端根本不知道这些节点存在，零执行开销、零类型问题

## 用法

1. 框选一组节点 → `Ctrl+G` 建组并命名（如「抽卡」「高清放大」）；要几组建几组
2. 双击画布搜「运行组开关」或 Add Node → utils 添加节点
3. 点节点上的行 = 切换到该组运行（单选，不能全关），然后正常 Queue
4. 选中状态随 workflow JSON 保存（节点 mode 本身会被序列化），重开工作流不丢

**硬性约束：每个组必须自带输出节点（Save Image / Preview Image）。**
静音组的输出链接会在提交时被清理，如果多组合用一个末端 Save，
提交会报 `required_input_missing`（400）。共享的加载类节点（Loader、
提示词等）放组外即可，它们不受切组影响、每次都会执行。

## 推荐布局（抽卡 + 高清放大）

- 组外：模型 Loader、LLM 提示词节点（comfyui-ollama-prompt-encode，配 lock 复用提示词）
- 组「抽卡」：KSampler → VAE Decode → Save Image
- 组「高清放大」：Load Image → Ultimate SD Upscale（4x-UltraSharp，denoise 0.25~0.35）→ Save Image

抽到好图后：右键输出图 → Send to workflow（或拖图）进高清组的 Load Image → 切到高清组 → Queue。

## 原理与实现要点

- 纯前端虚拟节点（`isVirtualNode = true`），无任何 Python 节点，零依赖
- mode 常量：`ALWAYS=0`，`NEVER（静音）=2`，`BYPASS=4`；本节点只使用 0 和 2
- 勾选状态不单独持久化——组员节点的 mode 就是权威状态（与 rgthree 同思路），
  面板每 1.5s 兜底轮询 + 监听 `graphChanged` 增量刷新行
- 手动 Ctrl+B/Ctrl+M 改过的组会如实显示（有 ALWAYS 节点 = 运行中），
  点任意一行即归一化为单选

## 兼容性

- 与 rgthree-comfy 并存无冲突（本节点实现参考了其源码模式）
- 只服务根画布的分组；子图（subgraph）内的分组暂不枚举
- 已知生态问题：ComfyUI 设置里的新 Node 2.0 渲染模式与 rgthree 不兼容
  （会卡顿、渲染错乱），保持默认渲染即可

## 安装

```bash
git clone https://github.com/zhaoruizhe81-bot/ComfyUI-RunGroup.git ComfyUI/custom_nodes/ComfyUI-RunGroup
```

重启 ComfyUI，浏览器硬刷新（Ctrl+F5）。无法直连 GitHub 的机器：在本机下载后，
把整个目录（至少含 `__init__.py` 与 `js/rungroup.js`）拷进 `custom_nodes/` 即可。
