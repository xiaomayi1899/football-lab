/* 半全场实验室 · 前端 */
(function () {
  'use strict';

  var C = window.FootballCore;
  var $view = document.getElementById('view');
  var $tabbar = document.getElementById('tabbar');
  var $date = document.getElementById('data-date');

  var state = { tab: 'today', data: null, error: null, league: 'all' };
  var HAFU = C.HAFU;
  var LABEL = C.LABELS;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pct(x) { return (x * 100).toFixed(1) + '%'; }
  function num(x, d) { return (Number(x) || 0).toFixed(d === undefined ? 2 : d); }
  function fmtVol(v) {
    v = Number(v) || 0;
    if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(1) + '万';
    return String(Math.round(v));
  }
  function sign(x, d) { var v = Number(x) || 0; return (v >= 0 ? '+' : '') + v.toFixed(d === undefined ? 2 : d); }

  function render() {
    Array.prototype.forEach.call($tabbar.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === state.tab);
    });
    if (state.error) {
      $view.innerHTML = '<div class="card"><div class="card-title">数据加载失败</div><p class="hint">' + esc(state.error) + '</p></div>';
      return;
    }
    if (!state.data) {
      $view.innerHTML = '<div class="card"><div class="skel"></div></div><div class="card"><div class="skel" style="height:80px"></div></div>';
      return;
    }
    var html;
    if (state.tab === 'today') html = renderToday();
    else if (state.tab === 'experts') html = renderExperts();
    else if (state.tab === 'review') html = renderReview();
    else html = renderData();
    $view.innerHTML = html;
    $view.classList.remove('fade'); void $view.offsetWidth; $view.classList.add('fade');
    window.scrollTo({ top: 0 });
  }

  /* ---------------- 今日 ---------------- */
  function grid9(m) {
    var best = null, bk = '';
    for (var i = 0; i < HAFU.length; i++) {
      var k = HAFU[i];
      if (!best || (m.model[k] || 0) > best) { best = m.model[k] || 0; bk = k; }
    }
    var picked = {};
    (m.picks || []).forEach(function (p) { picked[p.key] = (picked[p.key] || 0) + 1; });

    var rows = [['h', '全场胜'], ['d', '全场平'], ['a', '全场负']];
    var cols = [['h', '半场胜'], ['d', '半场平'], ['a', '半场负']];
    var html = '<div class="grid9"><div></div>';
    cols.forEach(function (c) { html += '<div class="gh">' + c[1] + '</div>'; });
    rows.forEach(function (r) {
      html += '<div class="gh">' + r[1] + '</div>';
      cols.forEach(function (c) {
        var k = c[0] + r[0];
        var od = m.hafu[k];
        var cls = 'cell' + (k === bk ? ' hot' : '') + (picked[k] ? ' pick' : '');
        html += '<div class="' + cls + '">' +
          '<div class="lbl">' + LABEL[k] + (picked[k] ? '<span class="dot"></span>' : '') + '</div>' +
          '<div class="od">' + (od ? num(od, 2) : '—') + '</div>' +
          '<div class="im">' + pct(m.implied[k] || 0) + '</div>' +
          '</div>';
      });
    });
    html += '</div>';
    return html;
  }

  function bifaBlock(m) {
    if (!m.bifa) return '';
    var rows = [['主胜', m.bifa.home], ['平局', m.bifa.draw], ['客胜', m.bifa.away]];
    return '<div class="bifa">' +
      '<div class="bifa-title">真实投注 · 必发交易</div>' +
      rows.map(function (r) {
        var x = r[1];
        if (!x) return '';
        return '<div class="bifa-row">' +
          '<span class="bifa-name">' + r[0] + '</span>' +
          '<span class="bifa-share">' + pct(x.share) + '</span>' +
          '<span class="bifa-vol">' + fmtVol(x.volume) + '</span>' +
          '<span class="bifa-pnl ' + (x.pnl >= 0 ? 'up' : 'down') + '">庄' + (x.pnl >= 0 ? '盈' : '亏') + fmtVol(Math.abs(x.pnl)) + '</span>' +
          '<span class="bifa-hot ' + (x.hot >= 0 ? 'hot' : 'cold') + '">' + (x.hot >= 0 ? '+' : '') + x.hot + '</span>' +
          '</div>';
      }).join('') +
      (m.tip ? '<div class="bifa-tip">' + esc(m.tip) + '</div>' : '') +
      '</div>';
  }

  function injuryBlock(m) {
    var dj = m.djyy;
    if (dj && ((dj.homeOut && dj.homeOut.length) || (dj.awayOut && dj.awayOut.length))) {
      var row = function (label, list) {
        if (!list || !list.length) return '<div class="inj-row"><span class="inj-k">' + label + '</span><span class="inj-none">无缺阵</span></div>';
        return '<div class="inj-row"><span class="inj-k">' + label + '</span><span class="inj-list">' +
          list.slice(0, 6).map(function (p) {
            return '<span class="inj-chip">' + esc(p.player) + '<i>' + esc(p.reason || '') + (p.missed ? ' · 缺' + p.missed + '场' : '') + '</i></span>';
          }).join('') + '</span></div>';
      };
      return '<div class="inj-block">' +
        '<div class="inj-title">真实伤停 · DJYY' + (dj.xg ? ' · xG ' + num(dj.xg.home) + '-' + num(dj.xg.away) : '') + '</div>' +
        row('主队', dj.homeOut) + row('客队', dj.awayOut) +
        '</div>';
    }
    if (!m.injuries) return '';
    var h = m.injuries.home || [], a = m.injuries.away || [];
    if (!h.length && !a.length) {
      return '<div class="injury-row"><span class="injury-k">伤停</span><span class="hint">该场未匹配到伤停数据</span></div>';
    }
    return '<div class="injury-row"><span class="injury-k">伤停</span><span>主 ' + esc(h.join('、') || '无') + ' · 客 ' + esc(a.join('、') || '无') + '</span></div>';
  }

  function matchCard(m) {
    return '<div class="match">' +
      '<div class="match-head"><span class="match-num">' + esc(m.num) + '</span>' +
      '<span>' + esc(m.league) + '</span>' +
      '<span class="match-time">' + esc(m.date.slice(5)) + ' ' + esc(String(m.time || '').slice(0, 5)) + '</span></div>' +
      '<div class="teams">' +
      '<div class="team"><b>' + esc(m.home) + '</b><span>' + esc(m.homeRank || '') + '</span></div>' +
      '<div class="vs">VS</div>' +
      '<div class="team away"><b>' + esc(m.away) + '</b><span>' + esc(m.awayRank || '') + '</span></div>' +
      '</div>' +
      grid9(m) +
      bifaBlock(m) +
      injuryBlock(m) +
      '<div class="basis">' +
      '<div class="basis-row"><span>近10场</span><b>' + (m.formHome ? m.formHome.w + '胜' + m.formHome.d + '平' + m.formHome.l + '负' : '—') +
      '</b><span class="vs">主</span><b>' + (m.formAway ? m.formAway.w + '胜' + m.formAway.d + '平' + m.formAway.l + '负' : '—') + '</b><span class="vs">客</span></div>' +
      '<div class="basis-row"><span>场均进/失</span><b>' + (m.formHome ? m.formHome.gf + '/' + m.formHome.ga : '—') +
      '</b><span class="vs">主</span><b>' + (m.formAway ? m.formAway.gf + '/' + m.formAway.ga : '—') + '</b><span class="vs">客</span></div>' +
      '<div class="basis-row"><span>交锋</span><b>' + (m.h2h && m.h2h.n ? m.h2h.hw + '-' + m.h2h.d + '-' + m.h2h.aw : '无记录') +
      '</b><span class="vs">休息</span><b>' + (m.restHome === null ? '—' : m.restHome + '天') + ' / ' + (m.restAway === null ? '—' : m.restAway + '天') + '</b></div>' +
      '<div class="basis-row"><span>ELO</span><b>' + (m.eloHome || '—') + '</b><span class="vs">vs</span><b>' + (m.eloAway || '—') +
      '</b><span class="vs">λ</span><b>' + num(m.lambda.home, 2) + ' / ' + num(m.lambda.away, 2) + '</b></div>' +
      '</div>' +
      '<div class="picks">' + (m.picks || []).map(function (p) {
        return '<div class="pick-row">' +
          '<span class="pick-name">' + esc(p.name) + '</span>' +
          '<span class="pick-key">' + esc(p.label) + '</span>' +
          '<span class="pick-odds">' + (p.odds ? num(p.odds, 2) : '—') + '</span>' +
          (p.edge !== undefined ? '<span class="pick-edge">模型期望 +' + pct(p.edge) + '</span>' : '') +
          '<span class="pick-conf conf-' + esc(p.conf) + '">' + esc(p.conf) + '</span>' +
          '</div>' +
          (p.reason ? '<div class="pick-reason">' + esc(p.reason) + '</div>' : '');
      }).join('') + '</div>' +
      '<p class="hint" style="margin-top:8px">小字为市场隐含概率；λ 是泊松模型的期望进球</p>' +
      '</div>';
  }

  function renderToday() {
    var d = state.data;
    var list = d.upcoming || [];
    var leagues = ['all'];
    list.forEach(function (m) { if (leagues.indexOf(m.league) === -1) leagues.push(m.league); });
    var shown = state.league === 'all' ? list : list.filter(function (m) { return m.league === state.league; });
    var byDate = {};
    shown.forEach(function (m) { (byDate[m.date] = byDate[m.date] || []).push(m); });

    var body = Object.keys(byDate).sort().map(function (date) {
      return '<div class="page-head" style="margin-top:16px"><h2>' + esc(date) + '</h2><p>' + byDate[date].length + ' 场在售</p></div>' +
        byDate[date].map(matchCard).join('');
    }).join('');

    return '<div class="page-head"><h2>今日竞彩</h2><p>' + list.length + ' 场在售 · 半全场 9 种结果 · 8 个专家独立推荐</p></div>' +
      '<div class="card" style="padding:10px 12px"><p class="hint">每格显示：半全场结果 / 官方赔率 / 市场隐含概率。金点是专家推荐最多的选项，绿框是模型最看好的一项。</p></div>' +
      '<div class="seg-wrap" style="display:flex;gap:6px;overflow-x:auto;padding:10px 0 2px">' +
      leagues.map(function (lg) {
        return '<button class="chip" data-league="' + esc(lg) + '" style="' + (state.league === lg ? 'background:rgba(63,214,181,.18);color:#3fd6b5' : '') + '">' + (lg === 'all' ? '全部' : esc(lg)) + '</button>';
      }).join('') + '</div>' +
      (body || '<div class="empty">今天没有在售比赛</div>');
  }

  /* ---------------- 专家 ---------------- */
  function renderExperts() {
    var d = state.data;
    var base = d.baselines || { random: 1 / 9, modal: 0.2678 };
    var live = (d.experts || []).slice().sort(function (a, b) { return b.roi - a.roi; });
    var bt = d.backtest || [];
    var exById = {};
    (d.experts || []).forEach(function (e) { exById[e.id] = e; });

    var liveRows = live.map(function (e) {
      return '<div class="live-row">' +
        '<span class="live-name">' + esc(e.name) + '</span>' +
        '<span class="live-fam">' + esc(e.family) + '</span>' +
        '<span class="live-n">' + e.n + ' 注</span>' +
        '<span class="live-hr">' + (e.n ? pct(e.hitRate) : '—') + '</span>' +
        '<span class="live-roi ' + (e.profit >= 0 ? 'up' : 'down') + '">' + (e.n ? sign(e.profit) : '—') + '</span>' +
        '</div>';
    }).join('');

    var btHtml = bt.map(function (b) {
      var w = Math.max(2, Math.min(100, (b.hitRate / 0.45) * 100));
      var baseW = Math.max(2, Math.min(100, ((b.modalBaseline || 0) / 0.45) * 100));
      var edge = b.edge === undefined ? 0 : b.edge;
      return '<div class="exp">' +
        '<div class="exp-head"><span class="exp-name">' + esc(b.name) + '</span>' +
        '<span class="exp-fam">历史回测</span>' +
        '<span class="exp-roi ' + (edge >= 0 ? 'up' : 'down') + '">' + sign(edge * 100, 1) + 'pp</span></div>' +
        '<div class="exp-stats">' +
        '<div><b>' + b.n + '</b><span>回测场次</span></div>' +
        '<div><b>' + b.hits + '</b><span>命中</span></div>' +
        '<div><b>' + pct(b.hitRate) + '</b><span>命中率</span></div>' +
        '<div><b>' + pct(b.randomBaseline) + '</b><span>随机 1/9</span></div>' +
        '</div>' +
        '<div class="bar"><i style="width:' + w + '%"></i><span class="base" style="left:' + baseW + '%"></span></div>' +
        '<p class="hint" style="margin-top:6px">金色刻度 = 「总是选' + esc(b.modalKey ? LABEL[b.modalKey] : '最热项') + '」的基线 ' + pct(b.modalBaseline) + '；超额 ' + sign(edge * 100, 1) + ' 个百分点</p>' +
        (function () {
          var e = exById[b.id];
          if (!e || !e.avgOdds) return '';
          var roi = e.projectedROI;
          return '<div class="breakeven ' + (roi >= 0 ? 'up' : 'down') + '">' +
            '<span>平均赔率 <b>' + num(e.avgOdds) + '</b></span>' +
            '<span>保本命中 <b>' + pct(e.breakEven) + '</b></span>' +
            '<span>预计 ROI <b>' + sign(roi * 100, 1) + '%</b></span>' +
            '</div>' +
            '<p class="hint" style="margin-top:4px">命中率 ' + pct(b.hitRate) + (b.hitRate >= e.breakEven ? ' 高于' : ' 低于') +
            '保本线 — ' + (roi >= 0 ? '按当前赔率结构可能盈利' : '命中率不够覆盖赔率，长期亏钱') + '</p>';
        })() +
        '</div>';
    }).join('');

    return '<div class="page-head"><h2>专家榜</h2><p>上半部分是真实赔率结算，下半部分是 631 场历史命中率回测</p></div>' +
      '<div class="notice">真实盈亏只在「有官方赔率快照 + 已完赛」时结算。官方不保留历史赔率，所以真实样本从抓取当日起累积；回测部分没有赔率，只统计命中率。</div>' +
      '<div class="page-head" style="margin-top:16px"><h2 style="font-size:15px">真实结算</h2><p>官方赔率 + 已完赛才计入</p></div>' +
      '<div class="card live-table">' + liveRows + '<p class="hint" style="margin-top:8px">当前 0 注：今日 44 场的赛果还没出。明天起自动结算。</p></div>' +
      '<div class="page-head" style="margin-top:16px"><h2 style="font-size:15px">历史命中率回测</h2><p>' + (bt[0] ? bt[0].n : 0) + ' 场 · 无前视</p></div>' +
      (btHtml || '<div class="empty">暂无</div>');
  }

  /* ---------------- 复盘 ---------------- */
  function renderReview() {
    var d = state.data;
    var settled = d.settled || [];
    var rows = settled.map(function (m) {
      return '<div class="rev-row">' +
        '<div><div><b>' + esc(m.home) + '</b> vs <b>' + esc(m.away) + '</b></div>' +
        '<div class="rev-meta">' + esc(m.num) + ' · ' + esc(m.league) + ' · ' + esc(m.date) + '</div>' +
        '<div class="rev-picks">' + (m.picks || []).map(function (p) {
          var hit = p.key === m.result.htft;
          return '<span class="chip ' + (hit ? 'hit' : 'miss') + '">' + esc(p.name) + ' ' + esc(p.label) + '</span>';
        }).join('') + '</div></div>' +
        '<div style="text-align:right"><div class="rev-score">' + esc(m.result.ht[0] + ':' + m.result.ht[1]) + ' → ' + esc(m.result.ft[0] + ':' + m.result.ft[1]) + '</div>' +
        '<div class="rev-meta">实际 ' + esc(m.result.label) + '</div></div>' +
        '</div>';
    }).join('');

    var bt = d.backtest || [];
    var exById = {};
    (d.experts || []).forEach(function (e) { exById[e.id] = e; });
    var recent = [];
    bt.forEach(function (b) {
      (b.picks || []).slice(-12).reverse().forEach(function (p) {
        recent.push({ expert: b.name, p: p });
      });
    });
    recent.sort(function (a, b) { return (b.p.date + b.p.num).localeCompare(a.p.date + a.p.num); });

    return '<div class="page-head"><h2>复盘</h2><p>开奖后逐场对比：每个专家推荐了什么、实际开什么、是否命中</p></div>' +
      '<div class="notice">真实复盘需要「赛前赔率快照 + 赛后比分」。今天起抓取的比赛会在次日自动结算；下方历史回测只统计命中，不结算盈亏。</div>' +
      '<div class="card"><div class="card-title">真实结算 <span class="sub">' + settled.length + ' 场</span></div>' +
      (rows || '<div class="empty">还没有可结算的比赛。<br>今日 44 场在售，明天开奖后这里会自动出现。</div>') + '</div>' +
      '<div class="card"><div class="card-title">历史回测记录 <span class="sub">最近 ' + recent.length + ' 条</span></div>' +
      recent.map(function (r) {
        return '<div class="rev-row"><div><div><b>' + esc(r.p.home) + '</b> vs <b>' + esc(r.p.away) + '</b></div>' +
          '<div class="rev-meta">' + esc(r.p.num) + ' · ' + esc(r.p.league) + ' · ' + esc(r.p.date) + ' · ' + esc(r.expert) + '</div></div>' +
          '<div style="text-align:right"><span class="chip ' + (r.p.hit ? 'hit' : 'miss') + '">' + esc(r.p.label) + '</span>' +
          '<div class="rev-meta">实际 ' + esc(r.p.actualLabel) + '</div></div></div>';
      }).join('') + '</div>';
  }

  /* ---------------- 数据 ---------------- */
  function renderData() {
    var d = state.data;
    var st = d.stats || {};
    var dist = st.htftDist || {};
    var total = 0;
    HAFU.forEach(function (k) { total += dist[k] || 0; });
    var distRows = HAFU.slice().sort(function (a, b) { return (dist[b] || 0) - (dist[a] || 0); }).map(function (k) {
      var n = dist[k] || 0;
      var w = total ? (n / total) * 100 : 0;
      return '<div class="dist-row"><span>' + LABEL[k] + '</span><div class="dist-bar"><i style="width:' + w + '%"></i></div><b>' + pct(n / total) + '</b></div>';
    }).join('');

    var tr = st.transitions || {};
    var trHtml = ['h', 'd', 'a'].map(function (ht) {
      var x = tr[ht] || { h: 0, d: 0, a: 0, n: 0 };
      var n = x.n || 1;
      return '<div><b>' + pct((x[ht] || 0) / n) + '</b><span>半场' + LABEL[ht + 'h'].slice(0, 1) + ' → 全场' + LABEL[ht + 'h'].slice(0, 1) + '</span></div>';
    }).join('');

    var leagueRows = (st.leagueTop || []).slice(0, 12).map(function (l) {
      var w = total ? (l.n / total) * 100 : 0;
      return '<div class="dist-row"><span style="font-size:10.5px">' + esc(l.name) + '</span><div class="dist-bar"><i style="width:' + w + '%"></i></div><b>' + l.n + '</b></div>';
    }).join('');

    return '<div class="page-head"><h2>数据分析</h2><p>' + d.meta.resultMatches + ' 场赛果 · ' + d.meta.resultDays + ' 天 · 官方公开数据</p></div>' +
      '<div class="card"><div class="card-title">半全场结果分布 <span class="sub">' + total + ' 场</span></div><div class="dist">' + distRows + '</div>' +
      '<p class="hint" style="margin-top:10px">这就是为什么「总是选胜胜」能有 ' + pct((dist.hh || 0) / total) + ' 命中率——分布本身偏斜，不是模型厉害。</p></div>' +
      '<div class="card"><div class="card-title">半场领先后的最终走向</div><div class="trans">' + trHtml + '</div>' +
      '<p class="hint" style="margin-top:10px">半场领先的球队，最终有较高比例保持领先。这是半全场玩法的结构性基础，不是可套利规律。</p></div>' +
      '<div class="card"><div class="card-title">联赛分布 <span class="sub">Top 12</span></div><div class="dist">' + leagueRows + '</div></div>' +
      '<div class="card"><div class="card-title">数据来源与口径</div><div class="hint">' +
      '<p>· 赛果与赔率全部来自中国体育彩票官方公开接口（sporttery.cn），赛果含半场比分 sectionsNo1 与全场比分 sectionsNo999。</p>' +
      '<p style="margin-top:6px">· 半全场结果 = 半场结果 + 全场结果，共 9 种。赔率键 h/d/a 分别代表主胜/平/客胜。</p>' +
      '<p style="margin-top:6px">· 官方不保留历史赔率，因此真实盈亏从抓取当日起逐日累积；历史回测只统计命中率。</p>' +
      '<p style="margin-top:6px">· 模型为泊松 + ELO + 市场隐含概率，无前视，但足球随机性极高，任何推荐都不构成投注建议。</p>' +
      '</div></div>';
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tab],[data-league]') : null;
    if (!el) return;
    if (el.hasAttribute('data-tab')) {
      state.tab = el.getAttribute('data-tab');
      history.replaceState(null, '', '#' + state.tab);
      render();
      return;
    }
    if (el.hasAttribute('data-league')) {
      state.league = el.getAttribute('data-league');
      render();
    }
  });

  function boot() {
    var h = String(location.hash || '').replace(/^#/, '');
    if (['today', 'experts', 'review', 'data'].indexOf(h) !== -1) state.tab = h;
    fetch('data/app.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        state.data = d;
        state.error = null;
        $date.textContent = '更新 ' + String(d.updatedAt || '').slice(5, 16).replace('T', ' ');
        render();
      })
      .catch(function (err) {
        state.error = err.message || String(err);
        $date.textContent = '加载失败';
        render();
      });
  }

  boot();
})();
