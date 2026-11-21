#!/usr/bin/env node
/**
 * 合并数据 + 生成专家推荐 + 结算复盘
 *
 *   node scripts/build.mjs
 *
 * 输入：data/results.json（赛果）、data/odds.json（赔率快照）
 * 输出：data/app.json（前端唯一数据源）
 *
 * 严格性说明：
 *   - ELO 按比赛日期增量计算，预测某场时只用该场之前的比赛，避免前视
 *   - 赔率来自官方快照；没有赔率的比赛不参与盈亏统计
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA = resolve(ROOT, 'data');

const C = require(resolve(ROOT, 'assets/core.js'));
const E = require(resolve(ROOT, 'assets/experts.js'));

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

const results = readJson(resolve(DATA, 'results.json'), { matches: [] }).matches || [];
const oddsFile = readJson(resolve(DATA, 'odds.json'), { snapshots: [] });
const snapshots = oddsFile.snapshots || [];

const keyOf = (m) => m.num + '|' + m.date;

/* ---------- 历史统计 ---------- */
const leagueRates = C.leagueRates(results);

/* 按日期排序，增量算 ELO，记录每场赛前的 ELO */
const sorted = results.slice().sort((a, b) => (a.date + a.num).localeCompare(b.date + b.num));
const elo = {};
const eloBefore = {};
const K = 22;
for (const m of sorted) {
  if (!m.ft) continue;
  const h = elo[m.home] || 1500;
  const a = elo[m.away] || 1500;
  eloBefore[keyOf(m)] = { home: h, away: a };
  const exp = 1 / (1 + Math.pow(10, (a - h + 60) / 400));
  const score = m.ft[0] > m.ft[1] ? 1 : m.ft[0] < m.ft[1] ? 0 : 0.5;
  const delta = K * (score - exp);
  elo[m.home] = h + delta;
  elo[m.away] = a - delta;
}

function priorFor(league) {
  return leagueRates[league] || { home: 1.42, away: 1.12 };
}

/* ---------- 逐场建上下文 ---------- */
function buildContext(m) {
  const odds = m.hafu || {};
  if (!odds.hh) return null;
  const implied = C.implied(odds);
  const prior = priorFor(m.league);
  const rates = C.teamRates(results, m.home, prior);
  const ratesAway = C.teamRates(results, m.away, prior);
  const lam = C.estimateLambda({
    home: rates.home,
    away: ratesAway.away
  }, prior);
  const model = C.htftProbs(lam.home, lam.away);
  const eloNow = eloBefore[keyOf(m)] || { home: elo[m.home] || 1500, away: elo[m.away] || 1500 };
  return {
    odds,
    implied,
    model,
    lambda: lam,
    eloDiff: eloNow.home - eloNow.away,
    eloHome: eloNow.home,
    eloAway: eloNow.away
  };
}

/* ---------- 结算 ---------- */
const expertAgg = {};
for (const e of E.LIST) {
  expertAgg[e.id] = {
    id: e.id, name: e.name, family: e.family, desc: e.desc,
    n: 0, hits: 0, profit: 0, stake: 0, peak: 0, maxDrawdown: 0,
    streak: 0, bestStreak: 0, curStreak: 0, picks: []
  };
}

const upcoming = [];
const settled = [];

const seen = new Set();
for (const snap of snapshots) {
  for (const m of snap.matches || []) {
    const k = keyOf(m);
    if (seen.has(k)) continue;
    seen.add(k);
    const ctx = buildContext(m);
    if (!ctx) continue;
    const picks = E.run(ctx);
    const result = results.find((r) => r.num === m.num && r.date === m.date) || null;

    const item = {
      num: m.num, date: m.date, time: m.time, league: m.league,
      home: m.home, away: m.away,
      homeRank: m.homeRank, awayRank: m.awayRank,
      hafu: m.hafu,
      implied: ctx.implied,
      model: ctx.model,
      lambda: ctx.lambda,
      eloDiff: Math.round(ctx.eloDiff),
      picks,
      result: result ? { ht: result.ht, ft: result.ft, htft: result.htft, label: C.LABELS[result.htft] } : null
    };

    if (result) {
      item.settled = true;
      for (const p of picks) {
        const s = C.settlePicks([{ key: p.key, stake: 1 }], result.htft, m.hafu);
        const agg = expertAgg[p.id];
        agg.n++;
        agg.hits += s.hit;
        agg.profit += s.profit;
        agg.stake += s.stake;
        agg.peak = Math.max(agg.peak, agg.profit);
        agg.maxDrawdown = Math.max(agg.maxDrawdown, agg.peak - agg.profit);
        if (s.hit) { agg.curStreak = Math.max(1, agg.curStreak + 1); agg.bestStreak = Math.max(agg.bestStreak, agg.curStreak); }
        else { agg.curStreak = Math.min(-1, agg.curStreak - 1); }
        agg.streak = agg.curStreak;
        agg.picks.push({
          num: m.num, date: m.date, league: m.league, home: m.home, away: m.away,
          key: p.key, label: p.label, odds: p.odds, prob: p.prob,
          actual: result.htft, actualLabel: C.LABELS[result.htft],
          hit: s.hit === 1, profit: s.profit, score: result.ft
        });
      }
      settled.push(item);
    } else {
      item.settled = false;
      upcoming.push(item);
    }
  }
}

