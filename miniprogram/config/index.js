/**
 * 全局配置 —— 小程序端所有「环境相关」的取值都集中在这里，改一处即可切换部署形态。
 *
 * 注意：不使用可选链（?.）与空值合并（??），以兼容较低基础库版本。
 */

/* ============================================================
 * 1. 传输方式（最重要的开关）
 * ============================================================
 *
 * 'direct'          —— wx.request 直连后端。本地开发默认用这个。
 *                      限制：开发者工具需勾选「不校验合法域名」；
 *                      真机体验版/正式版必须是 https 且已在后台登记 request 合法域名。
 *
 * 'cloud-function'  —— 经云函数 proxyTrip 中转，绕开合法域名限制。
 *                      前提：后端必须公网可访问，且云函数超时已调到 60s。
 *                      详见 cloudfunctions/proxyTrip/index.js 顶部说明。
 *
 * 'cloud-container' —— 经微信云托管 callContainer 调用（后端部署在 CloudBase 云托管时）。
 *                      这是最省事的生产方案：callContainer 不走 request 合法域名校验。
 */
var TRANSPORT = 'direct'

/* ============================================================
 * 2. 直连模式（direct）
 * ============================================================ */

// 后端服务地址（结尾不要带 /）
var BASE_URL = 'http://localhost:8000'

// 接口超时时间（毫秒）
// 多智能体规划「并行检索 + 行程生成」实测 17~25s，默认 60s 余量偏小，
// 这里放宽到 115s（wx.request 允许的上限附近）。
var REQUEST_TIMEOUT = 115000

/* ============================================================
 * 3. 云函数中转模式（cloud-function）
 * ============================================================ */

// 云函数目录名，必须与 cloudfunctions/ 下的文件夹名完全一致（大小写敏感）
var CLOUD_PROXY_NAME = 'proxyTrip'

/* ============================================================
 * 4. 云托管模式（cloud-container）
 * ============================================================ */

// 云托管服务名，对应 callContainer 请求头 X-WX-SERVICE 的值
var CLOUD_CONTAINER_SERVICE = 'trip-api'

// 云开发环境 ID（微信云开发 / CloudBase）
// 这里是小程序端唯一的环境 ID 来源，app.js 的 globalData.env 由它派生。
var CLOUD_ENV = 'cloud1-d5gan8twf7e51b2cf'

/* ============================================================
 * 5. 云数据库（行程跨设备可见）
 * ============================================================
 *
 * 开启后：行程会额外存一份到云数据库集合 `trips`，
 * 换设备 / 重装后仍能看到自己生成过的行程。
 *
 * 前置条件（只做一次）：
 *   云开发控制台 → 数据库 → 新建集合「trips」→ 权限选「仅创建者可读写」。
 *   集合不存在时**不会报错阻断**，只是自动退化为纯本地缓存
 *   （Console 里会给一条提示，见 utils/cloudStore.js）。
 *
 * 关掉这个开关即可完全回到「纯本地」行为。
 */
var USE_CLOUD_DB = true

module.exports = {
  TRANSPORT: TRANSPORT,

  BASE_URL: BASE_URL,
  REQUEST_TIMEOUT: REQUEST_TIMEOUT,

  CLOUD_PROXY_NAME: CLOUD_PROXY_NAME,

  CLOUD_CONTAINER_SERVICE: CLOUD_CONTAINER_SERVICE,
  CLOUD_ENV: CLOUD_ENV,

  USE_CLOUD_DB: USE_CLOUD_DB
}
