"""数据模型定义"""

from typing import List, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from datetime import date


MAX_TRAVEL_DAYS = 30


# ============ 请求模型 ============

class TripRequest(BaseModel):
    """旅行规划请求"""
    city: str = Field(..., description="目的地城市", json_schema_extra={"example": "北京"})
    start_date: str = Field(..., description="开始日期 YYYY-MM-DD", json_schema_extra={"example": "2025-06-01"})
    end_date: str = Field(..., description="结束日期 YYYY-MM-DD", json_schema_extra={"example": "2025-06-03"})
    travel_days: Optional[int] = Field(
        default=None,
        description="旅行天数；**服务端会按日期区间重算并以此为准**，客户端可不传",
        ge=1, le=MAX_TRAVEL_DAYS, json_schema_extra={"example": 3})
    transportation: str = Field(..., description="交通方式", json_schema_extra={"example": "公共交通"})
    accommodation: str = Field(..., description="住宿偏好", json_schema_extra={"example": "经济型酒店"})
    preferences: List[str] = Field(default=[], description="旅行偏好标签", json_schema_extra={"example": ["历史文化", "美食"]})
    free_text_input: Optional[str] = Field(default="", description="额外要求", json_schema_extra={"example": "希望多安排一些博物馆"})

    @model_validator(mode="after")
    def _derive_travel_days(self):
        """以日期区间为唯一真相推导 travel_days。

        为什么要在这里兜：Web 版与小程序版各自用「结束 - 开始 + 1」算出天数再传给
        后端，后端又独立接收一份 —— 同一个事实有两处真相，一旦两边差一天，模型
        就会按错的天数生成行程，而用户看到的是自己选的日期。收敛为「服务端按日期
        重算」后，客户端传什么都不影响结果；若传了且不一致只打日志，方便发现客
        户端 bug 而不影响线上可用性。
        """
        try:
            start = date.fromisoformat(self.start_date)
            end = date.fromisoformat(self.end_date)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"日期格式需为 YYYY-MM-DD：{exc}")

        days = (end - start).days + 1
        if days < 1:
            raise ValueError("结束日期不能早于开始日期")
        if days > MAX_TRAVEL_DAYS:
            raise ValueError(f"旅行天数不能超过 {MAX_TRAVEL_DAYS} 天（当前 {days} 天）")

        if self.travel_days is not None and self.travel_days != days:
            print(
                f"⚠️  客户端传的 travel_days={self.travel_days} 与日期区间不一致"
                f"（{self.start_date}~{self.end_date} 应为 {days} 天），已按日期重算"
            )
        self.travel_days = days
        return self

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "city": "北京",
                "start_date": "2025-06-01",
                "end_date": "2025-06-03",
                "travel_days": 3,
                "transportation": "公共交通",
                "accommodation": "经济型酒店",
                "preferences": ["历史文化", "美食"],
                "free_text_input": "希望多安排一些博物馆"
            }
        }
    )


class POISearchRequest(BaseModel):
    """POI搜索请求"""
    keywords: str = Field(..., description="搜索关键词", json_schema_extra={"example": "故宫"})
    city: str = Field(..., description="城市", json_schema_extra={"example": "北京"})
    citylimit: bool = Field(default=True, description="是否限制在城市范围内")


class RouteRequest(BaseModel):
    """路线规划请求"""
    origin_address: str = Field(..., description="起点地址", json_schema_extra={"example": "北京市朝阳区阜通东大街6号"})
    destination_address: str = Field(..., description="终点地址", json_schema_extra={"example": "北京市海淀区上地十街10号"})
    origin_city: Optional[str] = Field(default=None, description="起点城市")
    destination_city: Optional[str] = Field(default=None, description="终点城市")
    route_type: str = Field(default="walking", description="路线类型: walking/driving/transit")


# ============ 响应模型 ============

class Location(BaseModel):
    """地理位置"""
    longitude: float = Field(..., description="经度")
    latitude: float = Field(..., description="纬度")


class Attraction(BaseModel):
    """景点信息"""
    name: str = Field(..., description="景点名称")
    address: str = Field(..., description="地址")
    location: Location = Field(..., description="经纬度坐标")
    visit_duration: int = Field(..., description="建议游览时间(分钟)")
    description: str = Field(..., description="景点描述")
    category: Optional[str] = Field(default="景点", description="景点类别")
    rating: Optional[float] = Field(default=None, description="评分")
    photos: Optional[List[str]] = Field(default_factory=list, description="景点图片URL列表")
    poi_id: Optional[str] = Field(default="", description="POI ID")
    image_url: Optional[str] = Field(default=None, description="图片URL")
    ticket_price: int = Field(default=0, description="门票价格(元)")


class Meal(BaseModel):
    """餐饮信息"""
    type: str = Field(..., description="餐饮类型: breakfast/lunch/dinner/snack")
    name: str = Field(..., description="餐饮名称")
    address: Optional[str] = Field(default=None, description="地址")
    location: Optional[Location] = Field(default=None, description="经纬度坐标")
    description: Optional[str] = Field(default=None, description="描述")
    estimated_cost: int = Field(default=0, description="预估费用(元)")


class Hotel(BaseModel):
    """酒店信息"""
    name: str = Field(..., description="酒店名称")
    address: str = Field(default="", description="酒店地址")
    location: Optional[Location] = Field(default=None, description="酒店位置")
    price_range: str = Field(default="", description="价格范围")
    rating: str = Field(default="", description="评分")
    distance: str = Field(default="", description="距离景点距离")
    type: str = Field(default="", description="酒店类型")
    estimated_cost: int = Field(default=0, description="预估费用(元/晚)")