/* 专家汇总 */
const experts = Object.values(expertAgg).map((a) => ({
  id: a.id, name: a.name, family: a.family, desc: a.desc,
  n: a.n,
  hits: a.hits,
  hitRate: a.n ? +(a.hits / a.n).toFixed(4) : 0,
  profit: +a.profit.toFixed(3),
  stake: +a.stake.toFixed(3),
  roi: a.stake ? +(a.profit / a.stake).toFixed(4) : 0,
  maxDrawdown: +a.maxDrawdown.toFixed(3),
  streak: a.streak,
  bestStreak: a.bestStreak,
  picks: a.picks.slice(-80)
}));

/* 统计 */
const htftDist = {};
for (const r of results) htftDist[r.htft] = (htftDist[r.htft] || 0) + 1;
const leagueDist = {};
for (const r of results) leagueDist[r.league] = (leagueDist[r.league] || 0) + 1;
const leagueTop = Object.entries(leagueDist).sort((a, b) => b[1] - a[1]).slice(0, 20)
  .map(([name, n]) => ({ name, n }));

/* 半场领先后的最终走向：用于说明半全场的结构性规律 */
const transitions = {};
for (const r of results) {
  const ht = r.htft[0];
  transitions[ht] = transitions[ht] || { h: 0, d: 0, a: 0, n: 0 };
  transitions[ht][r.htft[1]]++;
  transitions[ht].n++;
}

/* ---------- 历史命中率回测（631 场，无赔率，仅统计命中） ---------- */
const btIds = ['poisson', 'home', 'draw', 'elo'];
const backtest = {};
for (const id of btIds) backtest[id] = { id, name: E.LIST.find((x) => x.id === id).name, n: 0, hits: 0, picks: [] };

for (let i = 40; i < sorted.length; i++) {
  const m = sorted[i];
  if (!m.ft) continue;
  const prior = priorFor(m.league);
  const ratesH = C.teamRates(sorted.slice(0, i), m.home, prior);
  const ratesA = C.teamRates(sorted.slice(0, i), m.away, prior);
  const lam = C.estimateLambda({ home: ratesH.home, away: ratesA.away }, prior);
  const model = C.htftProbs(lam.home, lam.away);
  const e = eloBefore[keyOf(m)] || { home: 1500, away: 1500 };
  const c = { model, eloDiff: e.home - e.away };
  for (const id of btIds) {
    const expert = E.LIST.find((x) => x.id === id);
    const r = expert.pick(c);
    backtest[id].n++;
    if (r.key === m.htft) backtest[id].hits++;
    if (backtest[id].picks.length < 60) {
      backtest[id].picks.push({ date: m.date, num: m.num, league: m.league, home: m.home, away: m.away,
        key: r.key, label: C.LABELS[r.key], actual: m.htft, actualLabel: C.LABELS[m.htft], hit: r.key === m.htft });
    }
  }
}
const modalKey = Object.keys(htftDist).sort((a, b) => htftDist[b] - htftDist[a])[0];
const modalShare = htftDist[modalKey] / results.length;
const btSummary = Object.values(backtest).map((b) => {
  const hitRate = b.n ? b.hits / b.n : 0;
  return {
    id: b.id, name: b.name, n: b.n, hits: b.hits,
    hitRate: +hitRate.toFixed(4),
    randomBaseline: +(1 / 9).toFixed(4),
    modalBaseline: +modalShare.toFixed(4),
    modalKey,
    edge: +(hitRate - modalShare).toFixed(4),
    picks: b.picks.slice(-40)
  };
});

const out = {
  updatedAt: new Date().toISOString(),
  meta: {
    resultDays: Math.round((Date.now() - new Date(sorted[0] ? sorted[0].date : Date.now())) / 86400000),
    resultMatches: results.length,
    oddsSnapshots: snapshots.length,
    oddsMatches: seen.size,
    settledMatches: settled.length,
    upcomingMatches: upcoming.length,
    source: '中国体育彩票官方公开接口（sporttery.cn）'
  },
  experts,
  upcoming: upcoming.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
  settled: settled.sort((a, b) => (b.date + b.num).localeCompare(a.date + a.num)).slice(0, 300),
  stats: {
    htftDist,
    leagueTop,
    transitions
  },
  backtest: btSummary,
  baselines: { random: +(1 / 9).toFixed(4), modal: +modalShare.toFixed(4), modalKey, modalLabel: C.LABELS[modalKey] }
};

writeFileSync(resolve(DATA, 'app.json'), JSON.stringify(out), 'utf8');

console.log(`赛果 ${results.length} 场 · 赔率比赛 ${seen.size} 场 · 已结算 ${settled.length} 场 · 待赛 ${upcoming.length} 场`);
for (const e of experts) {
  console.log(`  ${e.name.padEnd(8)} 投注 ${String(e.n).padStart(3)} 命中 ${String(e.hits).padStart(3)} 命中率 ${(e.hitRate * 100).toFixed(1)}% 盈亏 ${e.profit >= 0 ? '+' : ''}${e.profit} ROI ${(e.roi * 100).toFixed(1)}%`);
}
console.log('写入 data/app.json');
