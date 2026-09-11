# 运行：python -m unittest tests/test_update_data.py
import datetime as dt
import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

import pandas as pd  # 先导入，避免 mock.patch.dict 还原 sys.modules 时把 numpy 卸掉

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import update_data as ud  # noqa: E402


def make_rows(n, start="2000-01-03", price=100.0, step=0.01):
    rows, day = [], dt.date.fromisoformat(start)
    while len(rows) < n:
        if day.weekday() < 5:
            p = price + len(rows) * step
            rows.append([day.isoformat(), round(p, 4), round(p * 0.9, 4)])
        day += dt.timedelta(days=1)
    return rows


class FakeTicker:
    def __init__(self, rows):
        self.rows = rows

    def history(self, **kwargs):
        idx = pd.DatetimeIndex([pd.Timestamp(r[0]).tz_localize("America/New_York") for r in self.rows])
        return pd.DataFrame(
            {
                "Open": [r[1] for r in self.rows],
                "High": [r[1] for r in self.rows],
                "Low": [r[1] for r in self.rows],
                "Close": [r[1] for r in self.rows],
                "Adj Close": [r[2] for r in self.rows],
                "Volume": [1000] * len(self.rows),
            },
            index=idx,
        )


class UpdateDataTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "data.json")
        self.patches = [mock.patch.object(ud, "DATA_PATH", self.path), mock.patch.object(ud.time, "sleep", lambda s: None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def install_fake_yf(self, rows=None, error=None):
        fake = types.ModuleType("yfinance")

        def ticker(symbol):
            if error:
                raise error
            return FakeTicker(rows)

        fake.Ticker = ticker
        return mock.patch.dict(sys.modules, {"yfinance": fake})

    def test_yfinance_first_run_writes_file(self):
        rows = make_rows(1500)
        with self.install_fake_yf(rows):
            self.assertEqual(ud.main(), 0)
        with open(self.path, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(len(data["rows"]), 1500)
        self.assertEqual(data["rows"][-1], rows[-1])
        self.assertIn("yfinance", data["source"])

    def test_no_change_keeps_file(self):
        rows = make_rows(1500)
        ud.write_json(rows, "x")
        before = os.path.getmtime(self.path)
        with self.install_fake_yf(rows):
            self.assertEqual(ud.main(), 0)
        self.assertEqual(os.path.getmtime(self.path), before)

    def test_validation_rejects_bad_data(self):
        rows = make_rows(1500)
        self.assertIsNone(ud.validate(rows, []))
        self.assertIn("太少", ud.validate(rows[:10], []))
        jump = [list(r) for r in rows]
        jump[-1][1] = jump[-2][1] * 1.5
        self.assertIn("单日涨跌", ud.validate(jump, []))
        self.assertIn("少太多", ud.validate(rows[:1200], rows))
        shifted = [[d, c * 1.1, a] for d, c, a in rows]
        self.assertIn("差太多", ud.validate(shifted, rows))
        self.assertIn("还旧", ud.validate(rows[:-10], rows[:-10] + [["2099-01-01", 1, 1]]))

    def test_bad_yfinance_falls_back_to_chart_api(self):
        rows = make_rows(1200, start="2019-01-02")
        stamps = [int(dt.datetime.fromisoformat(r[0] + "T13:30:00+00:00").timestamp()) for r in rows]
        payload = {
            "chart": {
                "result": [
                    {
                        "meta": {"gmtoffset": -14400},
                        "timestamp": stamps,
                        "indicators": {
                            "quote": [{"close": [r[1] for r in rows]}],
                            "adjclose": [{"adjclose": [r[2] for r in rows]}],
                        },
                    }
                ]
            }
        }
        with self.install_fake_yf(error=RuntimeError("rate limited")), mock.patch.object(
            ud, "http_get", return_value=json.dumps(payload)
        ):
            self.assertEqual(ud.main(), 0)
        with open(self.path, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual([r[0] for r in data["rows"]], [r[0] for r in rows])
        self.assertIn("图表接口", data["source"])

    def test_stooq_appends_new_days_with_estimated_adjustment(self):
        old = make_rows(1200, start="2019-01-02")
        last = dt.date.fromisoformat(old[-1][0])
        new_days = [last + dt.timedelta(days=k) for k in (1, 2, 3, 4, 5, 6, 7) if (last + dt.timedelta(days=k)).weekday() < 5][:2]
        csv_text = "Date,Open,High,Low,Close,Volume\n" + "\n".join(
            f"{d.isoformat()},1,1,1,{old[-1][1] + i + 1},100" for i, d in enumerate(new_days)
        ) + f"\n{old[-1][0]},1,1,1,{old[-1][1]},100\n"
        parsed = ud.parse_stooq_csv(csv_text)
        self.assertEqual(len(parsed), 3)
        with mock.patch.object(ud, "http_get", return_value=csv_text):
            rows, source = ud.fetch_stooq(old)
        self.assertEqual(len(rows), len(old) + 2)
        ratio = old[-1][2] / old[-1][1]
        self.assertAlmostEqual(rows[-1][2], round(rows[-1][1] * ratio, 4), places=3)
        self.assertIn("备用", source)

    def test_all_sources_fail_keeps_old_data(self):
        old = make_rows(1500)
        ud.write_json(old, "旧数据")
        with open(self.path, encoding="utf-8") as f:
            before = f.read()
        with self.install_fake_yf(error=RuntimeError("blocked")), mock.patch.object(
            ud, "http_get", side_effect=OSError("network down")
        ):
            self.assertEqual(ud.main(), 1)
        with open(self.path, encoding="utf-8") as f:
            self.assertEqual(f.read(), before)


if __name__ == "__main__":
    unittest.main()
