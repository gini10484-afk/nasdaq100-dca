"""
每天自动更新 QQQ 行情，写入 docs/data.json（网页读取这个文件）。
由 GitHub Actions 自动运行，一般不需要你手动执行。

数据来源（按顺序尝试，前一个失败才用下一个）：
  1. Yahoo Finance（通过 yfinance 库）：有"分红调整后价格"，回测更准确
  2. Yahoo Finance 图表接口（直接请求，不依赖 yfinance）
  3. Stooq（备用）：只有收盘价，分红调整价按最近比例估算；下次 Yahoo 恢复后会整体覆盖

安全阀（借鉴 promise96319/qdii："数据质量不达标就不覆盖旧数据"）：
  行数明显变少、日期乱序、价格异常、单日涨跌超过 25%、和旧数据对不上 → 放弃这次更新，保留旧数据。
"""

import csv
import datetime as dt
import io
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

TICKER = "QQQ"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT, "docs", "data.json")
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
MIN_ROWS = 1000  # QQQ 从 1999 年开始有数据，正常有 6000+ 行


# ---------------------------------------------------------------- 工具
def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def load_existing():
    try:
        with open(DATA_PATH, encoding="utf-8") as f:
            return json.load(f).get("rows") or []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def clean(rows):
    """去掉空值，按日期排序，同一天只保留最后一条。"""
    by_date = {}
    for d, c, a in rows:
        if c is None or a is None:
            continue
        c, a = float(c), float(a)
        if math.isnan(c) or math.isnan(a):
            continue
        by_date[d] = [d, round(c, 4), round(a, 4)]
    return [by_date[d] for d in sorted(by_date)]


# ---------------------------------------------------------------- 数据源
def fetch_yfinance(_old):
    import yfinance as yf  # 放在函数里：没装 yfinance 时还能用后面的数据源

    df = yf.Ticker(TICKER).history(period="max", interval="1d", auto_adjust=False)
    if df is None or df.empty:
        raise RuntimeError("yfinance 返回了空数据")
    adj_col = "Adj Close" if "Adj Close" in df.columns else "Close"
    rows = [
        [ts.strftime("%Y-%m-%d"), close, adj]
        for ts, close, adj in zip(df.index, df["Close"].tolist(), df[adj_col].tolist())
    ]
    return clean(rows), "Yahoo Finance（yfinance）"


def fetch_yahoo_chart(_old):
    params = urllib.parse.urlencode(
        {
            "period1": 915148800,  # 1999-01-01
            "period2": int(time.time()) + 86400,
            "interval": "1d",
            "includeAdjustedClose": "true",
            "events": "div,split",
        }
    )
    url = f"https://query2.finance.yahoo.com/v8/finance/chart/{TICKER}?{params}"
    result = json.loads(http_get(url))["chart"]["result"][0]
    stamps = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]
    adj_list = result["indicators"].get("adjclose") or [{}]
    adjs = adj_list[0].get("adjclose") or closes
    offset = int(result.get("meta", {}).get("gmtoffset", -14400))
    rows = []
    for t, c, a in zip(stamps, closes, adjs):
        day = dt.datetime.fromtimestamp(t + offset, dt.timezone.utc).strftime("%Y-%m-%d")
        rows.append([day, c, a])
    return clean(rows), "Yahoo Finance（图表接口）"


def parse_stooq_csv(text):
    """Stooq 的 CSV：Date,Open,High,Low,Close,Volume。返回 {日期: 收盘价}。"""
    out = {}
    for row in csv.DictReader(io.StringIO(text.strip())):
        norm = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
        raw_date, raw_close = norm.get("date", ""), norm.get("close", "")
        if not raw_date or not raw_close:
            continue
        digits = raw_date.replace("-", "").replace("/", "")
        if len(digits) != 8 or not digits.isdigit():
            continue
        try:
            price = float(raw_close)
        except ValueError:
            continue
        out[f"{digits[:4]}-{digits[4:6]}-{digits[6:]}"] = price
    return out


