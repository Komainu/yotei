'use strict';
/* ニュースの RSS / Atom と Gemini の偽物 */
const H = 3600000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = n => String(n).padStart(2, '0');
/** RFC 822 の日付 (offMin 分ずらした時間帯で書く。例: -300 = -0500) */
function rfc822(t, offMin) {
  offMin = offMin || 0;
  const d = new Date(t + offMin * 60000);
  const sign = offMin < 0 ? '-' : '+', a = Math.abs(offMin);
  return `${DOW[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${offMin ? sign + p2(Math.floor(a / 60)) + p2(a % 60) : 'GMT'}`;
}
const URLS = {
  frb: 'https://www.federalreserve.gov/feeds/press_all.xml',
  sec: 'https://www.sec.gov/news/pressreleases.rss',
  cftc: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml',
  coindesk: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  theblock: 'https://www.theblock.co/rss.xml',
  ctg: 'https://cointelegraph.com/rss',
  decrypt: 'https://decrypt.co/feed',
};
const rss = items => `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Feed</title><link>https://example.com/</link><description>channel</description>\n${items.join('\n')}\n</channel></rss>`;
const item = (title, link, date, desc) => `<item>\n  <title>${title}</title>\n${link == null ? '' : `  <link>${link}</link>\n`}  <description>${desc == null ? '' : desc}</description>\n  <pubDate>${date}</pubDate>\n  <guid isPermaLink="false">g-${encodeURIComponent(String(link))}</guid>\n</item>`;

