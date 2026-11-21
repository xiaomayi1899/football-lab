#!/usr/bin/env node
/**
 * 严格样本外验证（自我审判）
 *
 *   node scripts/validate.mjs [--limit=2000]
 *
 * 做法：
 *   1. 按时间顺序，每场只用「该场之前」的数据（战绩/交锋/ELO/半场率）
 *   2. 让每个专家给出半全场推荐，记录是否命中
 *   3. 计算命中率、Wilson 95% 置信区间
 *   4. 与前 50% / 后 50% 分段对比，检验稳定性
 *   5. 与「总是选最热项」的基线对比，给出超额和显著性
 *
 * 输出 data/validation.json，并打印结论。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const C = require(resolve(ROOT, 'assets/core.js'));
const E = require(resolve(ROOT, 'assets/experts.js'));

const args = process.argv.slice(2);
const arg = (n, d) => {
  const h = args.find((a) => a.startsWith('--' + n + '='));
  return h ? Number(h.split('=')[1]) : d;
};
const LIMIT = arg('limit', 2000);

const results = JSON.parse(readFileSync(resolve(ROOT, 'data/results.json'), 'utf8')).matches || [];
const sorted = results.slice().sort((a, b) => (a.date + a.num).localeCompare(b.date + b.num));

/* 增量 ELO */
const elo = {};
const eloBefore = {};
const K = 22;
for (const m of sorted) {
  if (!m.ft) continue;
  const h = elo[m.home] || 1500;
  const a = elo[m.away] || 1500;
  eloBefore[m.num + '|' + m.date] = { home: h, away: a };
  const exp = 1 / (1 + Math.pow(10, (a - h + 60) / 400));
  const score = m.ft[0] > m.ft[1] ? 1 : m.ft[0] < m.ft[1] ? 0 : 0.5;
  const delta = K * (score - exp);
  elo[m.home] = h + delta;
  elo[m.away] = a - delta;
}

const leagueRates = C.leagueRates(sorted);
const priorFor = (lg) => leagueRates[lg] || { home: 1.42, away: 1.12 };

const ids = ['poisson', 'form', 'h2h', 'home', 'defense', 'comeback', 'elo'];
const experts = ids.map((id) => E.LIST.find((x) => x.id === id));

const modalKey = Object.keys(
  sorted.reduce((acc, m) => { acc[m.htft] = (acc[m.htft] || 0) + 1; return acc; }, {})
).sort((a, b) =>
  sorted.filter((m) => m.htft === b).length - sorted.filter((m) => m.htft === a).length
)[0];

/* 只验证最近 LIMIT 场，保证每场都有足够历史 */
const start = Math.max(60, sorted.length - LIMIT);
const rows = [];
const t0 = Date.now();

for (let i = start; i < sorted.length; i++) {
  const m = sorted[i];
  if (!m.ft) continue;
  const hist = sorted.slice(0, i);
  const prior = priorFor(m.league);
  const formHome = C.teamForm(hist, m.home, m.date, 10);
  const formAway = C.teamForm(hist, m.away, m.date, 10);
  const h2h = C.h2h(hist, m.home, m.away, m.date);
  const restHome = C.restDays(hist, m.home, m.date);
  const restAway = C.restDays(hist, m.away, m.date);
  const halfHome = C.halfRates(hist, m.home, m.date, 15);
  const halfAway = C.halfRates(hist, m.away, m.date, 15);
  const ratesH = C.teamRates(hist, m.home, prior);
  const ratesA = C.teamRates(hist, m.away, prior);
  const baseLam = C.estimateLambda({ home: ratesH.home, away: ratesA.away }, prior);
  const lam = C.adjustLambda(baseLam, { formHome, formAway, h2h, restHome, restAway, rankDiff: null, leagueAvg: prior });
  const model = C.htftProbs(lam.home, lam.away);
  const e = eloBefore[m.num + '|' + m.date] || { home: 1500, away: 1500 };
  const ctx = {
    model, implied: model, odds: {}, lambda: lam,
    eloDiff: e.home - e.away, eloHome: e.home, eloAway: e.away,
    formHome, formAway, h2h, restHome, restAway, halfHome, halfAway, rankDiff: null
  };
  const picks = {};
  for (const ex of experts) picks[ex.id] = ex.pick(ctx).key;
  rows.push({ date: m.date, htft: m.htft, picks, lh: lam.home, la: lam.away });
  if (rows.length % 400 === 0) console.log(`  已处理 ${rows.length} 场…`);
}

