#!/usr/bin/env node
/**
 * 抓取 500.com 的真实赛前数据（伤停 / 阵容 / 必发投注）
 *
 *   node scripts/fetch-500.mjs [--limit=60]
 *
 * 数据来源：odds.500.com（国内公开页面）
 *   - /fenxi/shuju-<fid>.shtml   伤病、停赛、首发阵容
 *   - /fenxi/touzhu-<fid>.shtml  必发成交量、交易比例、庄家盈亏、冷热指数
 *
 * 匹配方式：500.com 页面直接带竞彩编号（如「周六005」），与官方 matchNumStr 一致。
 *
 * 注意：
 *   1. 伤停与首发通常赛前 1 天才公布，提前抓会是空表——这是数据本身的时序。
 *   2. 页面为 GBK 编码。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA = resolve(ROOT, 'data');

const args = process.argv.slice(2);
const arg = (n, d) => {
  const h = args.find((a) => a.startsWith('--' + n + '='));
  return h ? Number(h.split('=')[1]) : d;
};
const LIMIT = arg('limit', 60);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://live.500.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

async function getText(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
}

const strip = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------------- 赛程列表 ---------------- */
async function fetchSchedule() {
  const html = await getText('https://live.500.com/');
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  const out = [];
  for (const r of rows) {
    const row = r[1];
    const m = row.match(/fenxi\/shuju-(\d+)\.shtml/);
    if (!m) continue;
    const txt = strip(row);
    /* 例如：周六005 英超 第11轮 11-21 20:30 [03] 曼城 (-1) ... 富勒姆 [15] */
    const head = txt.match(/^([周周][一二三四五六日]\d{3})\s+(\S+)\s+([\s\S]*?)\s+(\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (!head) continue;
    /* 主客队：去掉盘口与排名片段 */
    const rest = head[3] || '';
    const teams = rest.match(/\[[\d-]+\]\s*([^\[]+?)\s*\([+-]?\d*\)?[\s\S]*?([^\s\[\]]+)\s*\[[\d-]+\]/);
    const YEAR = new Date().getFullYear();
    const mm = Number(head[4].slice(0, 2));
    const year = mm < 6 ? YEAR + 1 : YEAR;
    out.push({
      fid: m[1],
      num: head[1],
      league: head[2],
      date: year + '-' + head[4],
      time: head[5],
      raw: txt.slice(0, 140),
      home: teams ? teams[1].trim() : '',
      away: teams ? teams[2].trim() : ''
    });
  }
  return out;
}

/* ---------------- 伤停 / 阵容 ---------------- */
function parseShuju(html) {
  const out = { injuries: { home: [], away: [] }, lineups: { home: [], away: [] }, hasLineup: false };
  /* 伤停表格：<th>伤病</th><th>停赛</th> 之后两列 */
  const blocks = [...html.matchAll(/<th>伤病<\/th>\s*<th>停赛<\/th>([\s\S]{0,1200}?)<\/table>/g)];
  blocks.forEach((b, idx) => {
    const side = idx === 0 ? 'home' : 'away';
    const cells = [...b[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => strip(c[1]));
    /* 前半是伤病，后半是停赛；空单元格跳过 */
    const mid = Math.floor(cells.length / 2) || 1;
    const joined = cells.filter(Boolean);
    out.injuries[side] = joined;
  });
  /* 首发：shuju-lineup-name */
  const names = [...html.matchAll(/class="shuju-lineup-name"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  if (names.length >= 10) {
    out.hasLineup = true;
    out.lineups.home = names.slice(0, 11);
    out.lineups.away = names.slice(11, 22);
  }
  return out;
}

/* ---------------- 必发投注 ---------------- */
function parseTouzhu(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => strip(r[1]));
  const pat = /^(.+?)\s+([\d.]+)\s+([\d.]+)%\s+-\s+([\d.]+)%\s+([\d.]+)\s+([\d,]+)\s+(-?[\d,]+)\s+-\s+(-?\d+)\s+(-?\d+)$/;
  const picks = [];
  for (const t of rows) {
    const m = t.match(pat);
    if (!m) continue;
    picks.push({
      name: m[1],
      price: +m[2],
      share: +m[3] / 100,
      euroProb: +m[4] / 100,
      bfPrice: +m[5],
      volume: Number(m[6].replace(/,/g, '')),
      pnl: Number(m[7].replace(/,/g, '')),
      bfIndex: +m[8],
      hot: +m[9]
    });
    if (picks.length === 3) break;
  }
  const plain = strip(html);
  const tipMatch = plain.match(/本场比赛必发成交量倾向于([^。]{0,80})/);
  let tip = tipMatch ? strip(tipMatch[1]) : '';
  tip = tip.split('暂无')[0].split('必发交易')[0].trim().slice(0, 70);
  return {
    bifa: picks.length === 3 ? { home: picks[0], draw: picks[1], away: picks[2] } : null,
    tip
  };
}

/* ---------------- 主流程 ---------------- */
const results = JSON.parse(readFileSync(resolve(DATA, 'results.json'), 'utf8')).matches || [];
const dateSet = new Set(results.map((m) => m.date));

console.log('抓取 500.com 赛程…');
const schedule = await fetchSchedule();
const today = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const valid = schedule.filter((m) => dateSet.has(ymd(today)) || true).slice(0, LIMIT);
console.log(`赛程 ${schedule.length} 场，处理 ${valid.length} 场`);

const out = { updatedAt: new Date().toISOString(), matches: {} };
let done = 0;
for (const m of valid) {
  try {
    const shuju = await getText(`https://odds.500.com/fenxi/shuju-${m.fid}.shtml`);
    const touzhu = await getText(`https://odds.500.com/fenxi/touzhu-${m.fid}.shtml`);
    const s = parseShuju(shuju);
    const t = parseTouzhu(touzhu);
    const homeName = t.bifa ? t.bifa.home.name : m.home;
    const awayName = t.bifa ? t.bifa.away.name : m.away;
    out.matches[m.num + '|' + m.date] = {
      fid: m.fid, num: m.num, date: m.date, league: m.league,
      home: homeName, away: awayName,
      injuries: s.injuries,
      hasLineup: s.hasLineup,
      bifa: t.bifa,
      tip: t.tip
    };
    done++;
    if (done % 5 === 0) console.log(`  已处理 ${done}/${valid.length}…`);
  } catch (e) {
    console.log('  跳过', m.fid, e.message);
  }
  await new Promise((r) => setTimeout(r, 150));
}

writeFileSync(resolve(DATA, 'detail-500.json'), JSON.stringify(out), 'utf8');
const withBifa = Object.values(out.matches).filter((m) => m.bifa).length;
const withInjury = Object.values(out.matches).filter((m) => m.injuries.home.length || m.injuries.away.length).length;
const withLineup = Object.values(out.matches).filter((m) => m.hasLineup).length;
console.log(`\n写入 data/detail-500.json`);
console.log(`  场次 ${Object.keys(out.matches).length}`);
console.log(`  有必发投注数据 ${withBifa}`);
console.log(`  有伤停/停赛 ${withInjury}`);
console.log(`  有首发阵容 ${withLineup}`);
