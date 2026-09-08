# Study Clinic 浅色背景系统

2026-09-09。基于 `5ecb51d16cd4151021e65ab258d3b705aca2af2e` 的当前工作树完成。接手时已有的品牌、图标和文案修改均保留，不纳入本次背景提交。

## 选定方向

**暖棉纸上的阅读光**：让浅象牙白像一张被自然光照亮的好纸。光线有缓慢变化，细纤维只在近看时出现，阅读内容仍然是第一视觉层。

现有深松绿导航、绿色纸页和课程库书本已有明确的纸张语言。延续同一种材质，比新增插画或几何装饰更适合这个安静、可信、长期阅读的学习空间。

实际浏览课程库、主页、学习、课程结构、知识地图、进展、资料和设置后再生成。原有浅色底面有细碎的明暗变化，但资料页和进展页的大片留白缺少方向，地图画布又与外壳脱节。新系统将光线与纸纹分开控制，统一所有主页面的环境。

## Image-2 探索与取舍

使用现有、未修改的 `C:/Users/smallfish/.codex/tools/imagegen-endpoint.ps1`，经适配器调用 imagegen skill CLI。使用配置中的 Image-2 别名 `gpt-image-2-4k`，没有切换其他模型。每次均附上本轮真实资料页截图，明确只作色彩与气质参考，输出纯背景素材。

共生成 **3 张**候选，未用满 10 张额度。开始时直接指定基础别名 `gpt-image-2` 被端点以 403 拒绝，没有返回图像；随后按现有适配器的已配置别名调用成功。

| 候选 | 实屏判断 | 处理 |
| --- | --- | --- |
| 细棉纸 | 触感自然，但单独铺满仍缺少空间层次 | 提取真实生成的纤维，作为轻薄的共用底材 |
| 漫射阅读光 | 暖白亮面向浅灰绿的边缘缓慢过渡，桌面和手机裁切都自然 | 选为共用环境光 |
| 浅压纹 | 弧形边界在空白资料页可辨认，容易被当成独立装饰，窄屏裁切也不够均衡 | 放弃 |

候选首先在真实资料页以 1440 × 1000、390 × 844 并排比较。接入后又降低了纤维强度并缩细显示尺度，避免手机近看时出现明显颗粒。不是把概念图当作页面截图，也没有用 CSS 绘图替代生成素材。

## 文件与分层

| 文件 | 职责 |
| --- | --- |
| `apps/web/public/backgrounds/reading-light.webp` | 1920 × 1280 的连续柔光，20,420 字节 |
| `apps/web/public/backgrounds/cotton-fiber.webp` | 512 × 512 的无缝透明棉纸纹，35,886 字节 |
| `apps/web/src/studio.css` | 共用背景、阅读面强度、手机裁切、地图画布及降级 |
| `.gitattributes` | 将 WebP 明确标记为二进制资源 |
| `apps/server/src/sourceHygiene.test.ts` | 在已有二进制格式声明中补入 WebP，避免把图片控制字节误报为源码污染 |
| `docs/PAPER_BACKGROUNDS.md` | 本文：方向、生成记录、接入和验收 |

两份素材合计 **56,306 字节，约 55 KiB**。不同页面复用同一 URL，不按路由重复保存图片。

- 环境光使用 `cover`，位于固定高度的课程外壳后方；页面内容在内部滚动，图片不会随文章长度拉伸。
- 从生成棉纸中提取细节，去除不均匀照明，再对称衔接四边。纹理透明度最大为 `5/255`，以 `384px × 384px` 固定尺寸平铺，独立于环境光缩放。
- 学习、设置添加 24% 的淡象牙白保护层。正文、表单和资料卡片继续使用不透明阅读面，不往文字上叠加纹理。
- 地图使用同样的两份素材，覆盖 66% 的浅色保护层，应用在静止画布上；节点、边和语义颜色不变，地图缩放和平移不会带动纸纹。
- 手机的环境光取景移到 `64% center`，保留宽幅原图的明暗过渡。所有纹理层都是 CSS 背景，不新增 DOM、定位层、点击拦截或动画。
- 图片失败时保留原有 `#f4f2ea` 纯色。`forced-colors`、`prefers-contrast: more` 和打印模式关闭浅色装饰背景。
- 最轻的辅助文字由 `#6d796f` 调整到 `#626f64`。对最终解码素材叠加最大纤维暗度的保守计算：正文约 10.52:1，次要文字约 4.60:1，辅助文字约 4.64:1。这是新增背景上的颜色检查，不是对整个产品的 WCAG 合规声明。

## 实屏验收

