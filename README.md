# 我的纳指100定投计划（QQQ · 每周定投 · 跌多多投）

**网站地址：<https://gini10484-afk.github.io/nasdaq100-dca/>**

一个每天自动更新的小网站。打开它就能看到：

- **下个定投日该投多少钱**：QQQ 离最高点跌得越多，投得越多
- **QQQ 历史上跌了多少**：图上画出了每一档加码的分界线
- **这个规则过去管不管用**：和“每周固定金额”的普通定投做回测对比，还会换不同开始年份再比一遍
- **用之前要知道的事**：最多一周要投多少、最长连续加码多久、历史上最长多久才回本

网站放在免费的 GitHub Pages 上。每个美股交易日收盘后（北京时间早上 6:30 左右），GitHub 会自动拉取最新行情并更新网站，手机和电脑都能打开。

> 这个网站不预测明天涨跌，没有人能稳定做到这件事。它做的是：用你自己定的规则，根据“现在已经跌了多少”算出这周该投多少，并用历史数据检验这个规则。

---

## 规则是什么

| QQQ 离最高点跌了 | 这周投入 |
|---|---|
| 不到 10% | 基础金额 × 1 |
| 10% – 20% | 基础金额 × 1.5 |
| 20% – 30% | 基础金额 × 2 |
| 30% 以上 | 基础金额 × 3 |

- 默认每周一定投，基础金额 $100。
- “跌了多少”用**定投日前一个交易日的收盘价**计算，不会偷看当天价格。
- 基础金额、定投日、分档，以及“跟历史最高点比”还是“跟近一年最高点比”，都可以直接在网页上改。改完信号和回测会马上重新计算，设置保存在你自己的浏览器里。

---

## 部署到网上（大约 15 分钟，只需要做一次）

### 第 1 步：注册 GitHub

打开 <https://github.com/signup> 注册一个免费账号，并验证邮箱。

### 第 2 步：新建一个公开仓库

1. 登录后点右上角 **＋** → **New repository**。
2. **Repository name** 填 `nasdaq100-dca`（也可以用别的名字，最后网址会跟着变）。
3. 选择 **Public**（免费账号的 GitHub Pages 需要公开仓库。仓库里只有代码和公开的行情数据，你在网页上的设置不会上传）。
4. 下面的 “Add a README” 等选项**都不要勾**，点 **Create repository**。

### 第 3 步：上传文件

1. 在刚建好的仓库页面上，点 **uploading an existing file** 这个链接。
2. 在 Mac 的“访达”里打开 **文稿 → nasdaq100-dca**，按 **Command + A** 全选**文件夹里面的内容**（`docs`、`scripts`、`tests`、`workflow`、`README.md`、`requirements.txt`），拖到网页的上传区域。不要拖外面的 `nasdaq100-dca` 文件夹本身。
3. 等文件列表出来后，点页面底部绿色的 **Commit changes**。

### 第 4 步：打开 GitHub Pages

1. 点仓库上方的 **Settings**，左侧点 **Pages**。
2. **Build and deployment → Source** 选择 **GitHub Actions**。

### 第 5 步：添加“每天自动更新”的设置文件

这个文件必须放在仓库的 `.github/workflows/` 文件夹里。这是隐藏文件夹，拖拽上传时经常被漏掉，所以在网页上单独新建：

1. 回到仓库首页（点左上角的仓库名），点 **Add file → Create new file**。
2. 文件名输入：`.github/workflows/update-and-deploy.yml`（输入 `/` 时会自动变成文件夹）。
3. 在电脑上用“文本编辑”打开 `nasdaq100-dca/workflow/update-and-deploy.yml`，按 Command + A 全选、复制，再粘贴到网页的大输入框里。
4. 点 **Commit changes**。

提交后，自动更新会马上开始第一次运行。

### 第 6 步：确认运行成功

1. 点仓库上方的 **Actions**。
2. 左边点 **每日更新数据并发布网站**，能看到正在运行的记录（黄色圆点）。
3. 如果没有运行记录，点右边 **Run workflow**，再点绿色的 **Run workflow**。
4. 等 2–3 分钟，出现绿色对勾 ✅ 就说明成功了。

### 第 7 步：打开你的网站

回到 **Settings → Pages**，页面顶部会显示网址，一般是：

```
https://你的用户名.github.io/nasdaq100-dca/
```

用手机打开，加到收藏或主屏幕，以后每周定投前看一眼就行。

---

## 以后每天会自动发生什么

