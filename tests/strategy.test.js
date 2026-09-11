// 运行：node --test tests/strategy.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DCA = require("../docs/strategy.js");

// 生成从 start 开始的交易日（跳过周末和 holidays）
function tradingDays(start, count, holidays = []) {
  const out = [];
  let d = DCA.dayNumber(start);
  while (out.length < count) {
    const wd = DCA.weekdayOf(d);
    const s = DCA.dateFromDayNumber(d);
    if (wd >= 1 && wd <= 5 && !holidays.includes(s)) out.push(s);
    d++;
  }
  return out;
}
function series(dates, closes, adjs) {
  return DCA.prepare({ rows: dates.map((d, i) => [d, closes[i], adjs ? adjs[i] : closes[i]]) });
}
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test("星期计算", () => {
  assert.equal(DCA.weekdayOf(DCA.dayNumber("2026-09-11")), 5); // 周五
  assert.equal(DCA.weekdayOf(DCA.dayNumber("2026-09-14")), 1); // 周一
  assert.equal(DCA.weekdayOf(DCA.dayNumber("1970-01-01")), 4); // 周四
});

test("回撤：历史最高点", () => {
  const s = series(tradingDays("2026-01-05", 5), [100, 110, 99, 120, 90]);
  const { dd, peakIdx } = DCA.drawdowns(s, "ath");
  [0, 0, 10, 0, 25].forEach((v, i) => close(dd[i], v));
  assert.deepEqual(peakIdx, [0, 1, 1, 3, 3]);
});

test("回撤：近 52 周最高点会“忘掉”一年前的高点", () => {
  const closes = Array(300).fill(100);
  closes[0] = 200;
  const s = series(tradingDays("2020-01-06", 300), closes);
  const { dd } = DCA.drawdowns(s, "52w");
  close(dd[251], 50); // 第 252 个交易日：窗口里还有 200
  close(dd[252], 0); // 第 253 个交易日：200 已经滑出窗口
  const ath = DCA.drawdowns(s, "ath").dd;
  close(ath[299], 50); // 历史最高点永远记得 200
});

test("分档：回撤越多倍数越高", () => {
  const tiers = DCA.normalizeTiers(DCA.DEFAULT_CONFIG.tiers);
  assert.equal(DCA.multiplierFor(0, tiers), 1);
  assert.equal(DCA.multiplierFor(9.99, tiers), 1);
  assert.equal(DCA.multiplierFor(10, tiers), 1.5);
  assert.equal(DCA.multiplierFor(25, tiers), 2);
  assert.equal(DCA.multiplierFor(45, tiers), 3);
  // 第一档从 5% 开始时，回撤不到 5% 按 ×1
  const t2 = DCA.normalizeTiers([{ minDrawdown: 15, multiplier: 2 }, { minDrawdown: 5, multiplier: 1.2 }]);
  assert.equal(t2[0].minDrawdown, 5); // 自动排序
  assert.equal(DCA.tierIndex(3, t2), -1);
  assert.equal(DCA.multiplierFor(3, t2), 1);
});

test("每周定投日：遇休市顺延，最后一周没过完不算", () => {
  // 2026-09-07 周一是美国劳动节休市；假设 9-18 周五也休市
  const dates = tradingDays("2026-09-07", 12, ["2026-09-07", "2026-09-18"]);
  assert.equal(dates[0], "2026-09-08");
  const s = series(dates, dates.map(() => 100));
  const mon = DCA.investDays(s, 1).map((i) => dates[i]);
  assert.deepEqual(mon, ["2026-09-08", "2026-09-14", "2026-09-21"]);
  const fri = DCA.investDays(s, 5).map((i) => dates[i]);
  // 9-11 周五；9-18 休市 → 用 9-17 周四；数据截止 9-24 周四，这周还没到周五 → 不算
  assert.equal(dates[dates.length - 1], "2026-09-24");
  assert.deepEqual(fri, ["2026-09-11", "2026-09-17"]);
});

test("下一个定投日", () => {
  assert.equal(DCA.nextInvestDate("2026-09-11", 1), "2026-09-14");
  assert.equal(DCA.nextInvestDate("2026-09-14", 1), "2026-09-21");
  assert.equal(DCA.nextInvestDate("2026-09-10", 5), "2026-09-11");
});

test("XIRR", () => {
  const d0 = DCA.dayNumber("2020-01-01");
  close(DCA.xirr([[d0, 100]], 110, d0 + 365), 0.1, 1e-8);
  close(DCA.xirr([[d0, 100], [d0 + 365, 100]], 231, d0 + 730), 0.1, 1e-8);
  close(DCA.xirr([[d0, 100]], 100, d0 + 365), 0, 1e-8);
  assert.ok(Number.isNaN(DCA.xirr([], 100, d0)));
});