def fetch_stooq(old):
    if not old:
        raise RuntimeError("备用源只能在已有历史数据上追加，请等 Yahoo 恢复后再试")
    new_closes = parse_stooq_csv(http_get(f"https://stooq.com/q/d/l/?s={TICKER.lower()}.us&i=d"))
    last_date, last_close, last_adj = old[-1]
    ratio = last_adj / last_close
    rows = [list(r) for r in old]
    for d in sorted(new_closes):
        if d > last_date:
            rows.append([d, new_closes[d], new_closes[d] * ratio])
    return clean(rows), "Stooq（备用源，分红调整价为估算）"


# ---------------------------------------------------------------- 校验
def validate(rows, old):
    if len(rows) < MIN_ROWS:
        return f"只有 {len(rows)} 行，太少了"
    today = dt.datetime.now(dt.timezone.utc).date()
    prev = None
    for d, c, a in rows:
        try:
            day = dt.date.fromisoformat(d)
        except ValueError:
            return f"日期格式不对：{d}"
        if prev and day <= prev:
            return f"日期没有按顺序排列：{d}"
        if not (c > 0 and a > 0):
            return f"{d} 的价格不正常：{c} / {a}"
        prev = day
    if prev > today + dt.timedelta(days=1):
        return f"最新日期 {prev} 在未来"
    for i in range(max(1, len(rows) - 60), len(rows)):
        change = rows[i][1] / rows[i - 1][1] - 1
        if abs(change) > 0.25:
            return f"{rows[i][0]} 单日涨跌 {change:.1%}，不太可能，先不更新"
    if old:
        if len(rows) < len(old) - 5:
            return f"新数据 {len(rows)} 行比旧数据 {len(old)} 行少太多"
        if rows[-1][0] < old[-1][0]:
            return f"新数据最新日期 {rows[-1][0]} 比旧数据 {old[-1][0]} 还旧"
        new_close = {d: c for d, c, _ in rows}
        for d, c, _ in old[-20:]:
            if d in new_close and abs(new_close[d] / c - 1) > 0.02:
                return f"{d} 的收盘价和旧数据差太多（{c} → {new_close[d]}）"
    return None


# ---------------------------------------------------------------- 写文件
def write_json(rows, source):
    lines = [
        "{",
        f'  "ticker": {json.dumps(TICKER)},',
        f'  "source": {json.dumps(source, ensure_ascii=False)},',
        f'  "updated_at": {json.dumps(dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))},',
        '  "columns": ["date", "close", "adj_close"],',
        '  "rows": [',
    ]
    lines += [
        "    " + json.dumps(r, separators=(",", ":")) + ("," if i < len(rows) - 1 else "")
        for i, r in enumerate(rows)
    ]
    lines += ["  ]", "}"]
    text = "\n".join(lines) + "\n"
    json.loads(text)  # 写之前自检一遍
    tmp = DATA_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, DATA_PATH)


def main():
    old = load_existing()
    problems = []
    for fetch in (fetch_yfinance, fetch_yahoo_chart, fetch_stooq):
        rows = None
        for attempt in range(1, 4):
            try:
                rows, source = fetch(old)
                break
            except Exception as e:  # noqa: BLE001 —— 任何错误都换下一次尝试
                problems.append(f"{fetch.__name__} 第 {attempt} 次失败：{type(e).__name__}: {e}")
                if isinstance(e, ImportError) or "备用源" in str(e):
                    break  # 这类错误重试也没用
                if attempt < 3:
                    time.sleep(10 * attempt)
        if rows is None:
            continue
        reason = validate(rows, old)
        if reason:
            problems.append(f"{fetch.__name__} 数据校验没通过：{reason}")
            continue
        if rows == old:
            print(f"数据没有变化（最新 {rows[-1][0]}），来源：{source}")
        else:
            write_json(rows, source)
            added = len(rows) - len(old)
            print(f"已更新：{len(rows)} 行，最新 {rows[-1][0]} 收盘 {rows[-1][1]}，新增 {added} 行，来源：{source}")
        for p in problems:
            print("  （之前的尝试）" + p)
        return 0

    print("所有数据源都失败了，保留旧数据，网页会显示“数据没更新”的提醒：")
    for p in problems:
        print("  - " + p)
    return 1


if __name__ == "__main__":
    sys.exit(main())