使用运行中的真实 React 页面和现有本地课程数据。最终截图来自生产构建预览 `http://127.0.0.1:5511`，不触发新的课程生成或 Tutor 请求。

| 步骤 | 页面 | 1440 × 1000 / 390 × 844 结果 |
| --- | --- | --- |
| 1 | 课程库 | 背景与原有书本自然融合，卡片和操作优先 |
| 2 | 课程主页 | 柔光衬托绿色下一步区域，标题和日程清晰 |
| 3 | 学习 | 文本仍在干净阅读面内，长文滚动不改变纸纹尺度 |
| 4 | 课程结构 | 大块阅读面与环境底材有层次，树形结构不变 |
| 5 | 知识地图 | 节点和关系可读，共用纸感更轻，缩放不影响底材 |
| 6 | 进展 | 摘要、标签页和空白区域保持统一，原有状态色不变 |
| 7 | 资料 | 大片留白有连续光感，素材卡仍为第一视觉层 |
| 8 | 设置 | 背景进一步减弱，表单与辅助说明保持清楚 |

截图与前后对比位于 `output/playwright/paper-background/`。地图对比在同一缩放和节点位置下恢复旧背景截图，避免把视图变化误算为背景效果。

另外检查图片加载失败、强制高对比度、增强对比度、打印、正文选择、长文滚动、Tutor 打开、手机导航和地图缩放。生产页面捕获未发现页面脚本错误或横向溢出。

额外覆盖 320、360、430、767、768、1024、1920px，共 56 次页面/宽度组合检查；另外用 390 × 844、DPR 2、触屏移动上下文验证真实像素密度下的纸纹。纹理四边像素一致，生产包内两份素材的 SHA-256 与源码资源完全一致。

项目检查：`npm run build` 通过（保留原有大于 500 KB 的 JS 分块提示）；`npm test` 全部 192 个测试文件、2727 项测试通过；`npm run format` 完成；`npm run lint` 无错误，保留 `FormalAssessmentPanel.tsx` 与 `GraphWorkspaceView.tsx` 的 3 条既有 Hooks 警告。原有未提交文件在格式化前后的内容哈希一致。

## 生成提示词与本地复现材料

原始图片保留在配套工作区 `hy3-study-clinic-v2-workspace/output/imagegen/paper-background/`。完整提示词、候选后处理、最终处理脚本和检查日志保留在 `hy3-study-clinic-v2-workspace/working/paper-background/`。其中 `prepare-final.py` 从这次实际生成的 cotton 与 reading-light 图片导出生产 WebP；没有程序生成噪声替代图像生成。

三份完整提示词分别为 `prompts/cotton.txt`、`prompts/reading-light.txt`、`prompts/blind-impression.txt`。共同规格：1536 × 1024、high quality；输入为本轮资料页实屏，明确禁止输出 UI、文字、logo、书本、叶片和具象装饰。

本地完整原文：[棉纸提示词](C:/Users/smallfish/open-source/hy3-study-clinic-v2-workspace/working/paper-background/prompts/cotton.txt)、[阅读光提示词](C:/Users/smallfish/open-source/hy3-study-clinic-v2-workspace/working/paper-background/prompts/reading-light.txt)、[压纹提示词](C:/Users/smallfish/open-source/hy3-study-clinic-v2-workspace/working/paper-background/prompts/blind-impression.txt)。

最终采用的提示词主体：

> **Cotton** — An exquisitely quiet, clean, warm ivory uncoated cotton paper surface, flat overhead, with extremely fine, softly interlocking paper fibres and minute tactile grain. Like the first blank page of a beautiful scholarly book, refined and contemporary. Pale ivory #f4f2ea and near-white #fcfaf3, a whisper of grey sage. Even diffuse illumination. Texture visible only on close inspection; no dirt, large speckles, ageing, mottling, folds, sheet boundaries, text, objects or vignetting. Softly seamless edges for potential tiling.

> **Reading light** — Soft daylight grazing an immaculate warm ivory, almost smooth cotton-paper surface in a quiet reading room. An extraordinarily broad, barely perceptible pool of diffuse natural light enters from the upper left; faint soft grey-sage shade settles at the distant right perimeter and lower edge. Airy, luminous, restrained. Enormous, feathery, out-of-focus shadows with no recognisable source or hard boundaries. Open central 75 percent bright, calm and even for text. Faint microscopic natural paper tooth, not noise. Principally #f4f2ea through #fdfbf5 with a trace of grey-green #e9eee5 and pale golden beige. A continuous softly lit surface that crops naturally to portrait as well as landscape; no objects, visible window frame, leaves, stripes, spotlight, clouds, dirty texture, text or logo.