1. 每个美股交易日收盘后，GitHub Actions 从 Yahoo Finance 拉取 QQQ 的完整历史行情。
2. 数据先检查一遍：行数突然变少、日期乱序、单日涨跌超过 25%、和旧数据对不上，都会放弃这次更新，保留旧数据。
3. 检查通过就保存到 `docs/data.json`，并重新发布网站。
4. 如果 Yahoo 暂时连不上，会自动换备用接口。全部失败时，网站继续显示旧数据并出现黄色提醒，GitHub 也会发邮件通知你，通常第二天会自己恢复。

---

## 常见问题

**Actions 里出现红叉 ❌ 怎么办？**
点进去看是哪一步失败了。如果是“更新行情数据”失败，多半是数据源暂时不可用，网站还会用旧数据正常发布，等第二天自动重试就好。如果是“发布到 GitHub Pages”失败，请检查第 4 步的 Source 是否选了 **GitHub Actions**。如果 Actions 页面什么都没有，请检查第 5 步的文件名是不是正好是 `.github/workflows/update-and-deploy.yml`。

**收到邮件说定时任务被停用了？**
GitHub 会暂停长期没有活动的仓库的定时任务。打开 **Actions**，点 **Enable workflow** 就能恢复。

**想改默认规则（网页第一次打开时的设置）？**
改 `docs/strategy.js` 最上面的 `DEFAULT_CONFIG`。在 GitHub 网页上点开这个文件，点铅笔图标编辑，然后 **Commit changes**。提交后网站会自动重新发布。

**想在自己电脑上预览？**
在 `docs` 文件夹里运行 `python3 -m http.server`，再打开 <http://localhost:8000>。不能直接双击 `index.html`，因为浏览器不允许网页这样读取数据文件。需要先有行情数据，可以先按第 6 步在仓库里运行一次，再把 `docs/data.json` 下载下来。

**想检查计算逻辑？**
```bash
node --test tests/strategy.test.js            # 规则和回测（15 项）
python3 -m unittest tests/test_update_data.py # 数据更新脚本（需要 pandas）
```

---

## 文件说明

```
nasdaq100-dca/
├── docs/                      ← 网站本身（发布到 GitHub Pages 的就是这个文件夹）
│   ├── index.html             页面：信号、图表、回测对比
│   ├── strategy.js            规则和回测计算（默认设置在最上面）
│   └── data.json              QQQ 行情数据（自动更新，不用手动改）
├── scripts/
│   └── update_data.py         拉行情、检查数据、写入 data.json
├── workflow/
│   └── update-and-deploy.yml  每天定时运行 + 发布网站（要复制到仓库的 .github/workflows/ 里，见第 5 步）
├── tests/                     自动测试
└── requirements.txt           Python 依赖（yfinance）
```

---

## 借鉴了这些开源项目

| 项目 | 借鉴了什么 |
|---|---|
| [wangsunan98/NDX100-autopilot-calculator](https://github.com/wangsunan98/NDX100-autopilot-calculator) | 分档倍数表：用一个基础金额算出每一档该投多少 |
| [kydchen/qqq-tqqq-signal-dashboard](https://github.com/kydchen/qqq-tqqq-signal-dashboard) | 用纳指回撤判断“低位”；设置保存在本地浏览器 |
| [promise96319/qdii](https://github.com/promise96319/qdii) | GitHub Actions 每天自动抓数据；数据质量不达标就不覆盖旧数据 |
| [scsfwgy/global_asset_history](https://github.com/scsfwgy/global_asset_history) | 按周定投回测，展示收益曲线和历史回撤 |
| [refraction-ray/xalpha](https://github.com/refraction-ray/xalpha) | 用 XIRR 衡量定投的真实年化收益 |
| [Elucidation/lumpsum_vs_dca](https://github.com/Elucidation/lumpsum_vs_dca) | 公平比较策略：看收益率，而不只看赚了多少钱 |
| [hzm0321/real-time-fund](https://github.com/hzm0321/real-time-fund) | 用 GitHub Actions 部署到 GitHub Pages |
| [ranaroussi/yfinance](https://github.com/ranaroussi/yfinance) | 从 Yahoo Finance 获取行情 |

---

## 免责声明

- 回测没有计算券商手续费、美股分红税和人民币汇率变化，并假设可以买零碎股、分红自动再投资。
- 过去的表现不代表未来。“跌多多投”在长期下跌时需要持续投入更多资金，请先确认自己的备用金够用。
- 本项目只用来记录和执行你自己定的定投规则，不构成任何投资建议。
