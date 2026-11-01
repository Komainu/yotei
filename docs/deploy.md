# サーバー (Apps Script) の自動公開

`gas/Code.gs` を GitHub で変更して main に入れると、GitHub Actions が自動で Google Apps Script に反映し、
**今のウェブアプリのURLのまま**新しいバージョンを公開します。
これまでの「コードを全選択して貼り替え → デプロイを管理 → 新バージョン」という手作業は要らなくなります。

## しくみ

```
main の gas/ が変わる
  → ① テスト (npm test)
  → ② clasp push   … Code.gs と appsscript.json を Apps Script へ送る
  → ③ clasp deploy -i <今のデプロイID> … 新しいバージョンを作り、今のデプロイをそれに切り替える
  → ④ 公開中のウェブアプリに問い合わせて、版数 (GAS_VERSION) が新しくなったか確認
```

- 設定ファイルは `.github/workflows/deploy-gas.yml` です
- clasp は Google が作っている、Apps Script をコマンドで操作する道具です (バージョン 3.4.1 を使います)
- 案件データ (スクリプト プロパティ) とトリガーは変わりません。変わるのはコードだけです

---

## 最初に1回だけやること

全部で6つです。上から順番に進めてください。

### 1. Apps Script API をオンにする

1. https://script.google.com/home/usersettings を開く (Apps Script を使っている Google アカウントで)
2. 「Google Apps Script API」を **オン** にする

> オンにしてから使えるようになるまで、数分かかることがあります。

### 2. 今の Apps Script プロジェクトを確認する

1. https://script.google.com でいつものプロジェクトを開く
2. 左の「ファイル」に並んでいるのが **スクリプト1つだけ** (`コード.gs` や `Code.gs`) であることを確認する

> 自動公開では、GitHub の `gas/` にあるファイルでプロジェクトの中身を **まるごと置き換えます**。
> もし GitHub に無いファイルを Apps Script 側だけで作っていたら、それは消えます。
> 心配な時は、そのファイルの中身を先にメモ帳などへコピーしておいてください。

### 3. デプロイIDを調べる

デプロイIDは、今使っているウェブアプリの「住所」です。`AKfycb` で始まる長い文字列です。

**方法A: Apps Script の画面で調べる (おすすめ)**

1. Apps Script のプロジェクトを開く
2. 右上の「デプロイ」→「**デプロイを管理**」
3. 左の一覧で、種類が「ウェブアプリ」のデプロイを選ぶ (「テストデプロイ」ではない方)
4. 「デプロイID」の横の「コピー」を押す

**方法B: アプリの設定から読み取る**

アプリの設定に入れている「ウェブアプリURL」は、次の形になっています。

```
https://script.google.com/macros/s/ここがデプロイID/exec
```

`/s/` と `/exec` の間の部分がデプロイIDです。

> ⚠️ 必ず、**今アプリに設定しているURLのデプロイID** を使ってください。
> 別のデプロイIDを使うと、アプリがつながっている方は更新されません。

### 4. 認証情報 (.clasprc.json) を作る

GitHub が、あなたの代わりに Apps Script を操作するための「鍵」を作ります。自分のパソコンで行います。

1. **Node.js を入れる** (入っていなければ)
   https://nodejs.org/ja から「LTS」と書かれた方をダウンロードして、インストールします。

2. **ターミナルを開く**
   - Mac: 「アプリケーション」→「ユーティリティ」→「ターミナル」
   - Windows: スタートメニューで「PowerShell」と入力して開く

3. **次のコマンドを貼り付けて Enter**

   ```bash
   npx @google/clasp@3.4.1 login
   ```

   - 「Ok to proceed? (y)」と聞かれたら `y` を押して Enter
   - ブラウザが開くので、**Apps Script のプロジェクトを持っている Google アカウント** を選ぶ
   - 「clasp が Google アカウントへのアクセスを求めています」の画面で、全部にチェックを入れて「続行」/「許可」
   - ブラウザに「Logged in! You may close this page.」と出て、ターミナルに `You are logged in as ...` と出れば成功です

4. **(確認) 正しくログインできたか、デプロイの一覧を出してみる** — 手順3のデプロイIDの確認にもなります

   ```bash
   npx @google/clasp@3.4.1 list-deployments 1jIJtHu-JHx0MD9WPtekTtz0402mcDQz5GpOKndoicF3KVlmlZo9FPcAP
   ```

   `- AKfycb... @12 - 説明` のような行が出ます。`@HEAD` と書かれた行はテスト用なので使いません。

5. **作られたファイルの中身を表示する**
   - Mac:

     ```bash
     cat ~/.clasprc.json
     ```

   - Windows (PowerShell):

     ```powershell
     Get-Content $HOME\.clasprc.json
     ```

   `{` から始まり `}` で終わる文字が表示されます。**最初の `{` から最後の `}` まで全部** をコピーします。

