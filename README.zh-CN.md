<div align="center">

# WordLink

**每个英语单词，都和它的"邻居"一起出现。**

开源的英语词汇工作台，核心是一张 **32.6 万条类型化词链**的图谱：同义、近义、同族（派生与词形）、形近拼写，
全部来自开放词典并用脚本挖掘生成。测验、分级阅读和 AI 助教都建立在这张图谱上。
仓库里还有 **WordLink-Edge** 的完整 SFT + DPO 训练管线与基准评测——一个微调过的 1.5B 模型，
专门把你要复习的单词写进分级短文。

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![React 19](https://img.shields.io/badge/React-19-61dafb)](https://react.dev)
[![Weights on ModelScope](https://img.shields.io/badge/weights-ModelScope-624aff)](https://modelscope.cn/models/OrionSheep/wordlink-lexiconstrain)

[在线体验](https://wordlink.lifeplayertribe.com) · [功能](#功能) · [本地运行](#本地运行) · [实现原理](#实现原理) · [模型](#模型wordlink-edge) · [路线图](#路线图) · [English](README.md)

</div>

![WordLink 工作台：词表、单词详情与词汇星图](public/images/showcase/study.jpg)

## 为什么做这个

大多数背单词软件一次只给你一个词。可是记 *abandon* 的时候，旁边同时看到 *desert*、*forsake*、*give up*，
再看到 *abandonment*、*abandoned*，会记得牢得多。WordLink 把这片"词汇邻里"放在你学的每个词旁边，
每复习一个词，也顺带复习了它周围的词。

## 功能

### 词汇星图
工作台右侧是当前单词的关系图：

- **颜色就是关系类型**：工具栏一键开关同义、近义、反义、形近。
- **同族词画成气泡**：派生和词形变化（*reach → reached, reaching, reachable*）圈在中心词周围的虚线气泡里，不再多画一堆连线。
- **每类关系一个扇区**：同类词朝同一方向展开，旁边标着「同义词 10/12 +」，点一下展开其余的词。
- **学习进度上图**：每个词外面有一圈进度环——见过是四分之一圈，学习中是三分之二圈，掌握后闭合成整圈，薄弱的词是红色整圈。
- 按 <kbd>H</kbd> 显示二度关联；还没有词条的词用虚线圈；放大后词下方显示简短中文释义。

<p align="center">
  <img src="public/images/showcase/graph-light.jpg" width="40%" alt="浅色主题下的词汇星图">
  <img src="public/images/showcase/graph-dark.jpg" width="40%" alt="深色主题下的词汇星图">
</p>

### 图谱之外
- **测验**：选择、拼写、回忆三种题型，每次作答都会更新这个词的记忆状态，决定它什么时候再出现。
- **分级阅读**：文章里每个词都能点开看释义，侧栏同时显示它的图谱。
- **屏保模式**：全屏单词流，配四季环境音（Web Audio 实时合成）。
- **还有**：学习护照（学习情况报告）、CSV 导入自定义词库、AI 助教对话、中英双语界面、深浅两套主题。

## 本地运行

需要 Node.js 20+ 和 Docker。

```bash
git clone https://github.com/orionsheep/wordlink.git
cd wordlink
npm install

docker compose up -d                 # 本地 PostgreSQL，端口 5432
cp .env.example .env.local           # 按下面的说明填写
npx prisma migrate deploy            # 建表
npm run migrate                      # 导入 data/ 里的词典数据（需要一段时间）
npm run import-edges                 # 导入图谱用的 32.6 万条词链

npm run dev                          # http://localhost:3000
```

最小 `.env.local`：

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/english_word_fission_dev?schema=LPT_english"
DEMO_MODE=true          # 不需要认证服务：所有访问者都使用内置演示账号
```

- **账号系统**：真实注册登录走 [Supabase Auth](https://supabase.com/docs/guides/cli)（本地用 `supabase start`），填好三个 `SUPABASE` 变量并关掉 `DEMO_MODE`。
- **AI 功能**（助教对话、短文生成、护照报告）调用任意 OpenAI 兼容接口：配置 `LLM_BASE_URL`、`LLM_MODEL` 和 API Key（`SILICONFLOW_APIKEY`）。其余功能不需要。
- **演示数据**：`npm run demo-data` 给 `demo@wordlink.test` 写入半年的学习记录。

完整部署说明：[docs/部署与运行指南.md](docs/部署与运行指南.md)。

## 实现原理

| 层 | 内容 |
|---|---|
| 应用 | Next.js 16 App Router、React 19、Tailwind CSS 4、next-intl |
| 数据 | PostgreSQL + Prisma，词库数据从 `data/` 导入 |
| 图谱 | `GET /api/fission?word=…` 从 `word_relation` 表取出该词的邻居及邻居的邻居，由 `src/components/PanelFissionGraph.tsx` 用 `react-force-graph-2d` 绘制 |
| 记忆 | 每次作答让单词在 UNFAMILIAR → FAMILIAR → LEARNED → MASTERED 之间移动，并设定下次复习时间（`src/lib/memory.ts`） |
| AI | 统一的 OpenAI 兼容网关（`src/lib/ai/gateway.ts`），提示词在 `data/ai_prompts/`，结果缓存到磁盘 |
| 认证 | Supabase Auth，或 `DEMO_MODE` 单一演示账号 |

词链来自开放数据和 [`scripts/`](scripts/README.md) 里的几个挖掘脚本：

| 关系 | 条数 | 来源 |
|---|---:|---|
| 词形变化 | 125,612 | ECDICT 词形码 |
| 形近拼写 | 120,946 | 最长公共子序列相似度 ≥ 0.75，排除同族词 |
| 同义 | 87,971 | `data/word_fission_data.csv` 同义词表 |
| 近义（带辨析） | 74,008 | `data/word_chinese/` 里的易混词辨析 |
| 派生 | 6,221 | 词条中的派生词链接 |
| 反义 | 0 | 尚未收集，见路线图 |

## 模型：WordLink-Edge

WordLink-Edge 是在 **Qwen2.5-1.5B-Instruct 上做 SFT + DPO** 得到的模型，只干一件事：按指定的 CEFR 等级写一篇包含指定目标词的短文，并以 JSON 返回。[`model_training/`](model_training/) 里包含完整管线：教师模型造数据 + 五重过滤、SFT、基于真实失败样本的 DPO、自动评测。

90 题基准、贪心解码实测（[完整报告](outputs/eval/BENCHMARK_RESULTS.md)）：

| 模型 | 目标词命中 ↑ | CEFR 越界 ↓ | JSON 合规 ↑ |
|---|---:|---:|---:|
| Qwen2.5-1.5B-Instruct（微调前） | 63.06% | 0.17% | 82.22% |
| **+ SFT**（2,045 篇短文） | **88.06%** | **0.01%** | **100%** |
| **+ DPO**（真实失败负例） | 87.78% | **0.01%** | **100%** |
| Qwen2.5-7B-Instruct 零样本 | 39.72% | 0.07% | 0% |
| DeepSeek-V3 零样本（教师） | 97.78% | 0.01% | 100% |

同一个 1.5B 模型微调后命中率提高 25 个百分点；没有微调的 7B 模型则完全守不住输出格式。

权重：[OrionSheep/wordlink-lexiconstrain](https://modelscope.cn/models/OrionSheep/wordlink-lexiconstrain)（SFT + DPO 合并）、[OrionSheep/wordlink-edge](https://modelscope.cn/models/OrionSheep/wordlink-edge)（SFT）。

> **现状**：模型已训练并完成评测，但网站目前还没有用它——AI 功能走的是 OpenAI 兼容 API。在浏览器里用 WebGPU 运行 WordLink-Edge 在路线图上。

## 路线图

- [ ] 反义词链（Open English WordNet）
- [ ] 在浏览器里运行 WordLink-Edge（WebGPU，4-bit）
- [ ] 用 `src/lib/reader-engine/fsrs.ts` 里已实现的 FSRS-6 安排复习
- [ ] 义项级词链：同义词对应的是这个词的哪个意思
- [ ] 工作台标签页与左右分屏
- [ ] 清理剩余的 ESLint 报错

欢迎提想法和 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 协议与数据

代码采用 [MIT](LICENSE) 协议。`data/` 打包了来自其他项目的词汇资源，包括 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT）；单独复用数据前请先确认各来源的条款。模型权重遵循 [Qwen2.5 协议](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct)。

## 致谢

- [ECDICT](https://github.com/skywind3000/ECDICT)：音标、中文释义、词形
- [Qwen2.5](https://github.com/QwenLM/Qwen2.5)：基座模型
- 图谱的关系筛选、同族气泡与熟悉度标记受 [HytidelLegend/ai-aug-edu](https://github.com/HytidelLegend/ai-aug-edu) 中「词汇星图」的启发

为 [UNU Macau · AI for SDGs 2026](https://unu.edu/macau) AI for Education 赛道（SDG 4）而做。
