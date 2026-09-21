"""访问控制（鉴权 + 限流）与相关配置自检。

为什么是「离线」测试
--------------------
用 FastAPI 的 TestClient 驱动真实的中间件链，请求路径与线上完全一致，
但**不需要起 uvicorn、不联网、不消耗任何 LLM 或高德配额、不读取 backend/.env**。
只需要 httpx（已在 requirements.txt 里）。

运行
----
    # 在 backend/ 目录下
    venv/Scripts/python.exe tests/test_access_control.py

退出码 0 = 全部通过，1 = 有失败项。
"""

from __future__ import annotations

import contextlib
import io
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

# 刻意在导入 app 之前固定这几个环境变量：
# load_dotenv() 默认不覆盖已存在的环境变量，因此即便 backend/.env 里写了 AUTH_MODE=api_key，
# 测试也会稳定地跑在 off 模式下。这样测试不依赖、也不会碰到任何真实密钥。
os.environ.setdefault("AUTH_MODE", "off")
os.environ.setdefault("RATE_LIMIT_PER_MINUTE", "3")
os.environ.setdefault("RATE_LIMIT_PLAN_PER_MINUTE", "2")

import app.config as config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from app.api.main import app  # noqa: E402
from app.api.security import limiter  # noqa: E402
from app.config import Settings  # noqa: E402

client = TestClient(app)

PLAN = "/api/trip/plan"   # 昂贵端点，有独立且更严的阈值
CHEAP = "/api/__probe__"  # 只要以 /api 开头就会被计数；返回 404 无妨
ORIGIN = "http://localhost:5173"

# 422 = FastAPI 参数校验失败。它意味着请求「已通过中间件、进入了路由」，
# 正是我们想断言的「放行」信号（因为测试不发真实的行程请求体）。
PASSED_THROUGH = 422

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    if ok:
        _passed += 1
        print(f"PASS  {name}")
    else:
        _failed += 1
        print(f"FAIL  {name}")
        if detail:
            print(f"      {detail}")


def reset(mode="off", keys="", secret="", per_min=3, plan_per_min=2) -> None:
    """切换 settings 的取值。get_settings() 每次读取模块全局，因此直接替换即可生效。"""
    config.settings = Settings(
        _env_file=None,
        amap_api_key="test-amap-key",
        auth_mode=mode,
        api_keys=keys,
        gateway_secret=secret,
        rate_limit_per_minute=per_min,
        rate_limit_plan_per_minute=plan_per_min,
    )
    limiter.reset()


def post_plan(headers=None, method="POST"):
    return client.request(method, PLAN, headers=headers or {}, json={})


# --------------------------------------------------------------------------
print("=" * 62)
print("1) AUTH_MODE=off —— 本地开发不该被这些机制打扰")
print("=" * 62)
reset("off")

r = client.get("/health")
check("/health 不受保护（云托管健康检查依赖它开放）", r.status_code == 200,
      f"status={r.status_code}")

r = post_plan()
check("off 模式下 /api/trip/plan 放行（422 表示已进入路由）",
      r.status_code == PASSED_THROUGH, f"status={r.status_code}")

# --------------------------------------------------------------------------
print()
print("=" * 62)
print("2) AUTH_MODE=api_key —— 无凭证必须挡住")
print("=" * 62)
reset("api_key", keys="key-alpha,key-beta")

r = post_plan()
check("无凭证 → 401", r.status_code == 401, f"status={r.status_code}")

check("401 带 WWW-Authenticate 头", r.headers.get("www-authenticate") == "Bearer",
      f"got={r.headers.get('www-authenticate')!r}")

# 必须带上 Origin 才能验证 CORS —— CORSMiddleware 只在请求含 Origin 时才追加响应头。
# 浏览器发出的跨域请求一定带 Origin，所以这条断言才是有意义的。
r = post_plan({"Origin": ORIGIN})
check("带 Origin 的 401 必带 CORS 头（否则浏览器只报跨域，掩盖真实原因）",
      r.headers.get("access-control-allow-origin") == ORIGIN,
      f"got={r.headers.get('access-control-allow-origin')!r}")

