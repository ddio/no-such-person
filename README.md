# 查無此人 no-such-person

自動找出照片裡的每張臉、蓋上動物頭（或戴上墨鏡）的純前端小工具。所有運算都在瀏覽器裡完成，照片不會上傳到任何伺服器。

👉 https://no-such-person.ddio.io

## 作法

- **偵測**：把照片切成多種尺度、互相重疊的方塊，逐塊用 MediaPipe BlazeFace 偵測，合併後再對每張臉裁切放大跑 Face Landmarker 定位。大合照裡的小臉也抓得到。
- **動物頭（預設）**：不透明的 [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) 動物臉蓋住整顆頭，被蓋掉的像素無法還原；側臉會依頭部轉角往後腦位移。動物隨機發放，不依臉的特徵挑選。
- **墨鏡**：只是好玩。研究顯示只遮眼睛時，人臉辨識系統仍有 99% 以上認得出來（[Impact of Sunglasses on One-to-Many Facial Identification Accuracy](https://arxiv.org/abs/2412.05721)），熟人也幾乎不受影響（[Noyes et al. 2021](https://pmc.ncbi.nlm.nih.gov/articles/PMC8074904/)）。
- **不洩漏臉部量測**：遮蔽物的大小只取決於粗略的臉部尺度 × 整張照片共用的常數 × `crypto.getRandomValues` 的隨機擾動（大小／位置／傾斜），無法從成品回推眼距等個人特徵。
- **匯出**：Canvas 重新編碼，不含原圖的 EXIF／GPS。
- **手動修正**：點動物頭換一隻；右鍵（手機長按）移除；從一隻眼睛拖曳到另一隻可手動加；勾「顯示候選框」後點紅框可補上。

## 隱私設計

- 模型、WASM、程式全部由本站提供（`vendor/`），處理照片時不連任何第三方。
- 頁面的 CSP 設為 `default-src 'none'; connect-src 'self'`，瀏覽器層級禁止對外連線。
- 偵測跑在 Web Worker 裡。Worker 刻意從 `blob:` URL 啟動：這樣它才會繼承頁面的 CSP；
  直接用網址載入的 Worker 只受自己的 HTTP 回應標頭約束，而靜態主機（GitHub Pages）無法設定標頭。
- 唯一的例外：頁面載入時對 [GoatCounter](https://www.goatcounter.com) 發一個匿名瀏覽計數（`img-src` 白名單，無 cookie）。
  `connect-src` 仍是 `'self'`，所以處理照片的程式與 Worker 沒有任何對外管道。
- 想自己驗證：打開開發者工具的 Network 分頁，或載入頁面後斷網使用。

## 開發

`index.html`（介面）＋ `app.js`（繪製與互動）＋ `worker.js`（偵測），沒有建置步驟，用任何靜態 server 開即可：

```sh
python3 -m http.server 8931
# http://127.0.0.1:8931/?img=test-photos/solvay1927.jpg&debug=1
```

`test-photos/` 是 Wikimedia Commons 的公有領域照片，出處見該目錄的 README。

社群分享圖 `og.jpg` 用的是 Giampietrino 約 1520 年臨摹的《最後的晚餐》（[Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Giampietrino-Last-Supper-ca-1520.jpg)，公有領域）：達文西的原作剝落太嚴重，偵測只抓得到一兩張臉；摹本自動抓到 11 張，其餘 2 張側臉手動補上。

## 已知限制

- 動物頭擋得住人臉辨識，但擋不住情境：衣著、體型、場景、同框的人，仍可能讓認識的人認出來。
- 被照片邊緣切掉的臉、嚴重遮擋的臉可能漏抓，請手動補上。

## 授權

[MIT](LICENSE)。`vendor/` 內的 MediaPipe 程式與模型為 Google 所有，採 Apache License 2.0，見 [`vendor/README.md`](vendor/README.md)；`stickers/` 的動物臉來自 Microsoft Fluent Emoji（MIT），見 [`stickers/README.md`](stickers/README.md)。
