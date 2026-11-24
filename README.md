# 水上ビル 人流ダッシュボード

水上ビル商店街（豊橋市）に置いたBLEセンサーの集計を、毎日見られるようにしたページです。

- 画面：`index.html` / `app.js` / `style.css`（GitHub Pagesで配信）
- データ：Google Apps Script が毎朝6時ごろ BigQuery で集計したJSONを読み込みます（`index.html` の `DATA_URL`）
- 端末を見分ける情報は含まれません。数はスマートフォンの台数で、人数そのものではありません

## 手元で見る

```sh
python3 -m http.server 8765   # http://localhost:8765/
```

`data/` は手元の確認用（公開しない）。

合同会社ひとなみ舎
