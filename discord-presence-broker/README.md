# Discord Presence Broker

此儲存庫可獨立執行共享 Broker：`node broker.js`。Broker 是唯一連線 Discord IPC 的程序；Claude 與 Codex 只會寫入 `%LOCALAPPDATA%\\mushroomTW\\discord-presence-broker` 的本機狀態。

Broker 每秒選取有效活動，15 秒未更新即失效。優先序是 Codex「執行工具、編輯、思考、讀取」高於一般等待活動；同級以最新更新者為準。
