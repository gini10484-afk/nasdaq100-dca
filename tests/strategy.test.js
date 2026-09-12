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
// 测试不依赖 DEFAULT_CONFIG（默认规则以后可能会改），需要哪种规则就写明
const TIERED = { strategy: "tiered", basis: "ath" };
const TREND = { strategy: "trend", basis: "ath", trend: { dipMultiplier: 1.5 } };

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
  const r = DCA.backtest(s, { ...TIERED, baseAmount: 100, investWeekday: 1 }, {});
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
  const plain = DCA.backtest(s, TIERED, { plain: true });
  const tiered = DCA.backtest(s, TIERED, {});
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
  const rows = DCA.compareStarts(s, TREND, [2018, 2019, 2020, last]);
  assert.deepEqual(rows.map((r) => r.year), [2018, 2019, 2020].filter((y) => y <= last - 1));
  rows.forEach((r) => {
    close(r.investedRatio, 1); // 一直创新高 → 从不加码
    close(r.trendInvestedRatio, 1); // 慢慢涨、没有涨太多 → 趋势定投也一直 ×1
    assert.equal(r.trend.strategy, "trend");
  });
  const cfg = DCA.withDefaults({ baseAmount: -5, investWeekday: 9, basis: "xx", tiers: [], strategy: "xx" });
  assert.equal(cfg.baseAmount, DCA.DEFAULT_CONFIG.baseAmount);
  assert.equal(cfg.investWeekday, DCA.DEFAULT_CONFIG.investWeekday);
  assert.equal(cfg.basis, DCA.DEFAULT_CONFIG.basis);
  assert.equal(cfg.tiers.length, 4);
  assert.equal(cfg.strategy, DCA.DEFAULT_CONFIG.strategy);
  assert.equal(DCA.withDefaults({ strategy: "tiered" }).strategy, "tiered");
  assert.equal(DCA.withDefaults({ strategy: "trend" }).strategy, "trend");
  assert.equal(DCA.withDefaults({ basis: "ath" }).basis, "ath");
});

test("当前信号", () => {
  const dates = tradingDays("2026-08-31", 10); // 截止 2026-09-11 周五
  const s = series(dates, [100, 105, 110, 120, 118, 110, 100, 96, 95, 90]);
  const sig = DCA.currentSignal(s, { ...TIERED, baseAmount: 200, investWeekday: 1 });
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
  const p = DCA.backtest(s, TIERED, { plain: true, dd });
  const t = DCA.backtest(s, TIERED, { dd });
  const tr = DCA.backtest(s, TREND, { strategy: "trend", dd });
  const y = DCA.yearly(s, dd, p.curve, t.curve, tr.curve);
  assert.deepEqual(y.map((r) => r.year), [2020, 2021, 2022]);
  assert.ok(y[1].trendReturn > 0);
  assert.equal(y[0].partial, true);
  assert.equal(y[1].partial, false);
  assert.ok(y[1].change > 0);
  assert.equal(y[1].maxDrawdown, 0);
});

test("买入记录：某天的规则建议用前一个交易日收盘价", () => {
  const dates = tradingDays("2026-08-31", 10); // 8-31 周一 … 9-11 周五
  const s = series(dates, [100, 100, 100, 100, 100, 100, 100, 100, 85, 100]);
  // 9-11（周五）当天：前一天 9-10 收盘 85 → 回撤 15% → ×1.5
  const a = DCA.suggestionForDate(s, { ...TIERED, baseAmount: 200 }, "2026-09-11");
  assert.equal(a.basedOn, "2026-09-10");
  assert.equal(a.multiplier, 1.5);
  assert.equal(a.amount, 300);
  assert.equal(a.closeOnDate, 100);
  // 9-13（周日）之后没有数据：用最新收盘 9-11（回撤 0）→ ×1
  const b = DCA.suggestionForDate(s, { ...TIERED, baseAmount: 200 }, "2026-09-13");
  assert.equal(b.basedOn, "2026-09-11");
  assert.equal(b.amount, 200);
  assert.equal(b.closeOnDate, null);
  // 周末买入：用周五收盘
  const c = DCA.suggestionForDate(s, TIERED, "2026-09-06");
  assert.equal(c.basedOn, "2026-09-04");
  // 比第一天还早：没有依据
  assert.equal(DCA.suggestionForDate(s, TIERED, "2026-08-31"), null);
  assert.equal(DCA.suggestionForDate(s, TIERED, "不是日期"), null);
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
  const r = DCA.summarizeTrades(s, { ...TIERED, baseAmount: 100 }, trades);
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
  const empty = DCA.summarizeTrades(s, TIERED, []);
  assert.equal(empty.count, 0);
  assert.ok(Number.isNaN(empty.xirr));
});

