"""配置管理模块"""

import os
from pathlib import Path
from typing import List
from pydantic_settings import BaseSettings
from dotenv import load_dotenv

# 加载环境变量
# 首先尝试加载当前目录的.env
load_dotenv()

# 然后尝试加载HelloAgents的.env(如果存在)
helloagents_env = Path(__file__).parent.parent.parent.parent / "HelloAgents" / ".env"
if helloagents_env.exists():
    load_dotenv(helloagents_env, override=False)  # 不覆盖已有的环境变量


class Settings(BaseSettings):
    """应用配置"""

    # 应用基本配置
    app_name: str = "HelloAgents智能旅行助手"
    app_version: str = "1.0.0"
    debug: bool = False

    # 服务器配置
    host: str = "0.0.0.0"
    port: int = 8000

    # CORS配置 - 使用字符串,在代码中分割
    cors_origins: str = "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000"

    # 高德地图API配置
    amap_api_key: str = ""

    # Unsplash API配置
    unsplash_access_key: str = ""
    unsplash_secret_key: str = ""

    # LLM配置 (从环境变量读取,由HelloAgents管理)
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4"

    # 日志配置
    log_level: str = "INFO"

    # ---------------- 访问控制 ----------------
    # off      : 全部放行（本地开发默认）
    # api_key  : 校验 X-API-Key 或 Authorization: Bearer
    # openid   : 取微信云托管注入的 X-WX-OPENID 作为身份（小程序部署场景）
    auth_mode: str = "off"

    # api_key 模式下允许的密钥，逗号分隔（便于轮换期同时保留新旧两个）
    api_keys: str = ""

    # openid 模式下可选：若配置了，则额外要求 X-Gateway-Secret 匹配。
    # 必要性：X-WX-OPENID 由云托管网关注入，但若服务同时可从公网直连，
    # 该请求头是可被伪造的，此时必须再加一层只有网关/客户端知道的密钥。
    gateway_secret: str = ""

    # 限流：按身份维度、每分钟允许的请求数
    rate_limit_per_minute: int = 30
    # 「生成行程」是昂贵端点（4 个 Agent + LLM + 高德配额），单独收紧
    rate_limit_plan_per_minute: int = 6

    # 生产环境建议关闭 /docs 与 /redoc，减少信息暴露
    enable_docs: bool = True

    class Config:
        env_file = ".env"
        case_sensitive = False
        extra = "ignore"  # 忽略额外的环境变量

    def get_cors_origins_list(self) -> List[str]:
        """获取CORS origins列表"""
        return [origin.strip() for origin in self.cors_origins.split(',')]

    def get_api_keys_list(self) -> List[str]:
        """获取允许的 API Key 列表（已去空白、过滤空项）"""
        return [k.strip() for k in self.api_keys.split(',') if k.strip()]


# 创建全局配置实例
settings = Settings()


def get_settings() -> Settings:
    """获取配置实例"""
    return settings


# 验证必要的配置
def validate_config():
    """验证配置是否完整"""
    errors = []
    warnings = []

    if not settings.amap_api_key:
        errors.append("AMAP_API_KEY未配置")

    # HelloAgentsLLM会自动从LLM_API_KEY读取,不强制要求OPENAI_API_KEY
    llm_api_key = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not llm_api_key:
        warnings.append("LLM_API_KEY或OPENAI_API_KEY未配置,LLM功能可能无法使用")

    if errors:
        error_msg = "配置错误:\n" + "\n".join(f"  - {e}" for e in errors)
        raise ValueError(error_msg)

    # 访问控制相关的配置自检
    auth_mode = (settings.auth_mode or "off").strip().lower()
    if auth_mode not in ("off", "api_key", "openid"):
        raise ValueError(
            f"配置错误:\n  - AUTH_MODE 取值非法: {settings.auth_mode}（应为 off / api_key / openid）"
        )

    if auth_mode == "api_key" and not settings.get_api_keys_list():
        raise ValueError("配置错误:\n  - AUTH_MODE=api_key 但未配置 API_KEYS，所有请求都会被拒绝")

    if auth_mode == "off":
        warnings.append(
            "AUTH_MODE=off —— 当前任何人都能调用本服务（会消耗 LLM 与高德配额）。"
            "对外部署请设为 api_key 或 openid"
        )
    if auth_mode == "openid" and not settings.gateway_secret:
        warnings.append(
            "AUTH_MODE=openid 但未配置 GATEWAY_SECRET —— 若本服务可从公网直连，"
            "X-WX-OPENID 可被伪造，建议补上该密钥"
        )
    if settings.enable_docs and not settings.debug:
        warnings.append("非调试模式下仍开放 /docs 与 /redoc，对外部署建议设 ENABLE_DOCS=false")

    if warnings:
        print("\n⚠️  配置警告:")
        for w in warnings:
            print(f"  - {w}")

    return True


# 打印配置信息(用于调试)
def print_config():
    """打印当前配置(隐藏敏感信息)"""
    print(f"应用名称: {settings.app_name}")
    print(f"版本: {settings.app_version}")
    print(f"服务器: {settings.host}:{settings.port}")
    print(f"高德地图API Key: {'已配置' if settings.amap_api_key else '未配置'}")

    # 检查LLM配置
    llm_api_key = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
    llm_base_url = os.getenv("LLM_BASE_URL") or settings.openai_base_url
    llm_model = os.getenv("LLM_MODEL_ID") or settings.openai_model

    print(f"LLM API Key: {'已配置' if llm_api_key else '未配置'}")
    print(f"LLM Base URL: {llm_base_url}")
    print(f"LLM Model: {llm_model}")
    print(f"日志级别: {settings.log_level}")

    # 访问控制状态（便于确认「防护到底开没开」）
    auth_mode = (settings.auth_mode or "off").strip().lower()
    auth_desc = {
        "off": "关闭（任何人可调用）",
        "api_key": f"API Key（已配置 {len(settings.get_api_keys_list())} 个）",
        "openid": "微信 openid" + ("+网关密钥" if settings.gateway_secret else "（无网关密钥）"),
    }.get(auth_mode, f"未知({settings.auth_mode})")
    print(f"访问控制: {auth_desc}")
    print(f"限流: {settings.rate_limit_per_minute} 次/分（生成行程 {settings.rate_limit_plan_per_minute} 次/分）")
    print(f"API 文档: {'已开启' if settings.enable_docs else '已关闭'}")