test("回测：价格不变时收益为 0，普通定投每周金额固定", () => {
  const dates = tradingDays("2021-01-04", 60);
  const s = series(dates, dates.map(() => 50));
  const r = DCA.backtest(s, { baseAmount: 100 }, { plain: true });
  // 12 个周一，但第一个交易日没有“前一天收盘价”，所以从第 2 周开始 → 11 周
  assert.equal(r.weeks, 11);
  assert.equal(r.invested, 1100);
  close(r.totalReturn, 0);
  close(r.xirr, 0, 1e-6);
  assert.equal(r.maxAmount, 100);
  assert.equal(r.longestStreak, 0);
});

test("回测：用前一天的回撤决定金额（不偷看当天）", () => {
  // 第 1 周：周一 100 → 第 2 周周一前一天(周五)跌到 80（回撤 20%）→ 第 2 周投 ×2
  // 第 2 周周一当天涨回 100：如果偷看当天，就会错投 ×1
  const dates = tradingDays("2021-01-04", 11); // 1-04 周一 … 1-18 周一
  const closes = [100, 100, 100, 100, 80, 100, 100, 100, 100, 100, 100];
  const s = series(dates, closes);
  const r = DCA.backtest(s, { baseAmount: 100, investWeekday: 1 }, {});
  // 第一个交易日没有“前一天”，从第 2 周开始定投
  assert.deepEqual(r.curve.filter((c) => !c.final).map((c) => [c.date, c.amount]), [
    ["2021-01-11", 200],
    ["2021-01-18", 100],
  ]);
  assert.equal(r.maxAmount, 200);
  assert.equal(r.maxAmountDate, "2021-01-11");
  assert.equal(r.boostedWeeks, 1);
  assert.equal(r.longestStreak, 1);
});

test("回测：跌多多投的平均买入价更低", () => {
  const dates = tradingDays("2019-01-07", 300);
  // 先涨后跌再回来
  const closes = dates.map((_, i) => 100 + 30 * Math.sin(i / 25));
  const s = series(dates, closes);
  const plain = DCA.backtest(s, {}, { plain: true });
  const tiered = DCA.backtest(s, {}, {});
  assert.equal(plain.weeks, tiered.weeks);
  assert.ok(tiered.invested > plain.invested);
  assert.ok(tiered.avgCost < plain.avgCost);
  assert.equal(plain.curve.length, tiered.curve.length);
});

test("回测：分红调整价用于算市值", () => {
  const dates = tradingDays("2022-01-03", 30);
  const closes = dates.map(() => 100);
  const adjs = dates.map((_, i) => 100 * (1 + i * 0.001)); // 调整价慢慢变高（相当于分红再投资）
  const s = series(dates, closes, adjs);
  const r = DCA.backtest(s, {}, { plain: true });
  assert.ok(r.totalReturn > 0);
  close(r.avgCost, 100); // 平均买入价按真实收盘价算
});

test("不同开始年份对比 & 设置容错", () => {
  const dates = tradingDays("2018-01-01", 1300);
  const s = series(dates, dates.map((_, i) => 100 + i * 0.05));
  const last = +dates[dates.length - 1].slice(0, 4);
  const rows = DCA.compareStarts(s, {}, [2018, 2019, 2020, last]);
  assert.deepEqual(rows.map((r) => r.year), [2018, 2019, 2020].filter((y) => y <= last - 1));
  rows.forEach((r) => close(r.investedRatio, 1)); // 一直创新高 → 从不加码
  const cfg = DCA.withDefaults({ baseAmount: -5, investWeekday: 9, basis: "xx", tiers: [] });
  assert.equal(cfg.baseAmount, 100);
  assert.equal(cfg.investWeekday, 1);
  assert.equal(cfg.basis, "ath");
  assert.equal(cfg.tiers.length, 4);
});

test("当前信号", () => {
  const dates = tradingDays("2026-08-31", 10); // 截止 2026-09-11 周五
  const s = series(dates, [100, 105, 110, 120, 118, 110, 100, 96, 95, 90]);
  const sig = DCA.currentSignal(s, { baseAmount: 200, investWeekday: 1 });
  assert.equal(sig.date, "2026-09-11");
  assert.equal(sig.nextDate, "2026-09-14");
  close(sig.drawdown, 25);
  assert.equal(sig.peakDate, "2026-09-03");
  assert.equal(sig.multiplier, 2);
  assert.equal(sig.amount, 400);
});