r = client.options(PLAN, headers={"Origin": ORIGIN,
                                  "Access-Control-Request-Method": "POST"})
check("OPTIONS 预检 200 且带 CORS 允许头",
      r.status_code == 200 and r.headers.get("access-control-allow-origin") == ORIGIN,
      f"status={r.status_code} acao={r.headers.get('access-control-allow-origin')!r}")

r = post_plan({"X-API-Key": "wrong-key"})
check("错误密钥 → 401", r.status_code == 401, f"status={r.status_code}")

r = post_plan({"X-API-Key": "key-alpha"})
check("X-API-Key 正确 → 放行", r.status_code == PASSED_THROUGH, f"status={r.status_code}")

check("放行时回带 X-RateLimit-Limit 响应头",
      r.headers.get("x-ratelimit-limit") == "2",
      f"got={r.headers.get('x-ratelimit-limit')!r}")

r = post_plan({"Authorization": "Bearer key-beta"})
check("Authorization: Bearer 亦可", r.status_code == PASSED_THROUGH, f"status={r.status_code}")

r = post_plan({"Authorization": "bearer key-beta"})
check("Bearer 前缀大小写不敏感", r.status_code == PASSED_THROUGH, f"status={r.status_code}")

# --------------------------------------------------------------------------
print()
print("=" * 62)
print("3) AUTH_MODE=openid —— 微信云托管场景")
print("=" * 62)
reset("openid")

r = post_plan()
check("无 X-WX-OPENID → 401", r.status_code == 401, f"status={r.status_code}")

r = post_plan({"X-WX-OPENID": "oABC123"})
check("带 X-WX-OPENID → 放行", r.status_code == PASSED_THROUGH, f"status={r.status_code}")

reset("openid", secret="gw-secret")
r = post_plan({"X-WX-OPENID": "oABC123"})
check("配置 GATEWAY_SECRET 后，仅伪造 openid → 401", r.status_code == 401,
      f"status={r.status_code}")

r = post_plan({"X-WX-OPENID": "oABC123", "X-Gateway-Secret": "bad"})
check("网关密钥错误 → 401", r.status_code == 401, f"status={r.status_code}")

r = post_plan({"X-WX-OPENID": "oABC123", "X-Gateway-Secret": "gw-secret"})
check("openid + 正确网关密钥 → 放行", r.status_code == PASSED_THROUGH, f"status={r.status_code}")

# --------------------------------------------------------------------------
print()
print("=" * 62)
print("4) 限流")
print("=" * 62)
reset("off", per_min=3)

codes = [client.get(CHEAP).status_code for _ in range(4)]
check("普通端点：阈值 3，第 4 次 429",
      codes[:3] == [404, 404, 404] and codes[3] == 429, f"codes={codes}")

r = client.get(CHEAP)
check("429 带 Retry-After 头", r.headers.get("retry-after") is not None,
      f"got={r.headers.get('retry-after')!r}")

reset("off", per_min=3)
codes = [post_plan().status_code for _ in range(3)]
check("昂贵端点用独立阈值：plan 阈值 2 → 第 3 次 429",
      codes[:2] == [PASSED_THROUGH, PASSED_THROUGH] and codes[2] == 429, f"codes={codes}")

reset("off", per_min=2)
a = [client.get(CHEAP, headers={"X-Forwarded-For": "1.1.1.1"}).status_code for _ in range(3)]
b = [client.get(CHEAP, headers={"X-Forwarded-For": "2.2.2.2"}).status_code for _ in range(3)]
check("限流按身份分桶，互不牵连",
      a == [404, 404, 429] and b == [404, 404, 429], f"a={a} b={b}")

reset("off", per_min=2)
c1 = [client.get(CHEAP, headers={"X-Forwarded-For": "9.9.9.9, 10.0.0.1"}).status_code
      for _ in range(3)]