const n = rows.length;
const half = Math.floor(n / 2);

function wilson(p, nn, z) {
  z = z || 1.96;
  const d = 1 + (z * z) / nn;
  const c = p + (z * z) / (2 * nn);
  const s = z * Math.sqrt((p * (1 - p)) / nn + (z * z) / (4 * nn * nn));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}
function hitRate(sub, id) {
  let h = 0;
  for (const r of sub) if (r.picks[id] === r.htft) h++;
  return sub.length ? h / sub.length : 0;
}
function modalRate(sub) {
  let h = 0;
  for (const r of sub) if (r.htft === modalKey) h++;
  return sub.length ? h / sub.length : 0;
}

/* ---------- Dixon-Coles rho 选参（用 Brier 分数） ---------- */
const RHOS = [0, -0.05, -0.1, -0.15, -0.2];
const brierByRho = {};
for (const rho of RHOS) {
  let sum = 0;
  for (const r of rows) {
    sum += C.brier(C.htftProbs(r.lh, r.la, 0.45, rho), r.htft);
  }
  brierByRho[rho] = +(sum / rows.length).toFixed(5);
}
const bestRho = RHOS.slice().sort((a, b) => brierByRho[a] - brierByRho[b])[0];
const uniformBrier = C.brier(
  C.HAFU.reduce((acc, k) => { acc[k] = 1 / C.HAFU.length; return acc; }, {}),
  rows[0].htft
);

const out = {
  generatedAt: new Date().toISOString(),
  n,
  window: { from: rows[0].date, to: rows[n - 1].date },
  modalKey,
  modalLabel: C.LABELS[modalKey],
  modalRate: +modalRate(rows).toFixed(4),
  elapsedMs: Date.now() - t0,
  brier: { byRho: brierByRho, bestRho, uniform: +uniformBrier.toFixed(5) },
  experts: []
};

console.log(`\n验证 ${n} 场（${rows[0].date} ~ ${rows[n - 1].date}），耗时 ${out.elapsedMs}ms`);
console.log(`固定基线：总是选「${C.LABELS[modalKey]}」= ${(out.modalRate * 100).toFixed(1)}%\n`);
console.log('Dixon-Coles rho 选参（多分类 Brier，越小越好）：');
for (const rho of RHOS) console.log(`  rho=${String(rho).padEnd(6)} Brier ${brierByRho[rho].toFixed(4)}${rho === bestRho ? '  ← 最优' : ''}`);
console.log(`  均匀分布基线 Brier ${uniformBrier.toFixed(4)}
`);
console.log('专家          命中率    95% CI            超额     前半段    后半段    结论');

for (const ex of experts) {
  const p = hitRate(rows, ex.id);
  const ci = wilson(p, n);
  const p1 = hitRate(rows.slice(0, half), ex.id);
  const p2 = hitRate(rows.slice(half), ex.id);
  const edge = p - out.modalRate;
  /* 两段同向且都超过基线才算稳定 */
  const stable = (p1 - modalRate(rows.slice(0, half))) > 0 && (p2 - modalRate(rows.slice(half))) > 0;
  const verdict = edge <= 0 ? '不如固定选热项'
    : !stable ? '仅单段领先，不稳定'
    : ci[0] > out.modalRate ? '显著优于基线'
    : '略高但不显著';
  out.experts.push({
    id: ex.id, name: ex.name,
    hitRate: +p.toFixed(4),
    ci95: [+ci[0].toFixed(4), +ci[1].toFixed(4)],
    edge: +edge.toFixed(4),
    firstHalf: +p1.toFixed(4),
    secondHalf: +p2.toFixed(4),
    stable, verdict
  });
  console.log(
    `${ex.name.padEnd(10)} ${(p * 100).toFixed(1).padStart(6)}%  ` +
    `[${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]`.padEnd(18) +
    `${(edge * 100 >= 0 ? '+' : '') + (edge * 100).toFixed(1)}pp`.padStart(8) +
    `  ${(p1 * 100).toFixed(1)}%   ${(p2 * 100).toFixed(1)}%   ${verdict}`
  );
}

writeFileSync(resolve(ROOT, 'data/validation.json'), JSON.stringify(out), 'utf8');
console.log('\n写入 data/validation.json');
