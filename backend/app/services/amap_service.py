"""高德地图MCP服务封装

MCPTool.run() 返回的是**文本**（MCP 的 content 被拼成字符串，可能带前后缀说明，
也可能整体包在 {"result": ...} 里），因此这里的解析统一走 `_as_payload()` 逐层剥壳，
再按高德 Web API v3 的字段结构映射到本项目的 Pydantic 模型。

对应关系（amap-mcp-server 工具 → 高德 API → 本项目模型）：
    maps_text_search   → /v3/place/text      → List[POIInfo]
    maps_search_detail → /v3/place/detail    → Dict
    maps_weather       → /v3/weather/*       → List[WeatherInfo]
    maps_geo           → /v3/geocode/geo     → Location
    maps_direction_*   → /v3/direction/*     → Dict(distance/duration/...)
"""

import json
import re
from typing import List, Dict, Any, Optional

from hello_agents.tools import MCPTool

from ..config import get_settings
from ..models.schemas import Location, POIInfo, WeatherInfo

# 全局MCP工具实例
_amap_mcp_tool = None


def get_amap_mcp_tool() -> MCPTool:
    """
    获取高德地图MCP工具实例(单例模式)

    Returns:
        MCPTool实例
    """
    global _amap_mcp_tool

    if _amap_mcp_tool is None:
        settings = get_settings()

        if not settings.amap_api_key:
            raise ValueError("高德地图API Key未配置,请在.env文件中设置AMAP_API_KEY")

        # 创建MCP工具
        _amap_mcp_tool = MCPTool(
            name="amap",
            description="高德地图服务,支持POI搜索、路线规划、天气查询等功能",
            server_command=["uvx", "amap-mcp-server"],
            env={"AMAP_MAPS_API_KEY": settings.amap_api_key},
            auto_expand=True  # 自动展开为独立工具
        )

        print(f"✅ 高德地图MCP工具初始化成功")
        print(f"   工具数量: {len(_amap_mcp_tool._available_tools)}")

        # 打印可用工具列表
        if _amap_mcp_tool._available_tools:
            print("   可用工具:")
            for tool in _amap_mcp_tool._available_tools[:5]:  # 只打印前5个
                print(f"     - {tool.get('name', 'unknown')}")
            if len(_amap_mcp_tool._available_tools) > 5:
                print(f"     ... 还有 {len(_amap_mcp_tool._available_tools) - 5} 个工具")

    return _amap_mcp_tool


# ============ 解析辅助（纯函数，便于离线单测） ============

_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def _as_payload(raw: Any, _depth: int = 0) -> Optional[Dict[str, Any]]:
    """把 MCPTool 的返回剥成高德业务 JSON 对象，失败返回 None。

    依次尝试：
      1. 已是 dict → 直接看是否需要再剥一层 `result`
      2. 字符串直接 json.loads
      3. 字符串里正则抠出第一个 `{...}` 再 loads（MCP 常在 JSON 前后加说明文字）
      4. MCP content 数组 [{"type": "text", "text": "..."}] → 取 text 再递归
    """
    if _depth > 3:
        return None

    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict) and item.get("type") == "text":
                got = _as_payload(item.get("text"), _depth + 1)
                if got is not None:
                    return got
            elif isinstance(item, (dict, str)):
                got = _as_payload(item, _depth + 1)
                if got is not None:
                    return got
        return None

    if isinstance(raw, dict):
        # MCP 包装层：{"result": {...}} / {"result": "{\"pois\": ...}"}
        if set(raw.keys()) == {"result"} or "result" in raw and "pois" not in raw:
            inner = _as_payload(raw.get("result"), _depth + 1)
            if inner is not None:
                return inner
        return raw

    if not isinstance(raw, str):
        return None

    text = raw.strip()
    if not text:
        return None

    try:
        return _as_payload(json.loads(text), _depth + 1)
    except (json.JSONDecodeError, ValueError):
        pass

    match = _JSON_OBJ_RE.search(text)
    if match:
        try:
            return _as_payload(json.loads(match.group()), _depth + 1)
        except (json.JSONDecodeError, ValueError):
            return None
    return None


def _check_status(payload: Dict[str, Any], what: str) -> bool:
    """检查高德返回的 status 字段（"1" 为成功）。"""
    status = str(payload.get("status", "1"))
    if status == "1":
        return True
    print(f"❌ {what}失败: status={status} info={payload.get('info')} "
          f"infocode={payload.get('infocode')}")
    return False


