/**
 * 错误翻译单测（离线，不需要开发者工具）
 *
 * 覆盖两个模块 —— 它们的共同职责是「把底层又长又脏的报错变成一句能读的话」：
 *   utils/request.js    → wx.request / wx.cloud.callFunction / callContainer
 *   utils/cloudStore.js → 云数据库
 *
 * 做法：用 vm 把模块源码加载进沙箱（stub 掉 config、wx、getApp），
 * 再把内部的翻译函数暴露出来直接调。不改动业务文件，也不依赖任何 wx API。
 *
 * 样本全部来自**实测抓到的原文**，这是本测试最有价值的地方：
 * 只凭想象写样本，正好会漏掉真实文案与预期的差异
 * （已经踩过两次：`could not be found` 不含 `not found`；集合报错没有 `-502005`）。
 *
 * 用法（在 miniprogram/ 目录下）：
 *   node tools/test-error-translate.js
 * 退出码：0=全通过，1=有失败
 */

var fs = require('fs')
var path = require('path')
var vm = require('vm')

// tools/ 的上一级就是 miniprogram 目录本身
var MINI = path.resolve(__dirname, '..')

var CONFIG_STUB = {
  BASE_URL: 'http://localhost:8000',
  REQUEST_TIMEOUT: 115000,
  TRANSPORT: 'direct',
  CLOUD_PROXY_NAME: 'proxyTrip',
  CLOUD_CONTAINER_SERVICE: 'trip-api',
  CLOUD_CONTAINER_ENV: '',
  CLOUD_ENV: 'cloud1-test',
  USE_CLOUD_DB: true
}

/**
 * 把某个模块加载进沙箱，并取出它内部挂出来的 __test
 */
function loadHelpers(file) {
  var src = fs.readFileSync(file, 'utf8')
  src += '\nmodule.exports.__test = {' +
    ' summarizeRaw: typeof summarizeRaw === "function" ? summarizeRaw : null,' +
    ' describeError: typeof describeError === "function" ? describeError : null,' +
    ' describeCloudError: typeof describeCloudError === "function" ? describeCloudError : null,' +
    ' describeDbError: typeof describeDbError === "function" ? describeDbError : null,' +
    ' resolveContainerEnv: typeof resolveContainerEnv === "function" ? resolveContainerEnv : null,' +
    ' shorten: typeof shorten === "function" ? shorten : null' +
    ' }\n'

  var sandbox = {
    module: { exports: {} },
    exports: {},
    console: { log: function () { }, warn: function () { }, error: function () { } },
    Promise: Promise,
    setTimeout: setTimeout,
    wx: {},
    getApp: function () { return { globalData: {} } },
    require: function (p) {
      if (String(p).indexOf('config') > -1) {
        return CONFIG_STUB
      }
      throw new Error('未预期的 require: ' + p)
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: file })
  return sandbox.module.exports.__test
}

/* ---------------- 实测样本 ---------------- */

// 实测抓到的原文：云函数未部署时的报错
var REAL_CF_NOT_DEPLOYED = 'cloud.callFunction:fail Error: errCode: -501000  | errMsg: FunctionName parameter could not be found. ' +
  '更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/FUNCTION_NOT_FOUND ' +
  '(callId: 1789984221103-0.2341688870712747) ' +
  '(trace: 17:50:21 start->17:50:21 system error (Error: errCode: -501000  | errMsg: FunctionName parameter could not be found. ' +
  '更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/FUNCTION_NOT_FOUND), abort)'

// 实测抓到的原文：集合未建时的报错
var REAL_DB_NO_COLLECTION = '[ResourceNotFound] Db or Table not exist: trips. Please check your request, ' +
  'but if the problem cannot be solved, contact us. ' +
  '更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/DATABASE_COLLECTION_NOT_EXIST'

var UNMAPPED_CLOUD = 'cloud.callFunction:fail Error: errCode: -501999 | errMsg: 后端服务暂时不可用 ' +
  '更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/UNKNOWN ' +
  '(callId: 1789984221103-0.99) (trace: 17:50:21 start->17:50:21 system error), abort'

