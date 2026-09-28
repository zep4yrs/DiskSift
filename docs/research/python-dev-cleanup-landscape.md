# Python / Dev-tool 清理生态调研

> 用途：为 pinkbin 的 conda / pip / python tmp / venv 等 scaffold 设计提供 GitHub 同类工具对照。
> 调研日期：2026-05-04
> 范围：gap-driven，聚焦 pinkbin 当前薄/缺的领域（conda envs、python tmp、orphan venv、pip 残留）

---

## 1. Python 生态

### 1.1 Conda environments 清理

#### 1.1.1 GitHub 项目对照表

| name | stars | last push | scope | 红线声明 | dry-run | URL |
|---|---|---|---|---|---|---|
| `Tlaloc-Es/killpy` | 109 | 2026-04 | venv / conda envs / pipx / poetry / pyenv / hatch / uv / tox / cache / artifacts（11 类） | 用 `⚠️` 标记当前 Python session 正在使用的 env，不阻止删除但提示 | 有（`killpy delete --dry-run`） | https://github.com/Tlaloc-Es/killpy |
| `nunombispo/venv-analyzer` | 1 | 2025-06 | venv 系列（含 `.venv` / `env` / `pyenv` 文件夹名） | 双重确认（先 y 再输 `DELETE`）；不显式区分 conda envs | 否（只有 `--auto-delete` / `--clean-unused`） | https://github.com/nunombispo/venv-analyzer |
| `trevor-moon/conda-remove-envs` | 0 | 2022-01 | 调用 `conda env remove` 批量删除指定 env 列表 | 依赖 conda 自身的"激活态拒删"语义 | 委托 `conda env remove --dry-run` | https://github.com/trevor-moon/conda-remove-envs |
| `bittner/pyclean` | 90 | 2026-04 | bytecode + debris（不动 envs；可选 `--debris tox` 清 `.tox/`） | `--erase` 自由 glob 强制 interactive；`.git` 等 VCS 目录隐式跳过 | 有（`--dry-run`） | https://github.com/bittner/pyclean |
| `thombashi/cleanpy` | 19 | 2026-04 | bytecode + cache + 可选 `--include-envs`（`.venv` / `.tox` / `.nox`） | 永远跳过 `.git` / `.hg` / `.svn` / `node_modules`；不触 conda envs | 有（`--dry-run` + `--list`） | https://github.com/thombashi/cleanpy |

**通用清理软件覆盖情况**：
- **BleachBit**（4.6.0，社区主流）：Python/conda/pip 都**没有官方 cleaner**。需要用户自己写 CleanerML 或 Winapp2.ini，社区里也没看到通用配置。
- **CleanMyMac**：没有专门的 Python/conda 清理模块。
- **MegaCleaner / ClearDisk**（Mac 商业工具）：覆盖 conda envs，前者还做 "orphan venv 检测"（venv 父项目源码缺失时标 orphan），是 pinkbin 直接对标的产品形态。
- **Anaconda 官方**：只有 `conda clean`（packages cache + tarballs），从来不动 `envs/`。

#### 1.1.2 "未使用 env" 的定义（各工具实测）

`venv-analyzer` 的实现最具参考价值：
- 不只看根目录 mtime，而是检查这些**关键文件的 atime**：
  - venv 根目录本身
  - `Scripts/` 或 `bin/`
  - `pyvenv.cfg`
  - 激活脚本：`activate` / `activate.bat` / `activate.ps1`
  - `python.exe` / `bin/python`
- 任意一个被访问过就视为"在用"，全部超阈值才标 unused
- 默认阈值 30 天，CLI 可调（30 / 60 / 90）

`KillPy` 的 `--older-than DAYS` 用类似策略，但**额外**检查当前 Python 进程是否锁着这个 env（标 `⚠️`）。

**对 pinkbin 的启示**：纯 mtime 不够（用户可能只读不写就用很久），要看 atime + 多个签名文件。但 Windows NTFS 默认禁用 atime 更新（`fsutil behavior set DisableLastAccess`），需要 fallback 到 mtime。

#### 1.1.3 已知陷阱（必须写进 disclaimer）

1. **base env 绝不能动**：所有工具都隐式假设 `~/anaconda3` / `~/miniconda3` 根目录本身（不是 `envs/<name>`）是 base，不会枚举为可删项。pinkbin 的 glob 需要明确排除 `envs/` 直接子项里的 `base` —— 但 conda 的 base 不在 `envs/`，而是在 `~/miniconda3/` 本体，所以 glob `**/envs/*/` 天然不会命中 base，这点是安全的。
2. **hardlink 共享 inode**：conda 默认用 hardlink 把 `envs/<name>/lib/...` 指回 `pkgs/`。直接删 `pkgs/` 不会立刻释放空间（envs 还引用），删 envs 也只在该 env 是最后一个引用时才释放。`conda clean --packages` 只清"无 hardlink 引用"的包，**手动删 `pkgs/` 在 hardlink 配置下安全**（envs 还能跑，inode 计数器自然下降）；但**符号链接（symlink）配置下手动删 `pkgs/` 会断掉 envs**。
3. **激活中的 env**：用户在 terminal 里激活了某 env 时，Windows 会锁住 `python.exe`，删除会失败但不会损坏。Mac/Linux 删除"成功"但 shell 继续用孤儿 inode，下次激活报错。`KillPy` 的 `⚠️` 提示是好做法。
4. **跨 env 的 jupyter kernel**：Jupyter kernel 注册在 `~/.local/share/jupyter/kernels/`，删 env 后 kernel 注册不会自动清理 —— 不归 pinkbin 管，但 disclaimer 可以提一句。
5. **`conda env list` vs 文件枚举**：用 conda CLI 列表能拿到 env name 和路径，但 pinkbin 没有"调子进程"的能力（scaffold 是声明式 glob）。只能纯文件系统枚举，**会漏掉 `--prefix` 模式创建的 env**（用户用 `conda create -p /custom/path` 装到自定义路径）—— 这是声明式 scaffold 的固有局限，文档里要说明。

#### 1.1.4 对 pinkbin `scaffolds/conda.toml` 的具体改动建议

