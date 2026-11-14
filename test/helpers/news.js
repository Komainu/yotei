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
  return out;
}

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
 */
function geminiFake() {
  const calls = [];
  const gem = (url, params) => {
    if (!/generativelanguage\.googleapis\.com/.test(url)) return null;
    const body = JSON.parse(params.payload), sys = body.system_instruction.parts[0].text, input = JSON.parse(body.contents[0].parts[0].text);
    const kind = /見出し/.test(sys) ? 'news' : /翻訳者/.test(sys) ? 'tr' : 'sc';
    calls.push({ kind, input });
    if (gem.down) return { getResponseCode: () => 500, getContentText: () => '{"error":{"message":"internal"}}' };
    const out = kind === 'news' ? input.map(x => { const [sc, cat] = newsJudge(x.t); return { i: x.i, ja: '和:' + x.t, sum: '要約:' + x.t.slice(0, 24), sc, cat }; })
      : kind === 'tr' ? input.map(x => ({ i: x.i, ja: '訳:' + x.t }))
      : input.map(x => ({ i: x.i, s: /Fed|Bitcoin|ETH|HYPE/.test(x.t) ? 3 : 0, c: 'その他' }));
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }) };
  };
  gem.calls = calls;
  return gem;
}

module.exports = { newsFetch, geminiFake, newsJudge, rfc822, NEWS_URLS: URLS };