test("最长水下期", () => {
  const dates = tradingDays("2021-01-04", 12);
  // 高点 120(第2天) → 最低 60 → 第 8 天回到 120；之后 130 → 125（还没回来，但时间更短）
  const s = series(dates, [100, 120, 90, 60, 80, 100, 110, 120, 130, 125, 126, 127]);
  const u = DCA.longestUnderwater(s);
  assert.equal(u.peakDate, dates[1]);
  assert.equal(u.troughDate, dates[3]);
  assert.equal(u.recoveryDate, dates[7]);
  close(u.maxDrawdown, 50);
  // 一直没回来的情况
  const s2 = series(dates.slice(0, 5), [100, 90, 80, 85, 95]);
  const u2 = DCA.longestUnderwater(s2);
  assert.equal(u2.recoveryDate, null);
  close(u2.maxDrawdown, 20);
});

test("按年汇总", () => {
  const dates = tradingDays("2020-06-01", 450); // 到 2022-02-18
  const s = series(dates, dates.map((_, i) => 100 + i));
  const dd = DCA.drawdowns(s, "ath").dd;
  const p = DCA.backtest(s, {}, { plain: true, dd });
  const t = DCA.backtest(s, {}, { dd });
  const y = DCA.yearly(s, dd, p.curve, t.curve);
  assert.deepEqual(y.map((r) => r.year), [2020, 2021, 2022]);
  assert.equal(y[0].partial, true);
  assert.equal(y[1].partial, false);
  assert.ok(y[1].change > 0);
  assert.equal(y[1].maxDrawdown, 0);
});

test("买入记录：某天的规则建议用前一个交易日收盘价", () => {
  const dates = tradingDays("2026-08-31", 10); // 8-31 周一 … 9-11 周五
  const s = series(dates, [100, 100, 100, 100, 100, 100, 100, 100, 85, 100]);
  // 9-11（周五）当天：前一天 9-10 收盘 85 → 回撤 15% → ×1.5
  const a = DCA.suggestionForDate(s, { baseAmount: 200 }, "2026-09-11");
  assert.equal(a.basedOn, "2026-09-10");
  assert.equal(a.multiplier, 1.5);
  assert.equal(a.amount, 300);
  assert.equal(a.closeOnDate, 100);
  // 9-13（周日）之后没有数据：用最新收盘 9-11（回撤 0）→ ×1
  const b = DCA.suggestionForDate(s, { baseAmount: 200 }, "2026-09-13");
  assert.equal(b.basedOn, "2026-09-11");
  assert.equal(b.amount, 200);
  assert.equal(b.closeOnDate, null);
  // 周末买入：用周五收盘
  const c = DCA.suggestionForDate(s, {}, "2026-09-06");
  assert.equal(c.basedOn, "2026-09-04");
  // 比第一天还早：没有依据
  assert.equal(DCA.suggestionForDate(s, {}, "2026-08-31"), null);
  assert.equal(DCA.suggestionForDate(s, {}, "不是日期"), null);
});

test("买入记录：汇总持仓、和规则对比", () => {
  const dates = tradingDays("2026-08-03", 30);
  const closes = dates.map(() => 100);
  closes[12] = 80; // 8-19 周三跌到 80（回撤 20%）
  const s = series(dates, closes);
  const trades = [
    { id: "b", date: dates[13], amount: 200, price: 80 }, // 前一天回撤 20% → 建议 ×2 = $200，照做
    { id: "a", date: dates[5], amount: 150, price: 100 }, // 建议 $100，多投了 $50
    { id: "x", date: "坏数据", amount: 100, price: 100 }, // 会被忽略
    { id: "y", date: dates[6], amount: 0, price: 100 }, // 金额为 0 忽略
  ];
  const r = DCA.summarizeTrades(s, { baseAmount: 100 }, trades);
  assert.equal(r.count, 2);
  assert.deepEqual(r.rows.map((x) => x.id), ["a", "b"]); // 按日期排序
  assert.equal(r.rows[0].suggested, 100);
  assert.equal(r.rows[0].diff, 50);
  assert.equal(r.rows[1].suggested, 200);
  assert.equal(r.rows[1].multiplier, 2);
  assert.equal(r.invested, 350);
  assert.equal(r.suggestedTotal, 300);
  assert.equal(r.followed, 1);
  close(r.shares, 1.5 + 2.5);
  close(r.value, 400); // 4 股 × 最新收盘 100
  close(r.avgCost, 87.5);
  close(r.profit, 50);
  assert.equal(r.lastDate, dates[29]);
  const empty = DCA.summarizeTrades(s, {}, []);
  assert.equal(empty.count, 0);
  assert.ok(Number.isNaN(empty.xirr));
});
