"""访问控制：鉴权 + 限流。

设计取舍
--------
本地开发不该被这些机制打扰，对外部署又必须收紧，因此用一个 `AUTH_MODE` 开关切换：

- `off`     : 全部放行（默认）。本地开发用。
- `api_key` : 校验 `X-API-Key` 或 `Authorization: Bearer`，与 `API_KEYS` 比对。
- `openid`  : 取微信云托管注入的 `X-WX-OPENID` 作为身份。小程序场景天然免自建登录。

限流按「身份」维度做固定窗口计数，身份取值 = openid / API Key 指纹 / 客户端 IP（off 模式）。
「生成行程」是昂贵端点（一次调用触发 4 个 Agent + LLM 与高德配额），单独用更严的阈值。

⚠️ 已知边界（写清楚，别误以为它是万能的）
1. 计数器在**进程内存**里，只对单实例有效。多实例部署（云托管扩副本）会让实际放行量
   变成「阈值 × 副本数」，且重启即清零。要精确限流必须换成 Redis 之类的共享存储。
2. `openid` 模式依赖 `X-WX-OPENID` 请求头。该头由云托管网关注入，但**若服务同时可从公网
   直连，它是可伪造的**。所以提供了 `GATEWAY_SECRET`：配了它就必须额外携带
   `X-Gateway-Secret`，把「来自网关」这件事变成一次真实的凭据校验。
3. 限流只挡「误用与轻量刷量」，不能替代配额告警与账单监控。
"""

from __future__ import annotations

import hashlib
import secrets
import time
from threading import Lock
from typing import Dict, Optional, Tuple

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from ..config import get_settings

# 受保护的前缀。刻意不含 /health 与 / —— 云托管健康检查需要它们保持开放。
PROTECTED_PREFIX = "/api"

# 昂贵端点：一次调用触发 4 个 Agent，显著消耗 LLM 与高德配额
EXPENSIVE_PATHS = frozenset({"/api/trip/plan"})

# 内存里最多跟踪多少个身份，防止被海量不同 IP 撑爆内存
_MAX_TRACKED_KEYS = 20_000


class FixedWindowLimiter:
    """固定窗口计数器（线程安全）。

    窗口长度 60 秒，边界对齐到整分钟。相比滑动窗口实现更简单，
    代价是窗口交界处最多可能放行 2 倍阈值 —— 对「防误用」这个目标够用。
    """

    def __init__(self) -> None:
        self._hits: Dict[str, Tuple[int, int]] = {}
        self._lock = Lock()

    def allow(self, key: str, limit: int, now: Optional[float] = None) -> Tuple[bool, int]:
        """记一次访问并判断是否放行。

        Returns:
            (是否放行, 建议的 Retry-After 秒数)
        """
        if limit <= 0:  # 0 或负数视为不限流，便于临时放开
            return True, 0

        now = time.time() if now is None else now
        window = int(now // 60)

        with self._lock:
            start, count = self._hits.get(key, (window, 0))
            if start != window:  # 跨窗口，重新计数
                start, count = window, 0
            count += 1
            self._hits[key] = (start, count)

            # 超量时顺手清理过期窗口，避免内存无界增长
            if len(self._hits) > _MAX_TRACKED_KEYS:
                self._hits = {k: v for k, v in self._hits.items() if v[0] == window}

            retry_after = max(1, 60 - int(now % 60))

        return count <= limit, retry_after

    def reset(self) -> None:
        """清空计数（测试用）。"""
        with self._lock:
            self._hits.clear()


limiter = FixedWindowLimiter()


def _client_ip(request: Request) -> str:
    """取客户端 IP，用于限流分桶。

    容器/网关后面直接取到的 `request.client` 是网关地址，所有请求会挤进同一个桶，
    因此优先看转发头。⚠️ 这些头同样可被伪造 —— 这里只用于限流分桶，不做安全判定。
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first

    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip

    return request.client.host if request.client else "unknown"


def _fingerprint(value: str) -> str:
    """把凭据换成短哈希作为内部身份 key —— 避免密钥原文进入内存与日志。"""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def _presented_key(request: Request) -> str:
    """从 Authorization: Bearer 或 X-API-Key 取调用方提供的密钥。"""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.headers.get("x-api-key", "").strip()


def _unauthorized(message: str) -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={"success": False, "message": message, "data": None},
        headers={"WWW-Authenticate": "Bearer"},
    )


def _too_many_requests(retry_after: int) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={
            "success": False,
            "message": f"请求过于频繁，请 {retry_after} 秒后重试",
            "data": None,
        },
        headers={"Retry-After": str(retry_after)},
    )


def resolve_identity(request: Request) -> Tuple[Optional[str], Optional[JSONResponse]]:
    """确定调用方身份。

    Returns:
        (identity, error)。identity 非空表示通过；error 非空表示应直接返回该响应。
    """
    settings = get_settings()
    mode = (settings.auth_mode or "off").strip().lower()

    if mode == "off":
        return f"ip:{_client_ip(request)}", None

    if mode == "api_key":
        presented = _presented_key(request)
        if not presented:
            return None, _unauthorized(
                "缺少访问凭证：请通过 X-API-Key 或 Authorization: Bearer 提供密钥"
            )
        # 常数时间比较，避免通过响应耗时逐位猜测密钥
        for allowed_key in settings.get_api_keys_list():
            if secrets.compare_digest(presented, allowed_key):
                return f"apikey:{_fingerprint(presented)}", None
        return None, _unauthorized("访问凭证无效")

    if mode == "openid":
        # 先校验网关密钥，再取 openid —— 顺序很重要：
        # 未通过密钥校验的探测请求不应得知「openid 是否存在」这类信息。
        expected_secret = (settings.gateway_secret or "").strip()
        if expected_secret:
            presented_secret = request.headers.get("x-gateway-secret", "").strip()
            if not presented_secret or not secrets.compare_digest(presented_secret, expected_secret):
                return None, _unauthorized("缺少或错误的网关密钥")

        openid = (request.headers.get("x-wx-openid") or "").strip()
        if not openid:
            return None, _unauthorized(
                "未取到微信身份（X-WX-OPENID）：请确认请求来自微信客户端并经云托管网关转发"
            )
        return f"openid:{openid}", None

    return None, _unauthorized(f"未知的 AUTH_MODE：{mode}")


class AccessGuardMiddleware(BaseHTTPMiddleware):
    """对 `/api/*` 统一做鉴权与限流，业务路由无需逐个装饰。"""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # 预检请求直接放行（交给 CORS 中间件），非 /api 路径不受保护
        if request.method == "OPTIONS" or not path.startswith(PROTECTED_PREFIX):
            return await call_next(request)

        identity, error = resolve_identity(request)
        if error is not None:
            return error

        settings = get_settings()
        limit = (
            settings.rate_limit_plan_per_minute
            if path in EXPENSIVE_PATHS
            else settings.rate_limit_per_minute
        )

        allowed, retry_after = limiter.allow(identity, limit)
        if not allowed:
            return _too_many_requests(retry_after)

        # 供后续路由按身份取用（例如将来做按用户维度的数据存储）
        request.state.identity = identity

        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(limit)
        return response
