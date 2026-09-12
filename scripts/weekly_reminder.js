/*
 * 定投日提醒：算出这次按规则该投多少，生成 GitHub 提醒的标题和内容。
 * 由 .github/workflows/weekly-reminder.yml 每个工作日北京时间 20:00 调用；
 * 只有“今天是定投日”才会真的发提醒（可以用 --force 强制发一条测试提醒）。
 *
 * 提醒按 docs/strategy.js 里的 DEFAULT_CONFIG 计算（strategy 决定按哪个策略提醒，另一个策略的金额也会附在后面；
 * frequency 设成 "daily" 时每个工作日都提醒）。
 * 你在网页上改的设置只保存在自己的浏览器里，GitHub 看不到；想让提醒也用新设置，就改 DEFAULT_CONFIG。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const DCA = require("../docs/strategy.js");

const ROOT = path.join(__dirname, "..");

function usd(v) {
  const digits = Math.abs(v - Math.round(v)) < 0.005 ? 0 : 2;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function cnDate(ds, withWeekday) {
  const [y, m, d] = ds.split("-").map(Number);
  let s = `${m}月${d}日`;
  if (withWeekday) s += `（${DCA.WEEKDAY_CN[DCA.weekdayOf(DCA.dayNumber(ds))]}）`;
  return s;
}
function isUsDst(ds) {
  const y = Number(ds.slice(0, 4));
  const d = DCA.dayNumber(ds);
  const nthSunday = (month, nth) => {
    const first = DCA.dayNumber(`${y}-${String(month).padStart(2, "0")}-01`);
    return first + ((7 - DCA.weekdayOf(first)) % 7) + (nth - 1) * 7;
  };
  return d >= nthSunday(3, 2) && d < nthSunday(11, 1);
}

// 分档范围的文字：跌不到 10% / 跌 10–20% / 跌 ≥30%
function rangeText(tiers, k) {
  if (k < 0) return `跌不到 ${tiers[0].minDrawdown}%`;
  if (k === tiers.length - 1) return `跌 ≥${tiers[k].minDrawdown}%`;
  if (tiers[k].minDrawdown === 0) return `跌不到 ${tiers[k + 1].minDrawdown}%`;
  return `跌 ${tiers[k].minDrawdown}–${tiers[k + 1].minDrawdown}%`;
}
// 趋势定投的状态文字，下跌趋势再带上是哪一档
function trendStateText(key, trend, drawdown) {
  const label = DCA.TREND_LABELS[key];
  if (key !== "down") return label;
  return `${label} · ${rangeText(trend.downTiers, DCA.tierIndex(drawdown, trend.downTiers))}`;
}

// 美东时间的今天（提醒在 UTC 12:00 运行，这时美东是当天早上）
function todayInNewYork(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now || new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * @param {object} data   docs/data.json 的内容
 * @param {object} opts   { today: "YYYY-MM-DD"（美东）, owner, repo, force, config }
 * @returns {{ skip: boolean, reason?: string, title?: string, body?: string }}
 */
