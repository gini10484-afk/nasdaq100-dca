/*
 * strategy.js —— 定投规则 + 历史回测（网页和测试共用这一份代码）
 *
 * 规则："跌多多投"
 *   1. 每周选一个交易日定投（默认周一；遇到美股休市，就用这周之后的第一个交易日）。
 *   2. 看"定投日前一个交易日的收盘价"离最高点跌了多少（回撤）。
 *   3. 回撤越大，倍数越高：投入金额 = 每周基础金额 × 倍数。
 *
 * 借鉴的开源项目：
 *   - 分档倍数表：wangsunan98/NDX100-autopilot-calculator（按估值分档，用一个基础金额算出各档金额）
 *   - 用纳指回撤判断"低位"：kydchen/qqq-tqqq-signal-dashboard（回撤 ≤ -20% 视为低位信号）
 *   - 用 XIRR（资金加权年化收益率）衡量定投：refraction-ray/xalpha
 *   - 比较收益率而不是只比赚了多少钱：Elucidation/lumpsum_vs_dca
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCA = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAY_MS = 86400000;

  // ===== 默认设置：想改规则，改这里就行 =====
  var DEFAULT_CONFIG = {
    baseAmount: 100, // 每周基础金额（美元）
    investWeekday: 1, // 定投日：1=周一 2=周二 3=周三 4=周四 5=周五（美东时间）
    basis: "ath", // 回撤参照："ath"=历史最高点，"52w"=近 52 周最高点
    tiers: [
      // 回撤达到 minDrawdown(%) 就用这一档的倍数
      { minDrawdown: 0, multiplier: 1 },
      { minDrawdown: 10, multiplier: 1.5 },
      { minDrawdown: 20, multiplier: 2 },
      { minDrawdown: 30, multiplier: 3 },
    ],
  };

  var WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

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
  function normalizeTiers(tiers) {
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
    return list.length ? list : DEFAULT_CONFIG.tiers.slice();
  }

  function withDefaults(config) {
    var c = config || {};
    var base = Number(c.baseAmount);
    var wd = Number(c.investWeekday);
    return {
      baseAmount: isFinite(base) && base > 0 ? base : DEFAULT_CONFIG.baseAmount,
      investWeekday: wd >= 1 && wd <= 5 ? Math.round(wd) : DEFAULT_CONFIG.investWeekday,
      basis: c.basis === "52w" ? "52w" : "ath",
      tiers: normalizeTiers(c.tiers || DEFAULT_CONFIG.tiers),
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

  // 每周的定投日（返回数据里的下标）
  function investDays(series, weekday) {
    var out = [], n = series.n, day = series.day, i = 0;
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
  function nextInvestDate(lastDateStr, weekday) {
    var d = dayNumber(lastDateStr) + 1;
    while (weekdayOf(d) !== weekday) d++;
    return dateFromDayNumber(d);
  }

  // ---------- 当前信号 ----------
  function currentSignal(series, config) {
    var cfg = withDefaults(config);
    if (!series.n) return null;
    var d = drawdowns(series, cfg.basis);
    var last = series.n - 1;
    var k = tierIndex(d.dd[last], cfg.tiers);
    var mult = k < 0 ? 1 : cfg.tiers[k].multiplier;
    return {
      date: series.dates[last],
      close: series.close[last],
      peak: d.peak[last],
      peakDate: series.dates[d.peakIdx[last]],
      drawdown: d.dd[last],
      tierIndex: k,
      multiplier: mult,
      amount: cfg.baseAmount * mult,
      nextDate: nextInvestDate(series.dates[last], cfg.investWeekday),
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
  // opts.plain = true  → 普通定投（每周固定金额）
  // opts.startDate     → 从哪天开始（含）
  // opts.dd            → 可选，提前算好的回撤数组（省时间）
  function backtest(series, config, opts) {
    opts = opts || {};
    var cfg = withDefaults(config);
    var n = series.n;
    if (n < 2) return null;
    var dd = opts.dd || drawdowns(series, cfg.basis).dd;
    var days = investDays(series, cfg.investWeekday);
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

    for (var i = firstIdx; i < n; i++) {
      if (p < days.length && days[p] === i) {
        var ddPrev = dd[i - 1]; // 用前一个交易日收盘价做决定，避免"偷看未来"
        var mult = opts.plain ? 1 : multiplierFor(ddPrev, cfg.tiers);
        var amount = cfg.baseAmount * mult;
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
        close: series.close[last],
        final: true,
      });
    }

    return {
      startDate: series.dates[firstIdx],
      endDate: series.dates[last],
      weeks: flows.length,
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
      worstReturn: worst,
      worstDate: worstDate,
      curve: curve,
    };
  }

  // 同一套规则，换不同开始年份各跑一遍（看结论稳不稳）
  function compareStarts(series, config, years) {
    var cfg = withDefaults(config);
    var dd = drawdowns(series, cfg.basis).dd;
    var lastYear = series.n ? +series.dates[series.n - 1].slice(0, 4) : 0;
    var out = [];
    years.forEach(function (y) {
      if (y > lastYear - 1) return; // 至少留一年以上
      var start = y + "-01-01";
      var a = backtest(series, cfg, { plain: true, startDate: start, dd: dd });
      var b = backtest(series, cfg, { startDate: start, dd: dd });
      if (!a || !b) return;
      out.push({
        year: y,
        plain: a,
        tiered: b,
        xirrDiff: b.xirr - a.xirr,
        investedRatio: b.invested / a.invested,
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
  // 某天买入时，按规则应该投多少：用那天之前最近一个交易日的收盘价算回撤
  function suggestionForDate(series, config, dateStr, dd) {
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
    var ddArr = dd || drawdowns(series, cfg.basis).dd;
    var mult = multiplierFor(ddArr[prevIdx], cfg.tiers);
    var sameDay = lo < n && series.day[lo] === target;
    return {
      date: dateStr,
      basedOn: series.dates[prevIdx],
      drawdown: ddArr[prevIdx],
      multiplier: mult,
      amount: cfg.baseAmount * mult,
      closeOnDate: sameDay ? series.close[lo] : null,
      latestClose: series.close[n - 1],
    };
  }

  // 汇总实际买入记录：和规则建议比，算持仓、市值、平均成本
  // trades: [{ id, date: "YYYY-MM-DD", amount: 实际投入美元, price: 成交价, note }]
  function summarizeTrades(series, config, trades) {
    var cfg = withDefaults(config);
    var n = series.n;
    var dd = n ? drawdowns(series, cfg.basis).dd : [];
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
      var sug = n ? suggestionForDate(series, cfg, t.date, dd) : null;
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

  // 按年汇总：年末收盘价、当年涨跌（含分红）、当年最深回撤、两种定投年末的累计收益率
  function yearly(series, dd, plainCurve, tieredCurve) {
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
      });
    });
    return out;
  }

  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    WEEKDAY_CN: WEEKDAY_CN,
    dayNumber: dayNumber,
    dateFromDayNumber: dateFromDayNumber,
    weekdayOf: weekdayOf,
    withDefaults: withDefaults,
    normalizeTiers: normalizeTiers,
    prepare: prepare,
    drawdowns: drawdowns,
    tierIndex: tierIndex,
    multiplierFor: multiplierFor,
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
    yearly: yearly,
  };
});
