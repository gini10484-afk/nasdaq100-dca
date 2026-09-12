/*
 * strategy.js —— 定投规则 + 历史回测（网页和测试共用这一份代码）
 *
 * 两种规则都是：每周选一个交易日定投（默认周一；遇到美股休市，就用这周之后的第一个交易日），
 * 或者每个交易日都投一次（frequency: "daily"）；
 * 只看"定投日前一个交易日的收盘价"，投入金额 = 每次基础金额 × 倍数。
 *
 * 策略一 "跌多多投"（strategy: "tiered"）
 *   离最高点跌得越多（回撤越大），倍数越高。
 *
 * 策略二 "趋势定投"（strategy: "trend"）：一直上涨时怎么投 + 下跌趋势里怎么投
 *   先看价格在 200 日均线上面还是下面，再看离最高点跌了多少：
 *   - 下跌趋势：跌破 200 日均线 → 加码，跌得越多投得越多（×1.5 / ×2 / ×3）
 *   - 涨太多：  比 200 日均线高 15% 以上 → 少投（×0.5）
 *   - 上涨中回调：在均线上方，但离最高点跌了 10% 以上 → 可以多投一点（默认 ×1，也就是不加码）
 *   - 正常上涨：其他情况 → 正常投（×1）
 *
 * 默认设置是"综合策略"：趋势定投 + 回撤跟近一年最高点比 + 上涨中回调不加码。
 * 用 1999 年以来的 QQQ 数据回测，它在不同时间段里比普通定投更稳定地略高一点，多投的钱和连续加码的时间也更少；
 * 但它更高主要是因为下跌时多投了钱——总共的钱一样多时，每周按时全部投进去历史上反而更好。过去不代表未来。
 *
 * 借鉴的开源项目：
 *   - 分档倍数表：wangsunan98/NDX100-autopilot-calculator（按估值分档，用一个基础金额算出各档金额）
 *   - 用纳指回撤判断"低位"：kydchen/qqq-tqqq-signal-dashboard（回撤 ≤ -20% 视为低位信号）
 *   - 用 XIRR（资金加权年化收益率）衡量定投：refraction-ray/xalpha
 *   - 比较收益率而不是只比赚了多少钱：Elucidation/lumpsum_vs_dca
 *   - 用 200 日均线区分上涨/下跌趋势：davidwang0116/Quant-QQQ-QLD-TQQQ-SMA200Timing-MixedPosition-Backtest
 *   - 按价格偏离均线多少来调整定投金额：wangsunan98/NDX100-autopilot-calculator（250 日均线偏离）
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCA = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAY_MS = 86400000;

  // ===== 默认设置：想改规则，改这里就行 =====
  var DEFAULT_CONFIG = {
    strategy: "trend", // 用哪个策略："tiered"=跌多多投，"trend"=趋势定投（定投日提醒也按这个算）
    frequency: "weekly", // 多久投一次："weekly"=每周一次，"daily"=每个交易日都投
    baseAmount: 100, // 每次基础金额（美元）
    investWeekday: 1, // 每周定投时用哪天：1=周一 2=周二 3=周三 4=周四 5=周五（美东时间）
    basis: "52w", // 回撤参照："ath"=历史最高点，"52w"=近 52 周最高点
    tiers: [
      // 跌多多投：回撤达到 minDrawdown(%) 就用这一档的倍数
      { minDrawdown: 0, multiplier: 1 },
      { minDrawdown: 10, multiplier: 1.5 },
      { minDrawdown: 20, multiplier: 2 },
      { minDrawdown: 30, multiplier: 3 },
    ],
    trend: {
      // 趋势定投
      maWindow: 200, // 用多少个交易日的均线判断趋势
      hotAbove: 15, // 比均线高出 15% 以上算"涨太多"
      hotMultiplier: 0.5, // 涨太多时投几倍
      dipDrawdown: 10, // 在均线上方、离最高点跌了 10% 以上算"上涨中回调"
      dipMultiplier: 1, // 回调时投几倍（1 = 不加码；想加码可以改成 1.5）
      downTiers: [
        // 跌破均线（下跌趋势）时：回撤达到 minDrawdown(%) 就用这一档的倍数
        { minDrawdown: 0, multiplier: 1.5 },
        { minDrawdown: 20, multiplier: 2 },
        { minDrawdown: 30, multiplier: 3 },
      ],
    },
  };

  var WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var STRATEGY_NAMES = { plain: "普通定投", tiered: "跌多多投", trend: "趋势定投" };
  // 趋势定投的四种状态（按投入从少到多排列）
  var TREND_STATES = ["hot", "up", "dip", "down"];
  var TREND_LABELS = { hot: "涨太多", up: "正常上涨", dip: "上涨中回调", down: "下跌趋势" };

  // ---------- 日期工具（只用日期，不涉及时区） ----------
  function dayNumber(dateStr) {
    var p = String(dateStr).split("-");
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY_MS);
  }
  function dateFromDayNumber(n) {
    return new Date(n * DAY_MS).toISOString().slice(0, 10);
  }
  function weekdayOf(dayNum) {
    // 0=周日；1970-01-01 是周四
    return (((dayNum + 4) % 7) + 7) % 7;
  }
  function mondayOf(dayNum) {
    return dayNum - ((weekdayOf(dayNum) + 6) % 7);
  }

  // ---------- 设置 ----------
  function normalizeTiers(tiers, fallback) {
    var list = (tiers || [])
      .map(function (t) {
        return { minDrawdown: Number(t.minDrawdown), multiplier: Number(t.multiplier) };
      })
      .filter(function (t) {
        return isFinite(t.minDrawdown) && isFinite(t.multiplier) && t.minDrawdown >= 0 && t.multiplier >= 0;
      })
      .sort(function (a, b) {
        return a.minDrawdown - b.minDrawdown;
      });
    if (list.length) return list;
    return (fallback || DEFAULT_CONFIG.tiers).map(function (t) {
      return { minDrawdown: t.minDrawdown, multiplier: t.multiplier };
    });
  }

  function normalizeTrend(trend) {
    var d = DEFAULT_CONFIG.trend, t = trend || {};
    function num(v, def, min, max) {
      v = v === "" || v == null ? NaN : Number(v);
      return isFinite(v) && v >= min && v <= max ? v : def;
    }
    return {
      maWindow: Math.round(num(t.maWindow, d.maWindow, 20, 400)),
      hotAbove: num(t.hotAbove, d.hotAbove, 1, 100),
      hotMultiplier: num(t.hotMultiplier, d.hotMultiplier, 0, 20),
      dipDrawdown: num(t.dipDrawdown, d.dipDrawdown, 0, 95),
      dipMultiplier: num(t.dipMultiplier, d.dipMultiplier, 0, 20),
      downTiers: normalizeTiers(t.downTiers || d.downTiers, d.downTiers),
    };
  }

  function withDefaults(config) {
    var c = config || {};
    var base = Number(c.baseAmount);
    var wd = Number(c.investWeekday);
    return {
      strategy: c.strategy === "trend" || c.strategy === "tiered" ? c.strategy : DEFAULT_CONFIG.strategy === "trend" ? "trend" : "tiered",
      frequency: c.frequency === "daily" || c.frequency === "weekly" ? c.frequency : DEFAULT_CONFIG.frequency === "daily" ? "daily" : "weekly",
      baseAmount: isFinite(base) && base > 0 ? base : DEFAULT_CONFIG.baseAmount,
      investWeekday: wd >= 1 && wd <= 5 ? Math.round(wd) : DEFAULT_CONFIG.investWeekday,
      basis: c.basis === "52w" || c.basis === "ath" ? c.basis : DEFAULT_CONFIG.basis,
      tiers: normalizeTiers(c.tiers || DEFAULT_CONFIG.tiers),
      trend: normalizeTrend(c.trend),
    };
  }

  // ---------- 数据 ----------
  // data.rows 形如 [["1999-03-10", 51.06, 43.10], ...]  即 [日期, 收盘价, 分红调整后收盘价]
  function prepare(data) {
    var rows = (data && data.rows) || [];
    var n = rows.length;
    var s = { n: n, dates: new Array(n), day: new Array(n), close: new Array(n), adj: new Array(n) };
    for (var i = 0; i < n; i++) {
      var r = rows[i];
      s.dates[i] = r[0];
      s.day[i] = dayNumber(r[0]);
      s.close[i] = Number(r[1]);
      s.adj[i] = r[2] != null ? Number(r[2]) : Number(r[1]);
    }
    return s;
  }

  // 回撤（百分数，0 表示在最高点，15 表示比最高点低 15%）
  function drawdowns(series, basis) {
    var n = series.n, close = series.close;
    var dd = new Array(n), peak = new Array(n), peakIdx = new Array(n);
    var i;
    if (basis === "52w") {
      var WINDOW = 252; // 约 52 周的交易日
      var dq = [], head = 0; // 单调队列：收盘价从大到小
      for (i = 0; i < n; i++) {
        while (dq.length > head && close[dq[dq.length - 1]] <= close[i]) dq.pop();
        dq.push(i);
        while (dq[head] <= i - WINDOW) head++;
        peakIdx[i] = dq[head];
        peak[i] = close[dq[head]];
        dd[i] = (1 - close[i] / peak[i]) * 100;
      }
    } else {
      var m = -Infinity, mi = 0;
      for (i = 0; i < n; i++) {
        if (close[i] >= m) {
          m = close[i];
          mi = i;
        }
        peak[i] = m;
        peakIdx[i] = mi;
        dd[i] = (1 - close[i] / m) * 100;
      }
    }
    return { dd: dd, peak: peak, peakIdx: peakIdx };
  }

  // 回撤落在哪一档（-1 表示比第一档还小，按 ×1 处理）
  function tierIndex(ddPct, tiers) {
    var idx = -1;
    for (var k = 0; k < tiers.length; k++) {
      if (ddPct >= tiers[k].minDrawdown - 1e-9) idx = k;
    }
    return idx;
  }
  function multiplierFor(ddPct, tiers) {
    var k = tierIndex(ddPct, tiers);
    return k < 0 ? 1 : tiers[k].multiplier;
  }

  // ---------- 趋势定投 ----------
  // 简单移动平均；前 win 天数据不够时，用已有天数的平均
  function movingAverage(values, win) {
    var out = new Array(values.length), sum = 0;
    for (var i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= win) sum -= values[i - win];
      out[i] = sum / Math.min(i + 1, win);
    }
    return out;
  }

  // 均线和"比均线高多少"（百分数，7.5 表示比均线高 7.5%，-12 表示比均线低 12%）
  function trendLines(series, maWindow) {
    var win = maWindow || DEFAULT_CONFIG.trend.maWindow;
    var ma = movingAverage(series.close, win);
    var dev = new Array(series.n);
    for (var i = 0; i < series.n; i++) dev[i] = (series.close[i] / ma[i] - 1) * 100;
    return { ma: ma, dev: dev, window: win };
  }

  // 根据回撤和均线偏离，判断现在是哪种状态、投几倍
  function trendState(ddPct, devPct, trend) {
    var t = trend || DEFAULT_CONFIG.trend;
    if (devPct < 0) {
      var k = tierIndex(ddPct, t.downTiers);
      return { key: "down", multiplier: k < 0 ? 1 : t.downTiers[k].multiplier, downTier: k };
    }
    if (devPct >= t.hotAbove) return { key: "hot", multiplier: t.hotMultiplier, downTier: -1 };
    if (ddPct >= t.dipDrawdown - 1e-9) return { key: "dip", multiplier: t.dipMultiplier, downTier: -1 };
    return { key: "up", multiplier: 1, downTier: -1 };
  }

  // 从某个下标起，四种状态各占多少比例的交易日
  function trendShare(dd, dev, trend, fromIdx) {
    var counts = { hot: 0, up: 0, dip: 0, down: 0 }, total = 0;
    for (var i = fromIdx || 0; i < dd.length; i++) {
      counts[trendState(dd[i], dev[i], trend).key]++;
      total++;
    }
    var out = { total: total };
    TREND_STATES.forEach(function (key) {
      out[key] = total ? counts[key] / total : 0;
    });
    return out;
  }

  // 某个下标那天，按策略该投几倍（prevIdx = 用哪天的收盘价做决定）
  function decide(cfg, strategy, dd, dev, prevIdx) {
    if (strategy === "plain") return { multiplier: 1, state: null, downTier: -1 };
    if (strategy === "trend") {
      var st = trendState(dd[prevIdx], dev[prevIdx], cfg.trend);
      return { multiplier: st.multiplier, state: st.key, downTier: st.downTier };
    }
    return { multiplier: multiplierFor(dd[prevIdx], cfg.tiers), state: null, downTier: -1 };
  }

  // 定投日（返回数据里的下标）：每周一次就每周挑一天，每日定投就是每个交易日
  function investDays(series, weekday, frequency) {
    var out = [], n = series.n, day = series.day, i = 0;
    if (frequency === "daily") {
      for (i = 0; i < n; i++) out.push(i);
      return out;
    }
    while (i < n) {
      var monday = mondayOf(day[i]);
      var j = i, pick = -1;
      while (j < n && mondayOf(day[j]) === monday) {
        if (pick < 0 && weekdayOf(day[j]) >= weekday) pick = j;
        j++;
      }
      if (pick < 0) {
        // 这周定投日及之后都休市：用这周最后一个交易日；
        // 但如果是数据里的最后一周（这周还没过完），就先不算
        if (j < n) pick = j - 1;
        else break;
      }
      out.push(pick);
      i = j;
    }
    return out;
  }

  // 最新数据之后的下一个定投日（不知道美股假期，遇休市顺延）
  function nextInvestDate(lastDateStr, weekday, frequency) {
    var d = dayNumber(lastDateStr) + 1;
    if (frequency === "daily") {
      while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d++; // 下一个工作日
      return dateFromDayNumber(d);
    }
    while (weekdayOf(d) !== weekday) d++;
    return dateFromDayNumber(d);
  }

  // ---------- 当前信号 ----------
  // pre：可选，提前算好的 { dd: drawdowns(...), tl: trendLines(...) }
  function currentSignal(series, config, pre) {
    var cfg = withDefaults(config);
    if (!series.n) return null;
    pre = pre || {};
    var d = pre.dd || drawdowns(series, cfg.basis);
    var tl = pre.tl || trendLines(series, cfg.trend.maWindow);
    var last = series.n - 1;
    var k = tierIndex(d.dd[last], cfg.tiers);
    var tieredMult = k < 0 ? 1 : cfg.tiers[k].multiplier;
    var st = trendState(d.dd[last], tl.dev[last], cfg.trend);
    var mult = cfg.strategy === "trend" ? st.multiplier : tieredMult;
    return {
      strategy: cfg.strategy,
      frequency: cfg.frequency,
      date: series.dates[last],
      close: series.close[last],
      peak: d.peak[last],
      peakDate: series.dates[d.peakIdx[last]],
      drawdown: d.dd[last],
      tierIndex: k,
      ma: tl.ma[last],
      deviation: tl.dev[last],
      state: st.key,
      downTier: st.downTier,
      tieredMultiplier: tieredMult,
      trendMultiplier: st.multiplier,
      multiplier: mult,
      amount: cfg.baseAmount * mult,
      nextDate: nextInvestDate(series.dates[last], cfg.investWeekday, cfg.frequency),
      basis: cfg.basis,
    };
  }

  // ---------- XIRR：资金加权年化收益率 ----------
  // flows: [[dayNumber, 投入金额], ...]，finalValue 在 finalDay 的市值
  function xirr(flows, finalValue, finalDay) {
    if (!flows.length || !(finalValue > 0)) return NaN;
    function f(r) {
      var s = finalValue;
      for (var i = 0; i < flows.length; i++) {
        s -= flows[i][1] * Math.pow(1 + r, (finalDay - flows[i][0]) / 365);
      }
      return s;
    }
    var lo = -0.99, hi = 10;
    if (f(lo) < 0) return lo;
    if (f(hi) > 0) return hi;
    for (var it = 0; it < 200 && hi - lo > 1e-10; it++) {
      var mid = (lo + hi) / 2;
      if (f(mid) > 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ---------- 回测 ----------
  // opts.strategy      → "plain"=普通定投（每周固定金额）、"tiered"=跌多多投、"trend"=趋势定投；不填就用设置里的策略
  // opts.plain = true  → 同 strategy: "plain"
  // opts.startDate     → 从哪天开始（含）
  // opts.dd / opts.dev → 可选，提前算好的回撤数组、均线偏离数组（省时间）
  function backtest(series, config, opts) {
    opts = opts || {};
    var cfg = withDefaults(config);
    var n = series.n;
    if (n < 2) return null;
    var mode = opts.plain ? "plain" : opts.strategy === "plain" || opts.strategy === "tiered" || opts.strategy === "trend" ? opts.strategy : cfg.strategy;
    var dd = opts.dd || drawdowns(series, cfg.basis).dd;
    var dev = mode === "trend" ? opts.dev || trendLines(series, cfg.trend.maWindow).dev : null;
    var days = investDays(series, cfg.investWeekday, cfg.frequency);
    var startDay = opts.startDate ? dayNumber(opts.startDate) : -Infinity;

    var p = 0;
    while (p < days.length && (series.day[days[p]] < startDay || days[p] < 1)) p++;
    if (p >= days.length) return null;
    var firstIdx = days[p];

    var sharesAdj = 0, sharesRaw = 0, invested = 0;
    var flows = [], curve = [];
    var maxAmount = 0, maxAmountDate = null;
    var boostedWeeks = 0, streak = 0, streakStart = null;
    var longest = 0, longestStart = null, longestEnd = null;
    var worst = 0, worstDate = null;
    var trimmedWeeks = 0, trimmedTotal = 0;
    var stateWeeks = { hot: 0, up: 0, dip: 0, down: 0 };

    for (var i = firstIdx; i < n; i++) {
      if (p < days.length && days[p] === i) {
        var ddPrev = dd[i - 1]; // 用前一个交易日收盘价做决定，避免"偷看未来"
        var dec = decide(cfg, mode, dd, dev, i - 1);
        var mult = dec.multiplier;
        var amount = cfg.baseAmount * mult;
        if (dec.state) stateWeeks[dec.state]++;
        if (mult < 1) {
          trimmedWeeks++;
          trimmedTotal += cfg.baseAmount - amount;
        }
        if (amount > 0) {
          sharesAdj += amount / series.adj[i];
          sharesRaw += amount / series.close[i];
          invested += amount;
          flows.push([series.day[i], amount]);
        }
        if (amount > maxAmount) {
          maxAmount = amount;
          maxAmountDate = series.dates[i];
        }
        if (mult > 1) {
          boostedWeeks++;
          if (streak === 0) streakStart = series.dates[i];
          streak++;
          if (streak > longest) {
            longest = streak;
            longestStart = streakStart;
            longestEnd = series.dates[i];
          }
        } else {
          streak = 0;
        }
        curve.push({
          date: series.dates[i],
          invested: invested,
          value: sharesAdj * series.adj[i],
          amount: amount,
          multiplier: mult,
          drawdown: ddPrev,
          deviation: dev ? dev[i - 1] : null,
          state: dec.state,
          close: series.close[i],
        });
        p++;
      }
      if (invested > 0) {
        var r = (sharesAdj * series.adj[i]) / invested - 1;
        if (r < worst) {
          worst = r;
          worstDate = series.dates[i];
        }
      }
    }

    var last = n - 1;
    var finalValue = sharesAdj * series.adj[last];
    if (curve.length && curve[curve.length - 1].date !== series.dates[last]) {
      curve.push({
        date: series.dates[last],
        invested: invested,
        value: finalValue,
        amount: 0,
        multiplier: 0,
        drawdown: dd[last],
        deviation: dev ? dev[last] : null,
        state: null,
        close: series.close[last],
        final: true,
      });
    }

    return {
      strategy: mode,
      startDate: series.dates[firstIdx],
      endDate: series.dates[last],
      weeks: flows.length, // 定投了多少次（每周定投就是多少周）
      invested: invested,
      finalValue: finalValue,
      profit: finalValue - invested,
      totalReturn: invested > 0 ? finalValue / invested - 1 : 0,
      xirr: xirr(flows, finalValue, series.day[last]),
      avgCost: sharesRaw > 0 ? invested / sharesRaw : NaN,
      maxAmount: maxAmount,
      maxAmountDate: maxAmountDate,
      boostedWeeks: boostedWeeks,
      longestStreak: longest,
      longestStreakStart: longestStart,
      longestStreakEnd: longestEnd,
      trimmedWeeks: trimmedWeeks,
      trimmedTotal: trimmedTotal,
      stateWeeks: mode === "trend" ? stateWeeks : null,
      worstReturn: worst,
      worstDate: worstDate,
      curve: curve,
    };
  }

  // 同一套设置，换不同开始年份，三种定投各跑一遍（看结论稳不稳）
  // pre：可选 { dd: 回撤数组, dev: 均线偏离数组 }
  function compareStarts(series, config, years, pre) {
    var cfg = withDefaults(config);
    pre = pre || {};
    var dd = pre.dd || drawdowns(series, cfg.basis).dd;
    var dev = pre.dev || trendLines(series, cfg.trend.maWindow).dev;
    var lastYear = series.n ? +series.dates[series.n - 1].slice(0, 4) : 0;
    var out = [];
    years.forEach(function (y) {
      if (y > lastYear - 1) return; // 至少留一年以上
      var start = y + "-01-01";
      var a = backtest(series, cfg, { strategy: "plain", startDate: start, dd: dd });
      var b = backtest(series, cfg, { strategy: "tiered", startDate: start, dd: dd });
      var c = backtest(series, cfg, { strategy: "trend", startDate: start, dd: dd, dev: dev });
      if (!a || !b || !c) return;
      out.push({
        year: y,
        plain: a,
        tiered: b,
        trend: c,
        xirrDiff: b.xirr - a.xirr,
        investedRatio: b.invested / a.invested,
        trendXirrDiff: c.xirr - a.xirr,
        trendInvestedRatio: c.invested / a.invested,
      });
    });
    return out;
  }

  // 从某个下标起，每一档占了多少比例的交易日
  function tierShare(dd, tiers, fromIdx) {
    var counts = tiers.map(function () {
      return 0;
    });
    var below = 0, total = 0;
    for (var i = fromIdx || 0; i < dd.length; i++) {
      var k = tierIndex(dd[i], tiers);
      if (k < 0) below++;
      else counts[k]++;
      total++;
    }
    return {
      total: total,
      below: total ? below / total : 0,
      shares: counts.map(function (c) {
        return total ? c / total : 0;
      }),
    };
  }

  // 最长的一次"水下期"：从创新高，到跌下去，再到重新回到这个高点，一共多久
  function longestUnderwater(series) {
    var n = series.n, close = series.close;
    var best = null, peakI = 0, troughI = 0;
    function consider(endI, recovered) {
      if (endI === peakI) return;
      var days = series.day[endI] - series.day[peakI];
      if (!best || days > best.days) {
        best = {
          peakDate: series.dates[peakI],
          troughDate: series.dates[troughI],
          maxDrawdown: (1 - close[troughI] / close[peakI]) * 100,
          recoveryDate: recovered ? series.dates[endI] : null,
          days: days,
        };
      }
    }
    for (var i = 1; i < n; i++) {
      if (close[i] >= close[peakI]) {
        consider(i, true);
        peakI = i;
        troughI = i;
      } else if (close[i] < close[troughI]) {
        troughI = i;
      }
    }
    if (n > 1 && peakI !== n - 1) consider(n - 1, false);
    return best;
  }

  // ---------- 我的买入记录 ----------
  // 某天买入时，按规则应该投多少：用那天之前最近一个交易日的收盘价算回撤（趋势定投还看均线）
  // pre：可选，提前算好的回撤数组，或 { dd: 回撤数组, dev: 均线偏离数组 }
  function suggestionForDate(series, config, dateStr, pre) {
    var cfg = withDefaults(config);
    var n = series.n;
    if (!n || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
    var target = dayNumber(dateStr);
    var lo = 0, hi = n;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (series.day[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    // lo = 当天或之后的第一个交易日；超出数据范围说明是最新数据之后的日子
    var prevIdx = lo < n ? lo - 1 : n - 1;
    if (prevIdx < 0) return null;
    var ddArr = Array.isArray(pre) ? pre : pre && pre.dd;
    if (!ddArr) ddArr = drawdowns(series, cfg.basis).dd;
    var devArr = null;
    if (cfg.strategy === "trend") {
      devArr = pre && !Array.isArray(pre) && pre.dev;
      if (!devArr) devArr = trendLines(series, cfg.trend.maWindow).dev;
    }
    var dec = decide(cfg, cfg.strategy, ddArr, devArr, prevIdx);
    var sameDay = lo < n && series.day[lo] === target;
    return {
      strategy: cfg.strategy,
      date: dateStr,
      basedOn: series.dates[prevIdx],
      drawdown: ddArr[prevIdx],
      deviation: devArr ? devArr[prevIdx] : null,
      state: dec.state,
      multiplier: dec.multiplier,
      amount: cfg.baseAmount * dec.multiplier,
      closeOnDate: sameDay ? series.close[lo] : null,
      latestClose: series.close[n - 1],
    };
  }

  // 汇总实际买入记录：和规则建议比，算持仓、市值、平均成本
  // trades: [{ id, date: "YYYY-MM-DD", amount: 实际投入美元, price: 成交价, note }]
  function summarizeTrades(series, config, trades) {
    var cfg = withDefaults(config);
    var n = series.n;
    var pre = {
      dd: n ? drawdowns(series, cfg.basis).dd : [],
      dev: n && cfg.strategy === "trend" ? trendLines(series, cfg.trend.maWindow).dev : null,
    };
    var list = (trades || [])
      .filter(function (t) {
        return t && /^\d{4}-\d{2}-\d{2}$/.test(String(t.date)) && Number(t.amount) > 0 && Number(t.price) > 0;
      })
      .slice()
      .sort(function (a, b) {
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      });
    var invested = 0, shares = 0, suggestedTotal = 0, followed = 0, compared = 0;
    var flows = [];
    var rows = list.map(function (t) {
      var amount = Number(t.amount), price = Number(t.price);
      var sug = n ? suggestionForDate(series, cfg, t.date, pre) : null;
      var sh = amount / price;
      invested += amount;
      shares += sh;
      flows.push([dayNumber(t.date), amount]);
      var diff = null;
      if (sug) {
        compared++;
        suggestedTotal += sug.amount;
        diff = amount - sug.amount;
        // 差额在 5%（至少 1 美元）以内，算“按规则执行”
        if (Math.abs(diff) <= Math.max(1, sug.amount * 0.05)) followed++;
      }
      return {
        id: t.id,
        date: t.date,
        amount: amount,
        price: price,
        shares: sh,
        note: t.note || "",
        suggested: sug ? sug.amount : null,
        multiplier: sug ? sug.multiplier : null,
        drawdown: sug ? sug.drawdown : null,
        deviation: sug ? sug.deviation : null,
        state: sug ? sug.state : null,
        basedOn: sug ? sug.basedOn : null,
        diff: diff,
      };
    });
    var lastClose = n ? series.close[n - 1] : NaN;
    var value = shares * lastClose;
    var firstDay = flows.length ? flows[0][0] : null;
    var endDay = n ? Math.max(series.day[n - 1], flows.length ? flows[flows.length - 1][0] : 0) : null;
    return {
      rows: rows,
      count: rows.length,
      invested: invested,
      shares: shares,
      lastClose: lastClose,
      lastDate: n ? series.dates[n - 1] : null,
      value: value,
      profit: value - invested,
      totalReturn: invested > 0 ? value / invested - 1 : 0,
      avgCost: shares > 0 ? invested / shares : NaN,
      suggestedTotal: suggestedTotal,
      compared: compared,
      followed: followed,
      spanDays: firstDay != null && endDay != null ? endDay - firstDay : 0,
      xirr: flows.length && value > 0 ? xirr(flows, value, endDay) : NaN,
    };
  }

  // ---------- 资金计划：手里的闲钱，每周该投多少 ----------
  // 历史上每个定投日按规则投了几倍（用当前的策略和设置；每周定投就是每周一个数）
  function weeklyMultipliers(series, config, pre) {
    pre = pre || {};
    var r = backtest(series, config, { dd: pre.dd, dev: pre.dev });
    if (!r) return [];
    return r.curve
      .filter(function (c) {
        return !c.final;
      })
      .map(function (c) {
        return c.multiplier;
      });
  }

  // input：{ cash: 现在的闲钱, monthly: 每月新增闲钱, share: 拿出多少比例投资(%), weeks: 现在这笔分几周投完,
  //          perWeek: 每周投几次（每周定投 1，每日定投 5，默认 1）,
  //          rate: 1 美元换多少本币（人民币就填汇率，美元填 1）, mode: "safe" 保守 | "avg" 平均 }
  // mults：weeklyMultipliers() 的结果；nowMultiplier：这周按规则的倍数
  // 返回的金额：带 Local 的是本币，其余是美元
  function planBudget(mults, input, nowMultiplier) {
    input = input || {};
    mults = mults || [];
    function num(v, def) {
      v = v === "" || v == null ? NaN : Number(v);
      return isFinite(v) && v >= 0 ? v : def;
    }
    var cash = num(input.cash, 0);
    var monthly = num(input.monthly, 0);
    var share = Math.min(100, num(input.share, 0));
    var weeks = Math.max(1, Math.round(num(input.weeks, 52)));
    var perWeek = Math.max(1, num(input.perWeek, 1));
    var periods = Math.max(1, Math.round(weeks * perWeek)); // 这段时间里一共投几次
    var rate = num(input.rate, 0) > 0 ? Number(input.rate) : 1;
    var mode = input.mode === "avg" ? "avg" : "safe";

    var poolLocal = (cash * share) / 100;
    var monthlyLocal = (monthly * share) / 100;
    var pool = poolLocal / rate; // 现在这笔拿出来投资的钱（美元）
    var inflow = (monthlyLocal * 12) / 52 / perWeek / rate; // 每月新增的投资钱，折成每次定投（美元）

    var n = mults.length;
    var ps = [0], maxMult = 0;
    for (var i = 0; i < n; i++) {
      ps.push(ps[i] + mults[i]);
      if (mults[i] > maxMult) maxMult = mults[i];
    }
    var avgMult = n ? ps[n] / n : 1;
    if (!(avgMult > 0)) avgMult = 1;

    // 平均：长期平均下来，每次投的钱 ≈ 每次能拿出来的钱
    var baseAvg = (pool / periods + inflow) / avgMult;

    // 保守：历史上不管从哪一次开始，接下来每一次累计要投的钱，都不超过到那时手里已有的钱
    var baseSafe = Infinity, worstSum = 0;
    var span = Math.min(periods, n);
    for (var t = 0; t < n; t++) {
      for (var k = 1; k <= periods && t + k <= n; k++) {
        var s = ps[t + k] - ps[t];
        if (s <= 0) continue;
        var b = (pool + inflow * k) / s;
        if (b < baseSafe) baseSafe = b;
        if (k === span && s > worstSum) worstSum = s;
      }
    }
    if (!isFinite(baseSafe)) baseSafe = baseAvg;

    // 按某个基础金额，历史上最坏的时候还差多少钱（0 表示一直够用）
    function shortfall(base) {
      var worst = 0;
      for (var t2 = 0; t2 < n; t2++) {
        for (var k2 = 1; k2 <= periods && t2 + k2 <= n; k2++) {
          var need = base * (ps[t2 + k2] - ps[t2]) - (pool + inflow * k2);
          if (need > worst) worst = need;
        }
      }
      return worst;
    }

    var base = mode === "avg" ? baseAvg : baseSafe;
    var m0 = nowMultiplier == null || !isFinite(Number(nowMultiplier)) ? 1 : Number(nowMultiplier);
    var avgWeekly = base * avgMult;
    var burn = avgWeekly - inflow;
    var gap = shortfall(base);
    return {
      empty: !(pool + inflow > 0),
      mode: mode,
      rate: rate,
      weeks: weeks,
      periods: periods,
      perWeek: perWeek,
      poolLocal: poolLocal,
      monthlyLocal: monthlyLocal,
      pool: pool,
      inflow: inflow,
      avgMult: avgMult,
      maxMult: maxMult,
      baseAvg: baseAvg,
      baseSafe: baseSafe,
      base: base,
      nowMultiplier: m0,
      thisWeek: base * m0,
      thisWeekLocal: base * m0 * rate,
      avgWeekly: avgWeekly, // 平均每次投多少（每周定投就是每周）
      maxWeekly: base * maxMult,
      worstSpend: base * worstSum, // 历史上最坏的连续 periods 次（数据不够就按全部），一共要投多少
      shortfall: gap,
      shortfallLocal: gap * rate,
      lastsWeeks: pool > 0 ? (burn > 1e-9 ? pool / burn : Infinity) : 0, // 按平均速度，现在这笔钱大约够投多少次
    };
  }

  // ---------- 买入记录备份（发到邮箱 / 粘贴导入） ----------
  var BACKUP_BEGIN = "----- 定投备份开始 -----";
  var BACKUP_END = "----- 定投备份结束 -----";

  // 生成邮件备份：正文里放一行紧凑的 JSON，恢复时把两条横线之间的内容粘贴回网页
  function formatTradesBackup(trades, opts) {
    opts = opts || {};
    var list = (trades || [])
      .filter(function (t) {
        return t && /^\d{4}-\d{2}-\d{2}$/.test(String(t.date)) && Number(t.amount) > 0 && Number(t.price) > 0;
      })
      .slice()
      .sort(function (a, b) {
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      })
      .map(function (t) {
        var row = [t.date, Math.round(Number(t.amount) * 100) / 100, Math.round(Number(t.price) * 10000) / 10000];
        if (t.note) row.push(String(t.note));
        return row;
      });
    var json = JSON.stringify({ app: "nasdaq100-dca", v: 1, trades: list });
    var day = opts.today ? opts.today + "，" : "";
    var subject = "定投买入记录备份 " + (opts.today || "") + "（" + list.length + " 笔）";
    var body = [
      "这是我的纳指100定投买入记录备份（" + day + "共 " + list.length + " 笔）。",
      "",
      "恢复方法：打开 " + (opts.siteUrl || "定投网站") + "，在「我的买入记录」点「粘贴导入」，把下面两条横线之间的内容（连横线一起）粘贴进去。",
      "",
      BACKUP_BEGIN,
      json,
      BACKUP_END,
      "",
    ].join("\n");
    return { subject: subject, body: body, json: json, count: list.length };
  }

  // 解析备份：支持邮件正文（带横线）、导出的 .json 文件内容；邮件被自动换行或加了“> ”引用也能读
  function parseTradesBackup(text) {
    var s = String(text == null ? "" : text);
    var a = s.indexOf(BACKUP_BEGIN), b = s.indexOf(BACKUP_END);
    if (a >= 0 && b > a) s = s.slice(a + BACKUP_BEGIN.length, b);
    s = s.trim();
    if (!s) throw new Error("没有找到备份内容");
    var obj;
    try {
      obj = JSON.parse(s);
    } catch (e) {
      try {
        obj = JSON.parse(s.replace(/^[ \t]*>[ \t]?/gm, "").replace(/[\r\n]+/g, ""));
      } catch (e2) {
        throw new Error("备份内容不完整或格式不对");
      }
    }
    var list = Array.isArray(obj) ? obj : obj && obj.trades;
    if (!Array.isArray(list)) throw new Error("没有找到买入记录");
    return list.map(function (t) {
      if (Array.isArray(t)) return { date: t[0], amount: t[1], price: t[2], note: t[3] || "" };
      return t || {};
    });
  }

  // 按年汇总：年末收盘价、当年涨跌（含分红）、当年最深回撤、三种定投年末的累计收益率
  function yearly(series, dd, plainCurve, tieredCurve, trendCurve) {
    var out = [], byYear = {}, order = [];
    for (var i = 0; i < series.n; i++) {
      var y = series.dates[i].slice(0, 4);
      if (!byYear[y]) {
        byYear[y] = { year: +y, firstIdx: i, lastIdx: i, maxDd: 0 };
        order.push(y);
      }
      byYear[y].lastIdx = i;
      if (dd[i] > byYear[y].maxDd) byYear[y].maxDd = dd[i];
    }
    function lastInYear(curve, y) {
      var hit = null;
      for (var k = 0; k < (curve || []).length; k++) {
        if (curve[k].date.slice(0, 4) === y) hit = curve[k];
      }
      return hit ? hit.value / hit.invested - 1 : null;
    }
    order.forEach(function (y, idx) {
      var o = byYear[y];
      var prevAdj = idx > 0 ? series.adj[byYear[order[idx - 1]].lastIdx] : series.adj[o.firstIdx];
      out.push({
        year: o.year,
        close: series.close[o.lastIdx],
        change: series.adj[o.lastIdx] / prevAdj - 1,
        partial: idx === 0 || idx === order.length - 1,
        maxDrawdown: o.maxDd,
        plainReturn: lastInYear(plainCurve, y),
        tieredReturn: lastInYear(tieredCurve, y),
        trendReturn: lastInYear(trendCurve, y),
      });
    });
    return out;
  }

  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    WEEKDAY_CN: WEEKDAY_CN,
    STRATEGY_NAMES: STRATEGY_NAMES,
    TREND_STATES: TREND_STATES,
    TREND_LABELS: TREND_LABELS,
    dayNumber: dayNumber,
    dateFromDayNumber: dateFromDayNumber,
    weekdayOf: weekdayOf,
    withDefaults: withDefaults,
    normalizeTiers: normalizeTiers,
    normalizeTrend: normalizeTrend,
    prepare: prepare,
    drawdowns: drawdowns,
    tierIndex: tierIndex,
    multiplierFor: multiplierFor,
    movingAverage: movingAverage,
    trendLines: trendLines,
    trendState: trendState,
    trendShare: trendShare,
    investDays: investDays,
    nextInvestDate: nextInvestDate,
    currentSignal: currentSignal,
    xirr: xirr,
    backtest: backtest,
    compareStarts: compareStarts,
    tierShare: tierShare,
    longestUnderwater: longestUnderwater,
    suggestionForDate: suggestionForDate,
    summarizeTrades: summarizeTrades,
    weeklyMultipliers: weeklyMultipliers,
    planBudget: planBudget,
    formatTradesBackup: formatTradesBackup,
    parseTradesBackup: parseTradesBackup,
    yearly: yearly,
  };
});
