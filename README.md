# 智能旅行规划助手 · 多智能体 × 地图 MCP

输入目的地与偏好，由 **4 个 Agent 协作**产出带真实 POI 坐标、天气、路线与预算的多日行程。
提供 **Web** 与 **微信小程序** 两套等价前端，**共用同一套 FastAPI 后端**。

技术栈：HelloAgents（SimpleAgent / MCPTool）· 高德地图 MCP · FastAPI · Vue 3 + TS · 微信小程序 + 云开发

---

## 一、项目来源与相对原版的改动

> 先说清楚边界，避免混淆贡献。

本项目骨架来自《Hello-Agents》教程**第 13 章的配套示例**。原版是一条串行调用的最小示例，
本仓库在其之上做了下面这些工程改造 —— **这部分是相对原版的实际增量**：

| # | 问题 | 做法 | 效果（实测） |
| --- | --- | --- | --- |
| 1 | 四个 Agent **串行**执行，前三步互不依赖却排队等待，单次请求必然超过前端 115s 超时 | 抽出 `_run_parallel()`，用 `ThreadPoolExecutor` + `as_completed` 并发跑前三个检索型 Agent；单个失败只降级为空串，不拖垮整体 | 北京 1 天 **82.2s → 17.0s**；上海 3 天 23.4s（改造前必然超时） |
| 2 | 提示词里工具调用示例被写成 `[TOOL_CA·LL:...]`（混入中点字符 `·`），污染格式示例 | 修正为 `[TOOL_CALL:...]` | 工具调用不再出现解析异常 |
| 3 | 原版只有 Web 端，地图依赖高德 JS API（要 Web 端 Key + 受浏览器跨域约束） | 新增**等价的微信小程序实现**，复用同一后端、**零后端改动**；地图改用小程序内置 `<map>` 组件 | **不再需要高德 Web 端 JS API Key**，也绕开浏览器跨域 |
| 4 | 后端地址写死在客户端，换部署形态就要改多处代码 | 抽象出 `TRANSPORT` 开关，三通道（直连 / 云函数 / 云托管）对上契约完全一致 | 改一个字符串即可切换部署形态 |
| 5 | 行程只存本地缓存，**换设备就没了** | 新增云数据库双写层：本地 `Storage` + 云数据库集合 `trips`，并做优雅降级 | 换设备 / 清缓存后仍能看到自己的行程 |
| 6 | 底层报错又长又脏（含 `callId` / `trace` / 文档链接），直接弹给用户满屏乱码 | 错误分层：已知错误精确映射 + 未知错误保守清洗，**弹窗只给人话、原文进日志** | 弹窗变成一句可照做的短句 |
| 7 | `frontend/.gitignore` 漏忽略 `.env`；两个 `.env.example` 里被误填了真实密钥 | 补齐 gitignore 并加根级兜底；密钥还原为占位符 | 仓库不再有明文密钥 |

---

## 二、核心链路

```
                         ┌────────────────────┐
       用户请求            │ ① 景点搜索 Agent    │──┐
  POST /api/trip/plan ──▶  ├────────────────────┤  │
   (城市/日期/偏好)         │ ② 天气查询 Agent    │──┤  并发执行
                         ├────────────────────┤  │  ThreadPoolExecutor
                         │ ③ 酒店推荐 Agent    │──┘   (max_workers=3)
                         └────────────────────┘
                                   │  三份检索结果（共享同一个 amap MCPTool）
                                   ▼
                         ┌────────────────────┐
                         │ ④ 行程规划 Agent    │  必须等前三者完成
                         └────────────────────┘
                                   │
                                   ▼
                          TripPlan (JSON) ──▶ 客户端渲染
```

**为什么并发是安全的**（已核对 hello_agents 源码，不是想当然）：

- `MCPTool.run()` 每次调用都 `async with MCPClient(...)` **新建会话**，不在实例上保存传输层状态 → 多线程互不干扰
- 每个 Agent 是独立的 `SimpleAgent` 实例，各自持有 `self._history`
- 共享的 `HelloAgentsLLM` 初始化后属性只读，底层是 OpenAI SDK（httpx）客户端，本身支持并发

> 第 ④ 步不能并发：它需要前三个 Agent 的检索结果作为输入，这是真实的依赖关系。

---