> ⚠️ この中身はパスワードと同じです。人に見せたり、チャットやメールに貼ったり、GitHub のファイルに書いたりしないでください。
> 貼り付けてよいのは、次の手順の GitHub Secrets だけです。

### 5. GitHub Secrets に登録する

1. GitHub でこのリポジトリ (https://github.com/Komainu/yotei) を開く
2. 上の「**Settings**」→ 左の「**Secrets and variables**」→「**Actions**」
3. 「**New repository secret**」を押して、次の2つを登録する

| Name (名前) | Secret (中身) |
|---|---|
| `CLASPRC_JSON` | 手順4でコピーした `.clasprc.json` の中身 (全部) |
| `GAS_DEPLOYMENT_ID` | 手順3で調べたデプロイID (`AKfycb...`) |

名前は大文字・小文字も含めて、表のとおりに入れてください。

> 登録が終わったら、パソコンの `.clasprc.json` は消してもかまいません (GitHub に登録した鍵はそのまま使えます)。
> 消す時は `npx @google/clasp@3.4.1 logout` を実行します。

### 6. 試しに動かす

1. GitHub の「**Actions**」タブ → 左の「**deploy-gas**」
2. 右の「**Run workflow**」→ 「Run workflow」を押す
3. 1〜2分待って、緑のチェック ✅ になれば成功です
4. アプリの「設定」でサーバーの版数が表示されることを確認します

赤い ✕ になった時は、下の「うまくいかない時」を見てください。

---

## 普段の使い方

1. `gas/Code.gs` を変更したら、`GAS_VERSION` の日付も上げる (例: `'2026.11.05'`)
2. PR を作って main にマージする
3. 自動で公開されます。Actions タブの「deploy-gas」が ✅ になれば完了です

- 公開後の確認では、ウェブアプリが返す版数と `Code.gs` の `GAS_VERSION` を比べています
- `README` や `index.html` だけの変更では動きません (`gas/` の中が変わった時だけ動きます)
- 手で公開し直したい時は、手順6の「Run workflow」を使います

### 自動ではできないこと (手作業が必要な時)

- **トリガーを変えた時**: `setup()` の中身 (通知の時刻など) を変えたら、Apps Script の画面で関数「setup」を選んで ▶ 実行 してください
- **新しい Google のサービスを使い始めた時** (例: カレンダーやスプレッドシートを使う処理を足した): `gas/appsscript.json` の `oauthScopes` にその権限を足してください (足りないと「〜を呼び出す権限がありません」で止まります。`npm test` の `test/gas-scopes.test.js` が足りない時に知らせます)。公開後、Apps Script の画面で `setup` を ▶ 実行し、表示される権限の確認で「許可」してください

---

## うまくいかない時

Actions の赤い ✕ の行を開くと、エラーの文が見られます。

| エラーに出る文 | 原因と直し方 |
|---|---|
| `GitHub Secrets が未登録です` | 手順5の Secrets が無いか、名前が違います |
| `CLASPRC_JSON がJSONとして読めません` | コピーが途中で切れています。`{` から `}` まで全部を貼り直してください |
| `User has not enabled the Apps Script API` | 手順1をやり直してください。オンにした直後なら数分待ってから再実行します |
| `invalid_grant` / `No credentials found` / `Unauthorized` | 鍵の期限が切れたか、無効になっています。手順4・5をやり直して `CLASPRC_JSON` を上書きしてください (Google のパスワードを変えた時などに起きます) |
| `Requested entity was not found` / `not found` | デプロイIDが違います。手順3で確認し、`GAS_DEPLOYMENT_ID` を上書きしてください |
| `The caller does not have permission` | 手順4で、プロジェクトを持っていない Google アカウントでログインしています |
| `公開中のウェブアプリの版数が … になりませんでした` | 公開は終わっていますが、別のデプロイを更新した可能性があります。手順3の「⚠️」を確認してください |
| `maximum number of versions` / バージョンの上限 | Apps Script はバージョンを200個までしか持てません。Apps Script の画面の左「プロジェクトの履歴」(時計のマーク) から、古いバージョンを削除してください |

## 安全について

- サーバーに **合言葉** を設定しても、この自動公開 (公開後の版数の確認を含む) はそのまま動きます。合言葉の設定方法は [secret.md](secret.md) を見てください

- `CLASPRC_JSON` は、あなたの Google アカウントで Apps Script を操作できる鍵です。GitHub Secrets 以外には置かないでください
- このリポジトリの `.gitignore` には `.clasprc.json` を入れてあり、誤ってコミットしにくくしています
- 自動公開は **main への変更の時だけ** 動きます。PR (他の人の提案) からは動かないので、鍵が使われることはありません
- 鍵が漏れたかもしれない時は、https://myaccount.google.com/permissions を開き、「clasp」のアクセスを削除してください。そのあと手順4・5で新しい鍵を作り直します
