# 借り人競争 早押し（Supabase版）

Claudeのアーティファクトとして作った早押しゲームを、ログインなしで誰でも使えるように移植したものです。
データの保存と同期はSupabaseが担当し、ページはGitHub Pagesで公開します。

| ファイル | 内容 |
|---|---|
| `index.html` | ゲーム本体（このファイル1つで動きます） |
| `setup.sql` | Supabaseに1回だけ流すSQL |

画面はURLの末尾で切り替わります。
- 参加者：`…/#team`
- 司会：`…/#host`（パスコードで保護）
- スクリーン投影：`…/#score`

---

## 1. Supabaseの準備（約5分）

1. Supabaseで **New project** を作成します。**Region は Northeast Asia (Tokyo)** を選んでください。
2. 左メニュー **SQL Editor** を開き、`setup.sql` の中身をすべて貼り付けて **Run** します。
   - 「Success. No rows returned」と出ればOKです。何度実行しても問題ありません。
3. **Project Settings → API**（または **Connect**）を開き、次の2つをコピーします。
   - Project URL（`https://xxxx.supabase.co`）
   - anon key（新しいプロジェクトでは `sb_publishable_...` という名前の publishable key）
   - ※ `service_role` / `secret` キーは**絶対に使わないでください**。

## 2. index.htmlに設定を書く

`index.html` の中で `HAYAOSHI_CONFIG` を検索し、2行を書き換えます。

```js
window.HAYAOSHI_CONFIG = {
  SUPABASE_URL: 'https://xxxx.supabase.co',
  SUPABASE_KEY: 'sb_publishable_xxxx',   // または eyJ... の anon key
};
```

### 手元で動作確認

```bash
cd 101-halloween-game
python3 -m http.server 8000
# → http://localhost:8000/#host と http://localhost:8000/#team を別タブで開く
```

上部に「サーバーにつながっていません」が出なければ、接続できています。

## 3. GitHub Pagesで公開

```bash
git init && git add index.html setup.sql README.md
git commit -m "借り人競争 早押し Supabase版"
git branch -M main
git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git
git push -u origin main
```

1. GitHubでリポジトリの **Settings → Pages** を開きます。
2. **Source: Deploy from a branch**、**Branch: main / (root)** を選んで **Save** します。
3. 1〜2分待つと `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます。

---

## 当日のチェックリスト

- [ ] **前日〜当日朝に一度サイトを開く**（Supabaseの無料プランは、1週間使わないと止まります）
- [ ] 司会画面を開き、**最初にパスコードを変更する**（初期値 `1031` はソースに書いてあり、誰でも見られます）
- [ ] 「チームの色」を当日のリストバンドに合わせる
- [ ] スマホ数台でリハーサルし、最後に「テスト結果をすべて消す」でリセットする
- [ ] 参加者には「**SafariかChromeで開いてください**」と案内する（LINEなどのアプリ内ブラウザだと、チーム選択が消えることがあります）
- [ ] URLは参加者だけに配る（簡易版なので、URLを知っている人は誰でも書き込めます）

## 仕組み（メモ）

- 元のコードが使っていたClaudeのDB（`window.claude.use('db')`）の代わりに、同じ書き方で動くつなぎのコードを `index.html` に入れています。ゲーム本体のロジックはそのままです。
- `docs` テーブル：`game/state`、`buzzes/r1-t1-1` のような「パス → JSON」を保存します。変更はSupabase Realtimeで全端末に届きます。念のため、10秒ごとと画面復帰時にも再読み込みします。
- `acquire_lease` 関数：同じチームの2台が同時に押しても1台しか通さないロックです。返す時刻はサーバー時計なので、早押しの順番はスマホの時計のずれに左右されません。

## 困ったとき

| 症状 | 確認すること |
|---|---|
| 「サーバーにつながっていません」が出る | `HAYAOSHI_CONFIG` のURLとkey、ネット接続、Supabaseプロジェクトが一時停止されていないか（ダッシュボードで **Restore**） |
| 他の端末に反映されない | `setup.sql` を最後まで実行したか（Realtimeの設定は最後のブロックです）。10秒待てば再読み込みで反映されます |
| `permission denied` が出る | `setup.sql` をもう一度実行する |