## 三、两种前端形态的取舍

| 能力 | Web 版（`frontend/`） | 小程序版（`miniprogram/`） |
| --- | --- | --- |
| 地图 | 高德 JS API（需 Web 端 Key） | 内置 `<map>` 组件（**免 Key**） |
| 主要约束 | 浏览器 CORS | request 合法域名白名单 |
| 结果传递 | `sessionStorage` | `wx.setStorageSync` + 云数据库 |
| 导出 | html2canvas + jsPDF → 图片 / PDF | 复制纯文本 + 转发分享（**小程序无 DOM**） |
| 跨设备 | 不支持 | 支持（云数据库） |

小程序版的地图替换是这次改造里收益最直接的一处：**省掉一个 Key，也消掉了浏览器跨域这类问题**。
代价是导出能力必须降级——小程序没有 DOM，`html2canvas` / `jsPDF` 这类库用不了。

---

## 四、关键设计决策

这几条是值得展开讲的部分，每条都对应一个真实踩过的坑。

### 1. 并发编排的边界划在哪

不是「能并发就并发」。三个检索 Agent 彼此无依赖，所以并发；第 ④ 步依赖前三者的输出，
是有向依赖，必须串行。并发安全的结论来自**读源码核对**（见上文三条依据），不是靠试。

### 2. 小程序的地图为什么换掉高德 JS API

高德 JS API 需要单独的 Web 端 Key，且受浏览器跨域约束。小程序内置 `<map>` 组件天然免 Key、
无跨域。坐标沿用高德返回的 **gcj02**，与 `<map>` 默认坐标系一致，因此**不做任何坐标转换**——
多做一次转换反而是引入误差。

### 3. 一个开关切三种传输通道

`miniprogram/config/index.js` 的 `TRANSPORT`：

| 取值 | 通道 | 用途 |
| --- | --- | --- |
| `direct` | `wx.request` | 本地开发（默认） |
| `cloud-function` | `wx.cloud.callFunction` | 绕开 request 合法域名白名单 |
| `cloud-container` | `wx.cloud.callContainer` | 后端部署在云托管，无云函数 60s 超时天花板 |

三通道的返回值契约完全一致，统一收拢在 `utils/request.js`，**上层页面无感知**。

### 4. 云数据库：优雅降级优先于功能

`utils/cloudStore.js` 的所有云操作**返回 `{ok, reason}` 而从不抛异常**。
集合不存在、权限不足、云环境异常——任何一种都只会让行程退回「仅本机」模式，页面不崩。

同步策略是四选一的收敛逻辑：云端没有则上传本地；`savedAt` 相同则只补记 `cloudId`；
云端更新则覆盖本地；本地更新则推云。生成成功后本地与云端**共用同一个 `savedAt`**，
所以刷新首页不会重复上传。

### 5. 错误信息分层：给人话，给日志留原文

底层 `errMsg` 实测一整屏。做法是两层：已知错误按错误码/关键词精确映射成一句可照做的提示；
未知错误一律过 `summarizeRaw()` 清洗（抽 `errCode`、去掉 URL / `callId` / `trace`、折叠空白、限长）。
**原始报错不丢**，但只打在真正持有它的网络封装层，页面层拿到的是翻译后的 `Error`。

### 6. 没有 DOM 就必须换实现

小程序没有 DOM，所以 Web 端那套「截图 / 导出 PDF」整体不可用，改为复制纯文本 + 转发分享。
这是平台能力边界决定的，不是实现取舍。

---

## 五、快速开始

### 后端

```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env              # 填入 AMAP_API_KEY 与 LLM_API_KEY
python run.py                     # 监听 http://localhost:8000
```

启动后访问 `/docs` 查看 API 文档，`/health` 返回 `healthy` 表示就绪。

> 首次调用会由 `uvx amap-mcp-server` 拉起高德 MCP 服务，需要网络且有一定冷启动耗时。

### Web 版

```bash
cd frontend
npm install
cp .env.example .env              # 填入高德 Web 端 Key
npm run dev                       # http://localhost:5173
```

### 小程序版

```bash
cd miniprogram
node tools/check-plan-transform.js   # 离线自测，不依赖开发者工具
```

导入开发者工具、域名配置、传输通道选择等完整步骤见
**[`miniprogram/README.md`](miniprogram/README.md)**。

