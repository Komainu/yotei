# 予定管理 (yotei) — 開発メモ

AIエージェント／開発者向けの全体像。変更前に必ず読むこと。利用者は日本語話者なので、画面の文言・コミット説明・PR本文は日本語で書く。

## 構成

| 部分 | 場所 | 役割 |
|---|---|---|
| アプリ本体 | `index.html` (1ファイル、HTML+CSS+JS) | GitHub Pages で公開 (https://komainu.github.io/yotei/)。データは端末の localStorage |
| サーバー | `gas/Code.gs` (Google Apps Script) | クラウド同期・Telegram Bot・毎朝の通知・ゲーム・記録。ウェブアプリとして公開 |
| 外部 | Telegram Bot API / Gmail(MailApp) / Gemini API(任意) / FRED・CoinGecko・Polymarket(表示のみ) | |

外部のビルド工程はない。ブラウザで `index.html` を開けば動く(`file://` でも動作する前提を壊さない)。

## 絶対に壊してはいけないもの (既存利用者のデータ)

- localStorage キー: `sakiyomi_v1` (state本体), `sakiyomi_backups` (自動バックアップ10世代)
- Script Properties のキー名 (下記)。名前を変える時は移行処理を必ず書く
- ウェブアプリの公開URL (デプロイID) は変えない。更新は main の `gas/` 変更で自動 (下記「サーバーの公開」)。手でやる時は「デプロイを管理 → 新バージョン」
- 空データでクラウドを上書きしない保護 (アプリ側とサーバー側の両方にある)

## アプリ (index.html) の要点

- `state = { projects:[], settings:{...}, deleted:{id:削除時刻}, updatedAt }`
- 案件: `{ id, name, chain(分野), deadline("YYYY-MM-DDTHH:MM" ローカル時刻), memo, sources:[{url,title}], pinned, status:"open"|"done", dropped?, doneAt?, createdAt, updatedAt }`
- `save()` は前回保存時との差分を見て、変わった案件だけ `updatedAt` を付け、消えた案件を `state.deleted` に記録する (`save({silent:true})` は設定変更用で印を付けない)
- 同期 (`gasSync`): クラウドを取得 → `mergeProjects()` で案件ごとに新しい方を採用 → 全件+削除記録を送信。サーバーでも同じ規則で合体する。同期は直列化 (`gasChain`)
- 版数: `APP_VERSION`, `MIN_GAS_VERSION` (サーバーが古いと警告)。変更したら日付で上げる
- 機能: HOME / よてい一覧 / Polymarket / BTCマクロ(FRED) / 設定 / 「🤖 AIに渡す」(用途別プロンプト・JSON/Markdown表の取り込み・📈振り返り分析) / 部屋の背景(手帳の線画SVG、家具・段ボール・日替わりイベント・季節) / ものがたり(完了数で進む全21話) / レベル・XP・連続記録の表示
- 秘密情報 (`key, tgToken, tgChat, gasUrl, gasKey, fredKey`) はエクスポートに含めない
- サーバーとの通信は必ず `gasGetUrl()` (GET) / `withGasKey()` (POST・フォーム送信) を通し、合言葉 `settings.gasKey` を付ける

## サーバー (gas/Code.gs) の要点

- 保存: 大きなデータは `saveBlob_/loadBlob_` を通す。保存先は Google ドライブ「予定管理データ」フォルダの `<KEY>.json` (Script Properties `STORE='drive'` の時)。移行前は Script Properties に8000文字ずつ分割 (合計500KB上限)
  - `ALL` 案件, `DELETED` 削除記録, `INBOX` Telegram変更の受信箱, `GAME` ゲーム状態, `HIST` 操作の記録
  - 移行 `migrateToDrive_()`: 書く→読み直して一致確認→`STORE='drive'`→古いチャンク削除。`setup()` と `pollTelegram` (30分に1回まで) から呼ぶ。失敗時は元データのまま
  - `loadBlob_` は1回の実行の中だけキャッシュする。ロックを取った直後は `blobCacheClear_()` を呼ぶこと。ドライブが読めない時は空ではなく例外にする (空データ扱いの上書き事故を防ぐ)
  - 週ごとのバックアップ `weeklyBackup` (日曜2時): 「予定管理バックアップ」に `yotei-backup-YYYY-MM-DD.json`、12個まで。秘密情報は入れない。詳細は `docs/storage.md`
  - その他: `TG_TOKEN, TG_CHAT(カンマ区切り), TG_PENDING, TG_OFFSET, TG_LASTLIST_<chat>, GEMINI_KEY, GEMINI_MODEL, MAIL_TO, SYNCED_AT, ALERT_LAST_RUN, ALERT_TRIES_<日付>, ALERT_LAST_OK, TG_LAST_SEND, NUDGE_LAST, HIST_SINCE, API_SECRET, STORE, STORE_AT, STORE_ERROR, STORE_TRIED, DATA_FOLDER_ID, FILE_<KEY>, BACKUP_FOLDER_ID, BACKUP_LAST`
- 合言葉 `API_SECRET`: 設定済みなら doGet は `key` パラメータ、doPost は JSON の `key` が一致しないと `{ok:false, needKey:true, version}` だけを返す (中身は返さない)。未設定なら今まで通り。`{action:"setSecret", newKey}` で設定 (未設定時は誰でも / 設定済みは今の key が必要)。Telegram・トリガーは doGet/doPost を通らないので影響なし。手順は `docs/secret.md`
- `doGet`: 状態 (`version, count, telegram, tgChats, game, inbox...`)。`?action=load` で案件+削除記録、`?action=history` で操作の記録
- `doPost` (text/plain JSON、フォーム送信 `payload=` も可):
  - `{action:"config", tgToken, tgChat, geminiKey, clear}` Chat IDは既存に追加、空値は変更しない
  - `{action:"inboxClear", before}`
  - 保存 `{all, deleted, base, syncedAt, email, force}` → 合体して `{projects, deleted, game}` を返す
- トリガー: `setup()` が作る。`sendDailyMail` 毎朝8時 (ピン留め&未完了をメール)、`pollTelegram` 1分おき (受信・ボタン処理・9時のクエスト・20時の連続記録お知らせ)、`weeklyBackup` 毎週日曜2時
- 日付はすべて日本時間 (`jstDays_`, `todayJst_`)
- Telegram: 自由文→Geminiで案件化 (キーが無ければ簡易登録)、`/alert /list /today /done N /pin N /help`、クエストのボタン `q:d|s|x:<id>`, `q:c`
- ゲーム: XP (期限内20/通常10/見送り2/確認2/全クリア+30)、レベル=累計25×(L-1)×L、連続記録、二重付与防止 `awarded`、`doneTotal` (ものがたり用)、`qhist`
- 記録 `HIST`: `{t,k,id,n,c,d,s}` k=add/done/drop/reopen/due/del/skip/check/pin、180日・1500件まで
- 版数: `GAS_VERSION`

## 作業のルール

- 1つのPRで1テーマ。既存機能の挙動を変える時はPR本文に明記
- 変更後はテストを通す (`npm test`)。テストが無い部分を触る時はテストも足す
- 画面の文言は丁寧語・やさしい日本語。専門用語は避ける
- 外部ライブラリは原則追加しない (追加する場合は cdnjs から、理由をPRに書く)
- 秘密情報 (トークン・APIキー・URL) をコード・テスト・ログに書かない

## テスト (`npm test`)

- Node 22 以上。`npm ci` → `npm test`。GitHub Actions (`.github/workflows/test.yml`) がプッシュ・PRのたびに実行する
- `test/helpers/gas.js`: `gas/Code.gs` を Node の vm で読み込み、PropertiesService などの偽物を差し込む (Telegramの送受信は `tg` に記録)
- `test/helpers/app.js`: `index.html` を jsdom で開く。通信は偽のGAS (上記) へ届く。`app.run("式")` でアプリ内の変数・関数を使える
- `test/helpers/clock.js`: 両方で共有する偽の時計 (日本時間)。テストでは実際の時刻を使わない

## サーバーの公開 (`.github/workflows/deploy-gas.yml`)

- main の `gas/` が変わると: テスト → `clasp push --force` → `clasp deploy -i <既存のデプロイID>` (新バージョン、URLは変わらない) → 公開中の `version` が `GAS_VERSION` と一致するか確認
- 設定: `gas/.clasp.json` (スクリプトID), `gas/appsscript.json` (Asia/Tokyo・V8・自分として実行・全員・`oauthScopes` を明示), `gas/.claspignore` (Code.gs と appsscript.json だけ送る)
- 権限は自動判定に頼らず `oauthScopes` に明示 (drive / script.external_request / script.send_mail / script.scriptapp)。新しいサービスを使う時は足すこと。`test/gas-scopes.test.js` が Code.gs のサービスと突き合わせる
- Secrets: `CLASPRC_JSON` (clasp login の認証情報), `GAS_DEPLOYMENT_ID`。手順は `docs/deploy.md`
- `setup()` (トリガー) は自動では実行されない。新しいGoogleサービスを使う時は画面での権限許可が必要