function buildReminder(data, opts) {
  const cfg = DCA.withDefaults(opts.config || DCA.DEFAULT_CONFIG);
  const today = opts.today;
  const weekday = DCA.weekdayOf(DCA.dayNumber(today));
  if (!opts.force && cfg.frequency !== "daily" && weekday !== cfg.investWeekday) {
    return { skip: true, reason: `今天（美东 ${today}）不是定投日，不发提醒` };
  }
  const s = DCA.prepare(data);
  if (s.n < 300) {
    return { skip: true, reason: "还没有行情数据，先运行一次“每日更新数据并发布网站”" };
  }

  // 用今天之前最近一个交易日的收盘价（和网页、回测的规则一致）
  // 两个策略都算一遍：主提醒按 DEFAULT_CONFIG.strategy，另一个写在后面供参考（网页上切换了策略也能对上）
  const other = cfg.strategy === "trend" ? "tiered" : "trend";
  const d = DCA.drawdowns(s, cfg.basis);
  const tl = DCA.trendLines(s, cfg.trend.maWindow);
  const pre = { dd: d.dd, dev: tl.dev };
  const sug = DCA.suggestionForDate(s, cfg, today, pre);
  const alt = DCA.suggestionForDate(s, Object.assign({}, cfg, { strategy: other }), today, pre);
  const basedIdx = s.dates.lastIndexOf(sug.basedOn);
  const peak = d.peak[basedIdx];
  const peakDate = s.dates[d.peakIdx[basedIdx]];
  const ma = tl.ma[basedIdx];
  const dev = tl.dev[basedIdx];
  const basisName = cfg.basis === "ath" ? "历史最高点" : "近一年最高点";
  const mult = Number(sug.multiplier.toFixed(2));
  const action = mult === 0 ? "这周暂停不投" : mult > 1 ? `加码到 ${mult} 倍` : mult === 1 ? "正常投" : `少投，${mult} 倍`;
  const lag = DCA.dayNumber(today) - DCA.dayNumber(sug.basedOn);
  const [owner, repo] = [opts.owner || "", opts.repo || ""];
  const site = owner && repo ? `https://${owner.toLowerCase()}.github.io/${repo}/` : "";
  const name = DCA.STRATEGY_NAMES[cfg.strategy];
  const devText = `比 ${cfg.trend.maWindow} 日均线 ${usd(Math.round(ma * 100) / 100)} ${dev >= 0 ? "高" : "低"} ${Math.abs(dev).toFixed(1)}%`;
  const ddText = sug.drawdown < 0.05 ? `在${basisName}附近` : `离${basisName}跌 ${sug.drawdown.toFixed(1)}%`;

  const title = `定投提醒 ${cnDate(today, true)}：投 ${usd(sug.amount)}（×${mult}）`;
  const lines = [];
  if (owner) lines.push(`@${owner}`, "");
  lines.push(`### 今天（美东 ${cnDate(today)} ${DCA.WEEKDAY_CN[weekday]}）按规则投 **${usd(sug.amount)}**（${name}）`);
  lines.push("");
  lines.push(`${action}：基础金额 ${usd(cfg.baseAmount)} × ${mult}`);
  lines.push("");
  lines.push(`- QQQ 最新收盘：${usd(s.close[basedIdx])}（${cnDate(sug.basedOn)}）`);
  if (cfg.strategy === "trend") {
    lines.push(`- ${devText}，${ddText}，属于「${trendStateText(sug.state, cfg.trend, sug.drawdown)}」`);
  } else {
    lines.push(
      sug.drawdown < 0.05
        ? `- 现在就在${basisName}附近`
        : `- 比${basisName} ${usd(peak)}（${cnDate(peakDate)}）低 ${sug.drawdown.toFixed(1)}%，属于「${rangeText(cfg.tiers, DCA.tierIndex(sug.drawdown, cfg.tiers))}」这一档`
    );
  }
  const altMult = Number(alt.multiplier.toFixed(2));
  const altWhy = other === "trend" ? `${devText}，属于「${trendStateText(alt.state, cfg.trend, alt.drawdown)}」` : ddText;
  lines.push(`- 如果按「${DCA.STRATEGY_NAMES[other]}」：投 ${usd(alt.amount)}（×${altMult}）——${altWhy}`);
  lines.push(`- 美股开盘：北京时间 ${isUsDst(today) ? "21:30" : "22:30"}；如果今天美股休市，顺延到下一个交易日`);
  if (lag > 5) {
    lines.push("");
    lines.push(`> ⚠️ 行情数据停在 ${cnDate(sug.basedOn)}，已经 ${lag} 天没更新，下单前先打开网站看看。`);
  }
  lines.push("");
  if (site) lines.push(`👉 [打开我的定投网站](${site})　买完记得在「我的买入记录」里记一笔。`);
  else lines.push("买完记得在网站「我的买入记录」里记一笔。");
  lines.push("");
  lines.push("<sub>这是按你自己定的规则自动算出来的提醒，不构成投资建议。下一条提醒发出时，这条会自动关闭。</sub>");
  return { skip: false, title, body: lines.join("\n") + "\n" };
}

function main() {
  const force = process.argv.includes("--force");
  const today = process.env.REMINDER_TODAY || todayInNewYork(new Date());
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "/").split("/");
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "data.json"), "utf8"));
  const result = buildReminder(data, { today, owner, repo, force });
  const out = process.env.GITHUB_OUTPUT;
  if (result.skip) {
    console.log(result.reason);
    if (out) fs.appendFileSync(out, "skip=true\n");
    return;
  }
  const bodyPath = path.join(ROOT, "reminder.md");
  fs.writeFileSync(bodyPath, result.body);
  console.log(result.title + "\n\n" + result.body);
  if (out) fs.appendFileSync(out, `skip=false\ntitle=${result.title}\nbody_path=${bodyPath}\n`);
}

if (require.main === module) main();

module.exports = { buildReminder, todayInNewYork, isUsDst, rangeText };
