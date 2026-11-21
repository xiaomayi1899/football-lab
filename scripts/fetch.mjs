#!/usr/bin/env node
/**
 * 竞彩足球数据抓取
 *
 *   node scripts/fetch.mjs [--days=45]
 *
 * 数据源（中国体育彩票官方公开接口）：
 *   1. 赛果：/gateway/uniform/football/getUniformMatchResultV1.qry
 *      - sectionsNo1 = 半场比分，sectionsNo999 = 全场比分
 *      - matchResultStatus = "2" 表示已完赛
 *   2. 在售赔率：/gateway/uniform/football/getMatchCalculatorV1.qry
 *      - poolCode=hafu 返回半全场 9 项赔率（aa/ad/ah/da/dd/dh/ha/hd/hh）
 *
 * 输出：
 *   data/results.json   历史赛果（累积去重，按 matchNumStr）
 *   data/odds.json      在售赔率快照（每天一份，累积）
 *
 * 注意：官方不提供历史赔率，赔率只能从抓取当日起积累。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA = resolve(ROOT, 'data');
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const args = process.argv.slice(2);
const arg = (n, d) => {
  const h = args.find((a) => a.startsWith('--' + n + '='));
  return h ? Number(h.split('=')[1]) : d;
};
const DAYS = arg('days', 365);
const ODDS_ONLY = args.includes('--odds-only');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const BASE = 'https://webapi.sporttery.cn/gateway/uniform/football/';

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function get(path, params, retries = 3) {
  const url = BASE + path + '?' + new URLSearchParams(params);
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Origin: 'https://www.sporttery.cn',
          Referer: 'https://www.sporttery.cn/',
          'User-Agent': UA
        }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j.success !== true || String(j.errorCode) !== '0') {
        throw new Error('API ' + j.errorCode + ' ' + j.errorMessage);
      }
      return j.value;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

function scorePair(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.split(':');
  if (m.length !== 2) return null;
  const a = Number(m[0]), b = Number(m[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

function htftCode(ht, ft) {
  const r = (a, b) => (a > b ? 'h' : a < b ? 'a' : 'd');
  return r(ht[0], ht[1]) + r(ft[0], ft[1]);
}

/* ---------------- 赛果 ---------------- */
async function fetchResults() {
  const end = new Date();
  const startAll = new Date(Date.now() - DAYS * 86400000);
  const out = [];
  let cursor = new Date(startAll.getTime());
  let chunk = 0;
  while (cursor < end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + 30 * 86400000, end.getTime()));
    let page = 1, pages = 1;
    do {
      const v = await get('getUniformMatchResultV1.qry', {
        matchBeginDate: ymd(cursor),
        matchEndDate: ymd(chunkEnd),
        leagueId: '',
        pageSize: 100,
        pageNo: page,
        isFix: 0,
        matchPage: 1,
        pcOrWap: 1
      });
      const list = v.matchResult || [];
      for (const m of list) {
        if (String(m.matchResultStatus) !== '2') continue;
        const ht = scorePair(m.sectionsNo1);
        const ft = scorePair(m.sectionsNo999);
        if (!ht || !ft) continue;
        out.push({
          num: m.matchNumStr,
          date: m.matchDate,
          league: m.leagueNameAbbr || m.leagueName || '',
          home: m.homeTeam,
          away: m.awayTeam,
          ht,
          ft,
          htft: htftCode(ht, ft),
          result: ft[0] > ft[1] ? 'h' : ft[0] < ft[1] ? 'a' : 'd'
        });
      }
      pages = Number(v.pages) || 1;
      page++;
    } while (page <= pages && page <= 40);
    chunk++;
    if (chunk % 2 === 0) console.log(`  ${ymd(cursor)} ~ ${ymd(chunkEnd)}：累计 ${out.length} 场`);
    cursor = new Date(chunkEnd.getTime() + 86400000);
  }
  return out;
}

/* ---------------- 在售赔率 ---------------- */
const HAFU_KEYS = ['hh', 'hd', 'ha', 'dh', 'dd', 'da', 'ah', 'ad', 'aa'];

async function fetchOdds() {
  const v = await get('getMatchCalculatorV1.qry', { channel: 'c', poolCode: 'hafu,had,hhad,ttg' });
  const out = [];
  for (const day of v.matchInfoList || []) {
    for (const m of day.subMatchList || []) {
      const hafu = m.hafu || {};
      const odds = {};
      let any = false;
      for (const k of HAFU_KEYS) {
        const val = Number(hafu[k]);
        if (Number.isFinite(val) && val > 0) { odds[k] = val; any = true; }
      }
      if (!any) continue;
      out.push({
        num: m.matchNumStr,
        date: m.matchDate,
        time: m.matchTime,
        league: m.leagueAllName || m.leagueAbbName || '',
        leagueAbb: m.leagueAbbName || '',
        home: m.homeTeamAllName || m.homeTeamAbbName,
        away: m.awayTeamAllName || m.awayTeamAbbName,
        homeAbb: m.homeTeamAbbName || m.homeTeamAllName,
        awayAbb: m.awayTeamAbbName || m.awayTeamAllName,
        homeRank: m.homeRank || '',
        awayRank: m.awayRank || '',
        status: m.matchStatus || '',
        hafu: odds,
        had: m.had && m.had.h ? { h: Number(m.had.h), d: Number(m.had.d), a: Number(m.had.a) } : null,
        ttg: m.ttg || null
      });
    }
  }
  return out;
}

/* ---------------- 主流程 ---------------- */
const resultsFile = resolve(DATA, 'results.json');
const oddsFile = resolve(DATA, 'odds.json');

const existingResults = readJson(resultsFile, { updatedAt: null, matches: [] });
const resultMap = new Map(existingResults.matches.map((m) => [m.num + '|' + m.date, m]));

let allResults = [...resultMap.values()].sort((a, b) => (a.date + a.num).localeCompare(b.date + b.num));
if (!ODDS_ONLY) {
  console.log(`抓取最近 ${DAYS} 天赛果…`);
  const fresh = await fetchResults();
  for (const m of fresh) resultMap.set(m.num + '|' + m.date, m);
  allResults = [...resultMap.values()].sort((a, b) => (a.date + a.num).localeCompare(b.date + b.num));
  writeFileSync(resultsFile, JSON.stringify({ updatedAt: new Date().toISOString(), matches: allResults }), 'utf8');
  console.log(`赛果：本次 ${fresh.length} 场，累计 ${allResults.length} 场`);
}

console.log('抓取在售半全场赔率…');
const odds = await fetchOdds();
const existingOdds = readJson(oddsFile, { updatedAt: null, snapshots: [] });
const today = ymd(new Date());
existingOdds.snapshots = (existingOdds.snapshots || []).filter((s) => s.date !== today);
existingOdds.snapshots.push({ date: today, fetchedAt: new Date().toISOString(), matches: odds });
existingOdds.snapshots.sort((a, b) => a.date.localeCompare(b.date));
writeFileSync(oddsFile, JSON.stringify(existingOdds), 'utf8');
console.log(`赔率：今日 ${odds.length} 场在售，累计 ${existingOdds.snapshots.length} 个快照`);

const covered = allResults.filter((r) => {
  const snap = existingOdds.snapshots.find((s) => s.matches.some((m) => m.num === r.num && m.date === r.date));
  return !!snap;
});
console.log(`可结算（有赔率快照 + 有赛果）：${covered.length} 场`);

/* 半全场结果分布，作为抓取健康检查 */
const dist = {};
for (const r of allResults) dist[r.htft] = (dist[r.htft] || 0) + 1;
console.log('半全场结果分布：', Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
