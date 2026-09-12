// 运行：node --test tests/reminder.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DCA = require("../docs/strategy.js");
const { buildReminder, todayInNewYork, isUsDst } = require("../scripts/weekly_reminder.js");
// 测试不依赖 DEFAULT_CONFIG，需要哪种规则就写明
const TIERED = { strategy: "tiered", basis: "ath" };
const TREND = { strategy: "trend", basis: "ath" };

function tradingDays(start, count) {
  const out = [];
  let d = DCA.dayNumber(start);
  while (out.length < count) {
    const wd = DCA.weekdayOf(d);
    if (wd >= 1 && wd <= 5) out.push(DCA.dateFromDayNumber(d));
    d++;
  }
  return out;
}
// 400 个交易日，最后一天 2026-09-11（周五）
function makeData(lastClose) {
  let d = DCA.dayNumber("2026-09-11");
  const dates = [];
  while (dates.length < 400) {
    const wd = DCA.weekdayOf(d);
    if (wd >= 1 && wd <= 5) dates.unshift(DCA.dateFromDayNumber(d));
    d--;
  }
  const rows = dates.map((ds, i) => [ds, i === dates.length - 1 ? lastClose : 100, 100]);
  return { rows };
}

test("美东日期和夏令时", () => {
  // UTC 2026-09-14 12:00 = 美东 9-14 早上 8 点
  assert.equal(todayInNewYork(new Date("2026-09-14T12:00:00Z")), "2026-09-14");
  // UTC 2026-09-15 02:00 = 美东 9-14 晚上 10 点
  assert.equal(todayInNewYork(new Date("2026-09-15T02:00:00Z")), "2026-09-14");
  assert.equal(isUsDst("2026-09-14"), true);
  assert.equal(isUsDst("2026-12-07"), false);
  assert.equal(isUsDst("2026-03-08"), true); // 3 月第二个周日开始
  assert.equal(isUsDst("2026-11-01"), false); // 11 月第一个周日结束
});

test("不是定投日就不发", () => {
  const r = buildReminder(makeData(100), { today: "2026-09-15", owner: "me", repo: "r", config: TIERED });
  assert.equal(r.skip, true);
  const f = buildReminder(makeData(100), { today: "2026-09-15", owner: "me", repo: "r", force: true, config: TIERED });
  assert.equal(f.skip, false);
});

test("定投日：按上一个交易日收盘价算金额", () => {
  const r = buildReminder(makeData(75), { today: "2026-09-14", owner: "Gini-X", repo: "nasdaq100-dca", config: TIERED });
  assert.equal(r.skip, false);
  assert.equal(r.title, "定投提醒 9月14日（周一）：投 $200（×2）");
  assert.match(r.body, /^@Gini-X/);
  assert.match(r.body, /按规则投 \*\*\$200\*\*/);
  assert.match(r.body, /低 25\.0%，属于「跌 20–30%」这一档/);
  assert.match(r.body, /北京时间 21:30/);
  assert.match(r.body, /https:\/\/gini-x\.github\.io\/nasdaq100-dca\//);
  assert.match(r.body, /今天（美东 9月14日 周一）/);
  assert.match(r.body, /按规则投 \*\*\$200\*\*（跌多多投）/);
  // 另一个策略的金额也写上，网页上切换了策略也能对上
  assert.match(r.body, /如果按「趋势定投」：投 \$200（×2）——比 200 日均线 .* 低 24\.9%，属于「下跌趋势 · 跌 20–30%」/);
  assert.doesNotMatch(r.body, /没更新/);
});

test("按趋势定投提醒：涨太多时少投", () => {
  const r = buildReminder(makeData(120), { today: "2026-09-14", owner: "me", repo: "r", config: TREND });
  assert.equal(r.title, "定投提醒 9月14日（周一）：投 $50（×0.5）");
  assert.match(r.body, /按规则投 \*\*\$50\*\*（趋势定投）/);
  assert.match(r.body, /少投，0\.5 倍：基础金额 \$100 × 0\.5/);
  assert.match(r.body, /比 200 日均线 \$100\.10 高 19\.9%，在历史最高点附近，属于「涨太多」/);
  assert.match(r.body, /如果按「跌多多投」：投 \$100（×1）——在历史最高点附近/);
  // 跌破均线：趋势定投加码，跌多多投还没到加码线
  const d = buildReminder(makeData(95), { today: "2026-09-14", config: TREND });
  assert.match(d.title, /投 \$150（×1\.5）/);
  assert.match(d.body, /属于「下跌趋势 · 跌不到 20%」/);
  assert.match(d.body, /如果按「跌多多投」：投 \$100（×1）——离历史最高点跌 5\.0%/);
});

test("数据太旧会提醒先看网站", () => {
  const r = buildReminder(makeData(95), { today: "2026-09-21", owner: "me", repo: "r", config: TIERED });
  assert.equal(r.skip, false);
  assert.match(r.body, /已经 10 天没更新/);
  assert.match(r.title, /投 \$100（×1）/);
  assert.match(r.body, /「跌不到 10%」这一档/);
});

test("没有数据时不发", () => {
  const r = buildReminder({ rows: [] }, { today: "2026-09-14", force: true });
  assert.equal(r.skip, true);
});

test("默认设置按综合策略提醒", () => {
  const r = buildReminder(makeData(95), { today: "2026-09-14", owner: "me", repo: "r" });
  assert.match(r.body, /（趋势定投）/);
  assert.match(r.body, /离近一年最高点跌 5\.0%，属于「下跌趋势 · 跌不到 20%」/);
  assert.match(r.title, /投 \$150（×1\.5）/);
  assert.match(r.body, /如果按「跌多多投」：投 \$100（×1）/);
});

test("每日定投：每个工作日都提醒", () => {
  const daily = { ...TIERED, frequency: "daily" };
  // 周二也发（每周定投时会跳过）
  const r = buildReminder(makeData(75), { today: "2026-09-15", owner: "me", repo: "r", config: daily });
  assert.equal(r.skip, false);
  assert.match(r.title, /9月15日（周二）：投 \$200（×2）/);
  assert.equal(buildReminder(makeData(75), { today: "2026-09-15", owner: "me", repo: "r", config: TIERED }).skip, true);
  // 周末不运行工作流，这里也不特殊处理
  assert.equal(buildReminder({ rows: [] }, { today: "2026-09-15", config: daily }).skip, true);
});