def _parse_lnglat(text: Any) -> Optional[Location]:
    """把高德返回的 "经度,纬度" 字符串转成 Location（gcj02 坐标系）。"""
    if isinstance(text, dict):
        lng, lat = text.get("longitude"), text.get("latitude")
        try:
            return Location(longitude=float(lng), latitude=float(lat))
        except (TypeError, ValueError):
            return None
    if not isinstance(text, str) or "," not in text:
        return None
    parts = text.split(",")
    if len(parts) != 2:
        return None
    try:
        return Location(longitude=float(parts[0]), latitude=float(parts[1]))
    except ValueError:
        return None


def _to_int(value: Any, default: int = 0) -> int:
    """高德的距离/时长常为字符串（如 "1200" / "1200.0"），统一转 int。"""
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _join_address(poi: Dict[str, Any]) -> str:
    """POI 没有 address 字段时，用省市区拼一个兜底地址。"""
    parts = [poi.get("pname"), poi.get("cityname"), poi.get("adname")]
    seen, out = set(), []
    for p in parts:
        if p and p not in seen:
            seen.add(p)
            out.append(str(p))
    return "".join(out)


def _parse_pois(payload: Dict[str, Any], limit: int = 20) -> List[POIInfo]:
    """把 /v3/place/text 的 pois 数组映射为 POIInfo 列表。"""
    pois = payload.get("pois") or []
    results: List[POIInfo] = []
    for poi in pois[:limit]:
        if not isinstance(poi, dict):
            continue
        location = _parse_lnglat(poi.get("location"))
        if location is None:
            # 没有坐标的 POI 对地图渲染无意义，直接丢弃
            continue
        results.append(POIInfo(
            id=str(poi.get("id") or ""),
            name=str(poi.get("name") or ""),
            type=str(poi.get("type") or ""),
            address=str(poi.get("address") or "") or _join_address(poi),
            location=location,
            tel=str(poi.get("tel") or "") or None,
        ))
    return results


def _parse_weather(payload: Dict[str, Any]) -> List[WeatherInfo]:
    """解析天气，同时兼容「实况(lives)」与「预报(forecasts.casts)」两种返回。"""
    results: List[WeatherInfo] = []

    # 形态一：预报（extensions=all），每天一条 casts
    for forecast in payload.get("forecasts") or []:
        if not isinstance(forecast, dict):
            continue
        for cast in forecast.get("casts") or []:
            if not isinstance(cast, dict):
                continue
            results.append(WeatherInfo(
                date=str(cast.get("date") or ""),
                day_weather=str(cast.get("dayweather") or ""),
                night_weather=str(cast.get("nightweather") or "") or str(cast.get("dayweather") or ""),
                day_temp=cast.get("daytemp") or 0,
                night_temp=cast.get("nighttemp") or 0,
                wind_direction=str(cast.get("daywind") or ""),
                wind_power=str(cast.get("daypower") or ""),
            ))

    # 形态二：实况（extensions=base），只有一条 lives，日夜字段共用
    for live in payload.get("lives") or []:
        if not isinstance(live, dict):
            continue
        weather = str(live.get("weather") or "")
        report_time = str(live.get("reporttime") or "")
        results.append(WeatherInfo(
            date=report_time[:10],
            day_weather=weather,
            night_weather=weather,
            day_temp=live.get("temperature") or 0,
            night_temp=live.get("temperature") or 0,
            wind_direction=str(live.get("winddirection") or ""),
            wind_power=str(live.get("windpower") or ""),
        ))

    return results


def _parse_route(payload: Dict[str, Any], route_type: str) -> Dict[str, Any]:
    """解析路线：步行/驾车看 route.paths，公共交通看 route.transits。"""
    route = payload.get("route") or {}

    paths = route.get("paths") or []
    if paths and isinstance(paths[0], dict):
        path = paths[0]
        distance = _to_int(path.get("distance"))
        duration = _to_int(path.get("duration"))
        steps = path.get("steps") or []
        first = steps[0].get("instruction") if steps and isinstance(steps[0], dict) else ""
        return {
            "distance": float(distance),
            "duration": duration,
            "route_type": route_type,
            "description": str(first or f"全程约 {distance} 米"),
        }

    transits = route.get("transits") or []
    if transits and isinstance(transits[0], dict):
        transit = transits[0]
        distance = _to_int(transit.get("distance"))
        duration = _to_int(transit.get("duration"))
        walking = _to_int(transit.get("walking_distance"))
        cost = transit.get("cost")
        desc = f"全程约 {distance} 米，其中步行 {walking} 米"
        if cost:
            desc += f"，票价约 {cost} 元"
        return {
            "distance": float(distance),
            "duration": duration,
            "route_type": "transit",
            "description": desc,
        }

    return {}


