# 查無此人 no-such-person

自動找出照片裡的人臉並戴上墨鏡的純前端小工具。所有運算都在瀏覽器裡完成，照片不會上傳到任何伺服器。

👉 https://no-such-person.ddio.io

## 作法

- **偵測**：把照片切成多種尺度、互相重疊的方塊，逐塊用 MediaPipe BlazeFace 偵測，合併後再對每張臉裁切放大跑 Face Landmarker 定位。大合照裡的小臉也抓得到。
- **墨鏡**：整張照片共用同一個款式、左右對稱，每副再加上 `crypto.getRandomValues` 的大小／位置／傾斜擾動，避免從墨鏡的尺寸回推個人臉部特徵。
- **匯出**：Canvas 重新編碼，不含原圖的 EXIF／GPS。
- **手動修正**：點墨鏡可移除；從一隻眼睛拖曳到另一隻可手動加；勾「顯示候選框」後點紅框可補戴。

## 隱私設計

- 模型、WASM、程式全部由本站提供（`vendor/`），執行時不連任何第三方。
- 頁面的 CSP 設為 `default-src 'none'; connect-src 'self'`，瀏覽器層級禁止對外連線。
- 偵測跑在 Web Worker 裡。Worker 刻意從 `blob:` URL 啟動：這樣它才會繼承頁面的 CSP；
  直接用網址載入的 Worker 只受自己的 HTTP 回應標頭約束，而靜態主機（GitHub Pages）無法設定標頭。
- 想自己驗證：打開開發者工具的 Network 分頁，或載入頁面後斷網使用。

## 開發

`index.html`（介面）＋ `app.js`（繪製與互動）＋ `worker.js`（偵測），沒有建置步驟，用任何靜態 server 開即可：

```sh
python3 -m http.server 8931
# http://127.0.0.1:8931/?img=test-photos/solvay1927.jpg&debug=1
```

`test-photos/` 是 Wikimedia Commons 的公有領域照片，出處見該目錄的 README。

## 已知限制

- 墨鏡對人眼有遮蔽效果，但不保證能擋下機器人臉辨識。
- 被照片邊緣切掉的臉、嚴重遮擋的臉可能漏抓，請手動補上。

## 授權

[MIT](LICENSE)。`vendor/` 內的 MediaPipe 程式與模型為 Google 所有，採 Apache License 2.0，見 [`vendor/README.md`](vendor/README.md)。