/** 説明文の中身 (DESC_MARK_…) はドライブに残ってはいけない */
function feeds(base, world) {
  const iso = t => new Date(t).toISOString();
  const out = {
    frb: rss([
      item('Federal Reserve issues FOMC statement', '<![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20261114a.htm]]>', `<![CDATA[${rfc822(base - 2 * H)}]]>`, '<![CDATA[DESC_MARK_frb1 The Committee decided to maintain the target range.]]>'),
      item('Minutes of the Board&#39;s discount rate meetings', 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261010a.htm', rfc822(base - 80 * H), 'DESC_MARK_frb2 old'),
      item('Federal Reserve Board announces approval of application by Example Bank', 'https://www.federalreserve.gov/newsevents/pressreleases/orders20261114a.htm', rfc822(base - 5 * H), 'DESC_MARK_frb3 approval'),
    ]),
    sec: rss([
      item('  SEC Approves Options on Spot Ether ETFs &amp; Sets Rules\n', 'https://www.sec.gov/newsroom/press-releases/2026-120', rfc822(base - 3 * H, -300),
        '&lt;p&gt;DESC_MARK_sec1 The&amp;nbsp;Commission &lt;b&gt;approved&lt;/b&gt; the listing.&lt;/p&gt;'),
      item('Click me', 'javascript:alert(1)', rfc822(base - 3 * H), 'DESC_MARK_sec2'),
      item('No link here', null, rfc822(base - 3 * H), 'DESC_MARK_sec3'),
      item('', 'https://www.sec.gov/newsroom/press-releases/2026-121', rfc822(base - 3 * H), 'DESC_MARK_sec4 (題が無い)'),
    ]),
    cftc: rss([
      item('CFTC Sues Louisiana Over Prediction Markets', 'https://www.cftc.gov/PressRoom/PressReleases/9326-26', 'someday soon', null),
    ]),
    coindesk: rss([
      item('<![CDATA[Bitcoin slides below $68,000 as ETF outflows <em>grow</em>]]>', 'https://www.coindesk.com/markets/2026/11/14/bitcoin-slides', rfc822(base - 1 * H), '<![CDATA[<p>DESC_MARK_cd1 Analysts point to <a href="x">fund</a> redemptions.</p>]]>'),
      item('<![CDATA[Weekend recap: NFT sales flat]]>', 'https://www.coindesk.com/tech/2026/11/14/weekend-recap', rfc822(base - 10 * H), 'DESC_MARK_cd2'),
    ]),
    theblock: `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>The Block</title><link rel="self" href="https://www.theblock.co/rss.xml"/><updated>${iso(base)}</updated>
<entry><title type="html">Hyperliquid tops &#8220;open interest&#8221; rankings</title><link rel="enclosure" href="https://img.example.com/x.jpg"/><link rel="alternate" type="text/html" href="https://www.theblock.co/news/1-hyperliquid"/><id>tag:1</id><published>${iso(base - 4 * H)}</published><updated>${iso(base - 3 * H)}</updated><summary type="html">&lt;p&gt;DESC_MARK_tb1 Share reached 11.7%.&lt;/p&gt;</summary></entry>
<entry><title>Polymarket volume hits record</title><link href="https://www.theblock.co/news/2-polymarket"/><id>tag:2</id><updated>${iso(base - 20 * H)}</updated><content type="html">DESC_MARK_tb2 content</content></entry>
</feed>`,
    ctg: rss([
      item('Ethereum developers set date for upgrade', '<![CDATA[https://cointelegraph.com/news/eth-upgrade?utm_source=rss_feed&utm_medium=rss]]>', rfc822(base - 6 * H), 'DESC_MARK_ctg1'),
    ]),
    decrypt: rss([
      item('Strategy&#39;s Bitcoin Buying &#x2014; What&#8217;s Next', 'https://decrypt.co/383300/strategy-bitcoin', rfc822(base - 8 * H), 'DESC_MARK_dc1 Michael Saylor&#39;s firm…'),
    ].concat(Array.from({ length: world.many || 0 }, (_, i) => item('Filler story ' + (i + 1), 'https://decrypt.co/filler/' + (i + 1), rfc822(base - 9 * H - i * 60000), 'DESC_MARK_fill' + (i + 1))))
      .concat((world.extra || []).map(x => item(x.title, x.link, rfc822(x.t), x.desc || '')))),
  };
  const add = (world.fund ? FUND_ITEMS(base) : []).concat(world.add || []);
  for (const x of add) {
    if (x.k === 'theblock') out.theblock = out.theblock.replace('</feed>', `<entry><title>${x.title}</title><link href="${x.link}"/><id>tag:${x.link}</id><published>${iso(x.t)}</published><content type="html">${x.desc || ''}</content></entry>\n</feed>`);
    else out[x.k] = out[x.k].replace('\n</channel>', '\n' + item(x.title, x.link, rfc822(x.t), x.desc || '') + '\n</channel>');
  }
  return out;
}

/**
 * 資金調達の見出し (world.fund = true で足す)。Acme は2つのサイトが少し違う名前・金額で書く。Zeta は金額なしで Paradigm が主導。
 * ETF の流出 ($500M) は資金調達ではない
 */
const FUND_ITEMS = base => [
  { k: 'theblock', title: 'Acme Labs raises $25 million Series A led by Paradigm and a16z', link: 'https://www.theblock.co/news/10-acme', t: base - 2 * H, desc: 'DESC_MARK_f1 Acme builds lending markets.' },
  { k: 'coindesk', title: 'Acme Protocol secures $24M in Series A funding', link: 'https://www.coindesk.com/business/2026/11/14/acme', t: base - 3 * H, desc: 'DESC_MARK_f2 Coinbase Ventures also joined.' },
  { k: 'ctg', title: 'Zeta Network raises strategic funding from Paradigm', link: 'https://cointelegraph.com/news/zeta-network', t: base - 5 * H, desc: 'DESC_MARK_f3' },
  { k: 'decrypt', title: 'Bitcoin ETFs see $500M outflows as prices slide', link: 'https://decrypt.co/500m-outflows', t: base - 4 * H, desc: 'DESC_MARK_f4' },
  { k: 'decrypt', title: 'Beta Wallet raises $8M seed round', link: 'https://decrypt.co/beta-wallet', t: base - 6 * H, desc: 'DESC_MARK_f5' },
  { k: 'ctg', title: 'Lighter raises $68M Series B at $1.5B valuation', link: 'https://cointelegraph.com/news/lighter-68m', t: base - 7 * H, desc: 'DESC_MARK_f6' },
];
/** 偽の Gemini が返す fund (英語の題で決める。当てはまらなければ null) */
const FUNDS = [
  [/^Acme Labs raises/, { p: 'Acme Labs', amt: 25000000, r: 'Series A', inv: ['Paradigm', 'a16z'], oth: 3, val: null, sec: 'DeFi' }],
  [/^Acme Protocol secures/, { p: 'Acme Protocol', amt: 24000000, r: 'Series A', inv: ['Paradigm', 'Coinbase Ventures'], oth: null, val: 250000000, sec: 'DeFi', note: '貸し借りの市場' }],
  [/^Zeta Network raises/, { p: 'Zeta Network', amt: null, r: 'Strategic', inv: ['Paradigm'], oth: null, val: null, sec: 'インフラ' }],
  [/^Beta Wallet raises/, { p: 'Beta Wallet', amt: 8000000, r: 'Seed', inv: ['Small Capital'], oth: 2, val: null, sec: 'ウォレット' }],
  [/^Lighter (raises|closes)/, { p: 'Lighter', amt: 68000000, r: 'Series B', inv: ['Founders Fund', 'Ribbit Capital'], oth: null, val: 1500000000, sec: '取引所' }],
  [/^(Old Corp|Ancient) raises/, { p: 'Old Corp', amt: 100000000, r: 'Series C', inv: ['Paradigm'], oth: null, val: null, sec: 'AI' }],
];
function fundJudge(t) { const f = FUNDS.find(x => x[0].test(t)); return f ? JSON.parse(JSON.stringify(f[1])) : null; }

/**
 * world = { down: { frb: true, ... }, allDown: false, many: 0, extra: [{title, link, t}], base }
 * 戻り値: ニュースの URL なら応答、それ以外は null。fetch.world / fetch.calls (取得した URL と headers)
 */
function newsFetch(clock, world) {
  world = world || {};
  if (world.base == null) world.base = clock.now;
  const calls = [];
  const fetch = (url, params) => {
    const k = Object.keys(URLS).find(x => URLS[x] === url);
    if (!k) return null;
    calls.push({ url, headers: (params && params.headers) || {} });
    if (world.allDown || (world.down && world.down[k])) return { getResponseCode: () => 503, getContentText: () => 'Service Unavailable' };
    const body = feeds(world.base, world)[k];
    return { getResponseCode: () => 200, getContentText: () => body };
  };
  fetch.world = world;
  fetch.calls = calls;
  return fetch;
}

/** ニュースの判定の決まり (英語の題で決める) */
function newsJudge(t) {
  if (/FOMC/.test(t)) return [3, '金融政策'];
  if (/Hyperliquid/.test(t)) return [3, '暗号資産市場'];
  if (/ETF/.test(t)) return [2, 'ETF・機関投資家'];
  if (/Polymarket|Prediction/.test(t)) return [2, '規制'];
  if (/Bitcoin/.test(t)) return [2, '暗号資産市場'];
  return [0, 'その他'];
}
/**
 * Gemini の偽物 (ニュースの整理・和訳・市場の判定)。gem.calls = [{ kind, input }]、gem.down = true で 500
 * gem.fund = 題 → fund の関数で、資金調達の答えを差し替える (壊れた答えの確認用)
 */
function geminiFake() {
  const calls = [];
  const gem = (url, params) => {
    if (!/generativelanguage\.googleapis\.com/.test(url)) return null;
    const body = JSON.parse(params.payload), sys = body.system_instruction.parts[0].text, input = JSON.parse(body.contents[0].parts[0].text);
    const kind = /見出し/.test(sys) ? 'news' : /翻訳者/.test(sys) ? 'tr' : 'sc';
    calls.push({ kind, input });
    if (gem.down) return { getResponseCode: () => 500, getContentText: () => '{"error":{"message":"internal"}}' };
    const out = kind === 'news' ? input.map(x => {
      const [sc, cat] = newsJudge(x.t), fund = gem.fund ? gem.fund(x.t) : fundJudge(x.t);
      return { i: x.i, ja: '和:' + x.t, sum: '要約:' + x.t.slice(0, 24), sc, cat: fund ? '資金調達' : cat, fund: fund === undefined ? null : fund };
    })
      : kind === 'tr' ? input.map(x => ({ i: x.i, ja: '訳:' + x.t }))
      : input.map(x => ({ i: x.i, s: /Fed|Bitcoin|ETH|HYPE/.test(x.t) ? 3 : 0, c: 'その他' }));
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }) };
  };
  gem.calls = calls;
  return gem;
}

module.exports = { newsFetch, geminiFake, newsJudge, fundJudge, rfc822, NEWS_URLS: URLS, FUND_ITEMS };
