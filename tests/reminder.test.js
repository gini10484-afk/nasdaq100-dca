// 运行：node --test tests/reminder.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DCA = require("../docs/strategy.js");
const { buildReminder, todayInNewYork, isUsDst } = require("../scripts/weekly_reminder.js");

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
  const r = buildReminder(makeData(100), { today: "2026-09-15", owner: "me", repo: "r" });
  assert.equal(r.skip, true);
  const f = buildReminder(makeData(100), { today: "2026-09-15", owner: "me", repo: "r", force: true });
  assert.equal(f.skip, false);
});

test("定投日：按上一个交易日收盘价算金额", () => {
  const r = buildReminder(makeData(75), { today: "2026-09-14", owner: "Gini-X", repo: "nasdaq100-dca" });
  assert.equal(r.skip, false);
  assert.equal(r.title, "定投提醒 9月14日（周一）：投 $200（×2）");
  assert.match(r.body, /^@Gini-X/);
  assert.match(r.body, /按规则投 \*\*\$200\*\*/);
  assert.match(r.body, /低 25\.0%，属于「跌 20–30%」这一档/);
  assert.match(r.body, /北京时间 21:30/);
  assert.match(r.body, /https:\/\/gini-x\.github\.io\/nasdaq100-dca\//);
  assert.match(r.body, /今天（美东 9月14日 周一）/);
  assert.doesNotMatch(r.body, /没更新/);
});

test("数据太旧会提醒先看网站", () => {
  const r = buildReminder(makeData(95), { today: "2026-09-21", owner: "me", repo: "r" });
  assert.equal(r.skip, false);
  assert.match(r.body, /已经 10 天没更新/);
  assert.match(r.title, /投 \$100（×1）/);
  assert.match(r.body, /「跌不到 10%」这一档/);
});

test("没有数据时不发", () => {
  const r = buildReminder({ rows: [] }, { today: "2026-09-14", force: true });
  assert.equal(r.skip, true);
});
