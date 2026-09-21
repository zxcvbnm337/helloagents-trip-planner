"""高德返回解析 + travel_days 收敛的离线单测。

为什么是「离线」测试
--------------------
只喂样例 JSON 给纯函数，**不启动 MCP、不联网、不消耗高德配额**。
样例字段结构照抄高德 Web API v3 的真实返回（含「数字是字符串」这一坑）。

运行
----
    # 在 backend/ 目录下
    venv/Scripts/python.exe tests/test_amap_parsing.py

退出码 0 = 全部通过，1 = 有失败项。
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.models.schemas import TripRequest  # noqa: E402
from app.services.amap_service import (  # noqa: E402
    _as_payload,
    _parse_lnglat,
    _parse_pois,
    _parse_route,
    _parse_weather,
)

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


# ============ 样例数据（结构照抄高德 v3） ============

POI_TEXT_SEARCH = """{
  "status": "1",
  "info": "OK",
  "infocode": "10000",
  "count": "2",
  "pois": [
    {
      "id": "B000A8UIN8",
      "name": "故宫博物院",
      "type": "风景名胜;风景名胜;世界遗产",
      "typecode": "110202",
      "location": "116.397128,39.916527",
      "pname": "北京市",
      "cityname": "北京市",
      "adname": "东城区",
      "address": "景山前街4号",
      "tel": "010-85007421"
    },
    {
      "id": "B0FFH8TQ2P",
      "name": "无坐标的脏数据",
      "type": "餐饮服务",
      "location": "",
      "pname": "北京市",
      "cityname": "北京市",
      "adname": "东城区"
    }
  ]
}"""

WEATHER_FORECAST = """{
  "status": "1",
  "info": "OK",
  "infocode": "10000",
  "count": "1",
  "forecasts": [
    {
      "city": "上海市",
      "reporttime": "2026-09-21 11:00:00",
      "casts": [
        {
          "date": "2026-09-22",
          "dayweather": "晴",
          "nightweather": "多云",
          "daytemp": "28",
          "nighttemp": "22",
          "daywind": "东南",
          "daypower": "1-3"
        },
        {
          "date": "2026-09-23",
          "dayweather": "小雨",
          "nightweather": "小雨",
          "daytemp": "26",
          "nighttemp": "21",
          "daywind": "东北",
          "daypower": "3-4"
        }
      ]
    }
  ]
}"""

WEATHER_LIVE = """{
  "status": "1",
  "lives": [
    {
      "province": "上海市",
      "city": "上海市",
      "weather": "多云",
      "temperature": "27",
      "winddirection": "东",
      "windpower": "≤3",
      "humidity": "62",
      "reporttime": "2026-09-21 11:00:00"
    }
  ]
}"""

ROUTE_WALKING = """{
  "status": "1",
  "info": "OK",
  "route": {
    "origin": "116.397128,39.916527",
    "destination": "116.404269,39.913164",
    "paths": [
      {
        "distance": "1200",
        "duration": "960",
        "steps": [{"instruction": "向东步行 300 米"}]
      }
    ]
  }
}"""

ROUTE_TRANSIT = """{
  "status": "1",
  "route": {
    "transits": [
      {
        "cost": "3.0",
        "duration": "1800",
        "walking_distance": "450",
        "distance": "6200"
      }
    ]
  }
}"""

ROUTE_FAILED = """{"status":"0","info":"INVALID_USER_KEY","infocode":"10001"}"""


# ============ 1. 剥壳 ============

print("---- 1. _as_payload 逐层剥壳 ----")
plain = _as_payload(POI_TEXT_SEARCH)
check("裸 JSON 字符串可解析", isinstance(plain, dict) and plain.get("count") == "2")

wrapped = _as_payload("这是高德返回：%s 以上。" % POI_TEXT_SEARCH)
check("前后缀带说明文字也能抠出 JSON",
      isinstance(wrapped, dict) and len(wrapped.get("pois") or []) == 2)

nested = _as_payload('{"result": "{\\"status\\":\\"1\\",\\"lives\\":[]}"}')
check("result 包装层被剥掉", isinstance(nested, dict) and nested.get("status") == "1")

content = _as_payload([{"type": "text", "text": '{"status":"1","pois":[]}'}])
check("MCP content 数组取 text", isinstance(content, dict) and content.get("pois") == [])

check("纯文本返回不炸，返回 None", _as_payload("服务器开小差了") is None)
check("空串返回 None", _as_payload("") is None)


# ============ 2. 坐标 ============

print("\n---- 2. _parse_lnglat ----")
loc = _parse_lnglat("116.397128,39.916527")
check("正常经纬度解析",
      loc is not None and abs(loc.longitude - 116.397128) < 1e-6
      and abs(loc.latitude - 39.916527) < 1e-6,
      repr(loc))
check("空串返回 None", _parse_lnglat("") is None)
check("格式错误返回 None", _parse_lnglat("116.39") is None)
check("非数字返回 None", _parse_lnglat("东经,北纬") is None)


# ============ 3. POI ============

print("\n---- 3. _parse_pois ----")
pois = _parse_pois(_as_payload(POI_TEXT_SEARCH))
check("无坐标的脏数据被丢弃", len(pois) == 1, f"实际 {len(pois)} 条")
if pois:
    p = pois[0]
    check("name 正确", p.name == "故宫博物院", p.name)
    check("address 正确", p.address == "景山前街4号", p.address)
    check("tel 正确", p.tel == "010-85007421", str(p.tel))
    check("经纬度正确",
          abs(p.location.longitude - 116.397128) < 1e-6
          and abs(p.location.latitude - 39.916527) < 1e-6)

    # address 缺失时用省市区兜底（pname 与 cityname 重复时只保留一份）
    missing_addr = _parse_pois({"pois": [{
        "id": "X", "name": "某美食城", "type": "餐饮", "location": "121.47,31.23",
        "pname": "上海市", "cityname": "上海市", "adname": "黄浦区",
    }]})
    check("address 缺失时回退为省市区拼接（自动去重）",
          bool(missing_addr) and missing_addr[0].address == "上海市黄浦区",
          missing_addr[0].address if missing_addr else "空")


# ============ 4. 天气 ============

print("\n---- 4. _parse_weather ----")
casts = _parse_weather(_as_payload(WEATHER_FORECAST))
check("预报模式解析出 2 天", len(casts) == 2, f"实际 {len(casts)}")
if len(casts) == 2:
    check("日期正确", casts[0].date == "2026-09-22", casts[0].date)
    check("白天天气正确", casts[0].day_weather == "晴", casts[0].day_weather)
    check("夜间天气正确", casts[0].night_weather == "多云", casts[0].night_weather)
    check("温度字符串被转成数字", casts[0].day_temp == 28 and casts[0].night_temp == 22,
          f"{casts[0].day_temp}/{casts[0].night_temp}")
    check("风向风力正确",
          casts[1].wind_direction == "东北" and casts[1].wind_power == "3-4")

lives = _parse_weather(_as_payload(WEATHER_LIVE))
check("实况模式解析出 1 条", len(lives) == 1, f"实际 {len(lives)}")
if lives:
    check("实况温度正确", lives[0].day_temp == 27 and lives[0].night_temp == 27,
          f"{lives[0].day_temp}/{lives[0].night_temp}")
    check("实况日期取 reporttime 前 10 位", lives[0].date == "2026-09-21", lives[0].date)


# ============ 5. 路线 ============

print("\n---- 5. _parse_route ----")
walk = _parse_route(_as_payload(ROUTE_WALKING), "walking")
check("步行距离转成数字", walk.get("distance") == 1200.0, repr(walk))
check("步行时长转成整数秒", walk.get("duration") == 960, repr(walk))
check("route_type 透传", walk.get("route_type") == "walking")

transit = _parse_route(_as_payload(ROUTE_TRANSIT), "transit")
check("公交距离正确", transit.get("distance") == 6200.0, repr(transit))
check("公交描述含票价与步行", "3.0 元" in (transit.get("description") or ""),
      transit.get("description") or "")
check("空 route 返回 {}", _parse_route({}, "walking") == {})


# ============ 6. travel_days 收敛 ============

print("\n---- 6. TripRequest.travel_days 以日期为准 ----")

base = dict(city="上海", transportation="公共交通",
            accommodation="经济型酒店", preferences=["历史文化"])

r = TripRequest(start_date="2026-09-22", end_date="2026-09-24", **base)
check("不传 travel_days 时按日期算出 3 天", r.travel_days == 3, str(r.travel_days))

r = TripRequest(start_date="2026-09-22", end_date="2026-09-24", travel_days=1, **base)
check("客户端传错（1 天）被日期纠正为 3 天", r.travel_days == 3, str(r.travel_days))

r = TripRequest(start_date="2026-09-22", end_date="2026-09-22", **base)
check("单日行程算 1 天", r.travel_days == 1, str(r.travel_days))

for name, kwargs, expect in [
    ("结束早于开始被判非法",
     dict(start_date="2026-09-24", end_date="2026-09-22"), "结束日期不能早于开始日期"),
    ("超过 30 天被判非法",
     dict(start_date="2026-01-01", end_date="2026-03-01"), "不能超过 30 天"),
    ("日期格式非法被判非法",
     dict(start_date="2026/09/22", end_date="2026-09-24"), "YYYY-MM-DD"),
]:
    try:
        TripRequest(**base, **kwargs)
        check(name, False, "竟然没报错")
    except Exception as exc:
        check(name, expect in str(exc), str(exc)[:160])


# ============ 汇总 ============

print("\n" + "=" * 46)
print(f"通过 {_passed} 项，失败 {_failed} 项")
print("=" * 46)
sys.exit(0 if _failed == 0 else 1)
