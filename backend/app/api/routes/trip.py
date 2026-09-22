"""旅行规划API路由"""

from fastapi import APIRouter, HTTPException
from ...models.schemas import (
    TripRequest,
    TripPlanResponse,
    ErrorResponse
)
from ...agents.trip_planner_agent import get_trip_planner_agent

router = APIRouter(prefix="/trip", tags=["旅行规划"])


@router.post(
    "/plan",
    response_model=TripPlanResponse,
    summary="生成旅行计划",
    description="根据用户输入的旅行需求,生成详细的旅行计划"
)
def plan_trip(request: TripRequest):
    """
    ⚠️ 这里是**同步 def，不是 async def** —— 刻意为之，别改回去。

    `agent.plan_trip()` 是同步阻塞方法（内部走 requests / 同步 LLM SDK），
    耗时 17~25 秒。FastAPI 的规则是：`async def` 路由**直接跑在事件循环上**，
    在里面做阻塞调用会占死整个 loop —— 期间该实例连 /health 都无响应，
    并发第二个请求要等第一个彻底结束。

    用 `def` 则 FastAPI 自动把它丢进 worker 线程池，事件循环保持空闲。
    已用最小实验实测过（`backend/tools/demo_eventloop_block.py`）：
    同样的 1.5s 阻塞，`async def` 下 /ping 被拖到 1220ms，改成 `def` 后只有 19.7ms。

    将来若要做任务化（提交->轮询），这里会改成 `async def` + 后台任务，
    届时**必须**用 `run_in_threadpool` / `asyncio.to_thread` 包住阻塞调用。

    生成旅行计划

    Args:
        request: 旅行请求参数

    Returns:
        旅行计划响应
    """
    try:
        print(f"\n{'='*60}")
        print(f"📥 收到旅行规划请求:")
        print(f"   城市: {request.city}")
        print(f"   日期: {request.start_date} - {request.end_date}")
        print(f"   天数: {request.travel_days}")
        print(f"{'='*60}\n")

        # 获取Agent实例
        print("🔄 获取多智能体系统实例...")
        agent = get_trip_planner_agent()

        # 生成旅行计划
        print("🚀 开始生成旅行计划...")
        trip_plan = agent.plan_trip(request)

        print("✅ 旅行计划生成成功,准备返回响应\n")

        return TripPlanResponse(
            success=True,
            message="旅行计划生成成功",
            data=trip_plan
        )

    except Exception as e:
        print(f"❌ 生成旅行计划失败: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"生成旅行计划失败: {str(e)}"
        )


@router.get(
    "/health",
    summary="健康检查",
    description="检查旅行规划服务是否正常"
)
def health_check():
    """健康检查

    同样是同步 def —— 内部 `get_trip_planner_agent()` 与 `list_tools()` 都是阻塞调用。
    ⚠️ 这条恰恰最不能阻塞：出故障时第一时间就会打它，而那一刻事件循环
    （若 /plan 正在进行）正被占死，反而是最需要它能答话的时候。
    """
    try:
        # 检查Agent是否可用
        agent = get_trip_planner_agent()
        
        return {
            "status": "healthy",
            "service": "trip-planner",
            "agent_name": agent.agent.name,
            "tools_count": len(agent.agent.list_tools())
        }
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"服务不可用: {str(e)}"
        )