test("买入记录备份：生成邮件正文并能原样导入", () => {
  const trades = [
    { id: "2", date: "2026-09-21", amount: 150, price: 700.12345, note: "加码 \"第一次\"" },
    { id: "1", date: "2026-09-14", amount: 100, price: 708.69 },
    { id: "bad", date: "坏", amount: 1, price: 1 },
  ];
  const b = DCA.formatTradesBackup(trades, { today: "2026-09-22", siteUrl: "https://me.github.io/x/" });
  assert.equal(b.count, 2);
  assert.equal(b.subject, "定投买入记录备份 2026-09-22（2 笔）");
  assert.match(b.body, /https:\/\/me\.github\.io\/x\//);
  assert.match(b.body, /----- 定投备份开始 -----\n\{.*\}\n----- 定投备份结束 -----/);
  const back = DCA.parseTradesBackup("前面的问候\n" + b.body + "\n--\n邮件签名");
  assert.deepEqual(back, [
    { date: "2026-09-14", amount: 100, price: 708.69, note: "" },
    { date: "2026-09-21", amount: 150, price: 700.1235, note: "加码 \"第一次\"" },
  ]);
  // 邮件 App 把长行折断、加了引用符号
  const wrapped = b.body.replace(b.json, b.json.slice(0, 30) + "\n" + b.json.slice(30, 70) + "\r\n" + b.json.slice(70)).split("\n").map((l) => "> " + l).join("\n");
  assert.deepEqual(DCA.parseTradesBackup(wrapped), back);
  // “导出备份”文件的格式也能读
  const fileJson = JSON.stringify({ app: "nasdaq100-dca", version: 1, trades: [{ id: "a", date: "2026-09-14", amount: 100, price: 708.69, note: "" }] });
  assert.equal(DCA.parseTradesBackup(fileJson)[0].id, "a");
  assert.throws(() => DCA.parseTradesBackup("随便一段话"), /格式不对|没有找到/);
  assert.throws(() => DCA.parseTradesBackup(""), /没有找到/);
  assert.throws(() => DCA.parseTradesBackup('{"hello":1}'), /没有找到买入记录/);
});

// ---------- 趋势定投 ----------
test("均线：数据不够 200 天时，用已有天数的平均", () => {
  assert.deepEqual(DCA.movingAverage([1, 2, 3, 4, 5], 3), [1, 1.5, 2, 3, 4]);
  const dates = tradingDays("2024-01-01", 4);
  const s = series(dates, [100, 100, 100, 130]);
  const tl = DCA.trendLines(s, 200);
  close(tl.ma[3], 107.5);
  close(tl.dev[3], (130 / 107.5 - 1) * 100);
  close(tl.dev[0], 0);
});

test("趋势定投：四种状态怎么判断", () => {
  const t = DCA.withDefaults(TREND).trend;
  const st = (dd, dev) => { const r = DCA.trendState(dd, dev, t); return [r.key, r.multiplier]; };
  // 跌破均线 = 下跌趋势，跌得越多投得越多
  assert.deepEqual(st(5, -1), ["down", 1.5]);
  assert.deepEqual(st(25, -3), ["down", 2]);
  assert.deepEqual(st(35, -20), ["down", 3]);
  // 比均线高 15% 以上 = 涨太多，就算离最高点还差很多也少投
  assert.deepEqual(st(0, 15), ["hot", 0.5]);
  assert.deepEqual(st(30, 22), ["hot", 0.5]);
  // 在均线上方、离最高点跌了 10% 以上 = 上涨中回调
  assert.deepEqual(st(10, 14.9), ["dip", 1.5]);
  // 其他 = 正常上涨；正好在均线上也算
  assert.deepEqual(st(9.9, 3), ["up", 1]);
  assert.deepEqual(st(0, 0), ["up", 1]);
  // 自定义规则
  const t2 = DCA.withDefaults({ trend: { hotAbove: 20, hotMultiplier: 0 } }).trend;
  assert.equal(DCA.trendState(0, 18, t2).key, "up");
  assert.deepEqual(DCA.trendState(0, 20, t2).multiplier, 0);
  // 乱填的设置用默认值
  const t3 = DCA.normalizeTrend({ maWindow: 5, hotAbove: -1, dipMultiplier: "", downTiers: [] });
  assert.equal(t3.maWindow, 200);
  assert.equal(t3.hotAbove, 15);
  assert.equal(t3.dipMultiplier, DCA.DEFAULT_CONFIG.trend.dipMultiplier);
  assert.deepEqual(t3.downTiers.map((x) => x.multiplier), [1.5, 2, 3]);
  // 各状态占比加起来是 100%
  const sh = DCA.trendShare([0, 12, 25, 0], [20, 5, -2, 3], t);
  close(sh.hot + sh.up + sh.dip + sh.down, 1);
  close(sh.down, 0.25);
});

test("趋势定投回测：一直上涨时少投，跌破均线后加码", () => {
  const dates = tradingDays("2020-01-06", 500);
  // 前 400 天每天涨 0.3%（会远远高出均线），然后 20 天跌掉 35%，之后横着走
  const closes = [];
  let p = 100;
  for (let i = 0; i < 500; i++) {
    if (i > 0 && i < 400) p *= 1.003;
    else if (i >= 400 && i < 420) p *= Math.pow(0.65, 1 / 20);
    closes.push(p);
  }
  const s = series(dates, closes);
  const cfg = { ...TREND, baseAmount: 100 };
  const r = DCA.backtest(s, cfg, {}); // 不指定就用设置里的策略
  assert.equal(r.strategy, "trend");
  const weeks = r.curve.filter((c) => !c.final);
  assert.ok(r.stateWeeks.hot > 30, "长期上涨时大部分周都在少投");
  assert.equal(r.trimmedWeeks, r.stateWeeks.hot);
  close(r.trimmedTotal, r.stateWeeks.hot * 50);
  assert.equal(r.stateWeeks.hot + r.stateWeeks.up + r.stateWeeks.dip + r.stateWeeks.down, r.weeks);
  // 最后几周：跌破均线、离最高点跌 35% → ×3
  assert.deepEqual(weeks.slice(-3).map((c) => [c.state, c.amount]), [["down", 300], ["down", 300], ["down", 300]]);
  // 用的是前一个交易日的均线偏离（不偷看当天）
  const tl = DCA.trendLines(s, 200);
  weeks.forEach((c) => close(c.deviation, tl.dev[dates.indexOf(c.date) - 1]));
  // 同样的数据，跌多多投在上涨阶段一直 ×1，不会少投
  const tiered = DCA.backtest(s, cfg, { strategy: "tiered" });
  assert.equal(tiered.trimmedWeeks, 0);
  assert.equal(tiered.stateWeeks, null);
  assert.ok(r.invested < tiered.invested);
});

test("趋势定投：当前信号和买入建议", () => {
  const dates = tradingDays("2025-08-04", 300); // 截止 2026-09-18 周五
  const closes = dates.map(() => 100);
  closes[299] = 120; // 最后一天大涨，比均线高很多
  const s = series(dates, closes);
  const sig = DCA.currentSignal(s, { ...TREND, baseAmount: 100 });
  assert.equal(sig.strategy, "trend");
  assert.equal(sig.state, "hot");
  assert.equal(sig.multiplier, 0.5);
  assert.equal(sig.amount, 50);
  assert.equal(sig.tieredMultiplier, 1);
  close(sig.ma, 100.1);
  // 跌多多投看同一份数据：×1，但仍然给出趋势状态供参考
  const sig2 = DCA.currentSignal(s, { ...TIERED, baseAmount: 100 });
  assert.equal(sig2.multiplier, 1);
  assert.equal(sig2.trendMultiplier, 0.5);

  closes[299] = 95; // 跌破均线、离最高点跌 5%
  const s2 = series(dates, closes);
  const next = DCA.nextInvestDate(dates[299], 1);
  const a = DCA.suggestionForDate(s2, TREND, next);
  assert.equal(a.state, "down");
  assert.equal(a.multiplier, 1.5);
  assert.equal(a.amount, 150);
  assert.equal(DCA.suggestionForDate(s2, TIERED, next).multiplier, 1); // 跌多多投：跌不到 10% → ×1
  // 提前算好的数组也能用
  const pre = { dd: DCA.drawdowns(s2, "ath").dd, dev: DCA.trendLines(s2, 200).dev };
  assert.equal(DCA.suggestionForDate(s2, TREND, next, pre).amount, 150);
  // 买入记录按趋势定投对比
  const sum = DCA.summarizeTrades(s2, TREND, [{ id: "a", date: next, amount: 150, price: 95 }]);
  assert.equal(sum.rows[0].state, "down");
  assert.equal(sum.rows[0].suggested, 150);
  assert.equal(sum.followed, 1);
});

test("默认设置：综合策略（趋势定投 + 近一年最高点 + 上涨中回调不加码）", () => {
  const cfg = DCA.withDefaults({});
  assert.equal(cfg.strategy, "trend");
  assert.equal(cfg.basis, "52w");
  assert.equal(cfg.trend.dipMultiplier, 1);
  assert.equal(cfg.trend.hotMultiplier, 0.5);
  // 在均线上方回调 → 正常投；跌破均线 → 加码
  assert.equal(DCA.trendState(15, 5, cfg.trend).multiplier, 1);
  assert.equal(DCA.trendState(15, -5, cfg.trend).multiplier, 1.5);
});

// ---------- 资金计划 ----------
test("资金计划：钱怎么换算成每周基础金额", () => {
  // 每周都是 ×1：保守和平均一样，5200 分 52 周 = 每周 100
  const flat = Array(300).fill(1);
  const a = DCA.planBudget(flat, { cash: 5200, share: 100, weeks: 52, rate: 1 }, 1.5);
  close(a.pool, 5200);
  close(a.baseAvg, 100);
  close(a.baseSafe, 100);
  close(a.thisWeek, 150); // 这周 ×1.5
  close(a.shortfall, 0);
  close(a.lastsWeeks, 52);
  // 人民币：1 万的 30% = 3000 元，汇率 6 → 500 美元；每月新增 2600 元的 30% = 780 元 → 每周 180 元 = 30 美元
  const b = DCA.planBudget(flat, { cash: 10000, share: 30, monthly: 2600, weeks: 50, rate: 6, mode: "avg" }, 1);
  close(b.poolLocal, 3000);
  close(b.pool, 500);
  close(b.monthlyLocal, 780);
  close(b.inflow, 30);
  close(b.base, 500 / 50 + 30); // 平均：每周 10 + 30
  close(b.thisWeekLocal, 40 * 6);
  assert.equal(b.mode, "avg");
  // 什么都没填
  assert.equal(DCA.planBudget(flat, {}, 1).empty, true);
  assert.equal(DCA.planBudget(flat, { cash: 1000, share: 0 }, 1).empty, true);
});

test("资金计划：保守方式在历史最坏的时候也够用", () => {
  // 平时 ×1，中间连续 10 周 ×3
  const mults = Array(200).fill(1);
  for (let i = 100; i < 110; i++) mults[i] = 3;
  const input = { cash: 2000, share: 100, weeks: 20, rate: 1 };
  const safe = DCA.planBudget(mults, input, 1);
  const avg = DCA.planBudget(mults, { ...input, mode: "avg" }, 1);
  assert.ok(safe.baseSafe < avg.baseAvg);
  close(safe.shortfall, 0); // 保守：从来不会不够
  assert.ok(avg.shortfall > 0); // 平均：遇到连续加码会不够
  // 保守金额：最坏的 20 周是 10 周 ×3 + 10 周 ×1 = 40 倍 → 2000 / 40 = 50
  close(safe.baseSafe, 50);
  close(safe.worstSpend, 2000);
  close(safe.maxWeekly, 150);
  // 用历史倍数序列
  const dates = tradingDays("2020-01-06", 400);
  const s = series(dates, dates.map((_, i) => 100 + 20 * Math.sin(i / 30)));
  const m = DCA.weeklyMultipliers(s, TIERED);
  assert.equal(m.length, DCA.backtest(s, TIERED, {}).weeks);
  assert.ok(m.some((x) => x > 1));
});

// ---------- 每日定投 ----------
test("每日定投：每个交易日都投一次", () => {
  const dates = tradingDays("2026-08-31", 10); // 8-31 周一 … 9-11 周五
  const s = series(dates, dates.map(() => 100));
  assert.deepEqual(DCA.investDays(s, 1, "daily"), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(DCA.investDays(s, 1, "weekly").length, 2);
  // 下一个定投日：周五之后是周一；周一之后是周二
  assert.equal(DCA.nextInvestDate("2026-09-11", 1, "daily"), "2026-09-14");
  assert.equal(DCA.nextInvestDate("2026-09-14", 1, "daily"), "2026-09-15");
  assert.equal(DCA.nextInvestDate("2026-09-11", 1, "weekly"), "2026-09-14");

  const daily = { ...TIERED, frequency: "daily", baseAmount: 10 };
  const r = DCA.backtest(s, daily, { plain: true });
  assert.equal(r.weeks, 9); // 第一天没有“前一天”，从第 2 天开始
  assert.equal(r.invested, 90);
  const sig = DCA.currentSignal(s, daily);
  assert.equal(sig.frequency, "daily");
  assert.equal(sig.nextDate, "2026-09-14");
  assert.equal(DCA.withDefaults({ frequency: "x" }).frequency, DCA.DEFAULT_CONFIG.frequency);
  assert.equal(DCA.withDefaults({ frequency: "daily" }).frequency, "daily");
});

test("每日定投：资金计划按每次金额算", () => {
  const flat = Array(1500).fill(1);
  const weekly = DCA.planBudget(flat, { cash: 5200, share: 100, weeks: 52, rate: 1 }, 1);
  const daily = DCA.planBudget(flat, { cash: 5200, share: 100, weeks: 52, perWeek: 5, rate: 1 }, 1);
  assert.equal(daily.periods, 260);
  close(daily.base, weekly.base / 5); // 同样的钱分成 5 倍次数，每次就是 1/5
  // 每月新增的钱也按次数摊开
  const m = DCA.planBudget(flat, { monthly: 5200, share: 100, weeks: 52, perWeek: 5, rate: 1 }, 1);
  close(m.inflow, (5200 * 12) / 52 / 5);
});

// ---------- 每年固定投一笔 ----------
test("每年固定投一笔：年初一次性，按当年汇率换汇", () => {
  const dates = tradingDays("2023-01-02", 520); // 2023-01-02 起两年，跨 2023 和 2024
  const s = series(dates, dates.map(() => 100));
  const rates = { 2023: 10, 2024: 20 };
  const r = DCA.annualBacktest(s, TIERED, { amount: 1000, startYear: 2023, mode: "lump", rates, nowRate: 10 });
  assert.equal(r.mode, "lump");
  assert.equal(r.startDate, "2023-01-02");
  assert.equal(r.times, 2);
  assert.equal(r.investedLocal, 2000);
  close(r.investedUsd, 150); // 1000/10 + 1000/20
  close(r.shares, 1.5);
  close(r.valueUsd, 150);
  close(r.valueLocal, 1500); // 汇率涨了，人民币口径反而亏
  close(r.totalReturn, -0.25);
  close(r.totalReturnUsd, 0);
  assert.equal(r.years.length, 2);
  assert.equal(r.years[0].year, 2023);
  close(r.years[0].rate, 10);
  close(r.years[0].multiple, 1); // 1 股 × $100 × 10 ÷ ¥1000
  close(r.years[1].multiple, 0.5);
  // 开始年份太早按数据第一年算，太晚就没得投
  assert.equal(DCA.annualBacktest(s, TIERED, { amount: 1000, startYear: 1990, mode: "lump", rates, nowRate: 10 }).times, 2);
  assert.equal(DCA.annualBacktest(s, TIERED, { amount: 1000, startYear: 2099, mode: "lump", rates, nowRate: 10 }), null);
  assert.equal(DCA.annualBacktest(s, TIERED, { amount: 0, mode: "lump" }), null);
});

test("每年固定投一笔：摊到每次定投 / 按策略投", () => {
  const dates = tradingDays("2023-01-02", 520);
  const s = series(dates, dates.map(() => 100));
  const rates = { 2023: 10, 2024: 10 };
  const n = DCA.investDays(s, 1, "weekly").filter((i) => i >= 1).length;
  const sp = DCA.annualBacktest(s, TIERED, { amount: 5200, startYear: 2023, mode: "spread", rates, nowRate: 10 });
  assert.equal(sp.times, n);
  close(sp.investedLocal, 100 * n); // 每年 5200 摊到 52 次，每次 100
  close(sp.cashUsd, 0);
  // 价格一直不动时没有回撤，策略倍数恒为 1，结果和平摊一模一样
  const st = DCA.annualBacktest(s, TIERED, { amount: 5200, startYear: 2023, mode: "strategy", rates, nowRate: 10 });
  close(st.shares, sp.shares);
  close(st.cashUsd, 0);
  // 每日定投时一年按 252 次摊
  const daily = DCA.annualBacktest(s, { ...TIERED, frequency: "daily" }, { amount: 5040, startYear: 2023, mode: "spread", rates, nowRate: 10 });
  close(daily.investedLocal, 20 * (s.n - 1));
});

test("每年固定投一笔：跌的时候策略会先攒钱", () => {
  const dates = tradingDays("2023-01-02", 520);
  // 先涨后腰斩，跌下去之后倍数变大，前面攒的钱才够多投
  const closes = dates.map((_, i) => (i < 200 ? 100 : 50));
  const s = series(dates, closes);
  const rates = { 2023: 10, 2024: 10 };
  const st = DCA.annualBacktest(s, TIERED, { amount: 5200, startYear: 2023, mode: "strategy", rates, nowRate: 10 });
  const sp = DCA.annualBacktest(s, TIERED, { amount: 5200, startYear: 2023, mode: "spread", rates, nowRate: 10 });
  close(st.investedLocal, sp.investedLocal); // 投入的钱一样多
  assert.ok(st.maxCashUsd > 0, "跌之前应该攒下过现金");
  assert.ok(st.shares > sp.shares, "跌了多投应该买到更多股"); // 同样的钱买到更多股
});

test("汇率表：没有的年份用最近的一年", () => {
  const rates = { 2000: 8, 2010: 6 };
  assert.equal(DCA.rateForYear(1990, rates), 8);
  assert.equal(DCA.rateForYear(2000, rates), 8);
  assert.equal(DCA.rateForYear(2005, rates), 6); // 中间年份按最后一个有数据的年份
  assert.equal(DCA.rateForYear(2030, rates), 6);
  close(DCA.CNY_RATES[1999], 8.277);
  assert.ok(DCA.rateForYear(2026) > 0);
});
