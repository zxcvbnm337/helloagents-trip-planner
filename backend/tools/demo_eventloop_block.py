# -*- coding: utf-8 -*-
"""
实验：`async def` 路由里做同步阻塞调用，会卡死整个事件循环。

动机
----
本项目 backend/app/api/routes/trip.py 是这样写的：

    @router.post("/plan")
    async def plan_trip(request: TripRequest):
        ...
        trip_plan = agent.plan_trip(request)   # 同步阻塞 17~25 秒
        ...

而 `agent.plan_trip()` 是同步方法（trip_planner_agent.py:224 `def plan_trip`）。
FastAPI/Starlette 的规则是：**`async def` 路由直接跑在事件循环上**，
在里面做阻塞调用会占死整个 loop —— 期间连 /health 都无响应。

本实验用最小代价证明这件事，并把「改成 def」这个修法也一并验证：
  1. /slow-async  异步路由 + time.sleep  -> 并发时 /ping 被拖慢
  2. /slow-sync   同步路由 + time.sleep  -> FastAPI 自动丢线程池，/ping 不受影响

跑法（本机）：
  venv/Scripts/python.exe tools/demo_eventloop_block.py
不联网、不消耗任何 LLM / 高德配额。
"""

import sys
import threading
import time
import urllib.request

import uvicorn
from fastapi import FastAPI

PORT = 8899
SLEEP = 1.5  # 模拟一次慢业务（真实项目里这里是 17~25s 的多智能体规划）

app = FastAPI()


@app.get("/slow-async")
async def slow_async():
    # ❌ 反例：async 路由里做同步阻塞
    time.sleep(SLEEP)
    return {"ok": True}


@app.get("/slow-sync")
def slow_sync():
    # ✅ 正解之一：同步路由 -> FastAPI 自动放到 worker thread 跑
    time.sleep(SLEEP)
    return {"ok": True}


@app.get("/ping")
def ping():
    return {"pong": True}


def get(url, timeout=30):
    t0 = time.time()
    with urllib.request.urlopen(url, timeout=timeout) as r:
        r.read()
    return time.time() - t0


def start_server():
    config = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="error")
    server = uvicorn.Server(config)
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    # 等服务就绪
    for _ in range(50):
        try:
            get(f"http://127.0.0.1:{PORT}/ping", timeout=1)
            return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("服务未能在 5 秒内就绪")


def measure(path_slow):
    """并发发起一个慢请求，0.3 秒后再打 /ping，量 /ping 的耗时。"""
    base = f"http://127.0.0.1:{PORT}"
    result = {}

    def hit_slow():
        try:
            result["slow"] = get(base + path_slow)
        except Exception as e:
            result["slow_err"] = str(e)

    t = threading.Thread(target=hit_slow)
    t.start()
    time.sleep(0.3)                     # 确保慢请求已经进到业务逻辑里
    ping_ms = get(base + "/ping") * 1000
    t.join()
    return ping_ms


def main():
    start_server()
    print("=" * 64)
    print("实验：sync 阻塞调用放在 async 路由里，会不会卡住其它请求？")
    print(f"（慢业务耗时 {SLEEP}s，下面的 /ping 是在慢请求进行中打的）")
    print("=" * 64)

    print("\n[1] async def 路由 + time.sleep（= 本项目现在的写法）")
    p1 = measure("/slow-async")
    print(f"    /ping 耗时 = {p1:8.1f} ms   <-- 被拖慢了 {p1/1000:.1f} 秒")

    time.sleep(0.5)
    print("\n[2] def 路由 + time.sleep（FastAPI 自动丢线程池）")
    p2 = measure("/slow-sync")
    print(f"    /ping 耗时 = {p2:8.1f} ms")

    print("\n" + "=" * 64)
    blocked = p1 > 1000
    fixed = p2 < 1000
    print(f"结论：async 写法被阻塞 = {blocked}   改成 def 后恢复正常 = {fixed}")
    if blocked and fixed:
        print("→ 印证：把 `async def plan_trip` 改成 `def plan_trip` 即可解除事件循环阻塞。")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
