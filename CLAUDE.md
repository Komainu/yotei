# ポリマーケット記録 (旧: 予定管理 yotei) — 開発メモ

> 2026-11 方針転換: 予定管理は MUSE に移した。アプリは Polymarket の情報収集・記録・分析に作り変え中。
> - 2026-11-14: 予定管理のコード (案件・同期・Telegram・毎朝のメール・クエスト・ものがたり・部屋・繰り返し・週ごとのバックアップ) は **取り除いた**。残してあるのは旧データだけ (下の「旧データ」)
> - サーバーのトリガーは `setup()` で `pmRecord` (1時間ごと)・`pmResolve` (毎日5時)・`pmAlert` (10分おき)・`pmDigest` (毎朝8時) を登録する。以前のトリガー (`sendDailyMail` `pollTelegram` `checkDeadlines` `weeklyBackup`) が残っていたら止める
> - 計画: ①記録の土台 (済) → ②和訳＋興味プロフィール (済) → ③検索・急変・ウォッチ画面 (済) → ④メール (済) → ⑤分析 (答え合わせ・急変のその後)
>
> ### Polymarket の記録 (gas/Code.gs 末尾)
> - `pmRecord()`: Gamma API から24時間出来高の上位 `PM_TOP`(400) 件 + ウォッチ (`PM_WATCH`) を取得し、ドライブ「ポリマーケット記録」の `snap-YYYY-MM-DD.json` (日本時間) に1行足す。`catalog.json` に市場の情報 (q,s,e,et,g,o,end, f=初めて見た, l=最後に見た) を貯める
> - `pmResolve()`: 結果が未記録で、締切を過ぎたか上位から6時間以上外れた市場を `id=` でまとめて問い合わせ、決着していれば `r` (勝った選択肢 / "50-50"), `ra`, `rp` を台帳に書く
> - 状況は doGet の `pm` (`pmStatus_`、Script Properties の控え `PM_*` から作る)。アプリの設定「状況を確認」に表示
> - 売買は一切しない
>
> ### Polymarket の画面 (index.html 「Polymarket」の囲み)
> - Gamma `/markets` を出来高順に500件取得 → `pmCompact` で小さくして `pm_cache_v1` に保存 → `pmGroup` でイベントごとにまとめる (negRisk は確率順、しきい値の段階は `groupItemThreshold` 順)
> - 急変の帯: 1時間で2pt以上 → 24時間で5pt以上の順。スポーツ・eスポーツは除く。推移グラフ・チャートは CLOB `/prices-history`
> - 和訳・あなた向け: アプリ → GAS `pmAi` (Gemini。訳は tr.json、点数と分野は score.json に保存して使い回す)。ルールの要約は `pmRule` (rule.json)。設定は `pmConfig`、ウォッチは `pmWatch` (→ `PM_WATCH`)。`pm*` の操作は doPost の入口で予定データのロックを取らずに処理する
> - 通知メール (gas/Code.gs 末尾): `pmAlert` 10分おき (あなた向け=点数2以上とウォッチだけ。1時間10pt/24時間15pt/出来高3倍、ウォッチは1時間5pt。同じ市場は6時間に1回) と `pmDigest` 毎朝8時。送り先 `MAIL_TO`、オン/オフ `PM_ALERT_ON` `PM_DIGEST_ON`。本文はテキスト中心 (MUSE が読む)
> - マクロ (gas/Code.gs 末尾 `macroData_`): FRED (fredgraph.csv・キー不要)・Hyperliquid・DefiLlama・alternative.me をサーバーで取り、ドライブの macro.json に保存 (FRED 6時間・価格30分)。`doGet ?action=macro`。`pmRecord` の後に `macroRefresh` で温める。画面は index.html の `MC_DEFS` (テーマ・計算・信号)
> - **マクロの計算は index.html と gas/Code.gs に同じコードの囲み** (「マクロの計算」の囲み。指標の定義 `MC_DEFS`・天気図 `mcSummary`・カレンダー `MC_CAL`)。変える時は両方を同じに直す (テストで一致を確認)。毎朝のまとめメール (`pmDigest`) の先頭に天気図・昨日から変わった信号 (`PM_MC_SIG`)・7日以内の予定を入れる
> - 天気図 (`renderWeather`): 信号 🟢+1/🟡0/🔴−1 を `MC_WEIGHT` で重み付き平均。経済カレンダー (`MC_CAL`): FOMC・CPI・雇用統計の公式日程 (2027年末まで。**毎年、翌年分を federalreserve.gov と bls.gov から足す**)。関連する Polymarket の市場は public-search で日付と言葉が合うものを探す
> - AI に渡す記録 (gas/Code.gs 末尾): `pmResolve` の後の `pmDailyJobs_` が毎日 `daily-YYYY-MM.json` (市場ごと [始値,終値,高値,安値,24h出来高]) と `macro-log.json` (天気図の1行) を作る。`pmAlert` が `alerts.json` に急変を記録。`doGet ?action=report&days=&parts=macro,watch,alerts,resolve` が依頼文つき Markdown を返す。アプリは「🤖 記録をAIに渡す」シート (30,000文字を超えたらファイル保存をすすめる)
> - Kalshi 比較 (gas/Code.gs 末尾 `fedCompare_`): Kalshi の公開 API (KXFEDDECISION) と Polymarket の「Fed decision in ○月」を、箱 (hold/cut25/cut50/hike) にそろえて比べる。`pmRecord` の後に `fedCompareRecord_` が fed-compare.json に記録し、買値・売値の幅を考えて5pt以上ずれたら通知。`doGet ?action=compare`
> - Hyperliquid の建玉 (`hlRecord_`): 1時間ごとに hl-YYYY-MM.json (キーは日本時間 'YYYY-MM-DDTHH:00')。24時間で建玉 ±20%・ファンディングの極端で通知。マクロの `D.hl` (doGet macro に直近8日分) から「建玉」カード
> - Hyperliquid タブ (index.html「Hyperliquid」の囲み): `doGet ?action=hl` (サーバーの `hlSnapshot_`: 先物全部・`predictedFundings` で Binance/Bybit のファンディングを8時間に直したもの・現物の流通量/総発行量) と記録 (`hlSeries_`)。記録の配列は [建玉, ファンディング(1h), 価格, 出来高, プレミアム, Binance8h, Bybit8h]。☆ で `pmHlWatch` → `HL_WATCH` (BTC/ETH/SOL/HYPE はいつも記録)。現物は hl-spot-YYYY-MM.json に日ごと
> - お金の流れタブ (DefiLlama): サーバーの `llamaData_` が /v2/chains・historicalChainTvl・stablecoinchains・stablecoincharts・overview/open-interest を取り llama-latest.json に6時間保存 (`doGet ?action=llama`)。`pmDailyJobs_` の `llamaLog_` が llama-YYYY-MM.json に日ごと。先物 DEX の出来高 (overview/derivatives) は有料なので使わない。先物 DEX は `llamaPerps_`: 建玉の内訳の推移 (シェア・NEW 判定)・overview/fees の手数料・/protocols (1日1回 llama-protocols.json) のトークンの有無と TVL。`llamaIsCand_` = トークン未発行のエアドロップ候補。詳細の手数料の推移は `doGet ?action=llamaFees&slug=`
> - オプション市場タブ (Deribit の公開 API・キー不要): サーバーの `optData_` (`optOne_`/`optExpiry_`/`optRead_`) が BTC・ETH の建玉・プット/コール比率・スキュー (10%下のプット IV − 10%上のコール IV、30日に近い満期)・マックスペイン・DVOL (12時間足90日) を計算し opt-latest.json に55分保存 (`doGet ?action=opt`、日ごとの記録 `hist` つき)。`pmRecord` の後に `hbRun_('opt', optRecord_)` が opt-YYYY-MM.json に日ごとの行 [価格, DVOL, P/C(建玉), P/C(出来高), 建玉, 出来高, スキュー, マックスペイン, その満期] を残し、DVOL が24時間で `NTF_SPEC.dvol` 以上動いたら通知 (`opt` でオン/オフ、12時間に1回)。毎朝のまとめは `pmOptSection_` (`dOpt`)、AI レポートは `optReportLines_` (parts `opt`, ## 8.)。見張りの `HEALTH_JOBS` に `opt`。画面は index.html「オプション市場 (Deribit)」の囲み (`OP` `loadOpt` `renderOpt` `renderOptCharts` `renderOptExps` `renderOptStrikes`、端末の保存 `op_cache_v1`)。テストの偽 Deribit は `test/helpers/deribit.js` (`deribitFetch(clock, world)`)
> - ニュースと公式発表 (gas/Code.gs「ニュースと公式発表 (RSS)」の囲み): `NEWS_FEEDS` (k, n, url, off=公式) = FRB・SEC・CFTC (公式) と CoinDesk・The Block・Cointelegraph・Decrypt。`pmRecord` の後に `hbRun_('news', newsRecord_)` が全部のフィードを別々に取り (`macroFetchText_`、User-Agent `market-notes/1.0` を付ける。SEC が名乗りを求めるため)、`newsParse_` (正規表現で RSS/Atom・CDATA・文字参照。http(s) 以外のリンクは捨てる) で72時間以内を取り込む。全部失敗した時だけ投げる。ドライブに `news-YYYY-MM.json` ({id: {t, s, ti, l, ja, sum, sc, cat, m=通知済み}}、月は記事の日本時間) と `news-latest.json` ({at, items 新しい順・7日・300件, errors: 取れなかったフィードの名前})。**記事の説明文・本文は保存しない** (AI に渡すだけ)。AI は `GEMINI_KEY` がある時だけ、未訳を新しい順に1回30件・15件ずつ `pmGemini_` (1日の上限 `PM_AI_DAY` に数える) で `ja` `sum` `sc` (0〜3、`pmProfile_()` に照らす) `cat` (`NEWS_CATS`)。通知は今回判定した `sc >= NTF_SPEC.newsMin` を1通 (8件まで・1件1回)。`newsList_(hours)`・`doGet ?action=news&days=` (既定3・最大7)。毎朝のまとめは `pmNewsSection_` (`dNews`、Polymarket の後)、急変メールに `newsAlertBlock_` (直近6時間・5件)、AI レポートは `newsReportLines_` (parts `news`, ## 9.)。見張りの `HEALTH_JOBS` に `news`。画面は index.html「ニュースと公式発表」の囲み (`NW` `loadNews` `renderNews` `nwRelatedHtml`=Polymarket の詳細の「関連しそうなニュース」、端末の保存 `nw_cache_v1`、絞り込みは `pm_ui_v1.nw`)。テストの偽 RSS と偽 Gemini は `test/helpers/news.js` (`newsFetch(clock, world)` `geminiFake()`)
> - ホーム (`tab-top`・`renderTop`): 各タブのデータ (`MC.res` `pm` `CMP` `HL` `FL`) から要点を集める。各タブの描画関数を包んで、描画のたびにホームも描き直す。旧・予定管理の `renderHome` (`tab-home`) とは別物なので名前を混ぜない
> - 記録の見張り (gas/Code.gs 末尾): 各ジョブが `hbOk_`/`hbErr_`/`hbRun_` で `HB_<名前>`・`HBE_<名前>` に控える。`pmHealth_` が `HEALTH_JOBS` の間隔と比べて ok/stale/error/never/off を返す (`doGet ?action=health`、状況の `pm.health`)。`pmHealthMail_` (pmRecord の最後) が、間隔を過ぎても直らない時だけ24時間に1回メール。**新しい定期処理を足したら HEALTH_JOBS にも足す**
> - 通知の条件 (gas/Code.gs 末尾 `NTF_SPEC`・`ntf_()`): 初期値と範囲を1か所で持ち、変更分だけ `PM_NOTIFY` に保存。`pmConfig` の `notify` (オブジェクト or 'reset') で変える。単位は画面と同じ (pt・%・倍・ドル・時間)。アプリは設定の「通知の条件を変える」(`data-ntf`)。**通知の基準を足す時は NTF_SPEC と画面の入力欄の両方に足す**
> - タブどうしのつながり (index.html「タブどうしをつなげる」): `relProject(e)` で市場のプロジェクト名を取り、`relFind(name)`/`relBadge` でチェーン・先物 DEX・現物に「予測市場あり」の印。Polymarket の詳細の `#pmSRelated` (`pmRelatedHtml`) に Hyperliquid の銘柄 (`REL_COINS`)・マクロの指標 (`REL_MACRO`)・チェーン/先物 DEX/現物 FDV を出す。移動は `data-relgo` (タブ)・`data-relopen` (市場)
> - 用語集: index.html の `GLOSS` (n 名前 / a 別名=自動リンクする言葉 / s ひとことで / w なぜ大事か / u・d 上がると・下がると / r 関連)。`linkTerms()` で本文に下線リンク、`termBtn()` で ? ボタン。用語を足す時は GLOSS に1つ足すだけ (テストで関連先と別名の重複を確認)
> - 端末の保存: `pm_tr_v1` `pm_sc_v1` `pm_watch_v1` `pm_hide_v1` (予定の `sakiyomi_v1` とは別)

AIエージェント／開発者向けの全体像。変更前に必ず読むこと。利用者は日本語話者なので、画面の文言・コミット説明・PR本文は日本語で書く。

## 構成

| 部分 | 場所 | 役割 |
|---|---|---|
| アプリ本体 | `index.html` (1ファイル、HTML+CSS+JS) | GitHub Pages で公開 (https://komainu.github.io/yotei/)。表示用のキャッシュと設定は端末の localStorage |
| サーバー | `gas/Code.gs` (Google Apps Script) | 記録 (Polymarket・マクロ・Hyperliquid・DefiLlama)・和訳・通知メール。ウェブアプリとして公開 |
| 外部 | Gmail(MailApp) / Gemini API / Polymarket・Kalshi・FRED・Hyperliquid・DefiLlama・Deribit・alternative.me・ニュースの RSS (FRB・SEC・CFTC・CoinDesk・The Block・Cointelegraph・Decrypt) | |

外部のビルド工程はない。ブラウザで `index.html` を開けば動く(`file://` でも動作する前提を壊さない)。

## 絶対に壊してはいけないもの

- localStorage キー `sakiyomi_v1`: 設定 (`settings.gasUrl, gasKey, theme, gasVersion, gasError`) の置き場所。**以前の予定データ (`projects`, `deleted`) が同じキーに残っている端末があるので、読み込んだ中身はそのまま持ち続けて保存し直す** (`load()` は `Object.assign` で全部受け取る。消してはいけない)
- 旧データ: ドライブ「予定管理データ」フォルダの `ALL.json` (案件) / `DELETED.json` (削除記録) と、Script Properties の `STORE` `FILE_ALL` `FILE_DELETED`。サーバーは **読むだけ** (`legacyData_()` → `?action=load`)。書き換え・削除はしない
- Script Properties のキー名。名前を変える時は移行処理を必ず書く
- ウェブアプリの公開URL (デプロイID) は変えない。更新は main の `gas/` 変更で自動 (下記「サーバーの公開」)

## アプリ (index.html) の要点

- `state = { settings:{...} }` (+ 旧データが残っていれば `projects`, `deleted` など。触らない)。`save()` は state をそのまま localStorage へ書く
- `load()` は使わなくなった設定 (`OLD_SETTINGS`: Telegram のトークン・Gemini のキーなど) を端末から消す
- タブ: `top` (ホーム)・`news` (ニュース)・`poly`・`btc` (マクロ)・`hl`・`opt` (オプション)・`flow`・`gloss`・`settings`。`switchTab()` が初回だけ各タブの読み込みを呼ぶ
- 設定の「旧データ (予定) をエクスポート」(`oldDataFetch`): サーバーの `?action=load` と端末の `state.projects` のうち件数の多い方を JSON で書き出す。設定・合言葉は入れない
- 起動時・画面に戻った時は `gasAutoResume()` → `gasCheck()` でサーバーの版数と合言葉を確かめるだけ (何も書き込まない)
- 版数: `APP_VERSION`, `MIN_GAS_VERSION` (サーバーが古いと警告)。変更したら日付で上げる。**`sw.js` の `VERSION` も必ず同じにする** (ホーム画面アプリは index.html をキャッシュから開くので、上げ忘れると新しい版が届かない。テストで確認している)
- PWA: `manifest.webmanifest`・`sw.js`・`icons/` (アイコンは `python3 icons/make-icons.py` で作り直せる)
- サーバーとの通信は必ず `gasGetUrl()` (GET) / `withGasKey()` (POST) を通し、合言葉 `settings.gasKey` を付ける

## サーバー (gas/Code.gs) の要点

- 先頭: 合言葉 → ドライブの共通処理 (`driveRetry_` `driveFolder_`) と旧データの読み出し → `doPost` / `doGet` → `setup` → 以降は機能ごとの節 (Polymarket の記録、和訳、通知、マクロ…)
- 合言葉 `API_SECRET`: 設定済みなら doGet は `key` パラメータ、doPost は JSON の `key` が一致しないと `{ok:false, needKey:true, version}` だけを返す (中身は返さない)。未設定なら誰でも使える。`{action:"setSecret", newKey}` で設定・変更 (12〜200文字)
- `doGet`: 既定は状況 (`version, locked, pm{..., ai, health, mail}`)。`?action=load` (旧データ) `report` `macro` `hl` `opt` `llama` `llamaFees` `health` `compare` `news`
- `doPost` (text/plain JSON、フォーム送信 `payload=` も可): `pm*` の操作 (`pmDoPost_`) と `setSecret` だけ。それ以外 (以前の案件の保存など) は `{ok:false, error:"予定管理の機能は終了しました…"}` を返す
- Script Properties: `API_SECRET, GEMINI_KEY, MAIL_TO, PM_*, HB_*/HBE_* (見張り), DATA_FOLDER_ID 系のフォルダID` など。以前の `TG_*` `GAME` などは残っていても使わない
- 日付はすべて日本時間 (`todayJst_`)
- 毎朝のまとめ (`pmDigest`): 天気図・予定 (`pmMacroSection_`) → Polymarket → ニュースと公式発表 (`pmNewsSection_`、`NTF_SPEC.dNews`) → マクロ指標の一覧 (`pmMacroList_`、`NTF_SPEC.dMacro`) → オプション市場 (`pmOptSection_`、`NTF_SPEC.dOpt`) → お金の流れ (`pmFlowSection_`、`NTF_SPEC.dFlow`) → 記録の状況。欄を足す時は `NTF_SPEC` と設定画面の `data-ntf` にオン/オフを足す
- 版数: `GAS_VERSION`

## 作業のルール

- 1つのPRで1テーマ。既存機能の挙動を変える時はPR本文に明記
- 変更後はテストを通す (`npm test`)。テストが無い部分を触る時はテストも足す
- 画面の文言は丁寧語・やさしい日本語。専門用語は避ける
- 外部ライブラリは原則追加しない (追加する場合は cdnjs から、理由をPRに書く)
- 秘密情報 (トークン・APIキー・URL) をコード・テスト・ログに書かない

## テスト (`npm test`)

- Node 22 以上。`npm ci` → `npm test`。GitHub Actions (`.github/workflows/test.yml`) がプッシュ・PRのたびに実行する
- `test/helpers/gas.js`: `gas/Code.gs` を Node の vm で読み込み、PropertiesService などの偽物を差し込む。`gas.setLegacy(list, tombs)` で旧データがドライブにある状態を作れる
- `test/helpers/app.js`: `index.html` を jsdom で開く。通信は偽のGAS (上記) へ届く。`app.run("式")` でアプリ内の変数・関数を使える
- `test/helpers/clock.js`: 両方で共有する偽の時計 (日本時間)。テストでは実際の時刻を使わない

## サーバーの公開 (`.github/workflows/deploy-gas.yml`)

- main の `gas/` が変わると: テスト → `clasp push --force` → `clasp deploy -i <既存のデプロイID>` (新バージョン、URLは変わらない) → 公開中の `version` が `GAS_VERSION` と一致するか確認
- GitHub の画面からのアップロードではファイルを消せないので、使わなくなったテスト (`gas-game` `gas-history` `gas-sync` `repeat` `room`) は中身を空にしてある。消してよい
- 設定: `gas/.clasp.json` (スクリプトID), `gas/appsscript.json` (Asia/Tokyo・V8・自分として実行・全員・`oauthScopes` を明示), `gas/.claspignore` (Code.gs と appsscript.json だけ送る)
- 権限は自動判定に頼らず `oauthScopes` に明示 (drive / script.external_request / script.send_mail / script.scriptapp)。新しいサービスを使う時は足すこと。`test/gas-scopes.test.js` が Code.gs のサービスと突き合わせる
- Secrets: `CLASPRC_JSON` (clasp login の認証情報), `GAS_DEPLOYMENT_ID`。手順は `docs/deploy.md`
- `setup()` (トリガー) は自動では実行されない。新しいGoogleサービスを使う時は画面での権限許可が必要