---

## 六、环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AMAP_API_KEY` | ✅ | 高德** Web 服务** API Key，供 MCP 使用 |
| `LLM_API_KEY` | ✅ | 大模型 Key（也兼容 `OPENAI_API_KEY`） |
| `LLM_BASE_URL` | 可选 | 兼容 OpenAI 协议的服务地址（如 DeepSeek） |
| `LLM_MODEL_ID` | 可选 | 模型名 |
| `CORS_ORIGINS` | 可选 | 逗号分隔，默认放行本地 5173 / 3000 |
| `UNSPLASH_ACCESS_KEY` | 可选 | 景点配图，未配置则跳过 |

真实密钥**只应存在于 `.env`**（已被 gitignore），仓库里只提交 `.env.example` 占位符。

---

## 七、项目结构

```
helloagents-trip-planner/
├── backend/                        # FastAPI 后端（Web 与小程序共用，唯一数据来源）
│   ├── app/
│   │   ├── agents/trip_planner_agent.py   # 多智能体编排 + 并发 + JSON 解析 + 兜底计划
│   │   ├── api/
│   │   │   ├── main.py                    # 应用装配、CORS、健康检查
│   │   │   └── routes/
│   │   │       ├── trip.py                # POST /api/trip/plan  ← 核心接口
│   │   │       ├── map.py                 # 路线 / 天气
│   │   │       └── poi.py                 # POI 检索、配图
│   │   ├── services/
│   │   │   ├── amap_service.py            # MCP 封装（高德 MCPTool）
│   │   │   ├── llm_service.py             # LLM 单例
│   │   │   └── unsplash_service.py        # 景点配图
│   │   ├── models/schemas.py              # Pydantic 请求/响应模型
│   │   └── config.py                      # pydantic-settings 配置
│   ├── requirements.txt
│   └── .env.example
├── frontend/                       # Vue 3 + TS + Vite + Ant Design Vue
│   └── src/
│       ├── views/Home.vue                 # 表单
│       ├── views/Result.vue               # 行程 / 地图 / 预算
│       └── services/api.ts
├── miniprogram/                    # 微信小程序（等价实现，复用后端）
│   ├── config/index.js                    # TRANSPORT 开关、BASE_URL、云环境 ID
│   ├── utils/
│   │   ├── request.js                     # 三通道 + 错误翻译
│   │   ├── cloudStore.js                  # 云数据库双写与降级
│   │   ├── storage.js                     # 本地缓存
│   │   └── plan.js                        # TripPlan → 视图模型（WXML 不能调函数）
│   ├── pages/{index,result}/
│   └── cloudfunctions/proxyTrip/          # 后端中转云函数
└── README.md
```

---

## 八、已知限制与后续计划

如实列出，都是有意留下的边界：

- **REST 侧仍是桩实现**：`/api/map/*`、`/api/poi/*` 的 `search_poi` / `get_weather` / `plan_route` / `geocode`
  目前 `return [] / {}`（带 TODO）。**真实能力全部走 Agent 链路**，这几个端点主要用于占位与后续扩展。
- **单次请求同步等待 17~25s**：没有做任务化 + 轮询，用户需停留在页面。生产化应改为
  「提交 → 返回任务 ID → 轮询结果」。
- **无鉴权与限流**：当前任何人拿到地址即可调用，会消耗 LLM 与高德配额。计划在生产部署时
  接入身份校验与速率限制。
- **`travel_days` 存在双份真相**：前端由日期差值算出、后端独立接收，需要收敛为单一来源。
- **导出能力降级**：小程序侧未实现图片版行程（可用 canvas 2d 手绘，成本较高）。
- **Pydantic v1 风格残留**：`Field(example=...)` 与 `class Config` 在 v2 下应改为
  `json_schema_extra` / `model_config`。

---

## 九、开源协议与致谢

本项目遵循 **CC BY-NC-SA 4.0**。

- [Hello-Agents](https://github.com/datawhalechina/Hello-Agents) — 智能体教程（本项目的来源）
- [HelloAgents 框架](https://github.com/jjyaoao/HelloAgents)
- [高德地图开放平台](https://lbs.amap.com/) / [amap-mcp-server](https://github.com/sugarforever/amap-mcp-server)
- [微信小程序云开发](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
