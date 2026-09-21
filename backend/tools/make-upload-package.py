"""生成微信云托管的「手动上传代码包」。

为什么需要这个脚本
------------------
云托管上传有两条硬约束，手工操作很容易踩：

1. **文件夹或 zip 都不能超过 2 MiB** —— 而 `backend/venv/` 实测有 280 MB。
   直接选 `backend/` 目录上传必然超限，且失败信息不一定说得清是体积问题。
2. **构建根目录必须能直接看到 `Dockerfile`** —— 本项目的 `Dockerfile` 在 `backend/` 子目录，
   所以 zip 里的路径**不能带 `backend/` 前缀**，否则平台在根目录找不到它。

这个脚本一次生成两个等价产物，覆盖控制台里的两种上传方式：

- `trip-api-upload.zip` —— 「上传方式 = 压缩包」用（推荐，体积小）
- `backend-deploy/`    —— 「上传方式 = 文件夹」用（免得手滑把 venv 拖进去）

用法（在仓库根目录执行）::

    python backend/tools/make-upload-package.py

两者都是 `backend/` 的子集，属构建产物，已在根 `.gitignore` 中忽略。
**改了 `backend/` 下的任何源码后，都要重新执行一次**，否则传上去的还是旧代码。
"""

from __future__ import annotations

import os
import shutil
import sys
import zipfile

# 只带这些进构建上下文。不要加 `tests/`（本地跑就够了）、不要加 `.env`。
INCLUDE = ["Dockerfile", ".dockerignore", "requirements.txt", "run.py", "app"]

# 这些目录/文件名一律跳过（venv 不在 INCLUDE 里，天然被排除）
SKIP_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache", "tests"}
SKIP_SUFFIXES = (".pyc", ".pyo")

# 官方上限：文件夹或 zip 里的代码不能超过 2 MiB
SIZE_LIMIT = 2 * 1024 * 1024

# 绝不能出现在包里的东西 —— 出现就直接失败，而不是打个警告了事
FORBIDDEN = {
    ".env",
    ".env.local",
    ".env.production",
    "id_rsa",
    # 有人会把云托管的环境变量 JSON 填成真实密钥后落到这里
    "env.cloudrun.json",
}


def repo_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))          # backend/tools
    return os.path.dirname(os.path.dirname(here))              # 仓库根


def collect() -> list[tuple[str, str]]:
    """返回 [(绝对路径, 包内相对路径)]，相对路径不带 `backend/` 前缀。"""
    backend = os.path.join(repo_root(), "backend")
    pairs: list[tuple[str, str]] = []

    for item in INCLUDE:
        src = os.path.join(backend, item)
        if not os.path.exists(src):
            raise SystemExit(f"❌ 缺少必需项：{src}")

        if os.path.isfile(src):
            pairs.append((src, item))
            continue

        for root, dirs, files in os.walk(src):
            # 原地过滤，os.walk 才会跳过这些子树
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for fn in files:
                if fn.endswith(SKIP_SUFFIXES):
                    continue
                abs_path = os.path.join(root, fn)
                rel = os.path.relpath(abs_path, backend).replace("\\", "/")
                pairs.append((abs_path, rel))

    return sorted(pairs, key=lambda p: p[1])


def main() -> int:
    root = repo_root()
    pairs = collect()

    # ---------- 安全检查：绝不把密钥打进包 ----------
    bad = [rel for _, rel in pairs if os.path.basename(rel) in FORBIDDEN]
    if bad:
        raise SystemExit(f"❌ 包里出现了不该有的文件，已中止：{bad}")

    if not any(rel == "Dockerfile" for _, rel in pairs):
        raise SystemExit("❌ 包根目录没有 Dockerfile —— 云托管会在根目录找它，构建必然失败")
    if not any(rel.startswith("app/") for _, rel in pairs):
        raise SystemExit("❌ 包里没有 app/ 源码")

    total = sum(os.path.getsize(p) for p, _ in pairs)
    print(f"源：{os.path.join(root, 'backend')}")
    print(f"共 {len(pairs)} 个文件，未压缩 {total / 1024:.1f} KB")

    # ---------- 产物 1：zip ----------
    zip_path = os.path.join(root, "trip-api-upload.zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for abs_path, rel in pairs:
            # arcname 就是 rel（不带 backend/ 前缀）—— 这是关键
            zf.write(abs_path, rel)
    zip_size = os.path.getsize(zip_path)

    # ---------- 产物 2：干净文件夹 ----------
    dir_path = os.path.join(root, "backend-deploy")
    if os.path.isdir(dir_path):
        shutil.rmtree(dir_path)
    for abs_path, rel in pairs:
        dst = os.path.join(dir_path, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(abs_path, dst)

    # ---------- 校验 ----------
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        assert "Dockerfile" in names, "Dockerfile 不在 zip 根目录"
        assert not any(n.startswith("backend/") for n in names), "arcname 不该带 backend/ 前缀"

    print(f"\n✅ {os.path.relpath(zip_path, root)}   {zip_size / 1024:.1f} KB")
    print(f"✅ {os.path.relpath(dir_path, root)}/   {len(pairs)} 个文件")
    print(f"   体积上限 {SIZE_LIMIT / 1024 / 1024:.0f} MiB —— "
          f"两者均占用 {zip_size / SIZE_LIMIT * 100:.1f}% / {total / SIZE_LIMIT * 100:.1f}%")
    print("\n控制台填法：选择方式=手动上传代码包，端口=80，目标目录留空，"
          "Dockerfile 文件=有、名称=Dockerfile")
    print("环境变量见 backend/DEPLOY-CLOUDRUN.md 第 4 节（⚠️ 不要填 PORT / GATEWAY_SECRET）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
