/* 竞彩足球 · 核心模型（浏览器 + Node 共用）
 *
 * 半全场（HT/FT）9 种结果：半场结果 + 全场结果，h=主胜 d=平 a=客胜。
 *   hh 胜胜 · hd 胜平 · ha 胜负
 *   dh 平胜 · dd 平平 · da 平负
 *   ah 负胜 · ad 负平 · aa 负负
 */
(function (root) {
  'use strict';

  var C = {};

  C.HAFU = ['hh', 'hd', 'ha', 'dh', 'dd', 'da', 'ah', 'ad', 'aa'];
  C.LABELS = {
    hh: '胜胜', hd: '胜平', ha: '胜负',
    dh: '平胜', dd: '平平', da: '平负',
    ah: '负胜', ad: '负平', aa: '负负'
  };
  C.COLORS = {
    hh: '#3fd6b5', hd: '#5bc8a8', ha: '#7fbf9b',
    dh: '#4da3ff', dd: '#9aa4bd', da: '#7a8fb5',
    ah: '#ffc45c', ad: '#ff9a3c', aa: '#ff5f6d'
  };

  C.htft = function (ht, ft) {
    var r = function (a, b) { return a > b ? 'h' : a < b ? 'a' : 'd'; };
    return r(ht[0], ht[1]) + r(ft[0], ft[1]);
  };

  /* 赔率 → 归一化隐含概率（去掉庄家抽水） */
  C.implied = function (odds) {
    var inv = {}, sum = 0, i, k;
    for (i = 0; i < C.HAFU.length; i++) {
      k = C.HAFU[i];
      var v = Number(odds[k]);
      if (Number.isFinite(v) && v > 0) { inv[k] = 1 / v; sum += inv[k]; }
    }
    var out = {};
    for (i = 0; i < C.HAFU.length; i++) {
      k = C.HAFU[i];
      out[k] = sum > 0 ? (inv[k] || 0) / sum : 1 / 9;
    }
    return out;
  };

  function poi(lambda, k) {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    var logp = -lambda + k * Math.log(lambda);
    for (var i = 2; i <= k; i++) logp -= Math.log(i);
    return Math.exp(logp);
  }
  C.poisson = poi;

  /*
   * Dixon-Coles 修正：低比分（0-0 / 1-0 / 0-1 / 1-1）的概率并不独立，
   * 用 tau 函数微调，rho 通常取 -0.2 ~ -0.05。
   * 半场与下半场各自做一次修正，再卷积成全场。
   */
  function tau(i, j, l1, l2, rho) {
    if (!rho) return 1;
    if (i === 0 && j === 0) return 1 - l1 * l2 * rho;
    if (i === 0 && j === 1) return 1 + l1 * rho;
    if (i === 1 && j === 0) return 1 + l2 * rho;
    if (i === 1 && j === 1) return 1 - rho;
    return 1;
  }
  C.tau = tau;

  C.htftProbs = function (lh, la, share, rho) {
    var H = share === undefined ? 0.45 : share;
    var R = rho === undefined ? -0.1 : rho;
    var MAX = 6;
    var out = { hh: 0, hd: 0, ha: 0, dh: 0, dd: 0, da: 0, ah: 0, ad: 0, aa: 0 };
    var h1 = lh * H, a1 = la * H, h2 = lh * (1 - H), a2 = la * (1 - H);
    var p1m = [], p2m = [], p3m = [], p4m = [];
    for (var i = 0; i <= MAX; i++) {
      p1m[i] = poi(h1, i); p2m[i] = poi(a1, i);
      p3m[i] = poi(h2, i); p4m[i] = poi(a2, i);
    }
    for (var i1 = 0; i1 <= MAX; i1++) {
      for (var j1 = 0; j1 <= MAX; j1++) {
        var p1 = p1m[i1] * p2m[j1] * tau(i1, j1, h1, a1, R);
        if (p1 < 1e-10) continue;
        var ht = i1 > j1 ? 'h' : i1 < j1 ? 'a' : 'd';
        for (var i2 = 0; i2 <= MAX; i2++) {
          for (var j2 = 0; j2 <= MAX; j2++) {
            var p2 = p3m[i2] * p4m[j2] * tau(i2, j2, h2, a2, R);
            if (p2 < 1e-10) continue;
            var fh = (i1 + i2) > (j1 + j2) ? 'h' : (i1 + i2) < (j1 + j2) ? 'a' : 'd';
            out[ht + fh] += p1 * p2;
          }
        }
      }
    }
    var sum = 0;
    for (var k in out) sum += out[k];
    if (sum > 0) for (k in out) out[k] = Math.max(0, out[k] / sum);
    return out;
  };

  /* 保持半全场内部结构，把「全场胜/平/负」三组总和调整到目标概率 */
  C.reweightHtft = function (probs, target) {
    var groups = { h: ['hh', 'dh', 'ah'], d: ['hd', 'dd', 'ad'], a: ['ha', 'da', 'aa'] };
    var out = {}, g, i;
    for (g in groups) {
      var sum = 0;
      for (i = 0; i < groups[g].length; i++) sum += probs[groups[g][i]] || 0;
      var scale = sum > 0 ? (target[g] || 0) / sum : 0;
      for (i = 0; i < groups[g].length; i++) out[groups[g][i]] = (probs[groups[g][i]] || 0) * scale;
    }
    var s2 = 0;
    for (var k in out) s2 += out[k];
    if (s2 > 0) for (k in out) out[k] /= s2;
    return out;
  };

  /* 汇总半全场概率 → 全场胜平负 */
  C.htftTo1x2 = function (probs) {
    return {
      h: (probs.hh || 0) + (probs.dh || 0) + (probs.ah || 0),
      d: (probs.hd || 0) + (probs.dd || 0) + (probs.ad || 0),
      a: (probs.ha || 0) + (probs.da || 0) + (probs.aa || 0)
    };
  };

  /* 多分类 Brier 分数：Σ(p_i - y_i)² / K，越小越好 */
  C.brier = function (probs, actualKey) {
    var s = 0, K = C.HAFU.length;
    for (var i = 0; i < K; i++) {
      var k = C.HAFU[i];
      var y = k === actualKey ? 1 : 0;
      var p = probs[k] || 0;
      s += (p - y) * (p - y);
    }
    return s / K;
  };

  /* 凯利比例（半凯利）：p 为模型概率，o 为赔率 */
  C.kelly = function (p, o, frac) {
    if (!(o > 1)) return 0;
    var b = o - 1;
    var f = (p * o - 1) / b;
    return Math.max(0, f) * (frac === undefined ? 0.5 : frac);
  };

  /* 结算：picks 是 [{key, stake}]，actual 是结果键，odds 是赔率表 */
  C.settlePicks = function (picks, actual, odds) {
    var profit = 0, stake = 0, hit = 0;
    for (var i = 0; i < picks.length; i++) {
      var p = picks[i];
      var s = p.stake === undefined ? 1 : p.stake;
      stake += s;
      if (p.key === actual) {
        var o = Number(odds[p.key]);
        if (Number.isFinite(o) && o > 0) { profit += s * (o - 1); hit++; }
        else profit -= s;
      } else {
        profit -= s;
      }
    }
    return { profit: +profit.toFixed(4), stake: +stake.toFixed(4), hit: hit, roi: stake ? +(profit / stake).toFixed(4) : 0 };
  };

  /* 从历史比赛统计联赛进球率（用于泊松先验） */
  C.leagueRates = function (matches) {
    var agg = {};
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (!m.ft) continue;
      var a = agg[m.league] || (agg[m.league] = { n: 0, hg: 0, ag: 0 });
      a.n++; a.hg += m.ft[0]; a.ag += m.ft[1];
    }
    var out = {};
    for (var k in agg) {
      var x = agg[k];
      if (x.n >= 5) out[k] = { n: x.n, home: x.hg / x.n, away: x.ag / x.n };
    }
    return out;
  };

  /* 球队近期进球/失球率（主客场分别），带收缩先验 */
  C.teamRates = function (matches, team, prior) {
    var home = { n: 0, gf: 0, ga: 0 };
    var away = { n: 0, gf: 0, ga: 0 };
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (!m.ft) continue;
      if (m.home === team) { home.n++; home.gf += m.ft[0]; home.ga += m.ft[1]; }
      if (m.away === team) { away.n++; away.gf += m.ft[1]; away.ga += m.ft[0]; }
    }
    var k = 8; /* 收缩强度：样本少时靠近先验 */
    return {
      home: {
        gf: (home.gf + prior.home * k) / (home.n + k),
        ga: (home.ga + prior.away * k) / (home.n + k),
        n: home.n
      },
      away: {
        gf: (away.gf + prior.away * k) / (away.n + k),
        ga: (away.ga + prior.home * k) / (away.n + k),
        n: away.n
      }
    };
  };

  /* 由两队主客进球率估计本场 λ */
  C.estimateLambda = function (rates, leagueAvg) {
    var lh = (rates.home.gf / Math.max(0.4, leagueAvg.home)) * (rates.away.ga / Math.max(0.4, leagueAvg.away)) * leagueAvg.home;
    var la = (rates.away.gf / Math.max(0.4, leagueAvg.away)) * (rates.home.ga / Math.max(0.4, leagueAvg.home)) * leagueAvg.away;
    return { home: Math.max(0.55, Math.min(4.2, lh)), away: Math.max(0.35, Math.min(3.8, la)) };
  };

  /* ELO：从按时间排序的比赛计算 */
  C.eloTable = function (matches, k) {
    var elo = {};
    var K = k || 20;
    var base = 1500;
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (!m.ft) continue;
      var h = elo[m.home] || (elo[m.home] = base);
      var a = elo[m.away] || (elo[m.away] = base);
      var exp = 1 / (1 + Math.pow(10, (a - h + 60) / 400));
      var score = m.ft[0] > m.ft[1] ? 1 : m.ft[0] < m.ft[1] ? 0 : 0.5;
      var delta = K * (score - exp);
      elo[m.home] = h + delta;
      elo[m.away] = a - delta;
    }
    return elo;
  };

  C.rankOf = function (p) {
    var keys = Object.keys(p).sort(function (a, b) { return p[b] - p[a]; });
    return { first: keys[0], second: keys[1], p: p };
  };

  /* ================= 球队画像 ================= */

  /* 近 n 场战绩（只看 beforeDate 之前），主客场分开统计 */
  C.teamForm = function (matches, team, beforeDate, n) {
    var recent = [];
    for (var i = matches.length - 1; i >= 0 && recent.length < (n || 10); i--) {
      var m = matches[i];
      if (!m.ft || m.date >= beforeDate) continue;
      if (m.home === team) recent.push({ gf: m.ft[0], ga: m.ft[1], home: true, opp: m.away, date: m.date });
      else if (m.away === team) recent.push({ gf: m.ft[1], ga: m.ft[0], home: false, opp: m.home, date: m.date });
    }
    var w = 0, d = 0, l = 0, gf = 0, ga = 0;
    var hw = 0, hd = 0, hl = 0, aw = 0, ad = 0, al = 0;
    for (var j = 0; j < recent.length; j++) {
      var r = recent[j];
      gf += r.gf; ga += r.ga;
      if (r.gf > r.ga) { w++; if (r.home) hw++; else aw++; }
      else if (r.gf === r.ga) { d++; if (r.home) hd++; else ad++; }
      else { l++; if (r.home) hl++; else al++; }
    }
    var n2 = recent.length;
    return {
      n: n2, w: w, d: d, l: l, gf: gf, ga: ga,
      avgGF: n2 ? gf / n2 : 0,
      avgGA: n2 ? ga / n2 : 0,
      pts: n2 ? (w * 3 + d) / n2 : 0,
      home: { w: hw, d: hd, l: hl },
      away: { w: aw, d: ad, l: al },
      recent: recent.slice(0, 5)
    };
  };

  /* 交锋历史（含主客互换） */
  C.h2h = function (matches, home, away, beforeDate) {
    var hw = 0, d = 0, aw = 0, n = 0;
    for (var i = matches.length - 1; i >= 0; i--) {
      var m = matches[i];
      if (!m.ft) continue;
      if (m.date >= beforeDate) continue;
      var hg, ag;
      if (m.home === home && m.away === away) { hg = m.ft[0]; ag = m.ft[1]; }
      else if (m.home === away && m.away === home) { hg = m.ft[1]; ag = m.ft[0]; }
      else continue;
      n++;
      if (hg > ag) hw++; else if (hg === ag) d++; else aw++;
      if (n >= 8) break;
    }
    return { n: n, hw: hw, d: d, aw: aw };
  };

  /* 休息天数 */
  C.restDays = function (matches, team, dateStr) {
    for (var i = matches.length - 1; i >= 0; i--) {
      var m = matches[i];
      if (m.date >= dateStr) continue;
      if (m.home === team || m.away === team) {
        return Math.round((new Date(dateStr) - new Date(m.date)) / 86400000);
      }
    }
    return null;
  };

  /* 半场专项：上半场进球/失球率 */
  C.halfRates = function (matches, team, beforeDate, n) {
    var htGF = 0, htGA = 0, cnt = 0;
    for (var i = matches.length - 1; i >= 0 && cnt < (n || 15); i--) {
      var m = matches[i];
      if (!m.ft || !m.ht || m.date >= beforeDate) continue;
      if (m.home === team) { htGF += m.ht[0]; htGA += m.ht[1]; cnt++; }
      else if (m.away === team) { htGF += m.ht[1]; htGA += m.ht[0]; cnt++; }
    }
    return { n: cnt, gf: cnt ? htGF / cnt : 0, ga: cnt ? htGA / cnt : 0 };
  };

  /* 用近期状态、交锋、排名、休息调整基础 λ（收紧幅度，避免连乘爆炸） */
  C.adjustLambda = function (base, ctx) {
    function clamp(lo, hi, v) { return Math.max(lo, Math.min(hi, v)); }
    var lh = base.home, la = base.away;
    var fh = ctx.formHome, fa = ctx.formAway;
    var avg = ctx.leagueAvg || { home: 1.4, away: 1.1 };
    var mh = 1, ma = 1;

    /* 状态：近 10 场进攻 ≈ 联赛平均时为 1，最多 ±12% */
    if (fh && fh.n >= 3) mh *= clamp(0.9, 1.12, 0.55 + 0.45 * (fh.avgGF / Math.max(0.6, avg.home)));
    if (fa && fa.n >= 3) ma *= clamp(0.9, 1.12, 0.55 + 0.45 * (fa.avgGF / Math.max(0.6, avg.away)));
    /* 对手防守：对方失球多则本方 λ 略升，最多 ±10% */
    if (fa && fa.n >= 3) mh *= clamp(0.92, 1.10, 0.7 + 0.3 * (fa.avgGA / Math.max(0.6, avg.away)));
    if (fh && fh.n >= 3) ma *= clamp(0.92, 1.10, 0.7 + 0.3 * (fh.avgGA / Math.max(0.6, avg.home)));
    /* 交锋：最多 ±8% */
    if (ctx.h2h && ctx.h2h.n >= 3) {
      var hShare = (ctx.h2h.hw + 0.5 * ctx.h2h.d) / ctx.h2h.n;
      mh *= 1 + (hShare - 0.5) * 0.16;
      ma *= 1 - (hShare - 0.5) * 0.16;
    }
    /* 排名：最多 ±8% */
    if (ctx.rankDiff !== null && ctx.rankDiff !== undefined) {
      var adj = clamp(-0.08, 0.08, ctx.rankDiff / 300);
      mh *= 1 + adj;
      ma *= 1 - adj;
    }
    /* 休息不足 */
    if (ctx.restHome !== null && ctx.restHome < 3) mh *= 0.95;
    if (ctx.restAway !== null && ctx.restAway < 3) ma *= 0.95;

    /* 总乘数限制在 0.78 ~ 1.30 */
    mh = clamp(0.78, 1.30, mh);
    ma = clamp(0.78, 1.30, ma);
    return {
      home: Math.max(0.7, Math.min(2.7, lh * mh)),
      away: Math.max(0.5, Math.min(2.6, la * ma))
    };
  };

  root.FootballCore = C;
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof globalThis !== 'undefined' ? globalThis : this);