class DayPlan(BaseModel):
    """单日行程"""
    date: str = Field(..., description="日期 YYYY-MM-DD")
    day_index: int = Field(..., description="第几天(从0开始)")
    description: str = Field(..., description="当日行程描述")
    transportation: str = Field(..., description="交通方式")
    accommodation: str = Field(..., description="住宿")
    hotel: Optional[Hotel] = Field(default=None, description="推荐酒店")
    attractions: List[Attraction] = Field(default=[], description="景点列表")
    meals: List[Meal] = Field(default=[], description="餐饮列表")


class WeatherInfo(BaseModel):
    """天气信息"""
    date: str = Field(..., description="日期 YYYY-MM-DD")
    day_weather: str = Field(default="", description="白天天气")
    night_weather: str = Field(default="", description="夜间天气")
    day_temp: Union[int, str] = Field(default=0, description="白天温度")
    night_temp: Union[int, str] = Field(default=0, description="夜间温度")
    wind_direction: str = Field(default="", description="风向")
    wind_power: str = Field(default="", description="风力")

    @field_validator('day_temp', 'night_temp', mode='before')
    @classmethod
    def parse_temperature(cls, v):
        """解析温度,移除°C等单位"""
        if isinstance(v, str):
            # 移除°C, ℃等单位符号
            v = v.replace('°C', '').replace('℃', '').replace('°', '').strip()
            try:
                return int(v)
            except ValueError:
                return 0
        return v


class Budget(BaseModel):
    """预算信息"""
    total_attractions: int = Field(default=0, description="景点门票总费用")
    total_hotels: int = Field(default=0, description="酒店总费用")
    total_meals: int = Field(default=0, description="餐饮总费用")
    total_transportation: int = Field(default=0, description="交通总费用")
    total: int = Field(default=0, description="总费用")


class AILabel(BaseModel):
    """AI 生成内容标识（API 侧的机器可读部分）。

    依据《人工智能生成合成内容标识办法》，生成合成内容应包含两类标识：
    - 显式标识：面向用户的可见提示 —— 由各前端渲染（文案见 miniprogram/config/index.js）。
    - 隐式标识：便于识别的元数据 —— 即本模型，随 API 响应一起下发。

    放在响应里而不是写死在客户端的价值：客户端拿到的是「这段内容是否由 AI 生成」的
    事实声明（`is_ai_generated`），而不是靠约定假设；将来若引入非 AI 内容（如人工
    编辑过的行程模板），前端可以据此决定是否展示标识，无需改动代码逻辑。
    """
    is_ai_generated: bool = Field(default=True, description="本内容是否由 AI 生成")
    producer: str = Field(default="智能旅行助手", description="生成合成服务提供者名称")
    label: str = Field(default="AI 生成", description="面向用户展示的短标识")
    disclaimer: str = Field(
        default=(
            "本行程由 AI 自动生成，仅供参考，不构成出行建议；"
            "景点开放时间、票价、交通与天气请以官方最新信息为准。"
        ),
        description="免责声明全文",
    )


class TripPlan(BaseModel):
    """旅行计划"""
    city: str = Field(..., description="目的地城市")
    start_date: str = Field(..., description="开始日期")
    end_date: str = Field(..., description="结束日期")
    days: List[DayPlan] = Field(..., description="每日行程")
    weather_info: List[WeatherInfo] = Field(default=[], description="天气信息")
    overall_suggestions: str = Field(..., description="总体建议")
    budget: Optional[Budget] = Field(default=None, description="预算信息")
    # 有默认值 —— 不改变既有调用方行为，但对新客户端是可读的元数据
    ai_label: AILabel = Field(default_factory=AILabel, description="AI 生成内容标识")


class TripPlanResponse(BaseModel):
    """旅行计划响应"""
    success: bool = Field(..., description="是否成功")
    message: str = Field(default="", description="消息")
    data: Optional[TripPlan] = Field(default=None, description="旅行计划数据")


class POIInfo(BaseModel):
    """POI信息"""
    id: str = Field(..., description="POI ID")
    name: str = Field(..., description="名称")
    type: str = Field(..., description="类型")
    address: str = Field(..., description="地址")
    location: Location = Field(..., description="经纬度坐标")
    tel: Optional[str] = Field(default=None, description="电话")


class POISearchResponse(BaseModel):
    """POI搜索响应"""
    success: bool = Field(..., description="是否成功")
    message: str = Field(default="", description="消息")
    data: List[POIInfo] = Field(default=[], description="POI列表")


class RouteInfo(BaseModel):
    """路线信息"""
    distance: float = Field(..., description="距离(米)")
    duration: int = Field(..., description="时间(秒)")
    route_type: str = Field(..., description="路线类型")
    description: str = Field(..., description="路线描述")


class RouteResponse(BaseModel):
    """路线规划响应"""
    success: bool = Field(..., description="是否成功")
    message: str = Field(default="", description="消息")
    data: Optional[RouteInfo] = Field(default=None, description="路线信息")


class WeatherResponse(BaseModel):
    """天气查询响应"""
    success: bool = Field(..., description="是否成功")
    message: str = Field(default="", description="消息")
    data: List[WeatherInfo] = Field(default=[], description="天气信息")


# ============ 错误响应 ============

class ErrorResponse(BaseModel):
    """错误响应"""
    success: bool = Field(default=False, description="是否成功")
    message: str = Field(..., description="错误消息")
    error_code: Optional[str] = Field(default=None, description="错误代码")