当前 `conda.toml` 只有两个 scope：`tarballs`（`**/pkgs/cache/**`）和 `unused-packages`（`**/pkgs/**` + days prompt），**完全没碰 envs/**。

建议新增：

- **新 scope: `envs-stale`**
  - glob: `**/envs/*/`（直接子项；`*/` 限定一层不进 env 内部，让删除走 recycle bin 整个 env 目录）
  - mode: `recycle`
  - prompt: `{ kind = "days", default = 90 }` —— 比 pkgs 的 30 天更保守，env 体积大重建贵
  - L 级：**L2**（用户历史，要确认）
  - 关键约束：scaffold 没法判断"是否 base"，但如上所述，base 不在 `envs/` 下，glob 天然安全
  - disclaimer 必须写：(a) 激活中的 env 删除会失败/损坏 shell；(b) 用 `--prefix` 创建的自定义路径 env 检测不到；(c) 删除前建议 `conda env list` 确认

- **新 scope: `logs`**
  - glob: `**/.conda/logs/**` 或 `**/conda-meta/history`（这个谨慎，history 也可能被工具读）
  - 多数 conda 安装会在 `~/.conda/` 下留 `environments.txt` 等小文件，意义不大，**不建议加**

- **不动 `tarballs` 和 `unused-packages` 的 glob**，但建议把 `unused-packages` 的 disclaimer 加一段："hardlink 模式下安全；如果你的环境用 symlink 配置（罕见，主要见于 Windows + 早期 conda），删除可能断掉 env 链接 —— 用 `conda config --show allow_softlinks` 自查"

- **detect 新增 mamba/miniforge 路径**（KillPy 列表里有，pinkbin 漏了）：
  - `${HOME}/miniforge3/envs`、`${HOME}/mambaforge/envs`
  - `${HOME}/opt/anaconda3/envs`（macOS Anaconda Navigator 默认路径）

- **命名建议**：把当前 `conda.toml` 拆成 `conda.toml`（pkgs cache，L1）和 `conda-envs.toml`（envs，L2），让用户在 UI 上能分别勾选。pinkbin 的 scope 维度也能表达，但分文件更清晰。

---

### 1.2 Python 通用临时目录（`__pycache__` / `.pytest_cache` / etc.）

#### 1.2.1 GitHub 项目对照表

| name | stars | last push | 默认范围 | 可选范围（flag） | 排除 | URL |
|---|---|---|---|---|---|---|
| `bittner/pyclean` | 90 | 2026-04 | bytecode（`*.pyc` / `*.pyo` / `__pycache__`） | `--debris` 加：legacy pytest cache、coverage、build/dist、ruff、（可选）mypy / pyright / tox / jupyter / complexipy | `--erase` 自由 glob 强制 interactive | https://github.com/bittner/pyclean |
| `thombashi/cleanpy` | 19 | 2026-04 | `*.pyc` / `*.pyo` / `__pycache__` / `.cache` / `.mypy_cache` / `.pytest_cache` / `.ruff_cache` | `--include-builds`：`build/` `dist/` `docs/_build/` `*.manifest` `*.spec`<br>`--include-envs`：`.venv` `.nox` `.tox`<br>`--include-metadata`：`.eggs` `*.egg-info` `.pyre` `.pytype` `pip-wheel-metadata`<br>`--include-testing`：`.coverage` `coverage.xml` `nosetests.xml` | 永远跳过 `.git` `.hg` `.svn` `node_modules` | https://github.com/thombashi/cleanpy |
| `Tlaloc-Es/killpy` | 109 | 2026-04 | （type=cache）`__pycache__` `.mypy_cache` `.pytest_cache` `.ruff_cache` + 全局 pip / uv cache；（type=artifacts）`dist/` `build/` `.egg-info` `.dist-info` | TUI 里按类型过滤；`killpy clean` 可单独清 cache | 不显式列；`--exclude PATTERN` | https://github.com/Tlaloc-Es/killpy |
| `python-dev-tools/pycache-cleaner` | <10（gist 级别） | - | `__pycache__` 单点 | 文件管理器右键扩展 | - | （gist） |

#### 1.2.2 扫描策略对比

| 策略 | 代表 | 优点 | 缺点 / 风险 |
|---|---|---|---|
| **当前目录递归** | `pyclean .` / `cleanpy .` | 工程师在仓库根敲一下就行；不影响其他项目 | 用户不会主动跑；散落别处的 cache 漏掉 |
| **指定路径列表** | `cleanpy DIR1 DIR2 ...` | 灵活；可整合到 CI | 同上 |
| **全盘 / `~` 扫描** | `killpy --path ~` | 一次扫干净所有项目 | 可能误入 `node_modules` 同名 cache、第三方备份目录；扫描慢 |
| **配置 PYTHONPYCACHEPREFIX 预防** | Python 3.8+ 官方建议 | 根本不在项目里写 cache | 是预防不是清理 |

**所有工具都默认跳过这些目录**（共识黑名单）：`.git` / `.hg` / `.svn` / `node_modules`。`pyclean` 还跳 `.idea` / `.vscode`。

**风险点（pinkbin 必须警觉）**：
1. `.tox/` 在 CI 里是临时的，但**有些项目**用它跑本地集成测试，里面可能有未提交的脚本 —— 算 L2，要 confirm
2. `build/` 在大多数项目是产物，但**少数项目**把它签入 git（罕见，比如 sphinx 文档发布），扫描应该跳过 `.git` 内的目录就够保护
3. `.eggs/` / `*.egg-info/` 有时是 `pip install -e .` 的产物，删了下次 install 重生 —— 算 L1
4. `.coverage` 数据文件，删了重跑测试就有 —— L1

#### 1.2.3 对 pinkbin 的建议

**强烈建议新建 `scaffolds/python-tmp.toml`**。理由：
- pinkbin 现在完全没覆盖这块，是明显空白
- cleanpy / pyclean 的"哪些目录默认安全删"已经形成社区共识，可以直接抄
- 用户基数最大（任何写过 Python 的人都有），ROI 最高

scaffold 设计草案（**不写 toml，只列设计**）：

- `id = "python-tmp"`，`risk = "low"`
- `detect`：默认指向用户开发目录（`%USERPROFILE%/Projects` / `${HOME}/Projects` / `${HOME}/code` 等常见名），**也支持用户在 UI 里自定义根**。**反对默认全盘扫**——会捞到 site-packages 里的 `__pycache__`，那是包安装的一部分，删了下次 import 慢一点，无大碍但也无大益，徒增风险
- 多个 scope：
  - **L1 always-safe**：`__pycache__/` `*.pyc` `*.pyo` `.pytest_cache/` `.mypy_cache/` `.ruff_cache/` `.coverage`（一个 scope，默认勾）
  - **L1 build-artifacts**：`**/build/` `**/dist/` `**/*.egg-info/` `**/.eggs/` `**/pip-wheel-metadata/`（单独 scope，因为偶尔有签入 build 的项目，让用户能取消勾选）
  - **L2 tox/nox**：`**/.tox/` `**/.nox/` 单独一个 scope，default 不勾，prompt confirm
  - **L2 jupyter checkpoints**：`**/.ipynb_checkpoints/`（jupyter 自动备份的 notebook，可能有未保存的迭代）
- **红线**（写进 [match] 排除 + safety test）：
  - `**/.git/**` `**/.hg/**` `**/.svn/**` `**/node_modules/**`
  - `**/site-packages/**`（避免删进 venv 内部）
  - `**/.venv/**` `**/venv/**` `**/env/**`（venv 内部的 cache 不归这个 scaffold 管）
- **safety test 必备红线断言**：随便扔一个 `<root>/.git/objects/__pycache__` 进 fixture，确认 zero match

---

### 1.3 孤儿 virtualenv 检测

#### 1.3.1 GitHub 项目对照表

| name | stars | last push | 探测算法 | 安全机制 | URL |
|---|---|---|---|---|---|
| `Tlaloc-Es/killpy` | 109 | 2026-04 | 文件夹名匹配 + `pyvenv.cfg` 存在 + atime（`--older-than`） | `⚠️` 标记当前 Python 进程使用中的；TUI 默认不删；`--delete-all --yes` 才跳过确认 | https://github.com/Tlaloc-Es/killpy |
| `nunombispo/venv-analyzer` | 1 | 2025-06 | 名字 in `{venv, .venv, env, .env, virtualenv, virtual_env, python_env, pyenv}` 或含 `Scripts/` `bin/` `pyvenv.cfg` `activate*` | 双确认（y + 输入 `DELETE`）；仅按 atime；不阻止删除 base venv | https://github.com/nunombispo/venv-analyzer |
| `venv-clean`（PyPI） | <10 | 2023 | 找 `pyvenv.cfg`，列表 + 单选删除 | 交互式 | https://pypi.org/project/venv-clean/ |

**没找到的"orphan = 父项目源码已不存在"**：MegaCleaner（商业 Mac 工具）有这个能力，但 GitHub 上没看到开源实现。**这是 pinkbin 的差异化机会**——我们能做"venv 的 parent dir 没有 `pyproject.toml` / `setup.py` / `requirements*.txt` / `.git/` 任一者，标记为 orphan"，比纯 atime 准。

#### 1.3.2 探测算法（社区共识）

签名集合（任一即认定为 venv）：
1. 目录名匹配：`venv` / `.venv` / `env` / `.env` / `virtualenv`
2. 含 `pyvenv.cfg` 文件（PEP 405 标准，最可靠）
3. 含 `Scripts/python.exe`（Windows）或 `bin/python` 软链（Unix）
4. 含 `Scripts/activate*` 或 `bin/activate*`

**最强单一信号是 `pyvenv.cfg`**——uv / venv / virtualenv 都生成（pipenv 历史上不生成，但新版本生成了）。

#### 1.3.3 风险评估

孤儿 venv 是 pinkbin 应该做的**高价值场景**：用户不写 Python 也常常因为装某工具留一堆 venv（pipx、Jupyter Lab 安装器、各种 Anaconda Navigator 一键应用）。

但风险也最高：
- venv 内可能有 `pip install` 但不在任何 `requirements.txt` 里的包，删了不可恢复
- 被某 systemd / launchd / 计划任务引用的 venv 删了会让后台服务挂掉
- venv 父目录是用户自己的代码仓库（如果连仓库一起搞没了，就是大事故）—— 但 pinkbin glob 不会上溯到父目录，这点天然安全

**强制规则**：必须 L2 + days prompt + recycle mode + 二次确认。**绝不允许 default delete**。

#### 1.3.4 对 pinkbin 的建议

**建议新建 `scaffolds/venv-orphan.toml`，但分两阶段做**：

- **Phase 1（容易）**：纯按 mtime/atime + `pyvenv.cfg` 探测。复刻 venv-analyzer 的思路。
- **Phase 2（差异化）**：扫 venv 的父目录，看有没有 `pyproject.toml` / `setup.py` / `requirements*.txt` / `.git/`，没有则提升 confidence 到 "very likely orphan"。这个判断逻辑超出当前 scaffold TOML schema 的能力（schema 是声明式 glob，没 sibling 谓词）—— **这个建议不能纯靠加 scaffold 实现，需要扩 detect schema**。先做 Phase 1，把 Phase 2 写进 roadmap。

scaffold 草案：
- `id = "venv-orphan"`，`risk = "high"`
- `detect`：用户开发目录（同 python-tmp）
- 单一 scope：`**/pyvenv.cfg` 的所在目录（这个 glob 也超出当前 schema —— pinkbin 的 glob 是路径模式，不是"文件存在则取其父" —— **此处再次需要 schema 扩展**）
- 折中方案：直接 glob `**/.venv/` `**/venv/` `**/env/`（按目录名），accept 漏掉自定义命名的 venv，准确率换覆盖率
- prompt: `{ kind = "days", default = 90 }`
- mode: `recycle`（强制）
- disclaimer：列举上述四类风险

**结论**：值得做，但需要先评估 schema 扩展（pyvenv.cfg-based detect）的工作量。如果只能按目录名匹配，覆盖率就和 venv-analyzer 一样不完美。

---

### 1.4 pip 残留

#### 1.4.1 user-install (`~/.local/lib/python*/site-packages`)

**GitHub 上没找到任何专门清理这块的工具**——这是有道理的：`pip install --user` 装的包是用户**当前在用的依赖**，自动清理就是 footgun。

最有名的相邻工具：
- `invl/pip-autoremove`（632 stars，2023-06 last push，**已停滞**）：移除一个包及其无人引用的依赖。需要用户**显式指定包名**，不是无脑扫描。
- `enjoysoftware/pip3-autoremove`（25 stars，2022-12 last push）：Python 3 fork，更老旧。

**结论**：`~/.local/lib/python*/site-packages/` 是 **pinkbin 的红线**，不应该建 scaffold。**正确做法是写进文档说"pinkbin 不碰 user-installed packages，要清理用 `pip uninstall <name>`"**。

唯一可以做的：检测**孤儿 `.dist-info` 目录**（包目录已删但元数据残留），这种文件极少，体积也小，价值低。**不建议做**。

#### 1.4.2 pip build temp（`/tmp/pip-build-*` / `/tmp/pip-install-*` / `/tmp/pip-unpack-*`）

这是真痛点。pypa/pip 的多个 issue（[#420](https://github.com/pypa/pip/issues/420)、[#939](https://github.com/pypa/pip/issues/939)、[#2892](https://github.com/pypa/pip/issues/2892)、[#12868](https://github.com/pypa/pip/issues/12868)）记录了 pip 经常不清理临时目录的问题：
- 服务器 `/tmp` 长期不重启会堆积
- Windows 路径过长（torch 这种深嵌套包）会导致 pip 半安装失败，留下大目录
- `/tmp` 是 tmpfs 时，pip 缓存会吃 RAM

**对 pinkbin 的建议**：**值得加进 `pip.toml`** 作为新 scope。

设计草案：
- 新 scope: `build-temp`
  - glob: `${TMPDIR}/pip-build-*` `${TMPDIR}/pip-install-*` `${TMPDIR}/pip-unpack-*` `${TMPDIR}/pip-*-build`
  - 同时枚举 `/tmp/pip-*`（Linux/macOS）和 `%TEMP%/pip-*` `%TMP%/pip-*`（Windows）
  - mode: `recycle`
  - L1（这些是 pip 自己的工作目录，正常情况下 pip 会清，残留就是泄漏）
- **风险**：极小概率正在跑 pip install，目录被锁；mode=recycle 时删除失败也无害

**这是低成本高 ROI 的小改动**，应该加。

---

### 1.5 总结：对 pinkbin 现有 scaffold 的改动清单

> 只列建议，不动 toml/rs。优先级标注：P0=立刻做，P1=下个 milestone，P2=待评估。

#### `scaffolds/conda.toml`

- **[P0]** detect 新增 mamba/miniforge/macOS-anaconda 路径：`miniforge3/envs`、`mambaforge/envs`、`opt/anaconda3/envs`
- **[P1]** 拆分出 `scaffolds/conda-envs.toml`（或在本文件新增 `envs-stale` scope）：glob `**/envs/*/`，days prompt 默认 90，mode recycle，risk medium，**完整 disclaimer**（激活中风险、`--prefix` 自定义路径漏检、hardlink 安全 / symlink 危险）
- **[P1]** 给现有 `unused-packages` scope 的 disclaimer 补 hardlink vs symlink 注解
- **[P2]** 评估能否检测 `~/.conda/environments.txt` 列出但不在 `envs/` 下的"远程 env 路径"（自定义 prefix），目前 scaffold schema 不支持

#### `scaffolds/pip.toml`

- **[P0]** 新增 scope `build-temp`：glob 覆盖 `${TMPDIR}/pip-build-*` / `pip-install-*` / `pip-unpack-*` / `pip-*-build`，Linux/macOS/Windows 都要枚举；mode recycle；L1
- **[不做]** `~/.local/lib/python*/site-packages/`：明确写进 disclaimer 说 pinkbin 不碰，引导用户用 `pip uninstall`

#### 新增 `scaffolds/python-tmp.toml`（P0）

- detect 指向用户开发目录（`%USERPROFILE%/Projects` / `${HOME}/Projects` / `${HOME}/code`），UI 支持自定义 root；**不全盘扫**
- 多 scope：
  - L1 `caches`：`__pycache__/` `*.pyc` `.pytest_cache/` `.mypy_cache/` `.ruff_cache/` `.coverage`
  - L1 `build-artifacts`：`**/build/` `**/dist/` `**/*.egg-info/` `**/.eggs/` `**/pip-wheel-metadata/`
  - L2 `tox-nox`：`**/.tox/` `**/.nox/` confirm prompt
  - L2 `jupyter-checkpoints`：`**/.ipynb_checkpoints/`
- 红线：`**/.git/**` `**/.hg/**` `**/.svn/**` `**/node_modules/**` `**/site-packages/**` `**/.venv/**` `**/venv/**` `**/env/**`
- safety test：放一份 `<root>/.git/objects/__pycache__` fixture 验证 zero match

#### 新增 `scaffolds/venv-orphan.toml`（P1，需先评估 schema）

- **schema 评估前置**：pinkbin 当前 glob 不支持"按文件存在性识别（如 pyvenv.cfg）+ 取其父目录"，需要决定是
  - (a) 折中按目录名匹配（`**/.venv/` `**/venv/` `**/env/`），覆盖率 70%
  - (b) 扩展 detect schema 支持 marker file 反推
- 落地形态：单 scope，days prompt 默认 90，mode recycle 强制，risk high，**完整 disclaimer**（pip --user 包不可恢复、后台服务依赖、自定义命名 venv 漏检）
- safety test：base venv（`~/anaconda3/`）必须 zero match；活跃 Python 进程持有的 venv（如果能模拟）必须能识别（Phase 2）

#### 新增 `scaffolds/pyenv.toml`（P2）

- 调研附带发现：`~/.pyenv/versions/` 和 conda envs 同样有"装了一堆 Python 版本占空间"问题，KillPy 也覆盖
- 风险：pyenv shims 引用，删了某版本 shims 会断；`pyenv-virtualenv` 创建的 virtualenv 也在 versions/ 下，红线类似 venv
- 优先级低于 conda envs，待 conda 方案稳定后参考

#### 横向工程改动（非 scaffold）

- **Studio UI 增强**：考虑加"父目录探测"标记（venv 父无 `pyproject.toml` 等 → 标 likely orphan），需要 Rust 端 detect 扩展
- **disclaimer 模板**：本调研发现 hardlink/symlink、激活态、--prefix 等陷阱很类似，考虑做一个 `disclaimers/` 目录复用片段
- **文档**：在 `docs/scaffold-requirements/` 加 `python-dev.md`，归档本报告的关键发现作为后续 scaffold 设计的需求依据

---

## 2. IDE 生态

> 用途：为 pinkbin 的 jetbrains / vscode / cursor 等 scaffold 设计提供 GitHub 同类工具对照。
> 调研日期：2026-05-04
> 范围：gap-driven，聚焦三个缺口 —— JetBrains 跨产品/跨版本拆分、VSCode 扩展 globalStorage 陷阱、PyCharm 专项目录（python_stubs / python_packages）

### 2.0 现状分析（pinkbin 三份 IDE scaffold 的问题）

| scaffold | LOC | scope 数 | 主要问题 |
|---|---|---|---|
| `vscode.toml` | 52 | 6 | 只清电子壳层 cache（`Code Cache` `GPUCache` `Service Worker` 等），**完全没碰 `User/globalStorage/<extension>/`**——这里常驻数 GB 的 Pylance / Copilot / TS server 索引 |
| `cursor.toml` | 46 | 5 | 同 vscode；额外漏掉 Cursor 的 AI 历史路径（`User/History/`、conversation SQLite），且没枚举 Windsurf / 参考 IDE / Kiro 等其他 VSCode fork |
| `jetbrains.toml` | 33 | 3 | **三粗暴 glob 一刀切**：`**/caches/**` `**/log/**` `**/system/**`。问题：(a) 不区分 product，(b) 不区分 version——一个用户有 IntelliJIdea2023.1 + IntelliJIdea2024.3 + PyCharm2024.1 同时残留时无法选择性清理；(c) `system/` 内部有 LocalHistory（用户历史，应 L2）和 plugins/ 共享路径风险 |

下文按三个子领域分别给出对照表与改动建议。

---

### 2.1 JetBrains 全家桶（含 PyCharm / IntelliJ / WebStorm / GoLand / Rider 等）

#### 2.1.1 官方目录布局（必读基线）

JetBrains 在 [Directories used by the IDE](https://www.jetbrains.com/help/idea/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html) 文档里规定了 4 类用户数据目录，**每个 product 每个 major version 独立**：

| 类别 | Windows 路径 | macOS 路径 | Linux 路径 | pinkbin 当前归类 | 实际应该 |
|---|---|---|---|---|---|
| **config** | `%APPDATA%\JetBrains\<Product><Ver>` | `~/Library/Application Support/JetBrains/<Product><Ver>` | `~/.config/JetBrains/<Product><Ver>` | 未覆盖（好） | **L3 红线** |
| **plugins** | `%APPDATA%\JetBrains\<Product><Ver>\plugins` | `~/Library/Application Support/JetBrains/<Product><Ver>/plugins` | `~/.local/share/JetBrains/<Product><Ver>` | 未覆盖（好） | **L3 红线**——卸载后无法自动恢复 |
| **system / caches** | `%LOCALAPPDATA%\JetBrains\<Product><Ver>` | `~/Library/Caches/JetBrains/<Product><Ver>` | `~/.cache/JetBrains/<Product><Ver>` | `**/system/**` + `**/caches/**` 一刀切 | 见下方按子目录拆 |
| **logs** | `%LOCALAPPDATA%\JetBrains\<Product><Ver>\log` | `~/Library/Logs/JetBrains/<Product><Ver>` | `~/.cache/JetBrains/<Product><Ver>/log` | `**/log/**` | L1 OK |

⚠️ pinkbin 当前的 `detect` 列表少了 macOS 的 `~/Library/Application Support/JetBrains`（config）和 `~/Library/Logs/JetBrains`（logs）—— 但这两个本就不该清，所以"没 detect"反而对了一半；问题是没法显示这些路径供用户参考。

#### 2.1.2 `system/` 子目录细分（关键）

[官方文档](https://intellij-support.jetbrains.com/hc/en-us/articles/206544519-Directories-used-by-the-IDE-to-store-settings-caches-plugins-and-logs) + [Local History 文档](https://www.jetbrains.com/help/idea/local-history.html) + DevCleaner 源码交叉确认，`system/` 下典型布局：

| 子目录 | 内容 | 大小（典型） | 删除影响 | pinkbin 应分级 |
|---|---|---|---|---|
| `caches/` | VFS、stub index、symbol index 等可重生缓存 | 数百 MB ~ 数 GB | 下次启动重建索引（5-30 分钟，根据项目大小） | **L1**（推荐勾） |
| `index/` | 平台层索引（与 `caches/` 类似但分库） | 数百 MB ~ 数 GB | 同上 | **L1** |
| `LocalHistory/` 或 `local_history/` | 单文件二进制数据库，所有项目共用，存所有文件编辑历史；默认保留 5 天 | 数十 MB ~ 数百 MB | **永久丢失未提交编辑历史**——是 IDE 提供的"安全网"，对未启用 VCS 或临时删除文件的恢复至关重要 | **L2**（要 confirm，且 disclaimer 强调"丢失可恢复"） |
| `frameworks/` | 框架文档/库元数据 cache | < 100 MB | 重新下载 | L1 |
| `compile-server/` | 外部 build 进程（JPS）增量编译缓存 | 数百 MB | 下次构建从零编译 | L1（但慢） |
| `log/` | 项目级日志 | < 100 MB | 无影响 | L1 |
| `plugins-sandbox/` | 插件开发用沙箱（仅插件作者会有） | 变动大 | 插件开发会话状态丢失 | L2 |
| `dom-stats/` `event-log-data/` `tasks/` 等 | 杂项 | < 10 MB | 无 | L1 |
| `JCEF/` `chrome-cache/` `webview/` | 内嵌浏览器（用于 markdown 预览、内嵌 docs） | 数十 MB | 内嵌浏览器历史/cookie 丢失 | L1 |

#### 2.1.3 PyCharm 特殊子目录（`system/` 之下额外有）

| 子目录 | 大小（典型） | 删除影响 | pinkbin 应分级 |
|---|---|---|---|
| `python_stubs/` | 几百 MB ~ **几 GB** | 自动生成的 Python type stub，重建慢但完全可恢复（重新 Ctrl+B 时按需生成） | **L1**（pinkbin 可以专门拎出来强调"可清几 GB"） |
| `python_packages/` 含 `packages_v2.json` | **2022.3 版本曾爆到 100GB+ 见 [PY-57156](https://youtrack.jetbrains.com/issue/PY-43132/Invalidate-cache-restart-does-not-clean-up-python_stubs)**；新版正常 < 100 MB | 包索引重建 | L1（已知 bug 路径，单独 scope 让用户能直接定向清） |
| `cpython-cache/` | 数百 MB | conda/pip env 的 Python 解释器索引 | L1 |

JetBrains 官方文档里反复强调："you may manually delete history files"——LocalHistory 是 safe to delete 的，**但是它是 user data，不能默认勾**。

#### 2.1.4 GitHub 项目对照表

| name | stars | last push | 平台 | scope 切分粒度 | 跨版本支持 | 红线 / safety | URL |
|---|---|---|---|---|---|---|---|
| `wookat/DevCleaner` | 0（新仓库） | 2026-02 | Windows（Tauri 2 + Rust + React，**与 pinkbin 同栈**） | 按 product+version 完整枚举，三档清理模式（Safe/Recommended/Aggressive）；UI 内子项可单独勾选 extension/workspaceStorage/globalStorage | **是**：扫描 `%APPDATA%\JetBrains\<prefix>*` 全部版本，UI 列表里独立显示每个版本及大小 | `PROTECTED_NAMES = ["settings.json", "keybindings.json", "argv.json"]`、`PROTECTED_DIRS = ["snippets", "profiles"]`，`is_protected()` 函数硬编码白名单 | https://github.com/wookat/DevCleaner |
| `denji/jetbrains-utility` | 63 | 2019-11 | macOS only | 按产品分组（IntelliJ / PyCharm / WebStorm / Rider / RubyMine / DataGrip / AppCode / GoLand），但**只有完全卸载脚本**（`Preferences/` `Caches/` `Application Support/` `Logs/` 全删——会丢 settings） | 用 brace expansion `{??,???,20??.*,-EAP}` 匹配所有版本号 | **没有**——这是卸载脚本不是清理工具，会删 Preferences | https://github.com/denji/jetbrains-utility |
| `usekudu.com/cleaners/jetbrains` | （闭源商业） | 持续更新 | 跨平台 | 按文档描述清 VFS records、filename/symbol/stub indexes、LocalHistory snapshots、JCEF browser cache、log files、SQLite WAL/SHM | 是 | 显式声明"不动 projects, source files, settings, accounts, saved credentials" | https://usekudu.com/cleaners/jetbrains |
| `ChrisCarini/jetbrains-sdk-cleaner` | 2 | 2026-05 | JetBrains plugin（Java） | 只清"未使用的 SDK"（用户在 IDE 里配置过的 JDK / Python interpreter 引用） | N/A（运行在 IDE 内） | 由 IDE 平台 API 保护，删除前列表确认 | https://github.com/ChrisCarini/jetbrains-sdk-cleaner |
| `PavlikPolivka/gitcleaner` | 19 | 2021-02 | JetBrains plugin | 只清无 remote 的本地 git 分支（与 cache 无关，作为生态参考） | N/A | 跳过 current branch、跳过未合并分支 | https://github.com/PavlikPolivka/gitcleaner |
| `georgekhananaev/spark-clean` | 39 | 2026-04 | macOS（Swift） | 笼统覆盖 JetBrains + Docker / Xcode / Node / Ollama / Homebrew | 否（按产品 root 一级目录） | 没看到红线声明 | https://github.com/georgekhananaev/spark-clean |
| `sjzsdu/os-cleaner` | 0 | 2026-03 | macOS / Linux（Go） | npm / Go / Docker / Xcode / JetBrains 一档 | 否 | 没红线 | https://github.com/sjzsdu/os-cleaner |
| `jemishavasoya/dev-cleaner` | 200 | 2026-02 | shell + PowerShell | 笼统多语言 cleaner，JetBrains 是顺带 | 否 | 默认交互式提示 | https://github.com/jemishavasoya/dev-cleaner |

**通用清理软件**：
- **BleachBit** [winapp2.ini](https://github.com/bleachbit/winapp2.ini)（Windows + Linux）：JetBrains 各 product 都有独立 entry（Detect 用注册表/路径），但 cleaner 粒度仍是 caches/logs/system 整目录，**不区分 LocalHistory 与 system caches**。
- **CCleaner**：内置定义同样是产品级而非 system 子目录级。
- **JetBrains Toolbox 1.22+**：自带 "Clean up tool directories"（参考 [官方博客](https://blog.jetbrains.com/blog/2021/11/09/toolbox-app-1-22/)），但只清 Toolbox 管理的安装目录，不动 caches/system。
- **JetBrains 官方 IDE 内**：
  - `File | Invalidate Caches & Restart`（带可选项："Clear file system cache and Local History" + "Clear downloaded shared indexes" + "Clear VCS Log caches" + "Ask Background tasks to terminate"）
  - `Help | Delete Leftover IDE Directories…`（自动清 180 天未更新的旧版本 caches/logs，留 config/plugins）
  - **关键发现**：官方在 180 天阈值过后**只清 caches/logs**，**保留 config/plugins**——这正是 pinkbin 该抄的策略。

#### 2.1.5 跨版本累积 / 旧版残留问题（pinkbin 核心痛点）

实测：用 IntelliJ 几年的用户 `%LOCALAPPDATA%\JetBrains\` 下常见：

```
IntelliJIdea2022.3/    ← 旧版未卸载
IntelliJIdea2023.1/    ← 旧版
IntelliJIdea2023.3/    ← 旧版
IntelliJIdea2024.1/    ← 当前版
PyCharm2023.2/         ← PyCharm 老版
PyCharm2024.3/         ← 当前版
```

每个版本有独立 `caches/` `system/` `log/`，单版本可能 3-10 GB。pinkbin 当前 glob `**/caches/**` 会一次清光所有版本，但 UI 上只显示一个聚合数字——用户**看不出哪些是旧版残留**（其实可全删 + 在 IDE 里"Delete Leftover IDE Directories" 走官方流程更安全）。

DevCleaner 的解决方案值得抄：UI 里**按 product+version 列表展示**（如 "IntelliJ IDEA 2024.1 — 4.2 GB"），每行可独立勾选。这需要 pinkbin 的 detect/scope 模型支持"动态枚举子目录"——目前 pinkbin scope 是静态 glob，**这是要 schema 升级的事**。

#### 2.1.6 LocalHistory 红线讨论（pinkbin 必须做的决策）

**两条对立路径**：
- **路径 A（保守）**：把 `**/system/LocalHistory/**` 和 `**/system/local_history/**` 列为 L3 红线，pinkbin 永远不动。理由：是用户唯一的"未提交改动恢复"安全网。
- **路径 B（务实）**：作为独立 L2 scope，default 不勾，prompt 强 disclaimer "this is your local edit history; deleting loses ability to recover unsaved/unversioned changes"。理由：JetBrains 自己 `Invalidate Caches` 默认就允许选清 Local History；非常多用户主动清。

**pinkbin 推荐路径 B**。原因：
1. 它确实占空间（几百 MB 到 GB），用户有合理需求清
2. 已经有 IDE 内功能允许清，pinkbin 不该比官方更保守
3. mode = recycle 能给二次后悔机会
4. L2 + 强 disclaimer + default 不勾 三件套足够安全

#### 2.1.7 plugins/ 红线（无争议）

`%APPDATA%\JetBrains\<Product><Ver>\plugins\` 是用户**手装的插件二进制**（除了 bundled 的，这些在 IDE 安装目录里）。删了**没有任何缓存可重生**，用户必须重新去 marketplace 装，外加丢失插件配置。

**强制 L3 红线，写进 safety test 断言。** pinkbin 当前没有 plugins glob（好），但要写进 `[match]` 排除或在 safety test 里显式断言"`**/plugins/**` 必须 zero match"。

#### 2.1.8 对 pinkbin `jetbrains.toml` 的具体改动建议

现在的 `jetbrains.toml` 必须重写。建议方案（**只列设计，不写 toml**）：

##### 方案 A（兼容性最高，建议先做）：保留单 toml 但 scope 细化

- **detect**：保留现有 + 加 macOS `~/Library/Application Support/JetBrains`（仅 detect 用，不会清；让用户能看到完整列表）
- **拆分 caches scope**：从 `**/caches/**` 一刀切，改成多个细粒度 scope：
  - `system-caches`（L1，default 勾）：`**/system/caches/**` `**/system/index/**` `**/system/frameworks/**` `**/system/compile-server/**` `**/system/dom-stats/**` `**/system/event-log-data/**` `**/system/tasks/**` `**/system/JCEF/**` `**/system/chrome-cache/**`
  - `logs`（L1）：`**/system/log/**` + `**/log/**`（覆盖 macOS 单独的 Logs 目录）
  - `local-history`（L2，default **不勾**，prompt confirm）：`**/system/LocalHistory/**` `**/system/local_history/**`，disclaimer 强调"丢失未提交编辑历史"
  - `pycharm-stubs`（L1，单独 scope 是因为 PyCharm 用户能看到具体收益）：`**/system/python_stubs/**` `**/system/python_packages/**` `**/system/cpython-cache/**`
- **新增 [match] 排除（safety test 必断言）**：
  - `**/plugins/**` 必须 zero match（用户手装插件）
  - `**/config/**` 必须 zero match（用户 settings）
  - `**/options/**` 必须 zero match（用户偏好 XML）
  - `**/keymaps/**` 必须 zero match（用户键位）
  - `**/colors/**` `**/codestyles/**` `**/inspection/**` 同样 L3
  - macOS 的 `~/Library/Application Support/JetBrains/<Product><Ver>/` 整个不能落 scope（除非新增显式 scope 清里面的 `frameworks/` 等子项，但风险高，**不建议做**）
- **disclaimer 重写**：明确说明"按产品+版本拆解显示需要 UI 升级；本 scaffold 当前会聚合显示所有版本的 caches"

##### 方案 B（差异化最大，需 schema 升级）：按 product 拆 toml

如果未来 pinkbin 想做 DevCleaner 那样的"按 product+version 列表"UI，需要：

- 拆出 `pycharm.toml` `intellij.toml` `webstorm.toml` `goland.toml` `clion.toml` `rider.toml` `phpstorm.toml` `rubymine.toml` `datagrip.toml` `rustrover.toml` `android-studio.toml`（11 个，按 DevCleaner 列表）
- 每个 scaffold 的 detect 用 product folder 前缀（如 `%LOCALAPPDATA%/JetBrains/PyCharm*` `%LOCALAPPDATA%/JetBrains/IntelliJIdea*`）
- 共享一个 base disclaimer / 红线模板（前面 Python section 提的 `disclaimers/` 目录复用）
- **schema 升级需求**：scope 内需要"按版本枚举子目录"的能力，目前的静态 glob 做不到"识别同 prefix 不同版本号目录并独立显示"
- **Studio UI 升级需求**：每个 scaffold 卡片内部要支持"子项目（按版本）展开"，参考 DevCleaner 的 UI 设计

**方案 B 工作量明显更大，建议作为 Phase 2/3。先做方案 A 把"system 子目录细化 + LocalHistory 单 scope + PyCharm 专项"落地，覆盖 90% 用户痛点。**

##### PyCharm 专项 scope 在方案 A 里的形态

pycharm 的 python_stubs / python_packages / cpython-cache 在所有 JetBrains product 中**只出现在 PyCharm 里**。把它们写成单独 scope 后，对其他 IDE 用户来说就是 zero match（无害），对 PyCharm 用户来说能看到独立的"Python Stubs: 3.4 GB"显示，体验明显更好。**这就是不必拆出独立 `pycharm.toml` 的理由——同一个 jetbrains scaffold 加 PyCharm-only scope 即可。**

---

### 2.2 VSCode / Cursor / 参考 IDE / Windsurf / Kiro / VSCodium 等 VSCode 系

#### 2.2.1 VSCode-fork 矩阵（DevCleaner 整理 + 补充）

| Editor | %APPDATA% folder | home dot folder | 备注 |
|---|---|---|---|
| Visual Studio Code | `Code` | `.vscode` | 微软主线 |
| Visual Studio Code Insiders | `Code - Insiders` | `.vscode-insiders` | nightly |
| Cursor | `Cursor` | `.cursor` | Anysphere AI fork |
| Windsurf | `Windsurf` | `.windsurf` | Codeium AI fork |
| 参考 IDE / 参考 IDE | `参考 IDE` / `参考 IDE` | `.trae` / `.trae-cn` | 字节 AI fork |
| Kiro | `Kiro` | `.kiro` | AWS AI fork |
| Antigravity | `Antigravity` | `.antigravity` | Google AI fork |
| PearAI | `PearAI` | `.pearai` | 开源 AI fork |
| Aide | `Aide` | `.aide` | AI fork |
| Positron | `Positron` | `.positron` | Posit / RStudio 推出的数据科学 fork |
| VSCodium | `VSCodium` | `.vscode-oss` | 去 telemetry 重打包 |
| Void | `Void` | `.void` | 开源 fork |
| Qoder | `Qoder` | `.qoder` | AI fork |

**pinkbin 当前只有 vscode + cursor 两个**，至少漏了 Windsurf / 参考 IDE / Kiro 三个有明显用户基数的（中国用户尤其常见 参考 IDE）。

#### 2.2.2 VSCode 文件系统分布（每个 fork 都一致）

```
%APPDATA%/Code/                   ← config root
├── User/
│   ├── settings.json             ← L3 红线
│   ├── keybindings.json          ← L3 红线
│   ├── snippets/                 ← L3 红线
│   ├── globalStorage/            ← ★ 大头，按 extension 子文件夹拆
│   │   ├── state.vscdb           ← L3 红线（含 sign-in token、各 extension 状态）
│   │   ├── state.vscdb.backup    ← L3 红线
│   │   ├── storage.json          ← L3 红线
│   │   ├── ms-python.vscode-pylance/   ← 可达 GB 级（onnxruntime + index cache）
│   │   ├── github.copilot/       ← 模型缓存
│   │   ├── ms-vscode.cpptools/   ← C++ language server cache
│   │   ├── redhat.java/          ← Java 索引（每版本 15-20MB 累积）
│   │   ├── ...
│   ├── workspaceStorage/         ← 当前覆盖（pinkbin 已有 days prompt）
│   │   └── <hash>/
│   │       ├── workspace.json    ← 含工作区路径（用来判断是否 orphan）
│   │       └── state.vscdb       ← per-workspace SQLite
│   └── History/                  ← Cursor / 参考 IDE 等会大；纯 VSCode 也会有
├── Cache/                        ← L1 已覆盖
├── CachedData/                   ← L1 已覆盖
├── CachedExtensions/             ← L1 未覆盖（可加）
├── CachedExtensionVSIXs/         ← L1 未覆盖（可加）
├── CachedProfilesData/           ← L1 未覆盖
├── Code Cache/                   ← L1 已覆盖
├── GPUCache/                     ← L1 已覆盖
├── DawnCache/ / DawnGraphiteCache/ ← L1 未覆盖（新版 Electron 的 GPU cache）
├── Service Worker/               ← L1 已覆盖
├── blob_storage/                 ← L1 未覆盖
├── Network/ / Session Storage/ / Local Storage/ ← Electron 默认 cache
├── IndexedDB/ / WebStorage/      ← Electron 默认（部分 extension 会塞数据进去，需要谨慎）
├── Crashpad/                     ← L1 未覆盖（崩溃 dump，本地）
├── logs/                         ← L1 已覆盖
└── (在 %LOCALAPPDATA%/Code 下还有镜像的) Cache/ Code Cache/ GPUCache/
```

`~/.vscode/extensions/` 是另一个完全独立的目录，存**安装的 extension 本身**（每个 extension 一个文件夹，含代码/二进制）。

#### 2.2.3 globalStorage 陷阱（pinkbin 当前最大空白）

[microsoft/vscode #166014](https://github.com/microsoft/vscode/issues/166014)、[#156519](https://github.com/microsoft/vscode/issues/156519) 等多个 upstream issue 反映：

- **没有官方 per-extension 磁盘占用 UI**——用户根本不知道哪个 extension 占了 1 GB
- **VSCode 自己不清理**：[redhat-developer/vscode-java #2597](https://github.com/redhat-developer/vscode-java/issues/2597) 明确写"Extensions are responsible for cleaning up their own out-of-date global storage folders"，但绝大多数 extension 不实现
- **极端案例**：Pylance 一次报告 [#5531](https://github.com/microsoft/pylance-release/issues/5531) 被 core dump 撑到 390 GB

**陷阱所在**：globalStorage 里**`state.vscdb` 是绝对不能删**的——它是所有 extension 状态的中央 SQLite，包含 sign-in token、订阅信息、各 extension 配置。Cursor 的 [删除事故 thread](https://forum.cursor.com/t/deleting-global-state-vscdb-causes-infinite-loading-chat-in-projects-history-not-recoverable-without-corrupted-backup/153220) 就是删了这个文件导致整个 chat history 进入 infinite loading 状态。

#### 2.2.4 globalStorage 的"可清"白名单（社区共识 + DevCleaner 实现）

DevCleaner 的 `is_ai_extension()` 和 protected_names 检查给出了一个良好起点：

**默认安全可清的 extension 子目录**（cache 性质，重新启动重建）：
- `ms-vscode.cpptools/` — C/C++ IntelliSense database
- `ms-toolsai.jupyter/` — Jupyter kernel discovery cache
- `ms-python.vscode-pylance/` — onnxruntime binaries + 索引（注意 onnxruntime 下次启动会重新解包，浪费但不致命）
- `ms-python.python/` — Python language server cache
- `redhat.java/` — Java workspace cache（红帽自己已经在 [#2110](https://github.com/redhat-developer/vscode-java/issues/2110) 表态会优化）
- `github.copilot/` `github.copilot-chat/` — 模型缓存（可重新下载）
- `tabnine.tabnine-vscode/` `codeium.codeium/` `supermaven.supermaven/` `continue.continue/` — AI 助手模型/缓存
- `ms-azuretools.vscode-docker/` 等 — 各厂商工具的本地 index

**绝对不能动的子目录**（含用户数据）：
- `vsliveshare.vsliveshare/` — Live Share session 数据
- `ms-vscode-remote.remote-*/` — Remote SSH/WSL 配置
- `cursor.cursor-*/` `anysphere.*/` — Cursor 的 AI 历史指针（实际数据在 SQLite 里，但 metadata 在这里）
- `code.visualstudio.com.code-settings-sync/` — Settings Sync 的待上传队列
- `*.auth*` `*.sign*` — 任何含认证 token 的子目录

**结论**：globalStorage 不能用一个 glob 一刀切。要么逐 extension 白名单（覆盖率有限），要么转成"按 days 清"的策略——但 days 策略对 globalStorage 风险较高（用户可能很久没用某 extension 但里面有重要 token）。

#### 2.2.5 workspaceStorage 的精细化策略

现在 pinkbin 的 `workspace-storage` scope 只用 `prompt = days 90`。可以更聪明：

[mehyaa/vscode-workspace-storage-cleanup](https://github.com/mehyaa/vscode-workspace-storage-cleanup) 用的策略是**读每个 hash 子目录里的 `workspace.json`，提取里面的 `folder` 字段，检查这个路径是否还存在；不存在就视为 orphan 可清**。这个策略的好处是不依赖时间，只删确定不再相关的——比 days 准确得多。

[jabbalaci/VS-Code-workspaceStorage-Cleaner](https://github.com/jabbalaci/VS-Code-workspaceStorage-Cleaner) 用纯 mtime > 60 天策略，简单但保守。

**对 pinkbin 的启示**：当前 days prompt 没问题，可以加一个 P2 任务"探索 workspace.json 路径校验"，需要 detect schema 支持读 JSON 取值的能力——比 venv 探测的 schema 升级稍简单，但还是要做工作。

#### 2.2.6 Cursor 的 AI 历史专项

Cursor 在标准 VSCode 路径之外多了：

- `%APPDATA%/Cursor/User/globalStorage/state.vscdb` — **Cursor AI 对话主库**，社区报告过单文件 14 GB
- `%APPDATA%/Cursor/User/workspaceStorage/<hash>/state.vscdb` — 包含 sidebar 索引；删除全局库会导致 sidebar 也"失忆"
- `%APPDATA%/Cursor/User/History/` — 编辑历史（VSCode 自带功能，但 Cursor 用户量大、写得勤）
- `%APPDATA%/Cursor/logs/<date>/exthost*/` — extension host 日志，AI 调用频繁导致这里爆

**红线**：`state.vscdb` 不能删（实测会打挂 chat history）。**只能删 `state.vscdb.corrupted*`**（Cursor 自身在出错时把数据 rename 成 `.corrupted`，那些是真正可清的）。这要写进 disclaimer。

**可清的 Cursor 路径**（额外加进 cursor.toml 的）：
- `**/Cursor/User/History/**`（L2，days prompt）
- `**/Cursor/User/globalStorage/state.vscdb.corrupted*`（L1，glob 精确匹配后缀）
- `**/Cursor/logs/*/exthost*/**`（L1）
- `**/Cursor/CachedExtensions/**` `**/Cursor/CachedExtensionVSIXs/**` `**/Cursor/DawnCache/**`（L1）

#### 2.2.7 GitHub 项目对照表（VSCode 系）

| name | stars | last push | 平台 | 范围 | 红线 / safety | URL |
|---|---|---|---|---|---|---|
| `wookat/DevCleaner` | 0 | 2026-02 | Windows（同 pinkbin 栈） | 13 个 VSCode-fork + 11 JetBrains product，按 product+version 拆，三档清理模式 | hardcoded protected_names + is_ai_extension() 标记，sub-item 展开让用户单选 | https://github.com/wookat/DevCleaner |
| `mehyaa/vscode-workspace-storage-cleanup` | 25 | 2025-11 | VSCode extension | workspaceStorage + Remote workspaces 单独命令 | 读 `workspace.json` 校验源路径存在性；不动 globalStorage | https://github.com/mehyaa/vscode-workspace-storage-cleanup |
| `8LWXpg/vscdb-workspace-storage-cleanup` | 2 | 2025-08 | VSCode extension | 操作 `${globalStoragePath}/state.vscdb` 删 PowerToys 残留的工作区记录 | 只 SQLite 层删行，不删文件本体 | https://github.com/8LWXpg/vscdb-workspace-storage-cleanup |
| `jabbalaci/VS-Code-workspaceStorage-Cleaner` | 17 | 2025-01 | Python script | workspaceStorage 按 mtime > 60 天 | DRY_RUN = True 默认；用户要手动改 False；只在用户 cd 到 workspaceStorage 目录时跑 | https://github.com/jabbalaci/VS-Code-workspaceStorage-Cleaner |
| `ilkhoeri/cache-cleaner` | 0 | 2026-01 | VSCode extension | 笼统 cache + Bun/Yarn/npm | 没强红线 | https://github.com/ilkhoeri/cache-cleaner |
| `vinugawade/ur-cache-cleaner` | 7 | 2025-10 | VSCode extension | Drupal 项目 cache（与 IDE 无关，误命中） | - | https://github.com/vinugawade/ur-cache-cleaner |
| `XDflight/clean_vscode-server.sh` | gist | 2024 | bash | `~/.vscode-server/` 服务端 cache + 旧版 extension + 旧 server | 只跑在远端 SSH 场景；不动 `data/User/` | https://gist.github.com/XDflight/5f3509eb84fc282b88059c909036f5bc |
| `al2718x/vscode-cleaner` | 0 | 2025-08 | Python | VSCode cache + 检测 workspace 关联项目是否还存在 | days 默认值 + 项目存在性检查 | https://github.com/al2718x/vscode-cleaner |
| `Titandaembody/VSCode-Performance-AI` | 1 | 2026-04 | 不明 | 营销页面项目，描述包含"启动加速 / 内存 profiler / cache cleaner / IntelliSense tuner"等模糊话术 | 看不到代码，无法评估 | （待确认） |

#### 2.2.8 Cursor / Claude Code 周边清理工具

| name | stars | last push | 范围 | 与 pinkbin 关系 | URL |
|---|---|---|---|---|---|
| `garrickz2/claude-code-cleaner` | 9 | 2026-03 | Rust TUI；`~/.claude/` 下的 orphan project caches、old session data、debug logs、telemetry、stale config | **scope 设计可借鉴**：protected paths 列表 `[settings.json, CLAUDE.md, skills/, commands/, agents/, ide/, credentials.json]`，dry-run 默认开 | https://github.com/garrickz2/claude-code-cleaner |
| `elexingyu/cc-cleaner` | 2 | 2026-01 | Python；Claude Code logs/telemetry + npm/pip/cargo/uv/yarn/pnpm/bun/nvm + huggingface/pytorch/whisper/ollama + browser cache + cocoapods + docker（22 cleaner，**没专门做 Cursor / VSCode**） | risk taxonomy（Safe / Moderate / Dangerous）与 pinkbin L1/L2/L3 对应；交互式 TUI；dry-run | https://github.com/elexingyu/cc-cleaner |
| `killerlux/cursor-cleaner` | 80 | 2025-09 | Debian/Ubuntu shell；**完全卸载** Cursor + 所有配置 | 是 uninstall 工具，不是 cache cleaner，**不该参考定位** | https://github.com/killerlux/cursor-cleaner |
| `ultrasev/cursor-reset` | （高 stars） | 2025+ | 重置 Cursor device ID 绕过 trial 限制 | **明确不是 cache cleaner**，pinkbin 不该往这个方向碰 | https://github.com/ultrasev/cursor-reset |
| `yuaotian/go-augment-cleaner` | 986 | 2025-11 | Go；清 Augment 插件数据 + 改 hosts 加速 API | 同上，是单一插件 reset 工具 | https://github.com/yuaotian/go-augment-cleaner |

#### 2.2.9 对 pinkbin `vscode.toml` / `cursor.toml` 的具体改动建议

##### 共同改动（VSCode + Cursor）

- **新增 cache scope（L1）**：`**/{Code,Cursor}/CachedExtensions/**` `**/CachedExtensionVSIXs/**` `**/CachedProfilesData/**` `**/DawnCache/**` `**/DawnGraphiteCache/**` `**/blob_storage/**` `**/Crashpad/**`
- **保留**现有 `cached-data` `code-cache` `gpu-cache` `service-worker` `logs`
- **强化 [match] / safety test 红线**：
  - `**/User/settings.json` 必须 zero match
  - `**/User/keybindings.json` 必须 zero match
  - `**/User/snippets/**` 必须 zero match
  - `**/User/globalStorage/state.vscdb` 必须 zero match
  - `**/User/globalStorage/state.vscdb.backup` 必须 zero match
  - `**/User/globalStorage/storage.json` 必须 zero match
  - `~/.vscode/extensions/**`（即 `**/.vscode/extensions/**`）必须 zero match —— 这是真正的扩展二进制
- **新增 globalStorage 子项 scope（L2，default 不勾，强 disclaimer）**：分两步：
  - **step 1（短期）**：直接用一个 scope `globalstorage-known-large`，glob 列出已知大户的扩展 ID 子目录：`**/User/globalStorage/ms-python.vscode-pylance/**` `**/ms-vscode.cpptools/**` `**/redhat.java/**` `**/github.copilot/**` `**/github.copilot-chat/**` `**/tabnine.tabnine-vscode/**` `**/codeium.codeium/**` `**/supermaven.supermaven/**` `**/continue.continue/**` `**/anysphere.*/**`（仅在 cursor.toml）
  - **step 2（schema 升级后）**：UI 支持枚举 globalStorage 下所有子目录、按大小排序，让用户逐个勾选——这需要 detect/scope 模型扩展，参考前面 JetBrains 方案 B 的 schema 升级讨论
- **workspaceStorage 升级（P2）**：当前的 `prompt = days 90` 保留作为 fallback，未来加"workspace.json 路径不存在时自动标 orphan"

##### Cursor 专项

- **新增 `corrupted-state` scope（L1）**：`**/Cursor/User/globalStorage/state.vscdb.corrupted*`
- **新增 `cursor-history` scope（L2，days prompt）**：`**/Cursor/User/History/**`
- **新增 `exthost-logs` scope（L1）**：`**/Cursor/logs/*/exthost*/**`
- **disclaimer 必须明确**："Cursor 的 AI chat history 存在 globalStorage/state.vscdb，删除会导致已有项目对话进入 infinite loading 状态——pinkbin 永远不动这个文件，但用户**手动清** globalStorage 时务必跳过它"

##### 新增 scaffolds（每个 VSCode-fork 一份）

按 DevCleaner 矩阵补：

- `windsurf.toml`（Codeium AI fork，国外用户多）
- `trae.toml`（字节 AI fork，**中国用户基数大，pinkbin 重点**；含 参考 IDE 的额外路径）
- `kiro.toml`（AWS）
- `vscodium.toml`（隐私意识强的开发者）

每个的结构基本是 `cursor.toml` 模板复用 + 替换路径。**这是 pinkbin 该做的小工作量大覆盖**。

如果嫌 scaffold 数量爆炸，可以做**模板复用机制**：让一个 `vscode-base.toml` 描述所有共有 scope，子文件只声明 `id` `appdata_folder` `home_dot_folder`——但这需要 schema 增加 import/extends 语法，工作量比直接复制 11 个 toml 还大。**先按 DevCleaner 模式平铺。**

##### 参考 IDE 专项需要研究

字节 参考 IDE 是国内重要 AI IDE，但有 [HN 报告](https://news.ycombinator.com/item?id=44703164) / [Neowin 报道](https://www.neowin.net/news/report-bytedances-vs-code-fork-trae-is-a-resource-hog-that-spies-on-you/) 指出它**即使关闭 telemetry 也持续上传遥测**。pinkbin 在 trae.toml 里可以考虑加一个 L2 scope 清遥测 buffer 目录（如果能找到的话），并在 disclaimer 里说明"参考 IDE 的遥测特性"——这是**差异化产品价值点**，但需要先实测确认 参考 IDE 的遥测落盘路径（可能在 `%APPDATA%/参考 IDE/Network/` 或 `%APPDATA%/参考 IDE/Cache/Cache_Data/`）。

---

### 2.3 PyCharm 专项（已并入 JetBrains，独立讨论"是否拆 toml"）

#### 2.3.1 决策：不拆出独立 `pycharm.toml`

理由：
1. PyCharm 的 cache 路径**完全是 JetBrains 通用框架**（`%LOCALAPPDATA%\JetBrains\PyCharm<Ver>\` 下同样的 `caches/` `system/` `log/` `LocalHistory/`）——和 IntelliJ/WebStorm 一模一样
2. 唯一专属的 `python_stubs/` `python_packages/` `cpython-cache/` 在 jetbrains.toml 里加成独立 scope 即可。其他 product 的 user 看到这个 scope 是 zero match，**无害**
3. 拆出独立 toml 等于把所有 JetBrains product 都拆出（intellij.toml / webstorm.toml / ...），见 2.1.8 方案 B 讨论——属于 schema 升级后的更大工程

#### 2.3.2 PyCharm 用户特别需要看到的"独立 scope 显示"

把这些专属 scope 加进 jetbrains.toml，让 PyCharm 用户在 Studio UI 里能看到独立的卡片项：

| scope id | glob | 用户视觉文案 | 收益示例 |
|---|---|---|---|
| `pycharm-stubs` | `**/system/python_stubs/**` | "Python Stubs (PyCharm 自动生成的类型存根)" | 数百 MB ~ 几 GB |
| `pycharm-packages` | `**/system/python_packages/**` | "Python Packages 索引（含已知的 packages_v2.json bug 路径）" | 正常 < 100 MB；2022.3 版有 100GB+ bug |
| `pycharm-cpython-cache` | `**/system/cpython-cache/**` | "CPython Interpreter Cache" | 每个 conda/pip env 几十到上百 MB |

#### 2.3.3 实测附录建议（写进 `docs/scaffold-requirements/jetbrains.md`）

按 CLAUDE.md 的"实测回环"纪律，pinkbin 写 jetbrains.toml 改动前应该先实测：

- 找 3-5 个 PyCharm 用户志愿者，列出他们 `%LOCALAPPDATA%\JetBrains\` 下所有目录与大小
- 确认 `LocalHistory` 在 PyCharm 2024.x 里是 `LocalHistory/` 还是 `local_history/`（小写下划线）—— [JetBrains 文档](https://www.jetbrains.com/help/idea/local-history.html) 用前者，但有 community report 提到 IntelliJ 某版本是后者
- 确认 macOS 的 PyCharm Cache 路径是 `~/Library/Caches/JetBrains/PyCharm2024.3/` 还是 `~/Library/Caches/PyCharm2024.3/`（[denji/jetbrains-utility](https://github.com/denji/jetbrains-utility) 的 brace expansion 暗示老版本不在 `JetBrains/` 子目录下）
- 确认 Toolbox 安装的 IDE 与独立安装的 IDE cache 路径是否一致

---

### 2.4 总结：IDE scaffold 改动清单（不动 toml/rs，只列建议）

> 优先级：P0=立刻做，P1=下个 milestone，P2=待 schema 升级后做。

#### `scaffolds/jetbrains.toml`（**必须重写**）

- **[P0]** 拆 `**/caches/**` 一刀切为多 scope：
  - `system-caches`（L1，default 勾）：`system/caches/` `system/index/` `system/frameworks/` `system/compile-server/` `system/dom-stats/` `system/event-log-data/` `system/tasks/` `system/JCEF/` `system/chrome-cache/`
  - `logs`（L1）：`system/log/` + `log/`
  - `local-history`（L2，default **不勾**，prompt confirm）：`system/LocalHistory/` `system/local_history/`，强 disclaimer
- **[P0]** PyCharm 专属 scope（其他 product 用户看到 zero match 无害）：
  - `pycharm-stubs`（L1）：`system/python_stubs/`
  - `pycharm-packages`（L1）：`system/python_packages/`（已知 bug 路径，让用户能定向清）
  - `pycharm-cpython-cache`（L1）：`system/cpython-cache/`
- **[P0]** 红线 safety test 必须断言：
  - `**/plugins/**` zero match
  - `**/config/**` zero match
  - `**/options/**` `**/keymaps/**` `**/colors/**` `**/codestyles/**` `**/inspection/**` zero match
  - macOS `~/Library/Application Support/JetBrains/<Product><Ver>/` 下任何路径 zero match
- **[P0]** detect 补全 macOS：`~/Library/Application Support/JetBrains` + `~/Library/Logs/JetBrains`（仅供 UI 显示，不用作 scope 起点）
- **[P0]** disclaimer 重写：明确"按 product+version 拆解显示"是 Phase 2 工作，当前会聚合所有版本
- **[P2]** schema 升级后拆 11 个 product-level scaffold（intellij / pycharm / webstorm / goland / clion / rider / phpstorm / rubymine / datagrip / rustrover / android-studio）+ Studio UI 支持按版本展开

#### `scaffolds/vscode.toml`（**增强**）

- **[P0]** 新增 cache scope `cached-extensions`：`**/Code/CachedExtensions/**` `**/Code/CachedExtensionVSIXs/**` `**/Code/CachedProfilesData/**`
- **[P0]** 新增 cache scope `electron-extras`：`**/Code/DawnCache/**` `**/Code/DawnGraphiteCache/**` `**/Code/blob_storage/**` `**/Code/Crashpad/**`
- **[P0]** 新增 globalStorage 已知大户 scope `globalstorage-known-large`（L2，default 不勾）：white-list 已知 cache 性质的 extension 目录
- **[P0]** [match] 排除 + safety test 红线断言：
  - `**/User/settings.json` zero match
  - `**/User/keybindings.json` zero match
  - `**/User/snippets/**` zero match
  - `**/User/globalStorage/state.vscdb` zero match
  - `**/User/globalStorage/state.vscdb.backup` zero match
  - `**/User/globalStorage/storage.json` zero match
  - `**/.vscode/extensions/**` zero match
- **[P2]** workspaceStorage 升级"workspace.json 路径校验"，需要 detect schema 扩展

#### `scaffolds/cursor.toml`（**增强 + Cursor 专项**）

- **[P0]** 同 vscode.toml 共同改动（cache 增项 + 红线 safety）
- **[P0]** Cursor 专项 scope：
  - `corrupted-state`（L1）：`**/Cursor/User/globalStorage/state.vscdb.corrupted*`
  - `cursor-history`（L2，days）：`**/Cursor/User/History/**`
  - `exthost-logs`（L1）：`**/Cursor/logs/*/exthost*/**`
- **[P0]** disclaimer 加"state.vscdb 是 AI chat history 主库，pinkbin 永远不动"
- **[P0]** [match] 红线：`**/Cursor/User/globalStorage/state.vscdb` zero match（与文件后缀 `.corrupted*` 区分）

#### 新增 VSCode-fork scaffold（P0/P1）

按用户基数和 pinkbin 受众，建议按这个顺序加：

- **[P0] `scaffolds/trae.toml`**：字节 参考 IDE（中国用户基数最大），含 `参考 IDE` 和 `参考 IDE` 两个 detect 路径
- **[P1] `scaffolds/windsurf.toml`**：Codeium Windsurf（国外 AI IDE 强势）
- **[P1] `scaffolds/vscodium.toml`**：去 telemetry 的 VSCode（隐私用户群）
- **[P2] `scaffolds/kiro.toml`** `scaffolds/positron.toml` `scaffolds/pearai.toml` 等：用户基数较小，按需

每份 scaffold 的结构 = `cursor.toml` 模板 + 替换路径。**短期接受 toml 文件数量增加**，长期再考虑 vscode-base.toml 模板复用机制。

#### 新增专项 scaffold（不放进现有文件）

- **[P1] `scaffolds/jetbrains-toolbox.toml`**：JetBrains Toolbox 自身的 cache（`%LOCALAPPDATA%\JetBrains\Toolbox\` 下有 `apps/` `bin/` `cache/` `download-cache/`），其中 `download-cache/` 和 `cache/` 是 L1 安全清；`apps/` 是 IDE 安装本体，红线
- **[P2] `scaffolds/vscode-server.toml`**：远端 SSH 场景的 `~/.vscode-server/`，参考 [XDflight gist](https://gist.github.com/XDflight/5f3509eb84fc282b88059c909036f5bc)；只在用户机器上有 SSH dev 习惯时有意义，优先级低

#### 横向工程改动（非 scaffold）

- **[P0] safety test 模板补强**：`crates/scaffold/tests/_templates/scaffold_safety.rs` 应该提供 IDE 类红线的标准断言集合（VSCode globalStorage `state.vscdb`、JetBrains plugins/config 等），让每份 IDE scaffold 复用
- **[P0] disclaimer 模板**：抽 IDE 共性 disclaimer 片段（"重启后会重建索引"、"扩展数据可能丢失登录态"、"Local History 是用户最后安全网"）到 `disclaimers/ide-common.md` 之类的复用源
- **[P1] Studio UI 增强**：考虑在 scaffold card 内支持子项展开（DevCleaner 模式），让 globalStorage 按 extension 子目录、JetBrains 按 product+version 子目录、workspaceStorage 按 hash 子目录都能可视化勾选；这是 schema + UI 双升级，工作量大但能彻底解决 jetbrains.toml 一刀切问题
- **[P1] detect schema 扩展**：支持"扫某基目录下所有匹配前缀的子目录"作为动态 detect，给 P2 的"按 product+version 拆"打基础
- **[P1] 文档**：在 `docs/scaffold-requirements/` 新建 `ide-jetbrains.md` 和 `ide-vscode-family.md`，把本调研的关键发现（official cleanup methods、red lines、protected file list）固化为后续 scaffold 设计的需求依据

---

### 2.5 一句话结论

> pinkbin 当前的 `jetbrains.toml` 是**最差的 scaffold**——三个粗 glob 既漏（不区分版本看不出旧版残留）又险（LocalHistory 和 system/caches 同 scope 一起清是有用户数据风险）。`vscode.toml` / `cursor.toml` 是**好基础但不够 deep**——只清 Electron 壳层 cache，没碰 globalStorage 这个真正的大头。短期 P0 只要做 jetbrains.toml 拆 scope + IDE 红线 safety test 补全 + 参考 IDE scaffold 新增三件事，就能把 pinkbin IDE 覆盖率从"对照 DevCleaner 的 30%"提到"接近持平"。

---

## 3. 产品哲学回顾（2026-05-04 user review）

> 本节由用户在 review 完 §1 + §2（共 33 条改动建议）后提出，作为后续所有 scaffold 与 UI 决策的**上位约束**。引用本报告任何条目前先读这一节，避免照搬 §1 / §2 的工程视角。

### 3.1 产品定位

Pinkbin 是**给普通用户简单解决 80% 最常规磁盘占用问题**的产品，**不是给 geek 的"无限可配置磁盘清理框架"**。两者在功能列表上看似相似，但产品形态截然不同：

- 普通用户：打开 app → 看到几个大头 → 一键清。不需要理解 scope / glob / mode
- Geek 框架：暴露所有 scope / 所有路径 / 所有 mode 让用户精细配置

**开发期（authoring）后端可以堆任意多 scaffold；产品交付到用户手里的形态必须狠狠收敛**——这两件事不是一回事。本调研报告 §1 / §2 的 33 条建议都是从工程视角写的，从产品视角约一半应当后置或砍掉。

### 3.2 砍掉的 geek 化建议（明确点名，避免未来重复造）

下列建议从工程视角都成立，但都是"geek 自嗨"，违反 80% 哲学，**默认不做**或显著后置：

| 建议 | 在原报告位置 | 为什么砍 |
|---|---|---|
| 13 个 VSCode fork 各做独立 scaffold（参考 IDE / Windsurf / Kiro / Antigravity / Aide / Positron / PearAI / Void / Qoder / VSCodium 等） | §2.2 + §2.4 P0/P1/P2 | 80% fork 用户已被 `vscode.toml` + `cursor.toml` 覆盖；剩余 fork 是长尾 |
| JetBrains 按 product 拆 11 份 scaffold（`pycharm.toml` / `idea.toml` / `webstorm.toml` / ...） | §2.4 P2 | 用户视角是"清 JetBrains"，不是"分别清 PyCharm 和 IDEA"；一份 `jetbrains.toml` 把 scope 切对就够 |
| 孤儿 venv 检测扩 schema（找 `pyvenv.cfg` 反推父目录） | §1.3 + §1.5 P1 | 受益群体是 5% 装了几十个 Python 项目的老炮，工程量大、误伤风险高 |
| pyenv / vscode-server / 参考 IDE 遥测 buffer / jetbrains-toolbox 单独 scaffold | §1.5 P2 + §2.4 P2 | 长尾 |
| Studio.tsx "按 extension 子目录 / 按 product+version 子目录可视化勾选"（DevCleaner 模式） | §2.4 P1 | 看似强大，实质是把 authoring 期的复杂度推给用户，违反 §3.4 |

**评估调研产出的真指标**：建议条数是负面指标，被砍掉的比例才是产品判断力。

### 3.3 真·80% 痛点（按"用户量 × 单次释放空间 × 用户感知度"重排）

替换原报告 §1.5 / §2.4 的 P0/P1/P2 排序——以用户视角而非工程视角：

1. **Conda envs**（不是 pkgs cache）—— anaconda 用户几乎人人有 2-5 个废 env，单 env 1-5 G。当前 `conda.toml` **完全没碰**。这是本次调研最大的真痛点
2. **VSCode/Cursor 的 `User/globalStorage/`**（Pylance 索引 / Copilot 缓存 / Tabnine 模型）—— 用户完全无感知，几个 G 静默累积。当前 scaffold **完全没碰**
3. **PyCharm 的 `system/python_stubs/` + `system/caches/`** —— PyCharm 重度用户痛点（官方 PY-43132 极端案例 100GB+，常态 5-20G）
4. **`jetbrains.toml` 当前的"既漏又险"** —— 不是要拆 11 份，而是要把单份的 scope 切对：caches / log / system-index 区分，plugins 与 LocalHistory 划红线

§1 / §2 的其他建议都不在这一档，应当后置。

### 3.4 UI 哲学延伸

"简单"≠"功能少"，="用户不用思考就能做对的事"。这意味着**后端要更聪明**，UI 才能更简洁：

- ❌ 反例：展开 `conda.toml` 看到 6 个 scope（pkgs cache / pkgs unused / envs base / envs >30d / envs >90d / pip in env），用户读 glob 决定勾哪个
- ✅ 正例：默认按 mtime > 90 天 + 非 base env 自动勾选，UI 一句话"发现 3 个 90 天没动过的 env，共 4.2 G，要清吗？"

当前 `Studio.tsx` 的"展开 scope 看 glob"那种渲染是 **authoring 期心智**（给开发者看自己写的 TOML 对不对），**不是产品形态**。如果认真贯彻这个哲学，UI 层有一轮专门的收敛要做——这件事不在 §1 / §2 任何一条建议里，但它是更上位的工作。

### 3.5 一个保留

80% 究竟是哪 80%，不能纯靠直觉。§3.3 的优先级排序部分有数据支撑（Conda envs 的社区怨气清晰可见），部分靠 GitHub issue 推断（globalStorage）。如果未来要补匿名占用统计上报来校准这个判断，要和"隐私优先"哲学**并桌权衡**，不能默默加。

### 3.6 这一节如何使用

- 后续任何 `/add-scaffold <id>` 的 Phase 1-2 需求采集，先翻本节核对该 scaffold 是否进入"真·80% 痛点"
- 任何"扩 schema / 加 UI 子项展开"的工程提案，先核对是否违反 §3.4
- 本哲学已固化为 feedback memory（`feedback_pinkbin_80pct_focus.md`），未来对话会自动加载

