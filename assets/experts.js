/* 竞彩足球 · 半全场专家引擎
 *
 * 每个专家只看「赔率 + 泊松模型 + ELO」的公开信息，独立给出一个半全场推荐。
 * 复盘时逐个结算，用真实赔率算盈亏，避免「只报命中不报亏损」。
 *
 * 注意：所有专家都承认自己是概率猜测，不承诺命中。
 */
(function (root) {
  'use strict';

  var C = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.FootballCore;
  var E = {};

  function top(obj, keys) {
    var list = keys || C.HAFU;
    var bk = list[0], bv = -1;
    for (var i = 0; i < list.length; i++) {
      var k = list[i];
      var v = obj[k] || 0;
      if (v > bv) { bv = v; bk = k; }
    }
    return { key: bk, prob: bv };
  }

  function confOf(p) {
    return p >= 0.3 ? '高' : p >= 0.18 ? '中' : '低';
  }

  /* ELO 差 → 半全场先验（简化：强队更可能半场就领先并保持） */
  function eloProbs(diff) {
    var win = 1 / (1 + Math.pow(10, -diff / 400));
    var draw = 0.26 * Math.exp(-Math.abs(diff) / 500);
    var lose = 1 - win - draw;
    var p = {};
    p.hh = win * 0.58; p.dh = win * 0.27; p.hd = win * 0.10; p.ha = win * 0.03; p.dd = win * 0.02;
    p.dd += draw * 0.55; p.dh += draw * 0.15; p.hd += draw * 0.15; p.da += draw * 0.10; p.ha += draw * 0.05;
    p.aa = lose * 0.52; p.da = (p.da || 0) + lose * 0.28; p.ad = lose * 0.11; p.ah = lose * 0.05; p.dd += lose * 0.04;
    var s = 0;
    for (var k in p) s += p[k];
    for (k in p) p[k] /= s;
    return p;
  }

  E.LIST = [
    {
      id: 'market', name: '市场共识', family: '赔率',
      desc: '直接取官方赔率隐含概率最高的半全场。跟市场走，不加工。',
      pick: function (x) {
        var r = top(x.implied);
        return { key: r.key, prob: r.prob, conf: confOf(r.prob) };
      }
    },
    {
      id: 'poisson', name: '泊松模型', family: '模型',
      desc: '用两队主客场进球率估计 λ，拆成上下半场枚举比分，算 9 种半全场概率。',
      pick: function (x) {
        var r = top(x.model);
        return { key: r.key, prob: r.prob, conf: confOf(r.prob) };
      }
    },
    {
      id: 'value', name: '价值投注', family: '模型',
      desc: '找「模型概率 × 赔率」最大的选项，只在期望为正时才下注。',
      pick: function (x) {
        var bestKey = null, bestEdge = -1, bestProb = 0;
        for (var i = 0; i < C.HAFU.length; i++) {
          var k = C.HAFU[i];
          var o = Number(x.odds[k]);
          if (!(o > 1)) continue;
          var edge = x.model[k] * o - 1;
          if (edge > bestEdge) { bestEdge = edge; bestKey = k; bestProb = x.model[k]; }
        }
        if (!bestKey || bestEdge <= 0) { var r = top(x.model); return { key: r.key, prob: r.prob, conf: '低' }; }
        return { key: bestKey, prob: bestProb, conf: bestEdge > 0.15 ? '高' : bestEdge > 0.05 ? '中' : '低', edge: +bestEdge.toFixed(3) };
      }
    },
    {
      id: 'home', name: '主队强势', family: '倾向',
      desc: '只在「半场主胜」相关的 hh / dh / ha 中选概率最高的。',
      pick: function (x) {
        var r = top(x.model, ['hh', 'dh', 'ha']);
        return { key: r.key, prob: r.prob, conf: confOf(r.prob) };
      }
    },
    {
      id: 'draw', name: '平局派', family: '倾向',
      desc: '只在「半场平」相关的 dd / dh / hd 中选概率最高的。',
      pick: function (x) {
        var r = top(x.model, ['dd', 'dh', 'hd']);
        return { key: r.key, prob: r.prob, conf: confOf(r.prob) };
      }
    },
    {
      id: 'cold', name: '冷门猎手', family: '赔率',
      desc: '只在赔率 ≥ 8 的高赔选项里，选模型概率最高的一个。',
      pick: function (x) {
        var pool = C.HAFU.filter(function (k) { return Number(x.odds[k]) >= 8; });
        if (!pool.length) { var r = top(x.model); return { key: r.key, prob: r.prob, conf: '低' }; }
        var rr = top(x.model, pool);
        return { key: rr.key, prob: rr.prob, conf: '低', odds: x.odds[rr.key] };
      }
    },
    {
      id: 'elo', name: 'ELO 等级分', family: '模型',
      desc: '用历史赛果算出的 ELO 差，推导半全场先验。',
      pick: function (x) {
        var p = eloProbs(x.eloDiff);
        var r = top(p);
        return { key: r.key, prob: r.prob, conf: confOf(r.prob) };
      }
    },
    {
      id: 'blend', name: '三源融合', family: '融合',
      desc: '市场 40% + 泊松 40% + ELO 20% 加权，取最高项。',
      pick: function (x) {
        var ep = eloProbs(x.eloDiff);
        var mix = {};
        for (var i = 0; i < C.HAFU.length; i++) {
          var k = C.HAFU[i];
          mix[k] = 0.4 * x.implied[k] + 0.4 * x.model[k] + 0.2 * ep[k];
        }
        var r = top(mix);
        return { key: r.key, prob: r.prob, conf: confOf(r.prob) };
      }
    }
  ];

  E.eloProbs = eloProbs;

  /* 对一场比赛跑全部专家 */
  E.run = function (ctx) {
    return E.LIST.map(function (e) {
      var r = e.pick(ctx);
      return {
        id: e.id,
        name: e.name,
        family: e.family,
        key: r.key,
        label: C.LABELS[r.key],
        prob: +(r.prob || 0).toFixed(4),
        odds: Number(ctx.odds[r.key]) || null,
        conf: r.conf || '低',
        edge: r.edge
      };
    });
  };

  root.FootballExperts = E;
  if (typeof module !== 'undefined' && module.exports) module.exports = E;
})(typeof globalThis !== 'undefined' ? globalThis : this);
