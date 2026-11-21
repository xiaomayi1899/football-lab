/* 竞彩足球 · 半全场专家引擎 v2
 *
 * 每个专家只看自己擅长的信号，必须给出「依据」（reason），
 * 避免所有专家都退化到「强队胜胜」。
 *
 * 信号来源：
 *   implied  官方赔率隐含概率
 *   model    泊松模型（已用近期状态 / 交锋 / 排名 / 休息调整 λ）
 *   form     近 10 场战绩（含主客场拆分）
 *   h2h      历史交锋
 *   half     上半场进球/失球率
 *   rest     休息天数
 */
(function (root) {
  'use strict';

  var C = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.FootballCore;
  var E = {};

  function top(obj, keys) {
    var list = keys || C.HAFU;
    var bk = list[0], bv = -1;
    for (var i = 0; i < list.length; i++) {
      var k = list[i], v = obj[k] || 0;
      if (v > bv) { bv = v; bk = k; }
    }
    return { key: bk, prob: bv };
  }
  function confOf(p) { return p >= 0.3 ? '高' : p >= 0.18 ? '中' : '低'; }
  function formText(f) {
    if (!f || !f.n) return '样本不足';
    return f.n + ' 场 ' + f.w + '胜' + f.d + '平' + f.l + '负';
  }
  function eloProbs(diff) {
    var win = 1 / (1 + Math.pow(10, -diff / 400));
    var draw = 0.26 * Math.exp(-Math.abs(diff) / 500);
    var lose = 1 - win - draw;
    var p = { hh: win * 0.58, dh: win * 0.27, hd: win * 0.10, ha: win * 0.03, dd: win * 0.02, da: 0, ad: 0, ah: 0, aa: lose * 0.52 };
    p.dd += draw * 0.55; p.dh += draw * 0.15; p.hd += draw * 0.15; p.da += draw * 0.10; p.ha += draw * 0.05;
    p.da += lose * 0.28; p.ad += lose * 0.11; p.ah += lose * 0.05; p.dd += lose * 0.04;
    var s = 0;
    for (var k in p) s += p[k];
    for (k in p) p[k] /= s;
    return p;
  }
  E.eloProbs = eloProbs;

  var HOME_KEYS = ['hh', 'dh', 'ha'];
  var AWAY_KEYS = ['aa', 'da', 'ad'];
  var DRAW_KEYS = ['dd', 'dh', 'hd'];

  E.LIST = [
    {
      id: 'market', name: '市场共识', family: '赔率',
      desc: '直接取官方赔率隐含概率最高的半全场。跟市场走，不加工。',
      pick: function (x) {
        var r = top(x.implied);
        return { key: r.key, prob: r.prob, conf: confOf(r.prob), reason: '官方赔率最低项 ' + (x.odds[r.key] || '—') };
      }
    },
    {
      id: 'poisson', name: '泊松模型', family: '模型',
      desc: '用近期状态、交锋、排名、休息调整过的 λ，枚举上下半场比分算 9 种结果。',
      pick: function (x) {
        var r = top(x.model);
        return { key: r.key, prob: r.prob, conf: confOf(r.prob), reason: 'λ 主 ' + x.lambda.home.toFixed(2) + ' / 客 ' + x.lambda.away.toFixed(2) };
      }
    },
    {
      id: 'form', name: '近期状态', family: '战绩',
      desc: '比较两队近 10 场得分率（胜 3 分 / 平 1 分），谁状态好就押谁那一侧。',
      pick: function (x) {
        var fh = x.formHome, fa = x.formAway;
        if (!fh || !fa || fh.n < 4 || fa.n < 4) {
          var r0 = top(x.model);
          return { key: r0.key, prob: r0.prob, conf: '低', reason: '样本不足，退回模型' };
        }
        var diff = fh.pts - fa.pts;
        var pool = diff > 0.35 ? HOME_KEYS : diff < -0.35 ? AWAY_KEYS : DRAW_KEYS;
        var r = top(x.model, pool);
        return {
          key: r.key, prob: r.prob, conf: confOf(r.prob),
          reason: '主 ' + formText(fh) + '（' + fh.pts.toFixed(2) + ' 分/场） vs 客 ' + formText(fa) + '（' + fa.pts.toFixed(2) + ' 分/场）'
        };
      }
    },
    {
      id: 'h2h', name: '交锋压制', family: '战绩',
      desc: '看两队历史交锋谁占优，只在该方向里选概率最高的一项。',
      pick: function (x) {
        var h = x.h2h;
        if (!h || h.n < 3) {
          var r0 = top(x.model);
          return { key: r0.key, prob: r0.prob, conf: '低', reason: '交锋样本不足（' + (h ? h.n : 0) + ' 场）' };
        }
        var share = (h.hw + 0.5 * h.d) / h.n;
        var pool = share > 0.58 ? HOME_KEYS : share < 0.42 ? AWAY_KEYS : DRAW_KEYS;
        var r = top(x.model, pool);
        return {
          key: r.key, prob: r.prob, conf: confOf(r.prob),
          reason: '近 ' + h.n + ' 次交锋：主胜 ' + h.hw + ' / 平 ' + h.d + ' / 客胜 ' + h.aw
        };
      }
    },
    {
      id: 'home', name: '主场龙', family: '场地',
      desc: '只看主队的主场战绩和主场进球率，主场特别强才推主队一侧。',
      pick: function (x) {
        var f = x.formHome;
        if (!f || (f.home.w + f.home.d + f.home.l) < 3) {
          var r0 = top(x.model);
          return { key: r0.key, prob: r0.prob, conf: '低', reason: '主场样本不足' };
        }
        var h = f.home, played = h.w + h.d + h.l;
        var rate = (h.w * 3 + h.d) / (played * 3);
        var pool = rate >= 0.6 ? HOME_KEYS : AWAY_KEYS;
        var r = top(x.model, pool);
        return {
          key: r.key, prob: r.prob, conf: confOf(r.prob),
          reason: '主队主场 ' + h.w + '胜' + h.d + '平' + h.l + '负（得分率 ' + Math.round(rate * 100) + '%）'
        };
      }
    },
    {
      id: 'defense', name: '防守派', family: '结构',
      desc: '两队场均失球都低时，偏向「半场平」与低比分；失球多则恢复正常进攻假设。',
      pick: function (x) {
        var fh = x.formHome, fa = x.formAway;
        if (!fh || !fa || fh.n < 4 || fa.n < 4) {
          var r0 = top(x.model);
          return { key: r0.key, prob: r0.prob, conf: '低', reason: '样本不足' };
        }
        var ga = (fh.avgGA + fa.avgGA) / 2;
        var pool = ga < 1.05 ? ['dd', 'dh', 'hd', 'hh', 'aa'] : C.HAFU;
        var r = top(x.model, pool);
        return {
          key: r.key, prob: r.prob, conf: confOf(r.prob),
          reason: '两队近 10 场场均失球 ' + ga.toFixed(2) + '（' + (ga < 1.05 ? '防守强，压低比分' : '防守一般') + '）'
        };
      }
    },
    {
      id: 'comeback', name: '逆转派', family: '结构',
      desc: '找「半场落后但全场可能翻盘」的组合，依赖两队上半场与下半场进球差异。',
      pick: function (x) {
        var hh = x.halfHome, ha = x.halfAway;
        if (!hh || !ha || hh.n < 5 || ha.n < 5) {
          var r0 = top(x.model);
          return { key: r0.key, prob: r0.prob, conf: '低', reason: '半场样本不足' };
        }
        /* 主队下半场强于上半场 → 可能半场落后再翻盘（ah / dh） */
        var homeLate = (x.formHome.avgGF - hh.gf) - (x.formAway.avgGF - ha.gf);
        var pool = homeLate > 0.15 ? ['ah', 'dh', 'hh'] : ['da', 'ad', 'aa'];
        var r = top(x.model, pool);
        return {
          key: r.key, prob: r.prob, conf: confOf(r.prob),
          reason: '半场场均进球 主 ' + hh.gf.toFixed(2) + ' / 客 ' + ha.gf.toFixed(2) + '，下半场差异 ' + (homeLate > 0 ? '主队更强' : '客队更强')
        };
      }
    },
    {
      id: 'elo', name: 'ELO 等级分', family: '实力',
      desc: '用 4700+ 场历史赛果累积的 ELO 分差推导半全场先验。',
      pick: function (x) {
        var r = top(eloProbs(x.eloDiff));
        return {
          key: r.key, prob: r.prob, conf: confOf(r.prob),
          reason: 'ELO ' + Math.round(x.eloHome) + ' vs ' + Math.round(x.eloAway) + '（差 ' + (x.eloDiff >= 0 ? '+' : '') + Math.round(x.eloDiff) + '）'
        };
      }
    },
    {
      id: 'value', name: '价值投注', family: '赔率',
      desc: '找「模型概率 × 赔率」最大的选项，只在期望为正时下注。',
      pick: function (x) {
        var bestKey = null, bestEdge = -1, bestProb = 0;
        for (var i = 0; i < C.HAFU.length; i++) {
          var k = C.HAFU[i];
          var o = Number(x.odds[k]);
          if (!(o > 1)) continue;
          var edge = x.model[k] * o - 1;
          if (edge > bestEdge) { bestEdge = edge; bestKey = k; bestProb = x.model[k]; }
        }
        if (!bestKey || bestEdge <= 0) {
          var r0 = top(x.model);
          return { key: r0.key, prob: r0.prob, conf: '低', reason: '没有正期望选项，退回模型' };
        }
        return {
          key: bestKey, prob: bestProb, edge: +bestEdge.toFixed(3),
          conf: bestEdge > 0.15 ? '高' : bestEdge > 0.05 ? '中' : '低',
          reason: '模型 ' + Math.round(bestProb * 100) + '% × 赔率 ' + x.odds[bestKey] + ' = 期望 +' + Math.round(bestEdge * 100) + '%'
        };
      }
    }
  ];

  E.run = function (ctx) {
    return E.LIST.map(function (e) {
      var r = e.pick(ctx);
      return {
        id: e.id, name: e.name, family: e.family,
        key: r.key, label: C.LABELS[r.key],
        prob: +(r.prob || 0).toFixed(4),
        odds: Number(ctx.odds[r.key]) || null,
        conf: r.conf || '低',
        edge: r.edge,
        reason: r.reason || ''
      };
    });
  };

  root.FootballExperts = E;
  if (typeof module !== 'undefined' && module.exports) module.exports = E;
})(typeof globalThis !== 'undefined' ? globalThis : this);
