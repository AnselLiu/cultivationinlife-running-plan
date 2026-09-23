# 耕跑團課表教練・PWA 部署包

把整個資料夾放到任何 **HTTPS** 網站的同一個目錄，就能「安裝到主畫面」、離線使用。

## 檔案
| 檔案 | 用途 |
|---|---|
| `index.html` | 課表教練本體（與 claude.ai 上的版本相同） |
| `manifest.webmanifest` | App 名稱、圖示、主題色、捷徑（今天／本週／全季） |
| `sw.js` | Service Worker：離線快取、更新提示 |
| `icons/` | App 圖示（192、512、maskable、Apple、favicon） |
| `web.config` | 只有放在 IIS 時需要（設定 .webmanifest 的 MIME） |

## 部署方式（擇一）
1. **GitHub Pages**：建一個 repo，把所有檔案放在根目錄 → Settings → Pages → 選 main 分支 → 取得 `https://帳號.github.io/repo/`。
2. **Netlify Drop**：到 app.netlify.com/drop，把整個資料夾拖進去，會直接給一個 HTTPS 網址。
3. **IIS**：把資料夾放到站台下（需 HTTPS），`web.config` 一起放進去。

> 一定要 HTTPS（或 localhost）；直接雙擊 index.html 開啟時不會啟用 PWA，但其他功能都能用。

## 安裝
- **Android／電腦版 Chrome、Edge**：右上角會出現黃色「安裝 App」按鈕，或網址列的安裝圖示。
- **iPhone／iPad**：用 Safari 開啟 → 分享 → 加入主畫面（按「安裝 App」會顯示步驟）。

## 更新版本
修改 `index.html` 後，把 `sw.js` 第一行的 `VERSION`（例如 `gengpao-coach-v1` → `v2`）改掉再上傳。使用者下次開啟會看到「有新版本 → 更新」提示。

## 安裝後的差異
- 全螢幕、有自己的圖示，長按圖示有「今天的課／本週課表／全季總覽」捷徑
- 沒有網路也能開啟、看課表、換算配速
- 「整季 PDF」和「加入行事曆」會直接下載 `.pdf`、`.ics`（不需要解壓縮）