class AmapService:
    """高德地图服务封装类"""

    def __init__(self):
        """初始化服务"""
        self.mcp_tool = get_amap_mcp_tool()

    # ---------- 内部：统一发起 MCP 调用并解析 ----------

    def _call(self, tool_name: str, arguments: Dict[str, Any], what: str) -> Optional[Dict[str, Any]]:
        """调用一个高德 MCP 工具并返回已剥壳的 JSON；失败返回 None。"""
        try:
            result = self.mcp_tool.run({
                "action": "call_tool",
                "tool_name": tool_name,
                "arguments": arguments,
            })
        except Exception as e:
            print(f"❌ {what}调用失败: {e}")
            return None

        preview = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        print(f"{what}返回: {preview[:200]}...")

        payload = _as_payload(result)
        if payload is None:
            print(f"⚠️  {what}返回内容无法解析为 JSON")
            return None
        if not _check_status(payload, what):
            return None
        return payload

    def search_poi(self, keywords: str, city: str, citylimit: bool = True) -> List[POIInfo]:
        """
        搜索POI

        Args:
            keywords: 搜索关键词
            city: 城市
            citylimit: 是否限制在城市范围内

        Returns:
            POI信息列表
        """
        payload = self._call(
            "maps_text_search",
            {"keywords": keywords, "city": city, "citylimit": str(citylimit).lower()},
            "POI搜索",
        )
        if payload is None:
            return []
        return _parse_pois(payload)

    def get_weather(self, city: str) -> List[WeatherInfo]:
        """
        查询天气

        Args:
            city: 城市名称

        Returns:
            天气信息列表
        """
        payload = self._call("maps_weather", {"city": city}, "天气查询")
        if payload is None:
            return []
        return _parse_weather(payload)

    def plan_route(
        self,
        origin_address: str,
        destination_address: str,
        origin_city: Optional[str] = None,
        destination_city: Optional[str] = None,
        route_type: str = "walking"
    ) -> Dict[str, Any]:
        """
        规划路线

        Args:
            origin_address: 起点地址
            destination_address: 终点地址
            origin_city: 起点城市
            destination_city: 终点城市
            route_type: 路线类型 (walking/driving/transit)

        Returns:
            路线信息
        """
        tool_map = {
            "walking": "maps_direction_walking_by_address",
            "driving": "maps_direction_driving_by_address",
            "transit": "maps_direction_transit_integrated_by_address",
        }
        tool_name = tool_map.get(route_type, "maps_direction_walking_by_address")

        arguments: Dict[str, Any] = {
            "origin_address": origin_address,
            "destination_address": destination_address,
        }
        # 城市参数能显著提高同名地址的解析准确率，各路线类型都传
        if origin_city:
            arguments["origin_city"] = origin_city
        if destination_city:
            arguments["destination_city"] = destination_city

        payload = self._call(tool_name, arguments, "路线规划")
        if payload is None:
            return {}
        return _parse_route(payload, route_type)

    def geocode(self, address: str, city: Optional[str] = None) -> Optional[Location]:
        """
        地理编码(地址转坐标)

        Args:
            address: 地址
            city: 城市

        Returns:
            经纬度坐标
        """
        arguments: Dict[str, Any] = {"address": address}
        if city:
            arguments["city"] = city

        payload = self._call("maps_geo", arguments, "地理编码")
        if payload is None:
            return None

        results = payload.get("results") or []
        if not results or not isinstance(results[0], dict):
            return None
        return _parse_lnglat(results[0].get("location"))

    def get_poi_detail(self, poi_id: str) -> Dict[str, Any]:
        """
        获取POI详情

        Args:
            poi_id: POI ID

        Returns:
            POI详情信息
        """
        payload = self._call("maps_search_detail", {"id": poi_id}, "POI详情")
        if payload is None:
            return {}
        # 详情接口把结果放在 pois[0]
        pois = payload.get("pois") or []
        if pois and isinstance(pois[0], dict):
            return pois[0]
        return payload


# 创建全局服务实例
_amap_service = None


def get_amap_service() -> AmapService:
    """获取高德地图服务实例(单例模式)"""
    global _amap_service

    if _amap_service is None:
        _amap_service = AmapService()

    return _amap_service
