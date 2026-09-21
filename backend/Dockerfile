# syntax=docker/dockerfile:1

# ============================================================
# 智能旅行助手 · 后端镜像
#
# 构建上下文必须指定 backend/ 这一层（Dockerfile 与 .dockerignore 都在这里）：
#   docker build -t trip-api ./backend
#   docker run --rm -p 8000:8000 --env-file .env -e PORT=8000 trip-api
#
# ⚠️ 镜像内不含任何密钥。.env 已被 .dockerignore 排除，
#    密钥一律在运行时用环境变量注入（--env-file，或云托管的环境变量配置）。
#    原因：镜像分层是持久的，一旦密钥被烤进某一层，即便后续删除也仍能从历史层里翻出来。
# ============================================================

# ---------- 阶段 1：构建依赖 ----------
# 单独用一层装编译工具链。有些包在 Linux 上只有源码分发（sdist），需要编译器；
# 本地验证是在 Windows 上做的，那里有预编译 wheel，**不能据此推断 Linux 也有**，
# 所以这里保守地带上 build-essential。这些工具不会进入最终镜像。
FROM python:3.13-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

# 依赖装进独立 venv，方便整体拷进运行阶段
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /build
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt


# ---------- 阶段 2：运行时 ----------
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    PORT=80

COPY --from=builder /opt/venv /opt/venv

# 预热高德 MCP Server。
#
# 为什么必须在构建期做：MCPTool 通过 `uvx amap-mcp-server` 拉起子进程
# （见 app/services/amap_service.py），uvx 首次运行要现下载包并建环境，
# 会把「第一笔请求」拖长到几十秒，很容易撞上云托管的请求超时。先装好就只付一次。
#
# 依据（已核对源码，不是猜测）：mcp SDK 的 stdio_client 在启动子进程时用的是
#   {**get_default_environment(), **server.env}
# 其白名单包含 PATH 与 HOME，所以容器里能找到 uvx、也能定位到 uv 的工具目录。
# uv 由 requirements.txt 显式声明（uv>=0.8.0），uv/uvx 可执行文件随 venv 一起进来。
RUN uv tool install amap-mcp-server

WORKDIR /app

# 只拷应用代码（venv / .env / 各种缓存已被 .dockerignore 排除）
COPY app/ ./app/
COPY run.py ./

EXPOSE 80

# 供容器编排做存活探测。云托管那边也有自己的健康检查配置，路径填 /health 即可。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import os, urllib.request as u; u.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT', '80'), timeout=4)"

# 生产直接用 uvicorn 启动，不走 run.py —— 那里开着 reload=True，只适合本地开发。
# 监听 ${PORT}：云托管会注入该变量（默认 80），本地可用 -e PORT=8000 覆盖。
CMD ["sh", "-c", "uvicorn app.api.main:app --host 0.0.0.0 --port ${PORT}"]
