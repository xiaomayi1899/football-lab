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
   * 用两队全场期望进球 λh / λa，拆成上半场 45% + 下半场 55%，
   * 枚举半场与下半场比分后合并，得到 9 种半全场概率。
   * 这样半场与全场不独立，符合真实比赛的强相关。
   */
  C.htftProbs = function (lh, la, share) {
    var H = share === undefined ? 0.45 : share;
    var MAX = 6;
    var out = { hh: 0, hd: 0, ha: 0, dh: 0, dd: 0, da: 0, ah: 0, ad: 0, aa: 0 };
    var h1 = lh * H, a1 = la * H, h2 = lh * (1 - H), a2 = la * (1 - H);
    var ph = [], pa = [], ph2 = [], pa2 = [];
    for (var i = 0; i <= MAX; i++) {
      ph[i] = poi(h1, i); pa[i] = poi(a1, i);
      ph2[i] = poi(h2, i); pa2[i] = poi(a2, i);
    }
    for (var i1 = 0; i1 <= MAX; i1++) {
      for (var j1 = 0; j1 <= MAX; j1++) {
        var p1 = ph[i1] * pa[j1];
        if (p1 < 1e-9) continue;
        var ht = i1 > j1 ? 'h' : i1 < j1 ? 'a' : 'd';
        for (var i2 = 0; i2 <= MAX; i2++) {
          for (var j2 = 0; j2 <= MAX; j2++) {
            var p2 = ph2[i2] * pa2[j2];
            if (p2 < 1e-9) continue;
            var fh = (i1 + i2) > (j1 + j2) ? 'h' : (i1 + i2) < (j1 + j2) ? 'a' : 'd';
            out[ht + fh] += p1 * p2;
          }
        }
      }
    }
    var sum = 0;
    for (var k in out) sum += out[k];
    if (sum > 0) for (k in out) out[k] /= sum;
    return out;
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
    var k = 4; /* 收缩强度：样本少时靠近先验 */
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

  root.FootballCore = C;
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof globalThis !== 'undefined' ? globalThis : this);