c2 = [client.get(CHEAP, headers={"X-Forwarded-For": "9.9.9.9"}).status_code for _ in range(1)]
check("X-Forwarded-For 取第一段（同一客户端跨网关共用同一个桶）",
      c1 == [404, 404, 429] and c2 == [429], f"c1={c1} c2={c2}")

# --------------------------------------------------------------------------
print()
print("=" * 62)
print("5) 边界与开关")
print("=" * 62)
reset("api_key", keys="key-alpha")

r = post_plan(method="OPTIONS")
check("OPTIONS 预检不被鉴权拦（交给 CORS 处理）", r.status_code != 401, f"status={r.status_code}")

r = client.get("/health")
check("非 /api 路径不受鉴权影响", r.status_code == 200, f"status={r.status_code}")

reset("api_key", keys="key-alpha", per_min=0)
r = post_plan({"X-API-Key": "key-alpha"})
check("限流阈值 0 表示不限流（便于临时放开）", r.status_code == PASSED_THROUGH,
      f"status={r.status_code}")

r = client.get("/openapi.json")
check("ENABLE_DOCS 默认开启时 openapi.json 可访问", r.status_code == 200, f"status={r.status_code}")

# --------------------------------------------------------------------------
print()
print("=" * 62)
print("6) 配置自检 validate_config() 与 API_KEYS 解析")
print("=" * 62)


def validate(**over):
    """构造一份 settings 并跑 validate_config()，返回 (异常或True, 标准输出)。"""
    base = dict(amap_api_key="test-amap-key")
    base.update(over)
    config.settings = Settings(_env_file=None, **base)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            config.validate_config()
        return True, buf.getvalue()
    except ValueError as exc:
        return exc, buf.getvalue()


def expect_raise(name, **over):
    res, _ = validate(**over)
    check(name, isinstance(res, ValueError),
          "预期抛 ValueError，但通过了" if not isinstance(res, ValueError) else "")


def expect_ok(name, **over):
    res, _ = validate(**over)
    check(name, not isinstance(res, ValueError), f"不该抛却抛了：{res}")


expect_ok("默认 off 可通过自检")
expect_raise("非法 AUTH_MODE 必须报错", auth_mode="banana")
expect_raise("api_key 模式未配 API_KEYS 必须报错", auth_mode="api_key")
expect_ok("api_key 模式配了 API_KEYS 可通过", auth_mode="api_key", api_keys="k1")
expect_ok("openid 模式可不配网关密钥（仅告警）", auth_mode="openid")
expect_ok("大小写与空格容错：' API_KEY '", auth_mode=" API_KEY ", api_keys="k1")
expect_raise("缺 AMAP_API_KEY 依旧报错（原有行为未被破坏）", amap_api_key="")

_, out = validate(auth_mode="off")
check("off 模式给出「任何人可调用」告警", "AUTH_MODE=off" in out)

_, out = validate(auth_mode="openid")
check("openid 无网关密钥时给出伪造风险告警", "GATEWAY_SECRET" in out)

_, out = validate(auth_mode="openid", gateway_secret="s")
check("openid + 网关密钥后不再告警", "GATEWAY_SECRET" not in out)

_, out = validate(auth_mode="api_key", api_keys="k1", enable_docs=False)
check("关闭 docs 后不再提示文档暴露", "ENABLE_DOCS" not in out)

s = Settings(_env_file=None, api_keys=" k1 , k2 ,, k3 ")
check("get_api_keys_list()：逗号分隔 + 去空白 + 过滤空项",
      s.get_api_keys_list() == ["k1", "k2", "k3"], f"got={s.get_api_keys_list()!r}")
check("get_api_keys_list()：空字符串得到空列表",
      Settings(_env_file=None, api_keys="").get_api_keys_list() == [])

# --------------------------------------------------------------------------
print()
print("-" * 62)
print(f"结果：通过 {_passed} 项，失败 {_failed} 项")
print("-" * 62)

sys.exit(1 if _failed else 0)