// 实测抓到的原文：云托管 callContainer 冷启动首调失败（2026-09-22 16:43）。
// 两个值得注意的形态，都是这里必须锁住的：
//   1. 错误码写的是 `code: 102002`，**不是** `errCode:` —— 只认 errCode 会整段丢掉；
//   2. 前缀是 `cloud.callContainer:fail`，且 errMsg 由**两层拼接**而成，
//      所以同一个前缀出现两次、错误码也出现两次。
var REAL_CC_COLDSTART = 'cloud.callContainer:fail 102002 . ' +
  'cloud.callContainer:fail system error. code: 102002'

var tests = []
var failed = 0

function check(name, actual, asserts) {
  var problems = []
  for (var i = 0; i < asserts.length; i++) {
    var msg = asserts[i](actual)
    if (msg) problems.push(msg)
  }
  if (problems.length) {
    failed++
    tests.push('FAIL  ' + name)
    tests.push('      实际输出 = ' + JSON.stringify(actual))
    for (var j = 0; j < problems.length; j++) tests.push('      ' + problems[j])
  } else {
    tests.push('PASS  ' + name)
    tests.push('      输出 = ' + JSON.stringify(actual))
  }
}

function notContains(s) {
  return function (v) { return String(v).indexOf(s) > -1 ? ('不应包含 ' + JSON.stringify(s)) : '' }
}
function contains(s) {
  return function (v) { return String(v).indexOf(s) > -1 ? '' : ('应包含 ' + JSON.stringify(s)) }
}
function maxLen(n) {
  return function (v) { return String(v).length <= n ? '' : ('长度 ' + String(v).length + ' 超过上限 ' + n) }
}
function equals(expected) {
  return function (v) {
    return String(v) === String(expected) ? '' : ('应为 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(v))
  }
}
function occursExactlyTimes(s, n) {
  return function (v) {
    var count = String(v).split(s).length - 1
    return count === n ? '' : ('应出现 ' + n + ' 次 ' + JSON.stringify(s) + '，实际 ' + count + ' 次')
  }
}

function main() {
  var req
  var cs
  try {
    req = loadHelpers(path.join(MINI, 'utils', 'request.js'))
    cs = loadHelpers(path.join(MINI, 'utils', 'cloudStore.js'))
  } catch (e) {
    console.log('加载模块失败: ' + ((e && e.stack) || e))
    process.exit(1)
  }

  tests.push('模块 1 = utils/request.js')
  tests.push('模块 2 = utils/cloudStore.js')
  tests.push('')

  /* ================= request.js ================= */

  tests.push('── request.js ──')

  check('describeCloudError(云函数未部署) → 可操作提示', req.describeCloudError({ errMsg: REAL_CF_NOT_DEPLOYED }), [
    contains('云函数'),
    contains('上传并部署'),
    notContains('callId'),
    notContains('https://'),
    maxLen(120)
  ])

  check('describeCloudError(未映射) → 清洗兜底', req.describeCloudError({ errMsg: UNMAPPED_CLOUD }), [
    contains('-501999'),
    contains('后端服务暂时不可用'),
    notContains('callId'),
    notContains('trace:'),
    notContains('https://'),
    notContains('callFunction'),
    notContains('errMsg:'),
    notContains('abort'),
    maxLen(120)
  ])

  check('summarizeRaw(原始长报错) → 短摘要', req.summarizeRaw(REAL_CF_NOT_DEPLOYED), [
    contains('-501000'),
    contains('FunctionName'),
    notContains('callId'),
    notContains('trace:'),
    notContains('https://'),
    notContains('callFunction'),
    notContains('errMsg:'),
    maxLen(110)
  ])

  check('summarizeRaw(云托管冷启动首调失败·实测原文) → 抽出 102002', req.summarizeRaw(REAL_CC_COLDSTART), [
    contains('（102002）'),
    contains('system error'),
    occursExactlyTimes('102002', 1),
    notContains('callContainer'),
    notContains('errCode'),
    notContains('code:'),
    maxLen(110)
  ])

  check('describeError(未知直连错误) → 清洗兜底', req.describeError({
    errMsg: 'request:fail some weird internal thing (trace: a->b) (callId: 123) https://example.com/x'
  }), [
    notContains('callId'),
    notContains('https://'),
    notContains('request:fail'),
    maxLen(120)
  ])

  check('describeError(超时) → 原提示保留', req.describeError({ errMsg: 'request:fail timeout' }), [
    contains('生成超时')
  ])

  check('describeError(合法域名) → 原提示保留', req.describeError({ errMsg: 'request:fail url not in domain list' }), [
    contains('合法域名')
  ])

  check('describeCloudError(超时) → 原提示保留', req.describeCloudError({ errMsg: 'cloud.callFunction:fail timeout' }), [
    contains('3 秒')
  ])

  /* ---- 云托管：callContainer 的 config.env 取自哪个环境 ID ---- */

  tests.push('')
  tests.push('── callContainer 的环境 ID ──')

  // 背景：微信云托管与微信云开发是两套独立体系（官方 FAQ），环境 ID 来自不同控制台。
  // 早期版本把云开发环境 ID 直接喂给 callContainer，属于双份真相 —— 这一组用例把它钉住。

  CONFIG_STUB.CLOUD_CONTAINER_ENV = 'prod-abc123456'
  check('resolveContainerEnv(已单独配置) → 用云托管环境 ID', req.resolveContainerEnv(), [
    equals('prod-abc123456'),
    notContains('cloud1-')
  ])

  CONFIG_STUB.CLOUD_CONTAINER_ENV = ''
  check('resolveContainerEnv(未配置) → 回退云开发环境 ID', req.resolveContainerEnv(), [
    equals('cloud1-test')
  ])
  CONFIG_STUB.CLOUD_CONTAINER_ENV = ''

  /* ================= cloudStore.js ================= */

  tests.push('')
  tests.push('── cloudStore.js ──')

  check('describeDbError(集合不存在·实测原文) → 可操作提示', cs.describeDbError({ errMsg: REAL_DB_NO_COLLECTION }), [
    contains('trips'),
    contains('新建集合'),
    contains('仅创建者可读写'),
    notContains('ResourceNotFound'),
    notContains('https://'),
    notContains('contact us'),
    maxLen(120)
  ])

  check('describeDbError(集合不存在·错误码形式) → 同样命中', cs.describeDbError({ errMsg: 'errCode: -502005' }), [
    contains('新建集合')
  ])

  check('describeDbError(权限不足) → 指向权限设置', cs.describeDbError({ errMsg: 'errCode: -502003 permission denied' }), [
    contains('权限'),
    contains('仅创建者可读写')
  ])

  check('describeDbError(未映射) → 清洗兜底且去链接', cs.describeDbError({
    errMsg: 'some unknown db failure 更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/WHATEVER'
  }), [
    contains('云数据库操作失败'),
    notContains('https://'),
    maxLen(120)
  ])

  check('shorten(普通长文本) → 截断加省略号', cs.shorten('啊'.repeat(200), 20), [
    maxLen(30)
  ])

  /* ================= 边界 ================= */

  tests.push('')
  try {
    req.summarizeRaw('')
    req.describeCloudError({})
    req.describeError({})
    cs.describeDbError({})
    cs.shorten('')
    tests.push('PASS  空输入不抛异常')
  } catch (e) {
    failed++
    tests.push('FAIL  空输入抛异常: ' + e.message)
  }

  tests.push('')
  tests.push('----------------------------------------')
  tests.push(failed ? ('结果：' + failed + ' 项失败') : '结果：全部通过')

  console.log(tests.join('\n'))
  process.exit(failed ? 1 : 0)
}

main()
