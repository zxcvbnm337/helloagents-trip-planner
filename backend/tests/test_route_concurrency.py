"""路由并发安全断言（离线，不需要起服务 / 联网 / 密钥）

为什么需要这个测试
------------------
`agent.plan_trip()` 是**同步阻塞**方法，实测耗时 17~25 秒（内部走同步 LLM SDK
与 requests）。FastAPI 的规则是：

  · `async def` 路由 —— **直接跑在事件循环上**。在里面做阻塞调用会占死整个 loop：
    期间该实例连 `/health` 都无响应，并发第二个请求必须等第一个彻底结束。
  · `def` 路由 —— FastAPI 自动丢进 worker 线程池，事件循环保持空闲。

因果关系不是推测，已用最小实验实测：
  `backend/tools/demo_eventloop_block.py` —— 同样是 1.5 秒阻塞，
  `async def` 写法下 `/ping` 被拖到 **1220ms**，改成 `def` 后只有 **19.7ms**。

所以这里把「路由必须是同步 def」钉死。它是**结构性断言**而非行为断言 ——
要在单测里复现事件循环阻塞必须真的起一个 ASGI 服务器，代价过高；
而 `inspect.iscoroutinefunction` 与「是否阻塞」在这个项目里是一一对应的，
上面那个实验就是这条对应关系的证据。

⚠️ 将来做任务化（提交 -> 轮询）时最容易踩这个坑：把 `plan_trip` 改成
`async def` + 后台任务，然后忘了用 `run_in_threadpool` / `asyncio.to_thread`
包住阻塞调用 —— 那时这个测试会失败，提醒你先包一层。**别直接删断言。**

用法（在 backend/ 目录下）：
  venv/Scripts/python.exe tests/test_route_concurrency.py
退出码：0=全通过，1=有失败
"""

import inspect
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    if ok:
        _passed += 1
        print(f"PASS  {name}")
    else:
        _failed += 1
        print(f"FAIL  {name}" + (f"  [{detail}]" if detail else ""))


def is_async(fn) -> bool:
    return inspect.iscoroutinefunction(fn)


def main() -> int:
    print(f"\n{'='*62}")
    print("1) 路由必须同步 def —— 否则阻塞事件循环")
    print(f"{'='*62}")

    try:
        from app.api.routes import trip as trip_routes
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL  无法导入 app.api.routes.trip: {exc}")
        return 1

    for name, why in [
        ("plan_trip", "内部 plan_trip() 阻塞 17~25s，写成 async 会占死整个事件循环"),
        ("health_check", "故障排查时最先打它；若事件循环被占死，它恰恰答不上话"),
    ]:
        fn = getattr(trip_routes, name, None)
        check(
            f"{name} 是同步 def（会走线程池）",
            fn is not None and not is_async(fn),
            f"实际 is_async={is_async(fn) if fn else 'N/A'} —— {why}",
        )

    print(f"\n{'='*62}")
    print("2) 路由与 Agent 的 async 属性必须一致")
    print(f"{'='*62}")

    # ⚠️ 这里刻意**只取类、不实例化**。
    # 多智能体实例的构造会真的去拉起 amap MCP 子进程并连上高德
    # （本测试初版就是误用了 get_trip_planner_agent()，输出里出现
    #  「🔗 连接到 MCP 服务器... ✅ 连接成功」才发现）。
    # 本文件的定位是「零依赖离线断言」，绝不能为了断言而建立外部连接。
    agent_plan = None
    try:
        from app.agents import trip_planner_agent as tpa

        cls = getattr(tpa, "MultiAgentTripPlanner", None)
        if cls is not None:
            agent_plan = cls.plan_trip  # 未绑定方法，不会触发 __init__
    except Exception as exc:  # noqa: BLE001
        print(f"  ⚠ 未能导入 Agent 模块（{type(exc).__name__}: {exc}）—— 跳过本组断言")
        print("    这不影响第 1 组结论。常见原因：缺失依赖。")

    if agent_plan is not None:
        # 自检：确认上面没有意外把单例建起来（建了就意味着连过 MCP）
        check(
            "未实例化多智能体系统（本测试不建 MCP 连接）",
            getattr(tpa, "_multi_agent_planner", None) is None,
            "单例已被创建 —— 说明本测试引入了外部连接，请改回只取类",
        )
        # 若路由是 sync 而 Agent 是 async，路由会把一个 coroutine 当结果返回 ——
        # 表现为「响应体里出现 <coroutine object>」，且伴随 RuntimeWarning: never awaited。
        check(
            "Agent.plan_trip 也是同步方法（与同步路由匹配）",
            not is_async(agent_plan),
            f"实际 is_async={is_async(agent_plan)}",
        )
        check(
            "路由与 Agent 的 async 属性一致（不一致会返回 coroutine 对象）",
            is_async(trip_routes.plan_trip) == is_async(agent_plan),
            f"route={is_async(trip_routes.plan_trip)} agent={is_async(agent_plan)}",
        )
    else:
        print("  （已跳过：未取到 Agent.plan_trip）")

    print()
    print("-" * 62)
    print(f"结果：通过 {_passed} 项，失败 {_failed} 项")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
